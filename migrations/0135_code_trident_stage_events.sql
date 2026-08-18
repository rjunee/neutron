-- Pre-build latency instrumentation (2026-08-18 latency card): append-only
-- per-run stage-event ledger. Rows are never updated or deleted by runtime
-- code, so stamps recorded before a crash/re-fire survive it. Writers:
-- TridentRunStore.recordStageEvent (host TS) and trident/stage-stamp.sh
-- (bash: codex-build.sh, and workflow prompts in a later task).
CREATE TABLE IF NOT EXISTS code_trident_stage_events (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    at TEXT NOT NULL,
    meta TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS code_trident_stage_events_run_idx ON code_trident_stage_events(run_id);
