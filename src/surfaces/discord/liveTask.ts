import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type Message } from "discord.js";
import type { TaskRow } from "../../orchestration/contracts.ts";
import type { ActivityHub, ActivityLine, TaskMeta, TaskView } from "../../orchestration/activityHub.ts";
import { getLogger } from "../../logger.ts";

const log = getLogger("surfaces/discord/liveTask");

// Live views by taskId, so a resume reuses the same DM message + subscription instead of spawning a
// new one. A view stays here through an idle (resumable) settle and is removed only on terminal.
const activeViews = new Map<string, LiveTaskView>();
/** True when a task already has a live DM view — the gateway skips creating a second one on resume. */
export function hasLiveTaskView(taskId: string): boolean {
  return activeViews.has(taskId);
}

// custom_id: `${TASK_CTL_PREFIX}<action>:<taskId>` — action ∈ stop|discard|discardyes|cancel|resume.
export const TASK_CTL_PREFIX = "tctl:";

/** Control buttons for a task's DM message, by status. Stop/Discard while running, Resume while idle,
 *  and a Live-log link whenever there's a viewer URL. Empty → the message shows no buttons. */
export function controlRow(taskId: string, status: string, webUrl: string | null): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (status === "running" || status === "needs_input") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`${TASK_CTL_PREFIX}stop:${taskId}`).setLabel("Stop").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${TASK_CTL_PREFIX}discard:${taskId}`).setLabel("Discard").setStyle(ButtonStyle.Danger),
    );
  } else if (status === "idle") {
    row.addComponents(new ButtonBuilder().setCustomId(`${TASK_CTL_PREFIX}resume:${taskId}`).setLabel("Resume").setStyle(ButtonStyle.Success));
  }
  if (webUrl) row.addComponents(new ButtonBuilder().setLabel("Live log").setStyle(ButtonStyle.Link).setURL(webUrl));
  return row.components.length ? [row] : [];
}

const EDIT_INTERVAL_MS = 5000; // Discord self-rate-limit: at most one in-place edit per 5s
const MAX_LINES = 14; // recent activity lines shown in the tail
const MAX_CONTENT = 1900; // under Discord's 2000-char message limit
const IDLE_RETAIN_MS = 10 * 60_000; // keep an idle (resumable) view this long for a resume, then tear down

// A single live-updating DM message per running task: a header + a tail of the most recent activity
// lines, edited in place (throttled to 5s) as the runner streams, and finalized on settle. The full
// stream lives at the web URL; this is the at-a-glance view.
export class LiveTaskView {
  private readonly lines: string[];
  private dirty = false;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEditAt = 0;
  private disposed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubs: Array<() => void> = [];

  private constructor(
    private readonly taskId: string,
    private readonly message: Message,
    view: TaskView,
    private readonly webUrl: string | null,
    private readonly meta: TaskMeta,
  ) {
    // Show tool calls + assistant text only; tool results are hidden here (they're the noise) and
    // stay available in the web viewer.
    this.lines = view.lines.filter((l) => l.atype !== "result").map(fmtLine);
    this.unsubs.push(view.onLine((l) => this.onLine(l)));
    this.unsubs.push(view.onStatus((status, summary) => this.onSettle(status, summary)));
  }

  static async start(client: Client, task: TaskRow, hub: ActivityHub, webUrl: string | null, meta: TaskMeta): Promise<LiveTaskView | null> {
    const user = await client.users.fetch(task.createdBy).catch(() => null);
    if (!user) return null;
    const msg = await user
      .send({ content: headerBlock(task.id, "running", webUrl, meta), components: controlRow(task.id, "running", webUrl) })
      .catch((err) => {
        log.warn({ err, taskId: task.id }, "failed to open live task message");
        return null;
      });
    if (!msg) return null;
    // Read the buffer AFTER the DM round-trip and subscribe in the same synchronous tick, so lines
    // that arrived during the await are in the seed and none fall between seed and subscription.
    const view = hub.view(task.id);
    if (!view) return null;
    const live = new LiveTaskView(task.id, msg, view, webUrl, meta);
    activeViews.set(task.id, live);
    live.render("running"); // paint whatever is already buffered
    return live;
  }

  private onLine(entry: ActivityLine): void {
    if (entry.atype === "result") return; // results hidden in Discord
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } // activity → the task resumed
    this.lines.push(fmtLine(entry));
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.editTimer || this.disposed) return;
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastEditAt));
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      if (this.dirty && !this.disposed) this.render("running");
    }, wait);
    this.editTimer.unref?.();
  }

  private onSettle(status: string, summary: string | null): void {
    if (summary) this.dropDuplicateFinal(summary);
    void this.message.edit({ content: this.body(status, summary), components: controlRow(this.taskId, status, this.webUrl) }).catch(() => {});
    // idle = stopped-but-resumable: keep the subscription + this same message so a resume continues here
    // (the hub reuses the stream on re-open). Tear down only on a terminal state, or if the idle window
    // lapses without a resume (onLine cancels this timer).
    if (status === "idle") {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.teardown(), IDLE_RETAIN_MS);
      this.idleTimer.unref?.();
      return;
    }
    this.teardown();
  }

  private teardown(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.editTimer) clearTimeout(this.editTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const u of this.unsubs) u();
    activeViews.delete(this.taskId);
  }

  // The agent's closing message is in the tail as a (truncated) 💬 line AND arrives again as the full
  // handback summary. If the last text line is that truncated head, drop it so it isn't shown twice.
  private dropDuplicateFinal(summary: string): void {
    const sum = summary.trim().replace(/\s+/g, " ");
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i]!;
      if (l.startsWith("🔧")) return; // last activity was a tool call — no duplicate to drop
      if (l.startsWith("💬")) {
        if (isTruncatedHeadOf(l.replace(/^💬\s*/, ""), sum)) this.lines.splice(i, 1);
        return;
      }
    }
  }

  private render(status: string): void {
    this.dirty = false;
    this.lastEditAt = Date.now();
    void this.message
      .edit({ content: this.body(status, null), components: controlRow(this.taskId, status, this.webUrl) })
      .catch((err) => log.warn({ err, taskId: this.taskId }, "live edit failed"));
  }

  private body(status: string, summary: string | null): string {
    const head = headerBlock(this.taskId, status, this.webUrl, this.meta);
    const settled = status !== "running";
    // Trim the activity tail so header + (on settle) summary + resume block fit under the 2000 limit.
    const reserve = settled ? 700 : 0;
    let block = this.lines.slice(-MAX_LINES).join("\n");
    const budget = MAX_CONTENT - head.length - reserve;
    if (block.length > budget) block = `…\n${block.slice(block.length - Math.max(0, budget))}`;
    let out = block ? `${head}\n\`\`\`\n${block}\n\`\`\`` : head;
    if (settled && summary) {
      const note = status === "failed" ? "-# ✗ failed · returned to orchestrator" : "-# ↩ handed back to orchestrator";
      out += `\n\n${summary.slice(0, 600)}\n${note}`;
    }
    if (settled && this.meta.resumeCommand) out += `\nResume elsewhere:\n\`\`\`\n${this.meta.resumeCommand}\n\`\`\``;
    return out.slice(0, 2000);
  }
}

const TAIL_LINE_MAX = 180; // the Discord tail is a glance view — clip each line here; full text is on the web

function fmtLine(entry: ActivityLine): string {
  const flat = entry.line.replace(/\s+/g, " ").trim();
  const clipped = flat.length > TAIL_LINE_MAX ? `${flat.slice(0, TAIL_LINE_MAX - 1)}…` : flat;
  return entry.atype === "tool" ? `🔧 ${clipped}` : `💬 ${clipped}`;
}

/** True when `text` (a possibly 400-char-truncated assistant line) is the leading head of `summary`. */
export function isTruncatedHeadOf(text: string, summary: string): boolean {
  const head = text.replace(/…\s*$/, "").trim().replace(/\s+/g, " ");
  const sum = summary.trim().replace(/\s+/g, " ");
  return head.length >= 8 && sum.startsWith(head);
}

function headerBlock(taskId: string, status: string, webUrl: string | null, meta: TaskMeta): string {
  const icon = status === "running" ? "⏳" : status === "failed" ? "❌" : "✅";
  const link = webUrl ? ` · [live](${webUrl})` : "";
  const runner = `${meta.runnerId} (${meta.kind})${meta.location ? ` · ${meta.location}` : ""}`;
  const lines = [`${icon} \`#${taskId}\` · ${status}${link}`, `🖥 ${runner}${meta.project ? ` · 📁 ${meta.project}` : ""}`];
  if (meta.cwd) lines.push(`\`${meta.cwd}\``);
  return lines.join("\n");
}
