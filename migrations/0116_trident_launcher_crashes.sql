-- Durable pooled-launcher ownership/crash ledger (#514).
-- A detached workflow row stores its exact child-generation token in
-- workflow_run_id. The
-- crash row is written before supervision respawns, so a launch completion
-- racing its tick snapshot cannot bind itself to an already-dead generation.
CREATE TABLE IF NOT EXISTS trident_launcher_crashes (
    session_key TEXT PRIMARY KEY NOT NULL, -- unique child-generation token
    failure_reason TEXT NOT NULL,
    crashed_at TEXT NOT NULL
) STRICT;
