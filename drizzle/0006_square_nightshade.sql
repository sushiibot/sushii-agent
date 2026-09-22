CREATE TABLE `slack_messages` (
	`channel` text NOT NULL,
	`ts` text NOT NULL,
	`thread_ts` text,
	`user` text,
	`bot_id` text,
	`subtype` text,
	`text` text DEFAULT '' NOT NULL,
	`blocks` text,
	`files` text,
	`team` text,
	`edited_ts` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`raw_json` text NOT NULL,
	`ingested_at` integer NOT NULL,
	PRIMARY KEY(`channel`, `ts`)
);
--> statement-breakpoint
CREATE INDEX `idx_slack_messages_channel_created` ON `slack_messages` (`channel`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_slack_messages_thread` ON `slack_messages` (`thread_ts`);--> statement-breakpoint
CREATE TABLE `slack_sync_state` (
	`channel` text PRIMARY KEY NOT NULL,
	`oldest_backfilled` text,
	`latest_seen` text,
	`updated_at` integer NOT NULL
);
