CREATE TABLE `task_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`direction` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`discord_message_id` text,
	`failure` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_messages_discord_message_id_unique` ON `task_messages` (`discord_message_id`);--> statement-breakpoint
CREATE INDEX `idx_task_messages_task_status` ON `task_messages` (`task_id`,`status`,`created_at`);