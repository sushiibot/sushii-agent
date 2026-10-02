import { runsStopParams, RPC_METHODS } from "../orchestration/contracts.ts";
// First: initialises OTel (when OTEL_EXPORTER_OTLP_ENDPOINT is set) before anything creates spans.
import { otelSDK } from "../telemetry.ts";
import { ConnectorManager } from "./connectors.ts";
import { join } from "node:path";
import { NotConnectedError, OrchestrationClient } from "../orchestration/transport/client.ts";
import { getLogger } from "../logger.ts";
import { WorkspaceConfigError, economyOf, loadWorkspaceConfig, taskRulesOf, type WorkspaceConfig } from "./config.ts";
import { TopicSessions } from "./topicSessions.ts";
import { PersonalSession } from "./personalSession.ts";
import { compactSession, compactionTrigger, createPiChatSessionFactory, idleRotateMs, recapSession, reloadContext, sessionModelLabel } from "./piChatSession.ts";
import { ModelChoice } from "./modelChoice.ts";
import { commandHandlers } from "./commands.ts";
import { readModelCosts } from "./modelCosts.ts";
import { TASK_PATHS, renderTasksCommand, runTaskReview } from "./tasks.ts";
import { MEMORY_PATHS, commitHome, scaffoldHome } from "./home.ts";
import { memoryFilesSignature, sessionFlushRanThisCycle, writeResetHandoff } from "./memoryFlush.ts";
import { scanMemoryForSecrets } from "./memoryGuard.ts";
import { RunLog, recordRotation } from "./runLog.ts";
import { HistoryWriter, recordHistory } from "./history.ts";
import { createConsolidationJob, waitIdle } from "./consolidation.ts";
import { ToolStubs } from "./toolStubs.ts";
import { GitHubCredentials } from "./githubCredentials.ts";
import { AuthLogin, ReauthNotifier, piChatGptLogin } from "./authLogin.ts";
import { BackendSelector } from "./chatgptFallback.ts";
import { SubagentHost } from "./subagents/host.ts";
import { MainTurnTracker } from "./subagents/turnTracker.ts";
import { Scheduler, jobAlertText, jobAlertWire } from "./scheduler.ts";
import { wireProactiveJobs } from "./proactive.ts";
import { ulid } from "./ulid.ts";
import { ChatExportReader, chatExportHandlers } from "./chatExport.ts";
import { UPLOADS_DIR } from "./inboundImages.ts";
import { notifyRunChanges, runsHandlers } from "./runsRpc.ts";
import { memoryHandlers } from "./memoryFiles.ts";
import { historyHandlers } from "./historyFiles.ts";
import { HistorySearch, historySearchHandlers } from "./historySearch.ts";
import { DurableState } from "../agentRuntime/durableState.ts";

const log = getLogger("workspace");

function loadConfigOrExit(): WorkspaceConfig {
  try {
    return loadWorkspaceConfig();
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      console.error(`workspace: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  // This is the OpenRouter key; Pi's built-in openai provider would otherwise send it to api.openai.com
  // whenever no ChatGPT login is stored.
  delete process.env.OPENAI_API_KEY;
  await scaffoldHome(config.home);
  // One instance for the whole process: later subagent and job runners record through it too.
  const runLog = new RunLog(config.stateDir, { warn: (obj, msg) => log.warn(obj, msg) });
  const orphans = runLog.reconcileOrphans();
  if (orphans) log.warn({ orphans }, "closed runs left open by a previous process");
  const historyLog = getLogger("workspace.history");
  const history = new HistoryWriter({ home: config.home, agentDir: config.agentDir, tz: config.tz });
  let client: OrchestrationClient | null = null;
  const runs = notifyRunChanges(recordHistory(runLog, history, historyLog), (method, params) => client?.notify(method, params), config.principalId, log);
  const toolStubs = new ToolStubs({
    principalId: config.principalId,
    request: (method, params, timeoutMs) => (client ? client.request(method, params, { timeoutMs }) : Promise.reject(new NotConnectedError())),
  });
  // Late-bound: the subagent watch leases a pre-push hook install, and subagents take these credentials.
  let watchRef: SubagentHost["watch"] | null = null;
  const github = new GitHubCredentials({
    principalId: config.principalId,
    home: config.home,
    askpassPath: join(config.stateDir, "git-askpass.sh"),
    request: (method, params, timeoutMs) => (client ? client.request(method, params, { timeoutMs }) : Promise.reject(new NotConnectedError())),
    leaseWrite: (paths) => watchRef?.mainWrite(paths) ?? (() => {}),
  });
  // The one backend selector: main, subagents, jobs and the auto-mode judge all start their calls on its
  // current backend, so a ChatGPT limit or auth failure anywhere moves them all to OpenRouter together.
  // Late-bound: the selector reports auth failures while the first session is built, before these exist.
  let reauth: ReauthNotifier | null = null;
  const selector = new BackendSelector({
    primaryEnabled: config.provider === "chatgpt",
    onAuthFailure: () => {
      try {
        reauth?.notify();
      } catch (err) {
        log.warn({ err }, "failed to send the ChatGPT re-auth notice");
      }
    },
  });
  // After the selector (its ChatGPT switch follows the deployed provider, not a pinned choice), before any
  // session or runner reads the config: a saved `!model` choice rewrites its model fields.
  const choice = new ModelChoice(config, config.stateDir);
  const turns = new MainTurnTracker();
  // Late-bound: main runs start only after the session exists.
  let personalTurn: PersonalSession | null = null;
  const notify = (method: string, params: unknown) => {
    turns.observe(method, params);
    client?.notify(method, params);
  };
  // Late-bound: background results only arrive after personal.start().
  let personalRef: PersonalSession | null = null;
  let topicsRef: TopicSessions | null = null;
  const durableState = new DurableState(config.stateDir);
  const subagents = new SubagentHost({
    config,
    runs,
    selector,
    toolStubs,
    github,
    notify,
    currentTurn: () => turns.current(),
    wake: (r, consumed) => (topicsRef ?? personalRef)?.wake({ id: r.runId, text: r.text, origin: r.origin, onConsumed: consumed }),
  });
  watchRef = subagents.watch;
  const connectors = new ConnectorManager(config.agentDir);
  await connectors.start();
  const personalOptions = {
    principalId: config.principalId,
    model: config.model,
    stateDir: config.stateDir,
    durableState,
    conversationId: "main",
    tz: config.tz,
    uploads: { dir: join(config.home, UPLOADS_DIR) },
    factory: createPiChatSessionFactory(config, { runs, toolStubs, selector, subagents, choice, github, connectors, parentTurn: () => { const turnId = personalTurn?.currentTurnId(); return turnId ? turns.get(turnId) : null; }, mainTurnId: () => personalTurn?.currentTurnId() }),
    memory: {
      compactionTrigger,
      reload: reloadContext,
      commit: (message) => {
        const flagged = scanMemoryForSecrets(config.home);
        if (flagged.length) log.warn({ files: flagged }, "memory files hold something secret-shaped; committing anyway");
        return commitHome(message, { home: config.home, paths: MEMORY_PATHS });
      },
      signature: () => memoryFilesSignature(config.home),
      handoff: (session, outcome) => {
        const end = subagents.watch.mainWrite(["memory"]);
        try {
          writeResetHandoff(config.home, session.messages, outcome);
        } finally {
          end();
        }
      },
      flushRanThisCycle: sessionFlushRanThisCycle,
    },
    context: {
      compact: compactSession,
      recap: async (session, signal) => (await recapSession(session, signal))?.text ?? null,
      idleRotateMs: (session) => idleRotateMs(session, config),
      rotateTokens: economyOf(config).idleRotateTokens,
      busy: () => subagents.isBusy(),
      onRotated: (r) => {
        try {
          recordRotation(runs, r);
        } catch (err) {
          log.warn({ err }, "failed to record the rotation in the run log");
        }
      },
      onSessionSummary: (s) => history.writeSession(s),
    },
    transport: {
      request: (method, params, timeoutMs) => (client ? client.request(method, params, { timeoutMs }) : Promise.reject(new NotConnectedError())),
      notify,
      isConnected: () => client?.connected ?? false,
    },
  } satisfies import("./personalSession.ts").PersonalSessionOptions;
  const personal = new PersonalSession(personalOptions);
  personalTurn = personal;
  const authLogin = new AuthLogin({
    principalId: config.principalId,
    login: piChatGptLogin({ agentDir: config.agentDir, cwd: config.home }),
    deliver: (d) => personal.deliverOutOfBand(d),
    model: config.chatgptModel,
    onLoggedIn: () => selector.reset(),
  });
  reauth = new ReauthNotifier({ stateDir: config.stateDir, deliver: (d) => personal.deliverOutOfBand(d), suppressed: () => authLogin.isPending });
  await personal.start();
  personalRef = personal;
  const commands = commandHandlers({
    principalId: config.principalId,
    compact: () => personal.compactNow(),
    choice,
    currentModel: () => (personal.chatSession ? sessionModelLabel(personal.chatSession) : null),
    fallbackUntil: () => selector.coolingDownUntil,
    costs: conversationId => readModelCosts({
      stateDir: config.stateDir,
      timeZone: config.tz,
      sessionFile: topicsRef ? topicsRef.sessionFileFor(conversationId) : personal.currentSessionFile || null,
    }),
    tasks: (arg) => renderTasksCommand(config.home, taskRulesOf(config), new Date(), arg),
  });
  const topics = new TopicSessions({
    principalId: config.principalId, stateDir: config.stateDir, main: personal,
    command: p => commands["chat/command"]!(p),
    create: id => {
      let topic: PersonalSession;
      topic = new PersonalSession({
        ...personalOptions,
        stateDir: join(config.stateDir, "topics", id),
        conversationId: id,
        factory: createPiChatSessionFactory(config, { runs, toolStubs, selector, subagents, choice, github, connectors, parentTurn: () => { const turnId = topic.currentTurnId(); return turnId ? { turnId, origin: { surface: "web", conversationId: id } } : null; }, origin: { surface: "web", conversationId: id }, sessionDir: join(config.agentDir, "topics", id), agentName: `topic:${id}`, mainTurnId: () => topic.currentTurnId() }),
        context: { ...personalOptions.context, busy: () => subagents.isBusy({ surface: "web", conversationId: id }) },
      });
      return topic;
    },
  });
  topicsRef = topics;
  await topics.restore();
  subagents.redeliverPending();
  const scheduler = new Scheduler({
    stateDir: config.stateDir,
    at: config.consolidateAt,
    tz: config.tz,
    log: getLogger("workspace.scheduler"),
    onJobAlert: (alert) => personal.deliverAlert(jobAlertWire(alert), jobAlertText(alert)),
  });
  const consolidation = createConsolidationJob(config, { runs, selector, live: topics });
  // Its memory and task writes are main-side: the subagents' protected watch must not undo them.
  // Two idle waits and a model call can each take 10 min, so the default max runtime would flag a normal slow run.
  scheduler.register({ ...consolidation, maxRunMs: 60 * 60_000, run: (ctx) => subagents.whileMainWrites(() => consolidation.run(ctx), ["USER.md", "MEMORY.md", "DREAMS.md", "TASKS.md", "tasks"]) });
  wireProactiveJobs(scheduler, {
    config,
    runs,
    selector,
    toolStubs,
    deliver: (text, job) => personal.deliverOutOfBand({ kind: "proactive", text, job }),
    note: async (name, text) => {
      await personal.handleMessage({
        origin: { surface: "workspace", conversationId: "schedule" },
        principalId: config.principalId,
        messageId: `job:${name}:${ulid()}`,
        text,
        kind: "context",
        author: { id: "workspace", name: "scheduler" },
      });
    },
    review: (limiter) => () =>
      runTaskReview({
        home: config.home,
        stateDir: config.stateDir,
        rules: taskRulesOf(config),
        allow: (now) => limiter.check("task-review", 20 * 60 * 60_000, now) === "ok",
        record: (now) => limiter.record("task-review", now),
        ask: (question, choices, parse) => personal.askOwner(question, choices, parse),
        write: async (fn, message) => {
          // Between turns when possible: the agent may be editing TASKS.md; the edit itself is synchronous.
          if (!(await waitIdle(topics, 30 * 60_000))) log.warn("applying the stale review while the chat session is busy");
          await subagents.whileMainWrites(async () => fn(), ["TASKS.md", "tasks"]);
          await commitHome(message, { home: config.home, paths: TASK_PATHS });
          topics.requestContextReload();
        },
        warn: (obj, msg) => log.warn(obj, msg),
      }),
    onScheduleChange: () =>
      void commitHome("chore(schedule): update schedule.md", { home: config.home, paths: ["schedule.md"] }).catch((err) =>
        log.warn({ err }, "failed to commit schedule.md"),
      ),
  });
  void scheduler.start();

  client = new OrchestrationClient({
    url: config.orchUrl,
    runnerId: `workspace-${config.principalId}`,
    kind: "pi-workspace",
    secret: config.orchSecret,
    principalId: config.principalId,
    state: () => topics.state,
    handlers: {
      ...personal.handlers(),
      ...connectors.handlers(config.principalId),
      ...chatExportHandlers({ principalId: config.principalId, reader: new ChatExportReader({ agentDir: config.agentDir }) }),
      // Session roots come from the host's own agent dir (process env set by the deploy), never from a run record.
      ...runsHandlers({ principalId: config.principalId, stateDir: config.stateDir, home: config.home, tz: config.tz, agentDirs: [config.agentDir] }),
      ...memoryHandlers({ home: config.home, principalId: config.principalId }),
      ...historyHandlers({ principalId: config.principalId, home: config.home, stateDir: config.stateDir }),
      ...historySearchHandlers(new HistorySearch({ principalId: config.principalId, home: config.home })),
      ...authLogin.handlers(),
      ...commands,
      ...topics.handlers(),
      [RPC_METHODS.runsStop]: async (p: unknown) => {
        const q = runsStopParams.parse(p);
        if (q.principalId !== config.principalId) throw new Error("principal mismatch");
        return { stopped: subagents.stop(q.runId) };
      },
    },
    onRegistered: (result) => {
      toolStubs.update(result?.tools ?? []);
      topics.onRegistered(result?.features ?? []);
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "workspace shutting down");
    client?.close();
    // Children first: they record their runs and persist background results while main can still take them.
    await subagents.dispose();
    await Promise.all([scheduler.stop(), personal.dispose(), topics.dispose(), connectors.dispose()]);
    await durableState.close();
    await otelSDK?.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info(
    {
      url: config.orchUrl,
      principalId: config.principalId,
      provider: config.provider,
      chatgptModel: config.chatgptModel,
      model: config.model,
      judge: config.autoMode ? { chatgpt: config.judgeChatgptModel, openrouter: config.judgeModel } : null,
    },
    "workspace starting",
  );
  await client.run();
}

main().catch((err) => {
  log.fatal({ err }, "workspace crashed");
  process.exit(1);
});
