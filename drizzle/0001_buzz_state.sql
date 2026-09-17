-- Additive: poll cursor for the buzz surface (U6). New table only — no data recreation, safe on
-- both fresh DBs and existing prod DBs.
CREATE TABLE IF NOT EXISTS `buzz_state` (
	`id` text PRIMARY KEY,
	`last_cursor` integer NOT NULL
);
