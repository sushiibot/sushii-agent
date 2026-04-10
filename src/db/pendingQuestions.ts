import { getDb } from "./index.ts";

export interface PendingQuestionRecord {
  threadId: string;
  question: string;
  choices: string[];
  triggeredByUserId: string;
  createdAt: number;
}

interface PendingQuestionRow {
  thread_id: string;
  question: string;
  choices: string;
  triggered_by_user_id: string;
  created_at: number;
}

function rowToRecord(row: PendingQuestionRow): PendingQuestionRecord {
  return {
    threadId: row.thread_id,
    question: row.question,
    choices: JSON.parse(row.choices) as string[],
    triggeredByUserId: row.triggered_by_user_id,
    createdAt: row.created_at,
  };
}

export function savePendingQuestion(record: PendingQuestionRecord): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO pending_questions (thread_id, question, choices, triggered_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [record.threadId, record.question, JSON.stringify(record.choices), record.triggeredByUserId, record.createdAt],
  );
}

export function loadPendingQuestion(threadId: string): PendingQuestionRecord | null {
  const db = getDb();
  const row = db
    .query<PendingQuestionRow, [string]>(
      "SELECT * FROM pending_questions WHERE thread_id = ?",
    )
    .get(threadId);

  return row ? rowToRecord(row) : null;
}

export function deletePendingQuestion(threadId: string): void {
  const db = getDb();
  db.run("DELETE FROM pending_questions WHERE thread_id = ?", [threadId]);
}

export function loadAllPendingQuestions(): PendingQuestionRecord[] {
  const db = getDb();
  const rows = db
    .query<PendingQuestionRow, []>("SELECT * FROM pending_questions")
    .all();

  return rows.map(rowToRecord);
}

export function deleteStalePendingQuestions(maxAgeMs: number): void {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  db.run("DELETE FROM pending_questions WHERE created_at < ?", [cutoff]);
}
