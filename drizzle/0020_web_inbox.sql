CREATE TABLE `web_inbox` (
	`key` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`run_id` text,
	`text` text NOT NULL,
	`at` integer NOT NULL,
	`read_at` integer,
	`done_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_web_inbox_done` ON `web_inbox` (`done_at`,`at`);