-- #629 — the Ralph iteration allowance belongs to the card, not the latest run
-- row. Terminal reconciliation advances this monotone snapshot; dispatch reads
-- it before creating the next row. NULL cap means the card has never had a
-- governed dispatch and therefore receives the configured full allowance.
ALTER TABLE work_board_items ADD COLUMN ralph_round INTEGER NOT NULL DEFAULT 0
    CHECK (ralph_round >= 0);

ALTER TABLE work_board_items ADD COLUMN max_ralph_rounds INTEGER
    CHECK (max_ralph_rounds IS NULL OR max_ralph_rounds >= 1);
