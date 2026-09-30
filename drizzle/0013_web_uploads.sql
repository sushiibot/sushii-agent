CREATE TABLE `web_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`content_type` text NOT NULL,
	`inline` integer NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`client_key` text,
	`outbox_id` text,
	`message_client_id` text,
	`created_at` integer NOT NULL,
	`referenced_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_uploads_client_key_unique` ON `web_uploads` (`client_key`);--> statement-breakpoint
CREATE INDEX `idx_web_uploads_direction_created` ON `web_uploads` (`direction`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_web_uploads_outbox` ON `web_uploads` (`outbox_id`);