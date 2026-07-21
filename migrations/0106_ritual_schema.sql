-- 0106_ritual_schema.sql
--
-- Executor-mode reminders — the RITUAL layer (P0-1 M2 parity, plan task 2;
-- spec of record `docs/plans/executor-mode-reminders-2026-07-20.md`).
--
-- A ritual is a reminder that, instead of composing a one-shot nudge, SPAWNS a
-- scoped sub-agent REPL at fire time (a "morning brief" that actually reads
-- STATUS.md + calendar, an "evening wrap" that writes a delta note, …). This
-- migration lands the persistent half of that layer in three forward-only DDL
-- units:
--
--   (1a) `reminders.ritual_id` — the OPT-IN tag that marks a reminder row as a
--        ritual dispatch instead of a plain nudge. Nullable, no default, no
--        CHECK — the SAME opaque-TEXT rationale as 0095's `recurrence_spec`: the
--        in-process ritual REGISTRY (`reminders/rituals.ts`) is the authoritative
--        validator of which ids are live, and a CHECK here would force a full
--        `reminders` table rebuild every time a ritual is added or removed. To
--        SQLite the column is opaque TEXT; the registry owns validity.
--
--   (1b) `code_ritual_runs` — durable RUN HISTORY. This is deliberately NOT the
--        same shape as the subagent registry (`code_subagent_registry`, 0100):
--        that table is a LIVENESS projection whose rows are DELETED on prune
--        (`runtime/subagent/store.ts` remove()), so it cannot answer "why did my
--        morning brief not run yesterday" once the live record is gone. This
--        table is the durable answer — one row per fire ATTEMPT (including
--        skips), retained on its own 30-day window (`reminders/ritual-runs.ts`
--        RITUAL_RUN_RETENTION_MS), never deleted on liveness prune. Its status
--        vocabulary is RICHER than the registry's on purpose: 'finished' /
--        'failed' / 'timed_out' distinguish outcomes the registry's single
--        'crashed'/'finished' cannot, and 'skipped' + its `skip_reason` capture
--        the fail-CLOSED validation verdicts (unknown ritual / missing prompt /
--        unapproved) that never spawn at all. The invariant CHECK forces every
--        'skipped' row to carry exactly one reason and every non-skipped row to
--        carry none.
--
--   (1c) Widen `code_subagent_registry.agent_kind` to admit 'ritual'. SQLite
--        cannot ALTER a CHECK constraint, so this is the standard
--        create-copy-drop-rename table rebuild: the FULL 0100 DDL is reproduced
--        as `code_subagent_registry_new` with ONLY the agent_kind enum line
--        changed, rows copied by EXPLICIT column list, the old table dropped, the
--        new one renamed into place, and BOTH indexes recreated. VERIFIED SAFE:
--        no other migration, FK, trigger, or view references
--        `code_subagent_registry` (grep-clean), so the rebuild is self-contained.
--        Everything else — STRICT, all CHECKs, NOT NULLs, boot_id — is preserved
--        byte-for-byte; the ONLY semantic change is the enum widening.
--
-- SNAPSHOT REGEN REQUIRED: units (1a) and (1c) change the `reminders` and
-- `code_subagent_registry` table shapes and (1b) adds a table, so
-- `migrations/expected-schema.txt` MUST be regenerated
-- (`bun run migrations/regen-snapshot.ts`) and committed alongside this file or
-- `migrations/snapshot.test.ts` will fail with schema drift.
--
-- Verification (post-migration, per-project DB):
--   table_info(reminders) shows ritual_id TEXT (nullable, no default).
--   code_ritual_runs exists; INSERT of status='ritual-run' rows round-trips.
--   INSERT into code_subagent_registry with agent_kind='ritual' SUCCEEDS;
--     an unknown kind is REJECTED (CHECK intact); both 0100 indexes exist.
--
-- Forward-only; no down-migration (Neutron OSS contract).

-- (1a) Ritual tag on reminders — opaque TEXT, registry-validated (precedent 0095).
ALTER TABLE reminders ADD COLUMN ritual_id TEXT;

-- (1b) Durable ritual run history (own retention; NOT pruned on liveness).
CREATE TABLE IF NOT EXISTS code_ritual_runs (
    run_id         TEXT PRIMARY KEY NOT NULL,
    ritual_id      TEXT NOT NULL,
    reminder_id    TEXT,
    instance_key   TEXT NOT NULL,
    project_id     TEXT,
    status         TEXT NOT NULL
                       CHECK (status IN ('spawned','finished','failed','timed_out','crashed','skipped')),
    skip_reason    TEXT
                       CHECK (skip_reason IS NULL OR skip_reason IN ('unknown_ritual','missing_prompt','unapproved')),
    started_at     INTEGER NOT NULL,               -- epoch ms
    ended_at       INTEGER,                         -- epoch ms
    output_summary TEXT,
    -- Every 'skipped' row carries a reason; every non-skipped row carries none.
    CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_code_ritual_runs_ritual
    ON code_ritual_runs (ritual_id, started_at DESC);

-- (1c) Widen agent_kind to admit 'ritual' — create-copy-drop-rename (SQLite
-- cannot ALTER a CHECK). The new table is the 0100 DDL VERBATIM with ONLY the
-- agent_kind enum line changed; every other column, CHECK, NOT NULL and STRICT
-- is preserved.
CREATE TABLE code_subagent_registry_new (
    run_id              TEXT PRIMARY KEY NOT NULL,
    instance_key        TEXT NOT NULL,
    agent_kind          TEXT NOT NULL
                            CHECK (agent_kind IN (
                                'forge', 'atlas', 'sentinel', 'argus', 'core', 'ritual'
                            )),
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'pending', 'running', 'finished', 'crashed', 'cancelled'
                            )),
    spawn_depth         INTEGER NOT NULL DEFAULT 0,
    parent_run_id       TEXT,
    parent_session_id   TEXT,
    child_session_id    TEXT,
    pid                 INTEGER,
    pid_starttime       INTEGER,
    started_at          INTEGER NOT NULL,               -- epoch ms
    ended_at            INTEGER,                         -- epoch ms
    last_event_at       INTEGER NOT NULL,               -- epoch ms
    cleanup_after       INTEGER,                         -- epoch ms
    delivery_target     TEXT,                            -- JSON {channel, binding_id}
    delegation_claims   TEXT,                            -- JSON {instance, depth, scope, jti}
    spawn_key           TEXT,
    failure_reason      TEXT
                            CHECK (failure_reason IS NULL OR failure_reason IN (
                                'process_dead', 'stuck'
                            )),
    boot_id             TEXT NOT NULL
) STRICT;

INSERT INTO code_subagent_registry_new (
    run_id, instance_key, agent_kind, status, spawn_depth, parent_run_id,
    parent_session_id, child_session_id, pid, pid_starttime, started_at,
    ended_at, last_event_at, cleanup_after, delivery_target, delegation_claims,
    spawn_key, failure_reason, boot_id)
  SELECT run_id, instance_key, agent_kind, status, spawn_depth, parent_run_id,
    parent_session_id, child_session_id, pid, pid_starttime, started_at,
    ended_at, last_event_at, cleanup_after, delivery_target, delegation_claims,
    spawn_key, failure_reason, boot_id FROM code_subagent_registry;

DROP TABLE code_subagent_registry;
ALTER TABLE code_subagent_registry_new RENAME TO code_subagent_registry;

-- Recreate BOTH 0100 indexes verbatim.
CREATE INDEX IF NOT EXISTS idx_code_subagent_registry_live
    ON code_subagent_registry (status)
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_code_subagent_registry_owner
    ON code_subagent_registry (instance_key);
