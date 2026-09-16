import { eq, lt } from "drizzle-orm";
import { getOrm } from "./index.ts";
import { pendingQuestions } from "./schema.ts";

export interface PendingQuestionRecord {
  threadId: string;
  question: string;
  choices: string[];
  triggeredByUserId: string;
  createdAt: number;
}

function rowToRecord(row: typeof pendingQuestions.$inferSelect): PendingQuestionRecord {
  return {
    threadId: row.threadId,
    question: row.question,
    choices: JSON.parse(row.choices) as string[],
    triggeredByUserId: row.triggeredByUserId,
    createdAt: row.createdAt,
  };
}

export function savePendingQuestion(record: PendingQuestionRecord): void {
  const orm = getOrm();
  const values = {
    threadId: record.threadId,
    question: record.question,
    choices: JSON.stringify(record.choices),
    triggeredByUserId: record.triggeredByUserId,
    createdAt: record.createdAt,
  };
  orm
    .insert(pendingQuestions)
    .values(values)
    .onConflictDoUpdate({ target: pendingQuestions.threadId, set: values })
    .run();
}

export function loadPendingQuestion(threadId: string): PendingQuestionRecord | null {
  const orm = getOrm();
  const row = orm.select().from(pendingQuestions).where(eq(pendingQuestions.threadId, threadId)).get();
  return row ? rowToRecord(row) : null;
}

export function deletePendingQuestion(threadId: string): void {
  const orm = getOrm();
  orm.delete(pendingQuestions).where(eq(pendingQuestions.threadId, threadId)).run();
}

export function loadAllPendingQuestions(): PendingQuestionRecord[] {
  const orm = getOrm();
  return orm.select().from(pendingQuestions).all().map(rowToRecord);
}

export function deleteStalePendingQuestions(maxAgeMs: number): void {
  const orm = getOrm();
  const cutoff = Date.now() - maxAgeMs;
  orm.delete(pendingQuestions).where(lt(pendingQuestions.createdAt, cutoff)).run();
}
