-- 0106_ritual_schema.sql
--
-- Executor-mode reminders — the RITUAL layer (P0-1 M2 parity, plan task 2;
-- spec of record `docs/plans/executor-mode-reminders-2026-07-20.md`).
--
-- A ritual is a reminder that, instead of composing a one-shot nudge, SPAWNS a
-- scoped sub-agent REPL at fire time (a "morning brief" that actually reads
-- STATUS.md + calendar, an "evening wrap" that writes a delta note, …). This
-- migration lands the PERSISTENT half of that layer in three forward-only DDL
-- units, in order:
--
--   PART A — `reminders.ritual_id`. The OPT-IN tag that marks a reminder row as
--     an executor dispatch instead of a plain nudge. Nullable, no default, no
--     CHECK — the SAME opaque-TEXT rationale as 0095's `recurrence_spec`
--     (a bare ALTER): the in-process ritual REGISTRY (`reminders/rituals.ts`) is
--     the authoritative validator of which ids are live, and a CHECK here would
--     force a full `reminders` table rebuild every time a ritual is added or
--     removed. Semantics: NULL = a nudge row (behaviour UNCHANGED for every
--     existing row — no backfill); non-NULL = an executor row pointing at a
--     registered RitualDef. Fire-time validation (unknown ritual / missing
--     prompt / unapproved) → log + SKIP, NEVER degrade-to-nudge, and NEVER an
--     empty tool surface (the #361 toolless class). There is DELIBERATELY no
--     `prompt_file` and no `model`/`timeout` column: the indirection through the
--     owner-controlled registry (prompt derived `rituals/<id>.md`; tier +
--     timeout module constants) IS the design (design doc §2a).
--
--   PART B — `code_ritual_runs`. Durable RUN HISTORY, one row per fire ATTEMPT
--     (including skips). This is deliberately NOT the shape of the subagent
--     registry (`code_subagent_registry`, 0100): that table is a LIVENESS
--     projection whose rows are DELETED on prune (`runtime/subagent/store.ts:171`
--     remove()), and its status vocabulary ('pending'/'running'/'finished'/
--     'crashed'/'cancelled') has no failed/timed_out and no ritual_id/output — so
--     "why did my morning brief not run yesterday?" is UNANSWERABLE from it once
--     the live row is gone. This table is the durable answer, retained on its OWN
--     window (the retention prune lands with the executor-branch task, not here).
--     Its status vocab is richer on purpose: 'finished'/'failed'/'timed_out'
--     distinguish outcomes the registry cannot, and 'skipped' + `skip_reason`
--     capture the fail-CLOSED validation verdicts that never spawn at all. The
--     invariant CHECK ties them: a row is 'skipped' IFF it carries a skip_reason.
--     NOTE: no `table-ownership.json` entry is added here — coverage is opt-in
--     per that file's $comment, and this table has NO writers yet (the first
--     runtime writer task adds the entry).
--
--   PART C — widen `code_subagent_registry.agent_kind` to admit 'ritual'. SQLite
--     cannot ALTER a CHECK constraint, so this is the standard
--     create-copy-drop-rename rebuild, entirely inside the runner's per-file
--     transaction (`migrations/runner.ts`; ROLLBACK on throw). The new table is
--     the 0100 DDL reproduced VERBATIM (same column order, same STRICT, same
--     NOT NULLs / DEFAULTs / CHECKs) with the SOLE change being the agent_kind
--     enum gaining 'ritual'; rows are copied by EXPLICIT column list, the old
--     table dropped, the new one renamed into place, and BOTH 0100 indexes
--     recreated (they drop with the old table). VERIFIED SAFE: no other
--     migration, FK, trigger, or view references `code_subagent_registry`
--     (grep-clean), so the rebuild is self-contained.
--
-- SNAPSHOT REGEN REQUIRED: Parts A and C change the `reminders` and
-- `code_subagent_registry` table shapes and Part B adds a table, so
-- `migrations/expected-schema.txt` MUST be regenerated
-- (`bun run migrations/regen-snapshot.ts`) and committed alongside this file or
-- `migrations/snapshot.test.ts` will fail with schema drift.
--
-- Forward-only; no down-migration (Neutron OSS contract).

-- PART A — ritual tag on reminders. Opaque TEXT, registry-validated (precedent
-- 0095 `recurrence_spec`, a bare ALTER). NULL = nudge row (unchanged); non-NULL
-- = executor row pointing at a registered RitualDef (`reminders/rituals.ts`).
ALTER TABLE reminders ADD COLUMN ritual_id TEXT;

-- PART B — durable ritual run history (own retention; NOT pruned on the subagent
-- liveness prune). One row per fire ATTEMPT, skips included.
CREATE TABLE IF NOT EXISTS code_ritual_runs (
    -- Minted per FIRE ATTEMPT (a UUID) — NOT the subagent run id: a validation
    -- skip never spawns, so it has no subagent row at all.
    run_id           TEXT PRIMARY KEY NOT NULL,
    ritual_id        TEXT NOT NULL,
    reminder_id      TEXT,
    project_slug     TEXT,
    -- The `code_subagent_registry` row when a spawn happened; NULL for skips.
    subagent_run_id  TEXT,
    status           TEXT NOT NULL
                         CHECK (status IN (
                             'skipped', 'running', 'finished', 'failed', 'timed_out', 'crashed'
                         )),
    skip_reason      TEXT
                         CHECK (skip_reason IS NULL OR skip_reason IN (
                             'unknown_ritual', 'missing_prompt', 'unapproved'
                         )),
    -- The approved content hash the run fired under (nullable; populated once the
    -- approval gate lands — plan task 3).
    content_hash     TEXT,
    started_at       INTEGER NOT NULL,               -- epoch ms
    ended_at         INTEGER,                         -- epoch ms
    -- Truncated final text of the run, kept for history.
    output_summary   TEXT,
    failure_reason   TEXT,
    -- A row is 'skipped' IFF it carries a skip_reason; every non-skipped row
    -- carries none.
    CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_code_ritual_runs_ritual
    ON code_ritual_runs (ritual_id, started_at);

CREATE INDEX IF NOT EXISTS idx_code_ritual_runs_live
    ON code_ritual_runs (status)
    WHERE status = 'running';

-- PART C — widen agent_kind to admit 'ritual' (create-copy-drop-rename). The new
-- table is the 0100 DDL VERBATIM with ONLY the agent_kind enum line changed.
--
-- Deliberately a PLAIN create (NO "IF NOT EXISTS"): the runner wraps this file in
-- a transaction that ROLLs BACK on any throw, so half-applied state is
-- impossible, and a full re-apply after a host-snapshot rollback re-runs the
-- whole rebuild cleanly (the `_new` name never persists past the RENAME). A
-- pre-existing `_new` table is therefore an anomaly that must error LOUDLY, never
-- be silently reused.
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
    -- Per-process-boot ownership token (see header). NOT NULL: every row is
    -- stamped with the creating process's boot id so the reap can tell prior-boot
    -- orphans from current-boot live rows.
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

-- Recreate BOTH 0100 indexes verbatim (they dropped with the old table).
CREATE INDEX IF NOT EXISTS idx_code_subagent_registry_live
    ON code_subagent_registry (status)
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_code_subagent_registry_owner
    ON code_subagent_registry (instance_key);
