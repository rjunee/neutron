-- 0070_connect_access_rename.sql
--
-- 2026-06-14 — Connect FEATURES B1 (connect-spec §1.4, OQ-4). Collapses the
-- 3-value `gbrain_scope` quarantine-whitelist axis to a plain
-- `access ∈ {read, write}` session-post permission on BOTH the member row and
-- the invite. The owner is the only admin (the `admin` value disappears).
--
--   write → the collaborator's turns drive the host's one session + memory.
--   read  → the collaborator observes; their POST /messages is refused at the
--           post boundary (connect-spec §1.4). Never writes.
--
-- This is a FORWARD, clean conversion — NO back-compat alias (no prod users;
-- NEUTRON.md "Neutron Open: ZERO back-compat"). Existing `admin` rows collapse
-- to `write`.
--
-- connected_members: full table rebuild (the CHECK domain changes 3→2 values, so
-- a column rename alone can't tighten it). Reproduces the CURRENT post-0062/0065
-- schema (role + home_instance_slug) verbatim, only swapping gbrain_scope→access.
-- connect_guest_invites: the domain was already {write, read}; a RENAME COLUMN
-- suffices (the CHECK + DEFAULT carry over to the new column name).
--
-- Migration mechanics: STRICT table; atomic under the runner's BEGIN/COMMIT.
-- Forward-only; never edited. Snapshot regen required
-- (bun run migrations/regen-snapshot.ts).

-- ── connected_members: rebuild to rename gbrain_scope → access + drop 'admin'.
CREATE TABLE connected_members_new (
    local_slug         TEXT PRIMARY KEY,
    display_name       TEXT NOT NULL,
    role               TEXT NOT NULL
                           CHECK (role IN ('owner', 'collaborator')),
    home_authority     TEXT,
    home_instance_slug TEXT,
    home_user_id       TEXT,
    access             TEXT NOT NULL
                           CHECK (access IN ('read', 'write')),
    approved_at        TEXT,
    status             TEXT NOT NULL
                           CHECK (status IN ('pending', 'active', 'revoked'))
) STRICT;

INSERT INTO connected_members_new
    (local_slug, display_name, role, home_authority, home_instance_slug,
     home_user_id, access, approved_at, status)
SELECT local_slug,
       display_name,
       role,
       home_authority,
       home_instance_slug,
       home_user_id,
       CASE gbrain_scope WHEN 'read' THEN 'read' ELSE 'write' END,
       approved_at,
       status
  FROM connected_members;

DROP TABLE connected_members;
ALTER TABLE connected_members_new RENAME TO connected_members;

CREATE UNIQUE INDEX idx_connected_members_active_identity
    ON connected_members (home_instance_slug, home_user_id)
    WHERE status = 'active';
CREATE INDEX idx_connected_members_status
    ON connected_members (status);
CREATE INDEX idx_connected_members_home_instance
    ON connected_members (home_instance_slug);

-- ── connect_guest_invites: domain already {write, read}; rename in place.
ALTER TABLE connect_guest_invites RENAME COLUMN gbrain_scope TO access;
