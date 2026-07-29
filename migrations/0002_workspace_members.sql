-- 0002_workspace_members.sql
--
-- Per docs/plans/P0-system-user-data-separation.md § 1.4.
--
-- Applies to every project DB but is only *meaningful* for instances where the application-level
-- instance flavor is 'workspace' — see § A.3.3 of the engineering plan. User instances land the
-- table empty and never write to it.
--
-- Sprint 1 dropped the standalone `instance_metadata` table + the `project_slug` FK on `sessions`
-- as unneeded at this phase (one owner per DB makes the FK redundant; the per-instance Unix
-- user + filesystem layout already encodes ownership). See § 1.4 "DECISION 2026-04-26"
-- addendum for the full rationale. workspace_members ships anyway because it's the join
-- table for the workspace-flavor multi-user case, which P1 needs ready.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS). The runner (migrations/runner.ts)
-- wraps this whole body in BEGIN/COMMIT atomically and inserts a row into `_migrations` on
-- success.

CREATE TABLE IF NOT EXISTS workspace_members (
    user_id TEXT PRIMARY KEY NOT NULL,                   -- the Neutron user_id from the auth service (Zone C); TEXT PRIMARY KEY is implicitly nullable on rowid tables, pin it
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at REAL NOT NULL,
    invited_by TEXT,                                     -- user_id of inviter; NULL for the founding owner
    invite_token TEXT,                                   -- nullable; consumed at accept-time
    accepted_at REAL                                     -- nullable; NULL = pending invite
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_role ON workspace_members(role);
