-- The latest plan-derived task total is separate from the iteration allowance.
-- Existing runs/cards stay unknown until a measured continuation is harvested.
ALTER TABLE code_trident_runs ADD COLUMN ralph_task_total INTEGER
    CHECK (ralph_task_total IS NULL OR (typeof(ralph_task_total) = 'integer' AND ralph_task_total > 0 AND ralph_task_total <= 9007199254740991));
ALTER TABLE work_board_items ADD COLUMN ralph_task_total INTEGER
    CHECK (ralph_task_total IS NULL OR (typeof(ralph_task_total) = 'integer' AND ralph_task_total > 0 AND ralph_task_total <= 9007199254740991));
