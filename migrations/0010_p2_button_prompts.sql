-- 0010_p2_button_prompts.sql
--
-- P2 S1 — `button_prompts` table.
--
-- Per docs/plans/P2-onboarding.md § 2.1 (button primitive contract) + § 4.2
-- (ButtonStore DB shape). One row per outbound button prompt the agent emits;
-- the channel layer writes on emit + reads on inbound callback for routing.
--
-- The table is split out from the monolithic `0009_p2_onboarding.sql` named
-- in the Pass-1 plan because the Pass-2 deepening (§ 6 S1 line 1879) called
-- for incremental migration safety: P2's later sprints add `onboarding_state`
-- + `onboarding_transcripts_meta` (S2) and `import_jobs` (S3) on their own
-- migration numbers. This migration is forward-only and idempotent on
-- re-run; no connection-level setup statements run.
--
-- Columns:
--   * prompt_id    — 16-byte UUID (rendered as 36-char canonical), PK.
--   * topic_id     — channel-agnostic topic this prompt was emitted into
--                     (channels/router.ts:Topic.topic_id). NOT FK in STRICT
--                     because `topics` lives in another module's table; the
--                     ButtonStore enforces referential integrity in code.
--   * body         — Markdown body shown above the buttons.
--   * options_json — canonical JSON of the `ButtonOption[]` array.
--   * allow_freeform — 0|1; whether a freeform reply resolves the prompt.
--   * expires_at   — wall-clock unix-ms after which sweepExpired auto-resolves.
--   * idempotency_key — caller-provided dedup key; UNIQUE (topic_id,
--                       idempotency_key) covers the "agent emits twice"
--                       race (§ 4.2 emit semantics). NULL when the agent
--                       elected no idempotency.
--   * created_at, resolved_at, resolution_value, resolution_freeform_text
--                   — populated lazily on resolve.

CREATE TABLE IF NOT EXISTS button_prompts (
    prompt_id TEXT PRIMARY KEY NOT NULL,
    topic_id TEXT NOT NULL,
    body TEXT NOT NULL,
    options_json TEXT NOT NULL,
    allow_freeform INTEGER NOT NULL CHECK (allow_freeform IN (0, 1)),
    expires_at INTEGER NOT NULL,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    resolved_at INTEGER,
    resolution_value TEXT,
    resolution_freeform_text TEXT,
    resolution_speaker_user_id TEXT,
    resolution_channel_kind TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS button_prompts_idempotency
    ON button_prompts (topic_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS button_prompts_topic_active
    ON button_prompts (topic_id, resolved_at);

CREATE INDEX IF NOT EXISTS button_prompts_expires
    ON button_prompts (expires_at)
    WHERE resolved_at IS NULL;
