-- 0131_code_trident_runs_base_sha_repair.sql
--
-- The ordinal-125 repair acknowledgment skips 0125 on the live database, so
-- base_sha/base_behind still need to be created at a fresh ordinal. Every fresh
-- install does apply 0125, however, and SQLite has no conditional ADD COLUMN;
-- repeating the ALTERs here would fail every fresh install with "duplicate
-- column name". Rebuilding the STRICT table (CREATE new → INSERT SELECT of
-- columns common to both states → DROP → RENAME) converges both paths to
-- the canonical schema. It also sheds dead incident-branch residue such as
-- claimed_paths, which is present on the live database and unused on main.
--
-- Accepted trade-off: an install that applied the original 0125 loses stored
-- base_sha/base_behind values during the rebuild. They are cut-time staleness
-- diagnostics only, and the owner instance has none because those columns do
-- not exist there. No foreign key references code_trident_runs; the preamble is
-- retained for parity with the 0130 rebuild. Forward-only; no down-migration.

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
                            CHECK (inner_verdict IS NULL OR inner_verdict IN ('APPROVE', 'REQUEST_CHANGES')),
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
) STRICT;

INSERT INTO code_trident_runs_new (
    id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round,
    max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status,
    repo_path, worktree, task, chat_id, thread_id, failure_reason,
    started_at, last_advanced_at, channel_kind, workflow_run_id,
    inner_checkpoint, inner_verdict, inner_result, harvested_at,
    inner_checkpoint_head, inner_checkpoint_findings, crash_recoveries,
    reviewed_head, bound_pr, fenced_paths, infra_retries, agent_waked_at
) SELECT
    id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round,
    max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status,
    repo_path, worktree, task, chat_id, thread_id, failure_reason,
    started_at, last_advanced_at, channel_kind, workflow_run_id,
    inner_checkpoint, inner_verdict, inner_result, harvested_at,
    inner_checkpoint_head, inner_checkpoint_findings, crash_recoveries,
    reviewed_head, bound_pr, fenced_paths, infra_retries, agent_waked_at
  FROM code_trident_runs;

DROP TABLE code_trident_runs;

ALTER TABLE code_trident_runs_new RENAME TO code_trident_runs;

CREATE INDEX idx_code_trident_runs_active
    ON code_trident_runs (phase)
    WHERE phase NOT IN ('done', 'failed', 'stopped');

CREATE UNIQUE INDEX idx_code_trident_runs_slug
    ON code_trident_runs (project_slug, slug)
    WHERE phase NOT IN ('done', 'failed', 'stopped');
