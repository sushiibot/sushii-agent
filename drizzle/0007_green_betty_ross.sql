CREATE TABLE `wiki_sync_source_state` (
	`wiki_id` text NOT NULL,
	`surface` text NOT NULL,
	`space_id` text NOT NULL,
	`last_processed_at` integer NOT NULL,
	PRIMARY KEY(`wiki_id`, `surface`, `space_id`)
);
--> statement-breakpoint
INSERT INTO wiki_sync_source_state (wiki_id, surface, space_id, last_processed_at) SELECT guild_id, 'discord', guild_id, last_processed_at FROM wiki_sync_state;
--> statement-breakpoint
DROP TABLE wiki_sync_state;
