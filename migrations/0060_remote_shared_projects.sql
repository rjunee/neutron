-- 0060_remote_shared_projects.sql
--
-- Neutron Connect (Slack-Connect model): the collaborator-side THIN
-- SHARED-PROJECT REFERENCE table (connect-spec §1.7). A collaborator's instance
-- records, for each shared project it can access on a host's relay, a
-- lightweight pointer to the host — just enough to list the shared project
-- beside its own private projects and open a LIVE session against the host.
--
-- This is NOT a content-sync read-replica. The deleted mesh tracked a
-- `last_seq_seen` cursor here to pull the host's syndication log; that cursor +
-- the whole content-sync apparatus were ripped (connect-spec §2.1, §2.2). What
-- survives is the thin host+access pointer only.
--
-- Columns:
--   project_id     PK; the host's project id this collaborator can access.
--   relay_base_url The host/connect node's public ingress base URL the
--                  collaborator's live session connects to.
--   owner_home     The host's home authority / instance slug (display + audit).
--   joined_at      ISO-8601 UTC join timestamp.
--
-- Migration mechanics:
--   STRICT table; CREATE ... atomic under the runner's BEGIN/COMMIT. Snapshot
--   regen required (bun run migrations/regen-snapshot.ts).
--
-- Verification (post-migration, per-project DB):
--   SELECT COUNT(*) FROM remote_shared_projects;  -- 0 on a fresh instance
--   SELECT name FROM sqlite_master WHERE type='table' AND name='remote_shared_projects';
--
-- Rollback path: dropping an empty net-new table has no data-loss risk.

CREATE TABLE remote_shared_projects (
    project_id     TEXT PRIMARY KEY,
    relay_base_url TEXT NOT NULL,
    owner_home     TEXT NOT NULL,
    joined_at      TEXT NOT NULL
) STRICT;
