-- 0077_code_trident_runs.sql
--
-- Trident port (PR-2 of ~5) — the autonomous Forge→Argus→merge state
-- machine's durable substrate.
--
-- This table is the SQLite translation of Vajra's `/trident` skill
-- state file (`~/vajra/gateway/trident-<slug>.state.json`). Where Vajra
-- kept one JSON file per run on disk and an out-of-process ScheduleWakeup
-- loop advanced it, Neutron Open persists each run as a row here and an
-- in-process tick loop (`trident/tick.ts`, modelled on
-- `reminders/tick.ts`) advances every non-terminal row. One row == one
-- autonomous build pipeline.
--
-- Scope of THIS migration (PR-2): the table + indexes only. The actual
-- Forge/Argus sub-agent spawning (PR-3) and the Ralph one-task-per-
-- fresh-context loop (PR-4) build ON this row; the columns for both are
-- landed now so neither later PR needs a schema change.
--
-- Column rationale (mirrors the Vajra state-file schema, SKILL.md
-- "## State file"):
--
-- * `id` — opaque UUID primary key (mirrors `reminders` / `tasks`). The
--   human-facing key is `slug`; `id` keeps joins + the subagent-status
--   restart-resume write path stable even if a slug is ever reused.
--
-- * `slug` — the slugified task (Vajra's state-file key). UNIQUE per
--   project so `/code trident <task>` is idempotent within an instance.
--
-- * `project_slug` — instance scoping. Even though the table lives in the
--   per-project DB, we mirror the redundant-but-defensive pattern used by
--   `reminders` / `tasks` so a cross-instance audit can attribute rows.
--
-- * `phase` — the state-machine cursor. The seven live phases come
--   verbatim from the skill's phase enum; `stopped` is added for the
--   `/trident stop` terminal (see `trident/state-machine.ts`
--   TERMINAL_PHASES). The tick driver only ever loads rows whose phase
--   is NOT terminal.
--
-- * `round` / `max_rounds` — the Argus review-fix loop counter + cap
--   (default 8, per the skill's "Default to 8 rounds").
--
-- * `ralph` / `ralph_round` / `max_ralph_rounds` — Ralph build-mode flags.
--   `ralph` is a 0/1 bool (STRICT has no BOOLEAN type). `ralph_round`
--   counts plan↔task cycles, capped by `max_ralph_rounds` (default 20)
--   so a non-converging planner can't spin forever. Unused until PR-4
--   but landed now to avoid a follow-up ALTER.
--
-- * `branch` / `pr` — the feature branch + PR number, populated by the
--   forge-init phase once the worktree/branch/PR exist (NULL before).
--
-- * `merge_mode` — `'pr'` when the project repo has a GitHub origin AND
--   `gh` is available, else `'local'` (the default). Auto-detected by
--   `detectMergeMode` (`trident/git-mode.ts`) at run creation; there is
--   no user config (Ryan-locked: build both, auto-detect).
--
-- * `subagent_run_id` / `subagent_status` — the CURRENTLY in-flight
--   sub-agent's id + status, persisted HERE (not in the disconnected
--   generic `runtime/subagent/` registry) so a gateway restart can
--   resume the loop: the tick re-reads this row, sees the run id +
--   last-known status, and re-checks completion. `subagent_status` is a
--   small closed enum.
--
-- * `repo_path` / `worktree` — the project repo working dir + the
--   per-run worktree path (worktree NULL until forge-init creates it).
--
-- * `task` — the full task description the run is building.
--
-- * `chat_id` / `thread_id` — the Telegram routing context (nullable;
--   carried so a resumed run can still post its delivery message).
--
-- * `failure_reason` — set alongside `phase='failed'` for a human-
--   readable halt cause (mirrors the skill's `failure_reason` field).
--
-- * `started_at` / `last_advanced_at` — ISO-8601 UTC strings (sortable,
--   matches the Vajra state-file + the `tasks` table's TEXT timestamps).
--   `last_advanced_at` is re-stamped on every state-machine transition.
--
-- Indexes match the two read paths:
--   * the tick driver's "load every non-terminal run" → a partial index
--     on `phase` excluding the terminal set keeps that scan dense even
--     once finished runs accumulate.
--   * slug idempotency lookup → UNIQUE (project_slug, slug).
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE code_trident_runs (
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
    started_at          TEXT NOT NULL,                  -- ISO-8601 UTC
    last_advanced_at    TEXT NOT NULL                   -- ISO-8601 UTC
) STRICT;

CREATE UNIQUE INDEX idx_code_trident_runs_slug
    ON code_trident_runs (project_slug, slug);

-- The tick driver scans only non-terminal runs; a partial index keeps
-- that query flat-cost as completed/failed/stopped rows pile up.
CREATE INDEX idx_code_trident_runs_active
    ON code_trident_runs (phase)
    WHERE phase NOT IN ('done', 'failed', 'stopped');
