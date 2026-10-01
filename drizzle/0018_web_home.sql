CREATE TABLE `web_alerts` (
	`job` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`alert` text NOT NULL,
	`first_at` text NOT NULL,
	`seq` integer NOT NULL,
	`key` text NOT NULL,
	`dismissed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_web_alerts_state` ON `web_alerts` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `web_dismissed_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `web_opened_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL
);
