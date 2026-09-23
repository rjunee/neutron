-- Preserve the historical migration ledger and translate only current row vocabulary.
-- This preamble runs outside the runner's atomic migration transaction.
PRAGMA foreign_keys = OFF;

-- A historically pending 0131/0138 rebuild can run after these additive
-- migrations were recorded. Restore only missing columns before copying them;
-- the runner tolerates duplicate-column errors solely inside this block.
-- @neutron:restore-columns BEGIN
ALTER TABLE code_trident_runs ADD COLUMN brief_alert TEXT;
ALTER TABLE code_trident_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE code_trident_runs ADD COLUMN wave_task_id TEXT;
ALTER TABLE code_trident_runs ADD COLUMN claimed_paths TEXT;
ALTER TABLE code_trident_runs ADD COLUMN published_pr INTEGER;
ALTER TABLE code_trident_runs ADD COLUMN ralph_task_total INTEGER
    CHECK (ralph_task_total IS NULL OR (typeof(ralph_task_total) = 'integer' AND ralph_task_total > 0 AND ralph_task_total <= 9007199254740991));
ALTER TABLE code_trident_runs ADD COLUMN resume_note TEXT;
-- A late 0130 rebuild may also have removed the already-ledgered card budget.
-- Zero allowance refuses new work when earlier spend can no longer be proven.
ALTER TABLE work_board_items ADD COLUMN ralph_round INTEGER NOT NULL DEFAULT +0 CHECK (ralph_round >= 0);
ALTER TABLE work_board_items ADD COLUMN max_ralph_rounds INTEGER DEFAULT 0 CHECK (max_ralph_rounds IS NULL OR max_ralph_rounds >= 0);
ALTER TABLE work_board_items ADD COLUMN ralph_task_total INTEGER
    CHECK (ralph_task_total IS NULL OR (typeof(ralph_task_total) = 'integer' AND ralph_task_total > 0 AND ralph_task_total <= 9007199254740991));
-- @neutron:restore-columns END

-- The restore block runs before the body. Its distinct but numerically identical
-- default is durable evidence that the counter was absent. An intact historical
-- column has DEFAULT 0. A missing counter with a surviving cap is unknown spend,
-- so disable that allowance too; never let a partial schema hole refund a card.
UPDATE work_board_items SET max_ralph_rounds = 0
WHERE (SELECT dflt_value FROM pragma_table_info('work_board_items') WHERE name = 'ralph_round') = '+0';

CREATE TABLE code_trident_runs_new (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'forge-init'
        CHECK (phase IN ('forge-init', 'task-plan', 'task-build', 'argus', 'forge-fix', 'done', 'failed', 'stopped')),
    round INTEGER NOT NULL DEFAULT 1,
    max_rounds INTEGER NOT NULL DEFAULT 8,
    execution_strategy TEXT CHECK (execution_strategy IN ('single', 'task_sequence')),
    strategy_rationale TEXT,
    strategy_plan TEXT,
    strategy_source TEXT CHECK (strategy_source IN ('planner', 'legacy')),
    task_iteration INTEGER NOT NULL DEFAULT 0,
    max_task_iterations INTEGER NOT NULL DEFAULT 20,
    branch TEXT,
    pr INTEGER,
    merge_mode TEXT NOT NULL DEFAULT 'local' CHECK (merge_mode IN ('local', 'pr')),
    subagent_run_id TEXT,
    subagent_status TEXT CHECK (subagent_status IS NULL OR subagent_status IN ('pending', 'running', 'completed', 'failed', 'crashed')),
    repo_path TEXT NOT NULL,
    worktree TEXT,
    task TEXT NOT NULL,
    chat_id TEXT,
    thread_id TEXT,
    failure_reason TEXT,
    started_at TEXT NOT NULL,
    last_advanced_at TEXT NOT NULL,
    channel_kind TEXT NOT NULL DEFAULT 'telegram' CHECK (channel_kind IN ('telegram', 'app_socket', 'webhook', 'cli')),
    workflow_run_id TEXT,
    inner_checkpoint TEXT,
    inner_verdict TEXT CHECK (inner_verdict IS NULL OR inner_verdict IN ('APPROVE', 'REQUEST_CHANGES', 'REVIEW_NOT_RUN')),
    inner_result TEXT,
    harvested_at INTEGER,
    inner_checkpoint_head TEXT,
    inner_checkpoint_findings TEXT,
    crash_recoveries INTEGER,
    reviewed_head TEXT,
    bound_pr INTEGER,
    fenced_paths TEXT,
    base_sha TEXT,
    base_behind INTEGER,
    infra_retries INTEGER,
    agent_waked_at INTEGER,
    brief_alert TEXT,
    parent_run_id TEXT,
    wave_task_id TEXT,
    claimed_paths TEXT,
    published_pr INTEGER,
    task_total INTEGER CHECK (task_total IS NULL OR (typeof(task_total) = 'integer' AND task_total > 0 AND task_total <= 9007199254740991)),
    resume_note TEXT
) STRICT;

INSERT INTO code_trident_runs_new SELECT
    id, slug, project_slug,
    CASE phase WHEN 'ralph-plan' THEN 'task-plan' WHEN 'ralph-task' THEN 'task-build' ELSE phase END,
    round, max_rounds,
    CASE ralph WHEN 1 THEN 'task_sequence' ELSE 'single' END,
    'Migrated from legacy ralph=' || ralph || '.', NULL, 'legacy',
    ralph_round, max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status,
    repo_path, worktree, task, chat_id, thread_id, failure_reason, started_at, last_advanced_at,
    channel_kind, workflow_run_id,
    CASE inner_checkpoint
        WHEN 'ralph-plan' THEN 'task-plan' WHEN 'ralph-task' THEN 'task-build'
        WHEN 'ralph-task-built' THEN 'task-built'
        WHEN 'ralph-task-built-deviated' THEN 'task-built-deviated'
        ELSE inner_checkpoint END,
    inner_verdict, inner_result, harvested_at, inner_checkpoint_head, inner_checkpoint_findings,
    crash_recoveries, reviewed_head, bound_pr, fenced_paths, base_sha, base_behind,
    infra_retries, agent_waked_at, brief_alert, parent_run_id, wave_task_id, claimed_paths,
    published_pr, ralph_task_total, resume_note
FROM code_trident_runs;

DROP TABLE code_trident_runs;
ALTER TABLE code_trident_runs_new RENAME TO code_trident_runs;
CREATE UNIQUE INDEX idx_code_trident_runs_slug ON code_trident_runs(project_slug, slug)
    WHERE phase NOT IN ('done', 'failed', 'stopped');
CREATE INDEX idx_code_trident_runs_active ON code_trident_runs(phase)
    WHERE phase NOT IN ('done', 'failed', 'stopped');
CREATE UNIQUE INDEX idx_code_trident_runs_wave_child ON code_trident_runs(parent_run_id, wave_task_id)
    WHERE parent_run_id IS NOT NULL;
CREATE TRIGGER code_trident_runs_seed_usage AFTER INSERT ON code_trident_runs
BEGIN
    INSERT INTO code_trident_phase_usage(run_id, phase)
        SELECT NEW.id, phase FROM code_trident_usage_phases;
END;

ALTER TABLE work_board_items RENAME COLUMN ralph_round TO task_iteration;
ALTER TABLE work_board_items RENAME COLUMN max_ralph_rounds TO max_task_iterations;
ALTER TABLE work_board_items RENAME COLUMN ralph_task_total TO task_total;
ALTER TABLE work_board_items ADD COLUMN execution_strategy TEXT CHECK (execution_strategy IN ('single', 'task_sequence'));
ALTER TABLE work_board_items ADD COLUMN strategy_rationale TEXT;
ALTER TABLE work_board_items ADD COLUMN strategy_plan TEXT;
ALTER TABLE work_board_items ADD COLUMN strategy_source TEXT CHECK (strategy_source IN ('planner', 'legacy'));

-- A card's own budget outlives its run link. An older card with a cleared link
-- and durable task spend retains its legacy task-sequence selection as well.
UPDATE work_board_items SET
    execution_strategy = COALESCE(
        (SELECT execution_strategy FROM code_trident_runs r WHERE r.id = linked_run_id AND r.project_slug = work_board_items.project_slug),
        CASE WHEN max_task_iterations IS NOT NULL OR task_iteration > 0 THEN 'task_sequence' END),
    strategy_rationale = COALESCE(
        (SELECT strategy_rationale FROM code_trident_runs r WHERE r.id = linked_run_id AND r.project_slug = work_board_items.project_slug),
        CASE WHEN max_task_iterations IS NOT NULL OR task_iteration > 0 THEN 'Migrated from legacy card iteration budget.' END),
    strategy_source = CASE WHEN EXISTS (
        SELECT 1 FROM code_trident_runs r WHERE r.id = linked_run_id AND r.project_slug = work_board_items.project_slug
    ) OR max_task_iterations IS NOT NULL OR task_iteration > 0 THEN 'legacy' END;

-- Live rows may have spent iterations since the last terminal reconciliation.
UPDATE work_board_items SET
    task_iteration = MAX(task_iteration, COALESCE((SELECT task_iteration FROM code_trident_runs r WHERE r.id = linked_run_id AND r.project_slug = work_board_items.project_slug), 0)),
    max_task_iterations = CASE WHEN EXISTS (SELECT 1 FROM code_trident_runs r WHERE r.id = linked_run_id AND r.project_slug = work_board_items.project_slug)
        THEN MIN(COALESCE(max_task_iterations, (SELECT max_task_iterations FROM code_trident_runs WHERE id = linked_run_id)),
                 (SELECT max_task_iterations FROM code_trident_runs WHERE id = linked_run_id)) ELSE max_task_iterations END,
    task_total = COALESCE(task_total, (SELECT task_total FROM code_trident_runs r WHERE r.id = linked_run_id AND r.project_slug = work_board_items.project_slug));

-- Keep the card snapshot current before a terminal observer or owner action can
-- clear its link. This also covers out-of-process workflow counter writes.
CREATE TRIGGER code_trident_runs_card_strategy
AFTER UPDATE OF execution_strategy, strategy_rationale, strategy_plan, strategy_source, task_iteration, max_task_iterations, task_total ON code_trident_runs
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM work_board_items WHERE linked_run_id = NEW.id AND project_slug = NEW.project_slug
        AND execution_strategy IS NOT NULL AND NEW.execution_strategy IS NOT execution_strategy
    ) THEN RAISE(ABORT, 'card execution strategy is immutable') END;
    UPDATE work_board_items SET
        execution_strategy = COALESCE(execution_strategy, NEW.execution_strategy),
        strategy_rationale = COALESCE(NEW.strategy_rationale, strategy_rationale),
        strategy_plan = COALESCE(NEW.strategy_plan, strategy_plan),
        strategy_source = COALESCE(strategy_source, NEW.strategy_source),
        task_iteration = MAX(task_iteration, NEW.task_iteration),
        max_task_iterations = MIN(COALESCE(max_task_iterations, NEW.max_task_iterations), NEW.max_task_iterations),
        task_total = CASE WHEN NEW.task_iteration >= task_iteration THEN COALESCE(NEW.task_total, task_total) ELSE task_total END
    WHERE linked_run_id = NEW.id AND project_slug = NEW.project_slug;
END;

CREATE TRIGGER work_board_items_attach_strategy
AFTER UPDATE OF linked_run_id ON work_board_items WHEN NEW.linked_run_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM code_trident_runs WHERE id = NEW.linked_run_id AND project_slug = NEW.project_slug
        AND NEW.execution_strategy IS NOT NULL AND execution_strategy IS NOT NEW.execution_strategy
    ) THEN RAISE(ABORT, 'card execution strategy is immutable') END;
    UPDATE work_board_items SET
        execution_strategy = COALESCE(execution_strategy, (SELECT execution_strategy FROM code_trident_runs WHERE id = NEW.linked_run_id)),
        strategy_rationale = COALESCE((SELECT strategy_rationale FROM code_trident_runs WHERE id = NEW.linked_run_id), strategy_rationale),
        strategy_plan = COALESCE((SELECT strategy_plan FROM code_trident_runs WHERE id = NEW.linked_run_id), strategy_plan),
        strategy_source = COALESCE(strategy_source, (SELECT strategy_source FROM code_trident_runs WHERE id = NEW.linked_run_id)),
        task_iteration = MAX(task_iteration, (SELECT task_iteration FROM code_trident_runs WHERE id = NEW.linked_run_id)),
        max_task_iterations = MIN(COALESCE(max_task_iterations, (SELECT max_task_iterations FROM code_trident_runs WHERE id = NEW.linked_run_id)),
            (SELECT max_task_iterations FROM code_trident_runs WHERE id = NEW.linked_run_id)),
        task_total = COALESCE((SELECT task_total FROM code_trident_runs WHERE id = NEW.linked_run_id), task_total)
    WHERE id = NEW.id AND EXISTS (SELECT 1 FROM code_trident_runs WHERE id = NEW.linked_run_id AND project_slug = NEW.project_slug);
END;

CREATE TRIGGER code_trident_runs_strategy_immutable
BEFORE UPDATE OF execution_strategy ON code_trident_runs
WHEN OLD.execution_strategy IS NOT NULL AND NEW.execution_strategy IS NOT OLD.execution_strategy
BEGIN
    SELECT RAISE(ABORT, 'execution strategy is immutable');
END;

-- Queue entries no longer select execution mode. Retain the old recorded value
-- solely as historical evidence while fresh dispatch waits for its planner.
ALTER TABLE overnight_queue RENAME COLUMN ralph TO legacy_execution_mode;
