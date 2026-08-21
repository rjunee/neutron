-- 0138_code_trident_runs_review_not_run.sql
--
-- Forward-only: widen the recorded inner verdict so a terminal run whose
-- reviewer never spoke can say so honestly. Measurement found that 95 of 146
-- REQUEST_CHANGES rows carry zero findings because that value was written when
-- the run died before review; REQUEST_CHANGES is now reserved for a reviewer
-- that actually produced a verdict. Existing rows are deliberately NOT
-- rewritten because they are the measurement evidence for this defect.
--
-- SQLite cannot ALTER a CHECK constraint on a STRICT table, so rebuild the
-- table and recreate its two partial indexes.

-- REBUILD HAZARD, RESOLVED AT REBASE. This file was authored against a table that
-- did not yet carry `parent_run_id` / `wave_task_id`; 0137_code_trident_runs_wave_
-- children.sql added them (and a UNIQUE index over them) on main while this branch
-- was open. A rebuild copies only the columns it NAMES and drops every index on the
-- old table, and neither omission FAILS at migrate time — the migration reports
-- success, then the plan-DAG code dies at runtime on "no such column
-- parent_run_id", and wave spawning silently loses its idempotency and inserts
-- duplicate children. Both were caught by the suite after the rebase (238 failures,
-- then 1). Any future ALTER to code_trident_runs must be mirrored into the column
-- list, the INSERT/SELECT lists, AND the index block at the bottom of this file.
--
-- The comments deliberately live OUT here rather than inside the CREATE TABLE body:
-- SQLite stores the statement text verbatim in sqlite_master, so a comment between
-- columns becomes part of the persisted schema and shows up as snapshot drift.

-- THE SECOND HEAD OF THE SAME DEFECT, AND THE REASON FOR THE BLOCK BELOW.
-- 0131_code_trident_runs_base_sha_repair.sql is itself a rebuild, and it only ever
-- runs LATE: it is pending exactly on the instances that skipped ordinal 125, which
-- by now have also applied 0136 (brief_alert) and 0137 (parent_run_id, wave_task_id
-- + the wave-child UNIQUE index). Its column list predates all three, so on those
-- instances it silently DELETES them and reports success — measured by holding it
-- back and applying it alone. Nothing on main names those columns after 0131, so
-- the loss stays quiet there; this file names all three, so without the restore
-- below the migration would fail with `no such column: brief_alert` and refuse the
-- boot. 0131 cannot be edited — its content hash is in every ledger that ran it.
--
-- The runner tolerates `duplicate column name` for these three ALTERs and NOTHING
-- else: only inside these markers, only for ADD COLUMN statements, and only for
-- that one error. On an instance that never lost the columns each ALTER is a
-- tolerated no-op; on one that did, this is what puts them back before the rebuild
-- copies them. The wave-child index is restored by the CREATE at the bottom of
-- this file, which a rebuild has to re-issue anyway.
-- @neutron:restore-columns BEGIN
ALTER TABLE code_trident_runs ADD COLUMN brief_alert TEXT;
ALTER TABLE code_trident_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE code_trident_runs ADD COLUMN wave_task_id TEXT;
-- @neutron:restore-columns END

PRAGMA foreign_keys = OFF;

CREATE TABLE code_trident_runs_new (
    id                  TEXT PRIMARY KEY NOT NULL,
    slug                TEXT NOT NULL,
    project_slug        TEXT NOT NULL,
    phase               TEXT NOT NULL DEFAULT 'forge-init'
                            CHECK (phase IN (
                                'forge-init', 'ralph-plan', 'ralph-task',
                                'argus', 'forge-fix',
                                'done', 'failed', 'stopped'
                            )),
    round               INTEGER NOT NULL DEFAULT 1,
    max_rounds          INTEGER NOT NULL DEFAULT 8,
    ralph               INTEGER NOT NULL DEFAULT 0
                            CHECK (ralph IN (0, 1)),
    ralph_round         INTEGER NOT NULL DEFAULT 0,
    max_ralph_rounds    INTEGER NOT NULL DEFAULT 20,
    branch              TEXT,
    pr                  INTEGER,
    merge_mode          TEXT NOT NULL DEFAULT 'local'
                            CHECK (merge_mode IN ('local', 'pr')),
    subagent_run_id     TEXT,
    subagent_status     TEXT
                            CHECK (subagent_status IS NULL OR subagent_status IN (
                                'pending', 'running', 'completed', 'failed', 'crashed'
                            )),
    repo_path           TEXT NOT NULL,
    worktree            TEXT,
    task                TEXT NOT NULL,
    chat_id             TEXT,
    thread_id           TEXT,
    failure_reason      TEXT,
    started_at          TEXT NOT NULL,
    last_advanced_at    TEXT NOT NULL,
    channel_kind        TEXT NOT NULL DEFAULT 'telegram'
                            CHECK (channel_kind IN ('telegram', 'app_socket', 'webhook', 'cli')),
    workflow_run_id     TEXT,
    inner_checkpoint    TEXT,
    inner_verdict       TEXT
                            CHECK (inner_verdict IS NULL OR inner_verdict IN ('APPROVE', 'REQUEST_CHANGES', 'REVIEW_NOT_RUN')),
    inner_result        TEXT,
    harvested_at        INTEGER,
    inner_checkpoint_head     TEXT,
    inner_checkpoint_findings TEXT,
    crash_recoveries    INTEGER,
    reviewed_head       TEXT,
    bound_pr            INTEGER,
    fenced_paths        TEXT,
    base_sha            TEXT,
    base_behind         INTEGER,
    infra_retries       INTEGER,
    agent_waked_at      INTEGER
, brief_alert TEXT, parent_run_id TEXT, wave_task_id TEXT) STRICT;

INSERT INTO code_trident_runs_new (
    id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round,
    max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status,
    repo_path, worktree, task, chat_id, thread_id, failure_reason, started_at,
    last_advanced_at, channel_kind, workflow_run_id, inner_checkpoint,
    inner_verdict, inner_result, harvested_at, inner_checkpoint_head,
    inner_checkpoint_findings, crash_recoveries, reviewed_head, bound_pr,
    fenced_paths, base_sha, base_behind, infra_retries, agent_waked_at,
    brief_alert, parent_run_id, wave_task_id
)
SELECT
    id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round,
    max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status,
    repo_path, worktree, task, chat_id, thread_id, failure_reason, started_at,
    last_advanced_at, channel_kind, workflow_run_id, inner_checkpoint,
    inner_verdict, inner_result, harvested_at, inner_checkpoint_head,
    inner_checkpoint_findings, crash_recoveries, reviewed_head, bound_pr,
    fenced_paths, base_sha, base_behind, infra_retries, agent_waked_at,
    brief_alert, parent_run_id, wave_task_id
FROM code_trident_runs;

DROP TABLE code_trident_runs;

ALTER TABLE code_trident_runs_new RENAME TO code_trident_runs;

CREATE INDEX idx_code_trident_runs_active
    ON code_trident_runs (phase)
    WHERE phase NOT IN ('done', 'failed', 'stopped');

CREATE UNIQUE INDEX idx_code_trident_runs_slug
    ON code_trident_runs (project_slug, slug)
    WHERE phase NOT IN ('done', 'failed', 'stopped');

-- SAME REBUILD HAZARD AS THE TWO COLUMNS ABOVE, AND QUIETER. A rebuild drops every
-- index on the old table; this one arrived with 0137 and was not in this file's
-- original list. Losing it does not fail anything at migrate time — it removes the
-- UNIQUENESS that makes wave spawning idempotent, so a re-spawn silently inserts a
-- DUPLICATE child instead of being refused. Caught by the "wave spawn is idempotent
-- per parent and task" test, which is the only thing standing between this and a
-- fan-out that doubles its own work.
CREATE UNIQUE INDEX idx_code_trident_runs_wave_child
    ON code_trident_runs (parent_run_id, wave_task_id)
    WHERE parent_run_id IS NOT NULL;
