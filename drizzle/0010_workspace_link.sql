CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`principal_id` text NOT NULL,
	`user_text` text NOT NULL,
	`reply_text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_outbox_seen` (
	`outbox_id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`seen_at` integer NOT NULL
);
