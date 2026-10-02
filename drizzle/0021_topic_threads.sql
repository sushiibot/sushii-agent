ALTER TABLE web_events ADD conversation_id text NOT NULL DEFAULT 'main';
--> statement-breakpoint
DROP INDEX uq_web_events_type_key;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_web_events_type_key ON web_events (conversation_id, type, key);
--> statement-breakpoint
CREATE INDEX idx_web_events_conversation_order ON web_events (conversation_id, coalesce(sort_seq, seq), seq);
--> statement-breakpoint
ALTER TABLE web_inbound ADD conversation_id text NOT NULL DEFAULT 'main';
--> statement-breakpoint
CREATE TABLE web_threads (id text PRIMARY KEY NOT NULL, title text NOT NULL, brief text NOT NULL, created_at integer NOT NULL, archived_at integer, archived_by text, report text, report_delivered integer NOT NULL DEFAULT 0);
