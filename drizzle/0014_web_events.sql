CREATE TABLE `web_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`key` text,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_web_events_type_key` ON `web_events` (`type`,`key`);--> statement-breakpoint
CREATE INDEX `idx_web_events_created` ON `web_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `web_inbound` (
	`client_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`upload_ids` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	`routed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_web_inbound_created` ON `web_inbound` (`created_at`);