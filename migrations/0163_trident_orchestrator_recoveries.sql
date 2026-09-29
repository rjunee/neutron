CREATE TABLE IF NOT EXISTS code_trident_orchestrator_recoveries (
    source_run_id TEXT PRIMARY KEY NOT NULL REFERENCES code_trident_runs(id),
    source_event_id INTEGER NOT NULL REFERENCES code_trident_stage_events(id),
    run_id TEXT UNIQUE NOT NULL REFERENCES code_trident_runs(id),
    project_slug TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES work_board_items(id),
    call_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    consumed_at TEXT NOT NULL,
    UNIQUE (project_slug, call_id)
) STRICT;
