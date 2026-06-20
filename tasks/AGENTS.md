# AGENTS.md — tasks

This module owns the canonical per-project task DB. STATUS.md and ACTIONS.md become auto-generated read-only projections from the DB per locked `docs/engineering-plan.md § B.P6`. Schema lives in migrations `0032_tasks_canonical.sql` + `0037_tasks_focus_score_and_reminder_links.sql`; CRUD lives in `store.ts` (`TaskStore`).

## P6.0 (substrate base, shipped)

- `tasks` table in project.db (migration 0032) — `(id, project_slug, project_id, title, description, status, priority, due_date, owner_persona, source, created_at, updated_at, completed_at)`.
- Indexes: `(project_slug, project_id, status)` for project-tab reads, `(project_slug, due_date)` partial for "due soon" rollups.
- `TaskStore` with `create / list / get / update / complete / cancel / delete`.
- Project-scoped tasks primary; `project_id=''` is the canonical "no project" sentinel (`NO_PROJECT`).
- Status enum: `'open' | 'done' | 'cancelled'`.

## P6 (this sprint, landed) — projection + integrations

- **`focus-score.ts`** — pure-function deterministic Nova-equivalent score over `(priority, due_date, updated_at, now)`. Module API: `computeFocusScore`, `priorityToFocusScale`, `FOCUS_SCORE_VERSION`.
- **`focus-score-cron.ts`** — per-instance 4-hourly recompute cron (`tasks.focus_score_recompute`). Mirrors the Sean Ellis trigger registration shape: `registerFocusScoreRecomputeCron({project_slug, jobs, handlers, handler})`. Also exports `recomputeFocusScoresForProject` for ad-hoc / test invocation.
- **`store.ts` extensions** — `focus_score` + `focus_score_updated_at` columns on `Task`; synchronous stamp on every `create` / score-affecting `update`; `subscribe(listener)` surface emits `TaskMutationEvent`s for projection + reminder-link subscribers; `delete` event fires BEFORE the SQL DELETE so subscribers can sweep linked state before FK CASCADE.
- **`reminder-link.ts`** — auto-create / cascade-cancel / reschedule a `reminders` row + `task_reminder_links` join row whenever a task has a `due_date`. Composition wires `attachReminderLinkSubscriber({store, ctx})` once per instance; production opts in via `CompositionInput.tasks.enable_reminder_link`.
- **`projection/`** — atomic + debounced writer for `<OWNER_HOME>/Projects/<id>/STATUS.md` (marked-block rewrite) + `ACTIONS.md` (whole-file). 500ms coalesce per `(instance, project)`. `parse.ts` / `format.ts` are pure; `write.ts` does the I/O. Subscribes to `TaskStore` mutation events.
- **`history-import-seeder.ts`** — post-onboarding hook that turns `ImportResult.proposed_tasks` into canonical task rows with `source='history-import'`. Idempotent via a deterministic `(project_slug, project_id, title)` hash; the seed id collides on re-run so duplicates are skipped.
- **`overnight-task-hook.ts`** — `createOvernightReviewTask({event, store})` and `attachOvernightWorkCompletedHook({store})`. Composition wires the latter as a subscriber the overnight dispatcher (current and future) can call to land a `source='overnight'` review task per completed item. Idempotent via a minute-bucketed `(instance, project, item_title)` hash.
- **HTTP surface additive extensions** — `/api/app/projects/<id>/tasks?order=focus_score` and `/api/app/focus?order=focus_score`. Default order unchanged (P5.4 / P5.5 clients keep working byte-identically).
- **Source canonicalization** — exports `TASK_SOURCE_APP | TASK_SOURCE_TASKS_CORE | TASK_SOURCE_REMINDER | TASK_SOURCE_OVERNIGHT | TASK_SOURCE_HISTORY_IMPORT | TASK_SOURCE_CHAT`. Every internal write site stamps one of these; the HTTP surface defaults to `'app'`.
- **Reminders Core convert-to-task tool** — `reminders_convert_to_task` MCP tool registered by `@neutron/reminders-core`. The tool calls `TaskStore.create({...; due_date: reminderToIso(reminder.fire_at)})` which goes through the link-creation path; the original reminder is cancelled so it doesn't fire twice.

## Still deferred (P6.x follow-ups, not in this sprint)

- LLM-driven daily nudge engine ("pick one most important thing" daily LLM pass) — needs prompt engineering + Haiku-vs-Sonnet calibration + sycophancy bar. The deterministic `focus_score` this sprint lands gives the nudge engine a starting signal.
- Staleness engine (skip-counting + demotion) — needs activity-tracking schema beyond `updated_at`.
- Task-styles per-user UI preference (`one-focus` / `priority-ordered` / `by-project` / `urgent-important` / custom) — depends on the P5.7 Settings tab landing.
- Subtasks / dependencies / tags / `archived` / `snoozed` (minimal-viable schema first).
- Recurring tasks (distinct from recurring reminders — those already exist in `reminders/`).
- Multi-user task assignment (deferred to Phase 2 — shared projects / collaborators).
- Owner-zero migration (parse Sam's existing STATUS.md / SAM-ACTIONS.md / project-local TODOs into the canonical store) — one-time migration sprint.

This module must NOT be the source of truth for STATUS.md narrative (the DB owns the projection block; narrative outside the marked block stays user-owned) or duplicate reminder state (`reminders/` owns reminders).

Cross-refs: `docs/engineering-plan.md § B.P6`, `docs/plans/P6-task-system-overhaul-sprint-brief.md`, `SPEC.md § Phases→Steps`, STATUS.md decisions log entries from 2026-04-25 (per-project tabs + Focus view).
