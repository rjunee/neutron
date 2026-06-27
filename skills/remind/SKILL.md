---
name: remind
description: |
  Manage the owner's reminders (create, list, snooze, cancel, update, convert-to-task).
  Every reminder is a context-aware, LLM-composed nudge: at fire time the reminder
  dispatcher composes the actual message from the stored instruction, so you store
  WHAT to nudge about (and optionally HOW), not a dumb fixed string.
  ALWAYS use this skill whenever the owner says ANY of these phrases or anything similar:
  CREATE: "remind me", "schedule", "set a reminder", "in N minutes/hours/days",
    "tomorrow at", "next Monday/Tuesday/…", "every day at", "every weekday", "every morning",
    "daily at", "weekly at", "monthly at", "ping me at", "notify me when", "check in with me at",
    "wake me at".
  LIST: "list reminders", "show my reminders", "what reminders do I have".
  CANCEL: "cancel reminder", "delete reminder", "remove the X reminder".
  SNOOZE: "snooze", "snooze the X reminder", "reschedule", "move the X reminder to",
    "push back", "postpone", "delay", "change when".
  UPDATE: "update the X reminder", "change the X reminder to say", "edit the X reminder".
  CONVERT: "turn the X reminder into a task", "make a task out of the X reminder".
  This skill is the ONLY sanctioned mechanism for managing the owner's reminders from
  inside a turn. NEVER improvise with cron, launchd, RemoteTrigger, or by hand-editing
  any reminders store.
license: MIT
compatibility: claude-code
allowed-tools:
  - mcp__neutron__reminders_create
  - mcp__neutron__reminders_list
  - mcp__neutron__reminders_snooze
  - mcp__neutron__reminders_cancel
  - mcp__neutron__reminders_update
  - mcp__neutron__reminders_convert_to_task
---

# Remind — Neutron reminder management

You MUST use this skill for ANY reminder-related request. Never improvise with cron files,
launchd plists, scheduled cloud agents, or by editing a reminders store directly. The
reminder capability is exposed to you as native Neutron MCP tools (the `mcp__neutron__reminders_*`
family); this skill tells you WHEN and HOW to call them.

## How it works

A reminder is a row with a fire time and an instruction. At fire time the Neutron reminder
dispatcher runs a small model that composes the message the owner actually receives from the
stored instruction — so a good reminder stores the INTENT ("nudge me to review the Q3 deck,
mention the open comments") rather than a frozen sentence. A literal string is fine too; the
composer passes it through when there's nothing to compose.

## Actions → tools

| Intent | Tool | Notes |
| --- | --- | --- |
| Create | `mcp__neutron__reminders_create` | Resolve relative times ("in 20 min", "tomorrow 9am") to the owner's timezone BEFORE calling. For recurring ("every weekday 8am"), pass the recurrence the tool's schema accepts. |
| List | `mcp__neutron__reminders_list` | Use first when the owner references "the X reminder" so you can resolve it to an id. |
| Snooze / reschedule | `mcp__neutron__reminders_snooze` | Needs the reminder id (list first). |
| Cancel / delete | `mcp__neutron__reminders_cancel` | Needs the reminder id (list first). Confirm the match before cancelling if ambiguous. |
| Update wording / schedule | `mcp__neutron__reminders_update` | Needs the reminder id. |
| Convert to a task | `mcp__neutron__reminders_convert_to_task` | Turns a reminder into a tracked task. |

## Rules

1. **Resolve time before you call.** Parse "in 20 minutes", "tomorrow at 9", "every weekday at 8am"
   into the concrete fire time / recurrence the tool expects, using the owner's timezone. Do not
   push a raw natural-language time string into the store.
2. **Disambiguate by listing.** Whenever the owner refers to "the X reminder" for snooze / cancel /
   update, call `reminders_list` first, find the matching id, then act on that id.
3. **Store intent, not just text.** Prefer an instruction the fire-time composer can flesh out over
   a frozen sentence — that is what makes the nudge context-aware.
4. **One confirmation.** After acting, tell the owner exactly what you set / changed (the what and
   the when), concisely.
5. **Never** create cron jobs, launchd entries, RemoteTriggers, or scheduled cloud agents for a
   user-facing reminder — those are for infrastructure, not reminders.
