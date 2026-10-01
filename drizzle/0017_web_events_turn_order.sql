CREATE TABLE `web_turn_anchors` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`anchor_seq` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `web_events` ADD `sort_seq` integer;--> statement-breakpoint
CREATE INDEX `idx_web_events_order` ON `web_events` (coalesce(`sort_seq`, `seq`),`seq`);