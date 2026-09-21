import type { Client, Message } from "discord.js";
import type { TaskRow } from "../../orchestration/contracts.ts";
import type { TaskView } from "../../orchestration/activityHub.ts";
import { getLogger } from "../../logger.ts";

const log = getLogger("surfaces/discord/liveTask");

const EDIT_INTERVAL_MS = 5000; // Discord self-rate-limit: at most one in-place edit per 5s
const MAX_LINES = 14; // recent activity lines shown in the tail
const MAX_CONTENT = 1900; // under Discord's 2000-char message limit

// A single live-updating DM message per running task: a header + a tail of the most recent activity
// lines, edited in place (throttled to 5s) as the runner streams, and finalized on settle. The full
// stream lives at the web URL; this is the at-a-glance view.
export class LiveTaskView {
  private readonly lines: string[];
  private dirty = false;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEditAt = 0;
  private disposed = false;
  private readonly unsubs: Array<() => void> = [];

  private constructor(
    private readonly taskId: string,
    private readonly message: Message,
    view: TaskView,
    private readonly webUrl: string | null,
  ) {
    this.lines = view.lines.map((l) => l.line); // seed from the buffer captured so far
    this.unsubs.push(view.onLine((l) => this.onLine(l.line)));
    this.unsubs.push(view.onStatus((status, summary) => this.onSettle(status, summary)));
  }

  static async start(client: Client, task: TaskRow, view: TaskView, webUrl: string | null): Promise<LiveTaskView | null> {
    const user = await client.users.fetch(task.createdBy).catch(() => null);
    if (!user) return null;
    const msg = await user.send(header(task.id, "running", webUrl)).catch((err) => {
      log.warn({ err, taskId: task.id }, "failed to open live task message");
      return null;
    });
    if (!msg) return null;
    const live = new LiveTaskView(task.id, msg, view, webUrl);
    live.render("running"); // paint whatever is already buffered
    return live;
  }

  private onLine(line: string): void {
    this.lines.push(line);
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
    this.disposed = true;
    if (this.editTimer) clearTimeout(this.editTimer);
    for (const u of this.unsubs) u();
    void this.message.edit(this.body(status, summary)).catch(() => {});
  }

  private render(status: string): void {
    this.dirty = false;
    this.lastEditAt = Date.now();
    void this.message.edit(this.body(status, null)).catch((err) => log.warn({ err, taskId: this.taskId }, "live edit failed"));
  }

  private body(status: string, summary: string | null): string {
    let block = this.lines.slice(-MAX_LINES).join("\n");
    if (block.length > MAX_CONTENT) block = `…\n${block.slice(block.length - MAX_CONTENT)}`;
    const head = header(this.taskId, status, this.webUrl);
    const tail = summary ? `\n${summary.slice(0, 500)}` : "";
    return block ? `${head}\n\`\`\`\n${block}\n\`\`\`${tail}` : `${head}${tail}`;
  }
}

function header(taskId: string, status: string, webUrl: string | null): string {
  const icon = status === "running" ? "⏳" : status === "failed" ? "❌" : "✅";
  const link = webUrl ? ` · [live](${webUrl})` : "";
  return `${icon} \`#${taskId}\` · ${status}${link}`;
}
