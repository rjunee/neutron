# IMPLEMENTATION_PLAN — Reminder fires must land on the topic that owns them, and never post raw intent (Plan card 2026-08-15)

Governing spec: this Plan card. Measured against main 2026-08-15; branch `trident/agent-replies-never-reach-the-proje` (single commit 62bc294, based on main @ ee0a7ff) carries the completed build.

- Defect A root cause CONFIRMED in code: `open/composer.ts` `resolveAppWsReminderTopic` discarded `explicit_topic` and returned the bare `app:<owner>` topic for EVERY fire. Fixed by T1. Forward fix only — the 24 misrouted rows are untouched.
- Defect B root cause CONFIRMED in code: `reminders/dispatcher.ts` `compose()` fell back to `literalFallback(shape)` = `row.message` verbatim on ANY compose failure, with no length bound anywhere. Fixed by T2.
- [x] Session-reply routing needs NO code change (spec correction 2026-08-15T17:22Z: measured session replies at 16:43/17:21 landed on the correct project topic). Only the regression PIN test was missing (T3). Do NOT touch the reply path.
- [x] Acceptance 5 (leave the 24 misrouted rows alone) — satisfied by construction: every task is forward-only; no migration, no history rewrite.

- [x] **T1 — Defect A: a reminder fire resolves to the topic the work belongs to.** `open/wiring/reminder-topic.ts` (`buildAppWsReminderTopicResolver`) wired at the composer's dispatcher seam; project reminder → `app:<owner>:<project>`; no project → `app:<owner>`; unknown destination → `app:<owner>` (never an unread topic). All `resolveAppWsReminderTopic(null)` call sites (ritual approval, executor post, briefs) stay on General. Unit + live-delivery integration tests green on the branch.
- [x] **T2 — Defect B: a compose failure never posts the raw intent; an over-bound "nudge" is refused.** `MAX_NUDGE_BODY_CHARS = 2000` bounds a COMPOSED body (acceptance 4); `MAX_DEGRADED_INTENT_CHARS = 300` bounds how much STORED INTENT may post verbatim when nothing rendered it; over-bound fallback posts a fixed generic line naming the reminder id with ZERO bytes of `row.message`, and logs. Short literals still degrade byte-identically. Pinned in `reminders/message-shape.test.ts` + `reminders/dispatcher.test.ts`.
- [x] **T3 — Acceptance 2 pin: a session reply lands in the topic whose message triggered the turn.** Integration test `open/__tests__/open-project-session-reply-topic.test.ts` drives a turn from a project topic and reads back `app_chat_messages.topic_id = 'app:owner:<id>'`. No product change.

Round-2 (Argus round-1 findings) — all addressed on the branch:

- [x] BLOCKER, CodeQL `js/polynomial-redos` on `reminders/message-shape.ts` — `ORIGINAL_REMINDER_RE` replaced by a forward `indexOf` scan with identical semantics, pinned by four tests including the 60k-space pathological input.
- [x] MAJOR (A+B) — acceptance 3 gap: intents ≤ 2000 chars could post verbatim on compose failure. Split into the two constants above; pinned at both sizes.
- [x] MAJOR (A+C) — `web:` branch never validated the user segment (`web:someoneelse:neutron-open` resolved to the owner's project topic). Both branches validate the user; foreign-user and malformed-boundary tests added.
- [x] MAJOR (A+B) — silent downgrades to General + fail-open project lister. Resolver takes an `onDowngrade` reporter (four reasons) wired to `log.warn('reminder_topic_downgraded_to_general')`; composer supplies a dedicated `listProjectIds` (one indexed SELECT) that does NOT swallow read errors.
- [x] MAJOR (B) — fired project reminder was invisible unless the owner sat inside the project: deliver seam now derives the project id off the `app:<owner>:<project>` topic so `buildAppWsSendReplyResult` stamps `last_activity_at` + re-fans `projects_changed`. Asserted in the live-delivery integration test.
- [x] MAJOR (B) — `reminders_create` discarded `ToolCallContext`; it now defaults `project_id` to the calling topic's project (explicit `project_id` honoured verbatim). Four tests in `cores/free/reminders/__tests__/tools.test.ts`.
- [x] MAJOR (A) — `docs/AS_BUILT.md`, `docs/SYSTEM-OVERVIEW.md`, `docs/INVARIANTS.md` #41/#41b updated to the post-fix behaviour and bounds.
- [x] MINOR (A+B) — refusal line names the reminder id (`overBoundNudgeBody`); still zero bytes of the stored message.
- [x] MINOR (A+B) — `open/__tests__/open-app-ws-durable-chatlog.test.ts` scrubs `NEUTRON_IDENTITY_JWKS_URL` / `_AUDIENCE`.
- [x] NIT (A) — live-delivery test re-stamps the RAW project id; `app-project:` shape covered in the unit table.
- [x] NIT (B) — a throwing `listProjectIds` (or reporter) is caught, reported `project_list_unavailable`, degraded to General — it can no longer make the dispatcher re-fire forever.
- [x] NIT (B) — decided NOT CHANGED: the `[ROUTING] target_thread:` header can steer a fire's topic. Deliberate: documented legacy-harness feature, can only select one of THIS owner's EXISTING projects (foreign/unknown downgrades to General and is logged), and the owner authors the reminders. Surfaced here rather than silently removed.
- [x] NIT (B) — decided NOT CHANGED: the T3 pin's negative assertion stays a fixed `sleep(800)` — the absence of a write has no positive signal to await; scope is one exact topic string on a fresh per-test DB.

Round-3 (main moved) — the one open task:

- [x] **T4 — Rebase the branch onto current main (4eb3adc, which landed the overlapping push build #297) and verify the semantic merge.** One textual conflict in `open/composer.ts` (additive both-sides hunk above `createDeliver` — keep BOTH: main's NATIVE PUSH block, then the branch's `appWsProjectIdOfTopic` helper). Verify `reminders/dispatcher.ts` / `reminders/index.ts` / test files auto-merge preserves both #297's push relocation and this card's compose bounds; run the touched suites green; leave the branch conflict-free against origin/main so publish can proceed.

Notes / guard rails:
- Do NOT touch the session-reply path (measured working — spec correction 2026-08-15T17:22Z).
- Do NOT migrate or rewrite the 24 misrouted rows (acceptance 5).
- A destination naming no EXISTING project must keep falling back to General (the #105 lesson — a durable row under a topic no client binds is a message that vanishes).
- Recovery note (unchanged, restored per Argus): `trident/derive-inline-activity-from-evidenc` needs a PUBLISH, not a rebuild. Never reset, force past, or gc it. Nothing in this diff touches that branch.
