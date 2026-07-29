-- 0018_p2_sean_ellis.sql
--
-- P2 S6 — sean_ellis_responses table.
--
-- Per docs/plans/P2-onboarding.md § 5.3 (Sean Ellis 4-week trigger) +
-- § 9.4 (Casey-specific qualitative loop) + § 6 S6 line 2202.
--
-- One row per fired Sean Ellis prompt. The trigger cron (registered as
-- `onboarding.sean_ellis_survey_<project_slug>`) fires 4 weeks after
-- `onboarding.completed_at` and writes a row with `response_kind =
-- 'no_response'` while the prompt is open. When the user taps a button
-- (or sends freeform after [B]), the row updates with the chosen
-- response_kind + responded_at + freeform_text.
--
-- response_kind enum carries the canonical PMF question shape per
-- master-plan §2 Phase 3:
--   'very_disappointed'      — [A] target ≥ 40% on the cohort
--   'somewhat_disappointed'  — [B]
--   'not_disappointed'       — [C]
--   'no_response'            — open prompt, user has not yet tapped
--
-- Forward-only. STRICT typing.

CREATE TABLE IF NOT EXISTS sean_ellis_responses (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prompt_emitted_at INTEGER NOT NULL,                  -- unix-ms when the survey button-prompt was rendered
    responded_at INTEGER,                                -- nullable until tapped / freeform completed
    response_kind TEXT NOT NULL DEFAULT 'no_response'
        CHECK (response_kind IN (
            'very_disappointed',
            'somewhat_disappointed',
            'not_disappointed',
            'no_response'
        )),
    freeform_text TEXT                                   -- only set when [B] tap path collected freeform
) STRICT;

CREATE INDEX IF NOT EXISTS sean_ellis_responses_project
    ON sean_ellis_responses (project_slug, prompt_emitted_at);

CREATE INDEX IF NOT EXISTS sean_ellis_responses_open
    ON sean_ellis_responses (project_slug)
    WHERE response_kind = 'no_response';
