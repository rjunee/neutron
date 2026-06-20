# AGENTS.md — reminders

This module owns the reminder engine: the `prompts/reminder-agent-base.md` grammar plus the three locked message shapes (literal, smart-wrap, pattern-template). State is scoped per instance via `project.db` (or `state/reminders/` JSONL files with the OpenClaw session-write-lock pattern — P1 detail; P0 schema is silent). Implementation lands in P1.

It must NOT be the cron scheduler (`cron/` owns timer/service emission), duplicate task tracking (tasks live in `tasks/`), or call directly into Telegram (channel binding goes through `gateway/`). Fire-time messages are composed by the reminder agent (Haiku-class model) at fire time, not pre-rendered.

Cross-refs: `docs/engineering-plan.md § B.P1`, Nova's `prompts/reminder-agent-base.md` (lift target).
