-- 0048_upload_sessions.sql
--
-- Upload Resume Phase 2 — chunked resumable upload protocol.
--
-- Backs the new chunked-upload endpoints
-- (`POST /api/upload/<source>/start`, `PATCH /api/upload/<source>/<upload_id>`,
-- `HEAD /api/upload/<source>/<upload_id>`). A single row tracks one
-- chunked upload's progress so a mid-upload network drop can resume from
-- the last acked byte instead of restarting from offset 0. Sam's 1.18GB
-- ChatGPT export motivated this — single-shot POST means a connection
-- drop at 90% restarts from byte 0, which is unacceptable UX on the
-- multi-GB exports the import pipeline now ingests.
--
-- Lifecycle:
--   - POST /start              → INSERT row with bytes_received=0,
--                                status='uploading'
--   - PATCH <upload_id>        → idempotent UPDATE
--                                bytes_received = MAX(bytes_received, end+1)
--                                so retried chunks don't regress the offset
--   - PATCH final chunk        → handler validates ZIP magic on the
--                                assembled file, renames to the final path,
--                                then DELETEs this row. Status='complete'
--                                is never persisted in practice — the
--                                CHECK enum keeps it as a valid value so
--                                tooling that reads the column doesn't
--                                blow up on a transient state.
--   - sweeper (every ~5 min)   → rows where status='uploading' AND
--                                expires_at < now → UPDATE status='expired'
--                                + unlink the partial file off disk. 24h
--                                grace period (set at /start time).
--
-- No FK to a project table — the per-project gateway runs against its OWN
-- project.db, so `project_slug` here is effectively a constant per database.
-- The column is recorded anyway so cross-instance log/grep queries and
-- future cross-instance tooling have a denormalised slug to filter on.
--
-- STRICT typing per the convention introduced in migration 0042. Forward-
-- only; no backfill needed since this is a brand-new table.

CREATE TABLE upload_sessions (
    upload_id       TEXT PRIMARY KEY NOT NULL,
    project_slug     TEXT NOT NULL,
    source          TEXT NOT NULL
                        CHECK (source IN ('chatgpt', 'claude')),
    filename        TEXT NOT NULL,
    total_bytes     INTEGER NOT NULL,
    bytes_received  INTEGER NOT NULL DEFAULT 0,
    mime_type       TEXT NOT NULL,
    status          TEXT NOT NULL
                        CHECK (status IN ('uploading', 'complete', 'expired')),
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_upload_sessions_project
    ON upload_sessions (project_slug, status);

-- Partial index — the sweeper's only query reads
-- `WHERE status='uploading' AND expires_at < ?` so a partial index keyed
-- on expires_at restricted to the 'uploading' subset is exactly what the
-- query planner needs. Rows that flip to 'expired' fall out of the
-- index, keeping it tiny.
CREATE INDEX idx_upload_sessions_expires
    ON upload_sessions (expires_at)
    WHERE status = 'uploading';
