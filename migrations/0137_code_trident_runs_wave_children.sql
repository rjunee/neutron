-- 0137_code_trident_runs_wave_children.sql
--
-- Wave members of a Ralph plan-DAG fan-out are CHILD ROWS of the parent run,
-- so the existing tick/step/checkpoint/liveness/crash machinery drives them
-- unchanged. Both columns are NULL on every ordinary row: this is a pure
-- additive ALTER on the STRICT table. The partial UNIQUE index makes wave spawn
-- IDEMPOTENT across crashes: a parent that dies mid-spawn re-runs the spawn and
-- the duplicate (parent, task) INSERT is refused. Its WHERE predicate keeps
-- ordinary rows out of the index instead of leaning on SQLite's
-- NULLs-are-distinct rule. ALTER TABLE cannot add the cross-column CHECK needed
-- for both-or-neither, so the single creation writer enforces pairing in store.

ALTER TABLE code_trident_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE code_trident_runs ADD COLUMN wave_task_id TEXT;

CREATE UNIQUE INDEX idx_code_trident_runs_wave_child
    ON code_trident_runs (parent_run_id, wave_task_id)
    WHERE parent_run_id IS NOT NULL;
