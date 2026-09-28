CREATE TABLE `screening_verdicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`scores` text,
	`categories` text,
	`top_rule` text,
	`flagged` integer DEFAULT 0 NOT NULL,
	`avatar_hash` text,
	`image_key` text,
	`source_url` text,
	`joined_at` integer,
	`ordinal` integer,
	`model` text,
	`cost` real,
	`judged` text,
	`error` text,
	`post_channel_id` text,
	`post_message_id` text,
	`outcome` text,
	`outcome_by` text,
	`outcome_action` text,
	`outcome_at` integer,
	`message_deleted` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_screening_guild_user` ON `screening_verdicts` (`guild_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_screening_pfp` ON `screening_verdicts` (`user_id`,`avatar_hash`);--> statement-breakpoint
CREATE INDEX `idx_screening_image` ON `screening_verdicts` (`image_key`);--> statement-breakpoint
CREATE INDEX `idx_screening_message` ON `screening_verdicts` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_screening_post` ON `screening_verdicts` (`post_message_id`);