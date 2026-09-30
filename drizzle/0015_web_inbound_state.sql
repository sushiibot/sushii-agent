ALTER TABLE `web_inbound` ADD `state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE `web_inbound` SET `state` = 'routed' WHERE `routed_at` IS NOT NULL;