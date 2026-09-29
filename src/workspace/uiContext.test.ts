import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ChatDeliverParams } from "../orchestration/contracts.ts";
import { PersonalSession, type ChatSession } from "./personalSession.ts";
import { ChatAsks, createHeadlessUIContext, parseConfirm, parseSelect, plainTheme, type AskRequest } from "./uiContext.ts";

function broker(timeoutMs?: number) {
  const asked: AskRequest[] = [];
  let n = 0;
  const asks = new ChatAsks({ deliver: (a) => asked.push(a), timeoutMs, newId: () => `a${++n}` });
  return { asks, asked, ui: createHeadlessUIContext(asks) };
}

describe("ChatAsks", () => {
  test("a button answer resolves its own ask even when an older one is open", async () => {
    const { asks, asked, ui } = broker();
    const first = ui.confirm("First?", "");
    const second = ui.confirm("Second?", "");
    expect(asks.answer(`wsask:${asked[1]!.askId}`, "Yes")).toBe("answered");
    expect(await second).toBe(true);
    expect(asks.size).toBe(1);
    asks.cancelAll("test");
    expect(await first).toBe(false);
  });

  test("free text answers the oldest ask that accepts it", async () => {
    const { asks, ui } = broker();
    const confirmed = ui.confirm("Ok?", "");
    const typed = ui.input("Name?");
    expect(asks.answer("m1", "drk")).toBe("answered");
    expect(await typed).toBe("drk");
    expect(asks.answer("m2", "yes")).toBe("answered");
    expect(await confirmed).toBe(true);
    expect(asks.answer("m3", "anything")).toBeNull();
  });

  test("a button answer for no open ask is stale", () => {
    const { asks } = broker();
    expect(asks.answer("wsask:gone", "Yes")).toBe("stale");
  });

  test("dialog signal and timeout options resolve to the default", async () => {
    const { ui, asks } = broker();
    const ctrl = new AbortController();
    const aborted = ui.select("Pick", ["a"], { signal: ctrl.signal });
    ctrl.abort();
    expect(await aborted).toBeUndefined();
    expect(await ui.confirm("Quick?", "", { timeout: 5 })).toBe(false);
    expect(asks.size).toBe(0);
    const pre = new AbortController();
    pre.abort();
    expect(await ui.input("Never", undefined, { signal: pre.signal })).toBeUndefined();
  });

  test("the default 30 minute timeout applies when none is given", async () => {
    const { ui } = broker(10);
    expect(await ui.input("Name?")).toBeUndefined();
  });

  test("parsers", () => {
    expect(parseConfirm("Yes")).toEqual({ value: true });
    expect(parseConfirm("no")).toEqual({ value: false });
    expect(parseConfirm("maybe")).toBeNull();
    const pick = parseSelect(["main", "dev"]);
    expect(pick("Dev")).toEqual({ value: "dev" });
    expect(pick("1")).toEqual({ value: "main" });
    expect(pick("3")).toBeNull();
    expect(pick("(option 2)")).toEqual({ value: "dev" });
  });
});

describe("headless UI context", () => {
  test("custom() declines at once", async () => {
    const { ui, asked } = broker();
    let built = false;
    const result = await ui.custom(() => {
      built = true;
      throw new Error("no TUI");
    });
    expect(result).toBeUndefined();
    expect(built).toBe(false);
    expect(asked).toEqual([]);
  });

  test("theme styling returns plain strings", () => {
    const { ui } = broker();
    expect(ui.theme).toBe(plainTheme);
    expect(ui.theme.fg("accent", "hi")).toBe("hi");
    expect(ui.theme.bg("selectedBg", "hi")).toBe("hi");
    expect(ui.theme.bold(ui.theme.italic("hi"))).toBe("hi");
    expect(ui.theme.style("hi", {} as never)).toBe("hi");
    expect(ui.theme.getFgAnsi("accent")).toBe("");
  });

  test("TUI-only calls are no-ops", () => {
    const { ui, asked } = broker();
    ui.notify("heads up", "warning");
    ui.setStatus("k", "v");
    ui.setWidget("k", ["line"]);
    ui.setFooter(undefined);
    ui.setTitle("t");
    expect(ui.onTerminalInput(() => undefined)).toBeFunction();
    expect(ui.getEditorText()).toBe("");
    expect(ui.getToolsExpanded()).toBe(false);
    expect(ui.setTheme("dark").success).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("a real Pi extension", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ws-ui-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function sessionWith(ui: ExtensionUIContext | undefined, onResult: (r: unknown, hasUI: boolean) => void, full = true): Promise<AgentSession> {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const cwd = join(root, "home");
    const agentDir = join(root, "agent");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      extensionFactories: [
        {
          name: "fake-guard",
          factory: (pi: ExtensionAPI) => {
            pi.registerCommand("check", {
              description: "asks the owner",
              handler: async (_args, ctx) => {
                const ok = await ctx.ui.confirm("Allow rm?", "bash wants to delete build/");
                if (!full) return onResult({ ok }, ctx.hasUI);
                const branch = await ctx.ui.select("Branch?", ["main", "dev"]);
                const name = await ctx.ui.input("Name?", "feat/...");
                onResult({ ok, branch, name, styled: ctx.ui.theme.fg("warning", "plain") }, ctx.hasUI);
              },
            });
          },
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(cwd),
    });
    if (ui) await session.bindExtensions({ uiContext: ui, mode: "rpc" });
    return session;
  }

  test("ctx.ui dialogs become asks that the owner's answers resolve", async () => {
    const { ui, asks, asked } = broker();
    const results: unknown[] = [];
    const session = await sessionWith(ui, (r, hasUI) => results.push({ ...(r as object), hasUI }));
    const run = session.prompt("/check");
    const nextAsk = async (i: number) => {
      for (let t = 0; t < 200 && asked.length <= i; t++) await new Promise((r) => setTimeout(r, 5));
      return asked[i]!;
    };
    const confirm = await nextAsk(0);
    expect(confirm).toMatchObject({ question: "Allow rm?\nbash wants to delete build/", choices: ["Yes", "No"] });
    expect(asks.answer(`wsask:${confirm.askId}`, "Yes")).toBe("answered");
    const select = await nextAsk(1);
    expect(select.choices).toEqual(["main", "dev"]);
    expect(asks.answer("m1", "2")).toBe("answered");
    const input = await nextAsk(2);
    expect(input.choices).toEqual([]);
    expect(asks.answer("m2", "feat/ui")).toBe("answered");
    await run;
    expect(results).toEqual([{ ok: true, branch: "dev", name: "feat/ui", styled: "plain", hasUI: true }]);
    session.dispose();
  });

  test("through PersonalSession: the confirm is delivered as an ask, answered in chat, and chat/new re-binds", async () => {
    const delivered: ChatDeliverParams[] = [];
    const transport = { request: async (_m: string, p: unknown) => void delivered.push(p as ChatDeliverParams), notify: () => {} };
    const results: Array<{ ok: unknown; hasUI: boolean }> = [];
    const sessions: AgentSession[] = [];
    const host = new PersonalSession({
      principalId: "drk",
      model: "test/model",
      stateDir: join(root, "state"),
      transport,
      factory: async ({ ui }) => {
        const session = await sessionWith(ui, (r, hasUI) => results.push({ ...(r as { ok: unknown }), hasUI }), false);
        sessions.push(session);
        return { session: session as unknown as ChatSession, sessionFile: join(root, `chat-${sessions.length}.jsonl`) };
      },
    });
    await host.start();
    const waitAsk = async (n: number) => {
      for (let t = 0; t < 200 && delivered.filter((d) => d.kind === "ask").length < n; t++) await new Promise((r) => setTimeout(r, 5));
      return delivered.filter((d) => d.kind === "ask")[n - 1]!;
    };

    const first = sessions[0]!.prompt("/check");
    const ask = await waitAsk(1);
    expect(ask).toMatchObject({ kind: "ask", principalId: "drk", ask: { question: "Allow rm?\nbash wants to delete build/", choices: ["Yes", "No"] } });
    const answer = { principalId: "drk", origin: { surface: "discord", conversationId: "dm" }, kind: "user" as const, author: { id: "1", name: "drk" } };
    expect(await host.handleMessage({ ...answer, messageId: `wsask:${ask.ask!.askId}`, text: "Yes" })).toEqual({ accepted: true, mode: "prompt" });
    await first;
    expect(results).toEqual([{ ok: true, hasUI: true }]);

    await host.handleNew();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.extensionRunner.hasUI()).toBe(true);
    const second = sessions[1]!.prompt("/check");
    await waitAsk(2);
    await host.handleMessage({ ...answer, messageId: "m-2", text: "yes" });
    await second;
    expect(results).toEqual([
      { ok: true, hasUI: true },
      { ok: true, hasUI: true },
    ]);
    await host.dispose();
  });
});
