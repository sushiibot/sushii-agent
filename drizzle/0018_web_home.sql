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
);--> statement-breakpoint
-- Job alerts are chat too; 0016's IF NOT EXISTS would keep the old list, so the trigger is replaced.
DROP TRIGGER IF EXISTS `web_events_keep_chat`;--> statement-breakpoint
CREATE TRIGGER `web_events_keep_chat` BEFORE DELETE ON `web_events`
WHEN old.type IN ('user','reply','proactive','ask','ask_resolved','approval','approval_resolved','session','alert')
BEGIN SELECT RAISE(IGNORE); END;
