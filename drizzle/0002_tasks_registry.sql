CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`runner_id` text NOT NULL,
	`project` text,
	`native_session_id` text,
	`resume_cursor` text,
	`status` text NOT NULL,
	`status_reason` text,
	`summary` text,
	`spawned_from_surface` text NOT NULL,
	`thread_refs` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_created_by` ON `tasks` (`created_by`);