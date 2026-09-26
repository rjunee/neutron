-- Card-owned terminal provenance; independent of the current dispatch binding.
CREATE TABLE IF NOT EXISTS work_board_terminal_attempts (
    project_slug TEXT NOT NULL,
    item_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('done', 'failed', 'blocked')),
    pr INTEGER,
    pr_url TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (project_slug, item_id, run_id),
    FOREIGN KEY (item_id) REFERENCES work_board_items(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO work_board_terminal_attempts
    (project_slug, item_id, run_id, outcome, pr, pr_url, recorded_at)
SELECT project_slug, id, linked_run_id, status, pr, pr_url, updated_at
FROM work_board_items
WHERE linked_run_id IS NOT NULL AND status IN ('done', 'failed', 'blocked');
