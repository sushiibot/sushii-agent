-- Full-text index over the chat text the bot keeps forever. Imported rows (seq <= 0) are indexed too.
CREATE VIEW IF NOT EXISTS `web_chat_text` AS SELECT `seq`, json_extract(`data`, '$.text') AS `text` FROM `web_events` WHERE `type` IN ('user','reply','proactive');
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `web_chat_fts` USING fts5(text, content='web_chat_text', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `web_chat_fts_ai` AFTER INSERT ON `web_events` WHEN new.type IN ('user','reply','proactive') BEGIN
	INSERT INTO `web_chat_fts`(rowid, text) VALUES (new.seq, json_extract(new.data, '$.text'));
END;
--> statement-breakpoint
-- AFTER, not BEFORE: web_events_keep_chat ignores a delete of a chat row, and then this never fires.
CREATE TRIGGER IF NOT EXISTS `web_chat_fts_ad` AFTER DELETE ON `web_events` WHEN old.type IN ('user','reply','proactive') BEGIN
	INSERT INTO `web_chat_fts`(`web_chat_fts`, rowid, text) VALUES ('delete', old.seq, json_extract(old.data, '$.text'));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `web_chat_fts_au` AFTER UPDATE ON `web_events` WHEN old.type IN ('user','reply','proactive') OR new.type IN ('user','reply','proactive') BEGIN
	INSERT INTO `web_chat_fts`(`web_chat_fts`, rowid, text) SELECT 'delete', old.seq, json_extract(old.data, '$.text') WHERE old.type IN ('user','reply','proactive');
	INSERT INTO `web_chat_fts`(rowid, text) SELECT new.seq, json_extract(new.data, '$.text') WHERE new.type IN ('user','reply','proactive');
END;
--> statement-breakpoint
INSERT INTO `web_chat_fts`(`web_chat_fts`) VALUES ('rebuild');
