-- Indexed by app code after each chat write, never by a trigger, so a broken index can't fail a chat insert.
CREATE VIRTUAL TABLE IF NOT EXISTS `web_chat_fts` USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_web_events_turn` ON `web_events` (json_extract(`data`, '$.turnId')) WHERE `type` IN ('reply','proactive');
