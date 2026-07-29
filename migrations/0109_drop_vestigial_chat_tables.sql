-- 0109 — drop the vestigial pre-app_chat_messages tables.
--
-- WHY: `messages`, `sessions` and `meters` are dead remnants of the original
-- 0001/0003 schema, superseded by `app_chat_messages` (0079) and its
-- receipt/reaction/edit siblings (0082/0083/0087). They cost a real incident:
-- on 2026-07-27, diagnosing "the mobile app shows no chat history", the
-- orchestrator queried `messages`, found 0 rows, and told Ryan the instance had
-- no messages at all — contradicting a screenshot of the web client full of
-- history. The tenant actually had 38 rows in `app_chat_messages`. A dead table
-- sitting next to the live one, with the more obvious name, is a trap that will
-- catch the next reader too. Ryan: "if there is a vestigial messages table,
-- delete it. what the fuck we just did a huge refactor why is there vestigial
-- crap?"
--
-- VERIFIED DEAD before writing this (all three):
--   * no production reader/writer anywhere in the repo — the only non-doc hits
--     are `migrations/expected-schema.txt` and `migrations/runner.test.ts`
--   * 0 rows in each on the live instance (`messages`, `sessions`, `meters`)
--   * nothing outside this cluster references them; the only foreign keys are
--     INTERNAL to it (`messages.session_id` -> sessions, `meters.session_id` ->
--     sessions, and `sessions.parent_session_id` -> sessions itself)
--
-- DATA NOTE: this is irreversible and drops any rows a long-lived install may
-- still hold. That data is already unreachable — no code path reads these
-- tables — so it is inert, not lost capability. Called out explicitly rather
-- than buried, because a DROP in a shipped product deserves to be a deliberate
-- decision and not a silent one.
--
-- ORDER MATTERS: triggers reference messages_fts; messages/meters reference
-- sessions. Drop dependents first.

DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;

-- Dropping the fts5 virtual table also removes its %_data/%_idx/%_docsize/
-- %_config shadow tables.
DROP TABLE IF EXISTS messages_fts;

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS meters;
DROP TABLE IF EXISTS sessions;
