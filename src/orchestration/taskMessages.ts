import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, asc, eq } from "drizzle-orm";
import { taskMessages } from "../db/schema.ts";

export type TaskMessageDirection = "agent_to_owner" | "owner_to_agent";
export type TaskMessageStatus = "pending" | "delivered" | "failed";
export interface TaskMessage {
  id: string;
  taskId: string;
  direction: TaskMessageDirection;
  content: string;
  status: TaskMessageStatus;
  discordMessageId: string | null;
  failure: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

/** Durable addressed mailbox for task ↔ owner messages. Pending records are written before any
 * external delivery; status changes capture the result, rather than conflating messages with task
 * steering or lifecycle state. */
export class TaskMessageStore {
  constructor(private readonly db: Database) {}

  create(input: { id?: string; taskId: string; direction: TaskMessageDirection; content: string }): TaskMessage {
    const row: TaskMessage = {
      id: input.id ?? randomUUID(), taskId: input.taskId, direction: input.direction, content: input.content,
      status: "pending", discordMessageId: null, failure: null,
      createdAt: Math.floor(Date.now() / 1000), deliveredAt: null,
    };
    drizzle({ client: this.db, schema: { taskMessages } }).insert(taskMessages).values(row).run();
    return row;
  }

  get(id: string): TaskMessage | undefined {
    return drizzle({ client: this.db, schema: { taskMessages } }).select().from(taskMessages).where(eq(taskMessages.id, id)).get();
  }

  findByDiscordMessageId(id: string): TaskMessage | undefined {
    return drizzle({ client: this.db, schema: { taskMessages } }).select().from(taskMessages).where(eq(taskMessages.discordMessageId, id)).get();
  }

  listPendingAgentMessages(): TaskMessage[] {
    return drizzle({ client: this.db, schema: { taskMessages } }).select().from(taskMessages)
      .where(and(eq(taskMessages.status, "pending"), eq(taskMessages.direction, "agent_to_owner")))
      .orderBy(asc(taskMessages.createdAt)).all();
  }

  list(taskId: string): TaskMessage[] {
    return drizzle({ client: this.db, schema: { taskMessages } }).select().from(taskMessages)
      .where(eq(taskMessages.taskId, taskId)).orderBy(asc(taskMessages.createdAt)).all();
  }

  markDelivered(id: string, discordMessageId: string | null = null): void {
    drizzle({ client: this.db, schema: { taskMessages } }).update(taskMessages)
      .set({ status: "delivered", discordMessageId, failure: null, deliveredAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(taskMessages.id, id), eq(taskMessages.status, "pending"))).run();
  }

  markFailed(id: string, failure: string): void {
    drizzle({ client: this.db, schema: { taskMessages } }).update(taskMessages)
      .set({ status: "failed", failure, deliveredAt: null })
      .where(and(eq(taskMessages.id, id), eq(taskMessages.status, "pending"))).run();
  }
}
