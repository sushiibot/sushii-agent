CREATE TABLE `runner_routing` (
	`principal` text NOT NULL,
	`project_key` text NOT NULL,
	`runner_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`principal`, `project_key`)
);
