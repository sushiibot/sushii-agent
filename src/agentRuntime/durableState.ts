import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type Session } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** One process owns one workspace database. Domain modules define their own versioned documents. */
export class DurableState {
  private opening: Promise<Session> | undefined;

  constructor(private readonly stateDir: string) {}

  open(): Promise<Session> {
    this.opening ??= this.load();
    return this.opening;
  }

  private async load(): Promise<Session> {
    mkdirSync(this.stateDir, { recursive: true });
    return createSession(await openNodeSqliteStorage(join(this.stateDir, "workspace.sqlite")));
  }

  async close(): Promise<void> {
    if (this.opening) await (await this.opening).close(BACKGROUND_CONTEXT);
  }
}
