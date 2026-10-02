DROP TRIGGER IF EXISTS `web_events_keep_chat`;--> statement-breakpoint
CREATE TRIGGER `web_events_keep_chat` BEFORE DELETE ON `web_events`
WHEN old.type IN ('user','reply','proactive','ask','ask_resolved','approval','approval_resolved','session','alert','turn_final')
BEGIN SELECT RAISE(IGNORE); END;
