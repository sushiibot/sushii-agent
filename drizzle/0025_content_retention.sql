CREATE INDEX idx_conversations_created_at ON conversations (created_at);
--> statement-breakpoint
CREATE INDEX idx_screening_created_at ON screening_verdicts (created_at);
--> statement-breakpoint
CREATE INDEX idx_pending_questions_created_at ON pending_questions (created_at);
--> statement-breakpoint
-- Requires SQLite >= 3.42. Stop retaining deleted message terms in FTS segments.
INSERT INTO messages_fts(messages_fts, rank) VALUES('secure-delete', 1);
--> statement-breakpoint
-- Rebuild once to discard old deletion tombstones from pre-retention versions.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
