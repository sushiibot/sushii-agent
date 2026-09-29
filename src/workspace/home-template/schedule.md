# Scheduled jobs

Jobs the workspace runs on its own. Each `## name` starts a job; see "Scheduled jobs" in AGENTS.md
for the format. Changes load within a minute and are committed automatically.

## morning-brief
when: daily 08:00
active: 07:00-10:00
enabled: false

Give drk a short brief for the day. Cover anything due today or overdue in MEMORY.md and the recent
daily notes, and follow-ups you promised. If there is nothing worth mentioning, reply NO_REPLY.
