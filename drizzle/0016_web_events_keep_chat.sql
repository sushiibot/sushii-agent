-- Chat rows outlive any code that prunes web_events; an intentional erase must drop or bypass this trigger.
CREATE TRIGGER IF NOT EXISTS `web_events_keep_chat` BEFORE DELETE ON `web_events`
WHEN old.type IN ('user','reply','proactive','ask','ask_resolved','approval','approval_resolved','session')
BEGIN SELECT RAISE(IGNORE); END;
