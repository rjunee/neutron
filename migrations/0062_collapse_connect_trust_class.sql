-- 0062_collapse_connect_trust_class.sql
--
-- 2026-06-08 — Neutron Connect membership-model collapse (obviates ISSUES #114).
-- Per docs/plans/connect-trust-class-collapse-brief.md +
-- docs/research/neutron-114-connect-model-reconciliation-2026-06-08.md.
--
-- WHAT THIS DOES: collapses the deployment-derived three-value trust class
-- (`owner | trusted | guest`) on `connected_members` to a single non-owner role
-- (`owner | collaborator`), and RENAMES the column `trust_class` → `role`.
--
-- WHY: the shipped model keyed a member's IDENTITY CLASS on where they were
-- hosted — Managed VPS → 'trusted', Neutron Open self-hosted → 'guest'. That
-- violates the locked principle that hosting shape MUST NOT change what a
-- collaborator gets (research § 0, neutron-open-vs-managed-architecture-2026-05-17
-- :8). There is ONE owner per project plus collaborators; the authentication
-- MECHANISM (Managed OAuth vs self-hosted token handshake) is an implementation
-- detail, never a tier. The capability axis is `gbrain_scope` (unchanged here).
-- 'role' is display-only — nothing downstream gates on it.
--
-- BACKFILL: every existing 'trusted' OR 'guest' row → 'collaborator'. Owner rows
-- are untouched. Per #114 trusted ISSUANCE was deferred (returns
-- workspace_unavailable), so production almost certainly holds ZERO 'trusted'
-- rows; the backfill collapses the reachable 'guest' rows → 'collaborator' and is
-- otherwise a no-op. This is why the collapse is cheapest NOW — we delete an
-- unbuilt distinction instead of completing it.
--
-- Migration mechanics:
--   SQLite CHECK constraints are immutable and there is no ALTER COLUMN, so the
--   only safe path is the table-rebuild dance (precedent: migration 0027, 0034):
--     1. build connected_members_new with the renamed `role` column + the
--        relaxed CHECK (`role IN ('owner','collaborator')`),
--     2. copy every row, rewriting trust_class → role with the
--        trusted|guest → collaborator backfill (owner passes through),
--     3. swap tables + re-create ALL THREE indexes that existed on the old table
--        (the partial UNIQUE active-identity index from 0057, the home_instance
--        index, and the status index from 0055).
--   The runner wraps the body in implicit BEGIN/COMMIT so the rebuild is atomic.
--   Forward-only; never edited. STRICT typing preserved. Snapshot regen required
--   (bun run migrations/regen-snapshot.ts).
--
--   `connect_guest_invites` (migration 0058) carries NO trust/role class column
--   (only a gbrain_scope CHECK), so it needs no change here.
--
-- Verification (post-migration, per-project DB):
--   SELECT COUNT(*) FROM connected_members WHERE role NOT IN ('owner','collaborator'); -- 0
--   SELECT name FROM pragma_table_info('connected_members') WHERE name='trust_class';  -- empty
--   SELECT name FROM pragma_table_info('connected_members') WHERE name='role';          -- role
--
-- Rollback path: reversing the rename + re-widening the CHECK would lose the
-- pre-collapse trusted/guest distinction (already backfilled to 'collaborator');
-- the accepted recovery path is a from-snapshot restore of the pre-migration
-- project DB. The migration is near-empty in prod (≈zero affected rows), so the
-- backup-then-migrate window is trivial.

CREATE TABLE connected_members_new (
    local_slug       TEXT PRIMARY KEY,
    display_name     TEXT NOT NULL,
    role             TEXT NOT NULL
                         CHECK (role IN ('owner', 'collaborator')),
    home_authority   TEXT,
    home_instance_slug TEXT,
    home_user_id     TEXT,
    gbrain_scope     TEXT NOT NULL
                         CHECK (gbrain_scope IN ('admin', 'write', 'read')),
    approved_at      TEXT,
    status           TEXT NOT NULL
                         CHECK (status IN ('pending', 'active', 'revoked'))
) STRICT;

INSERT INTO connected_members_new
    (local_slug, display_name, role, home_authority, home_instance_slug,
     home_user_id, gbrain_scope, approved_at, status)
SELECT local_slug,
       display_name,
       CASE trust_class
            WHEN 'owner' THEN 'owner'
            ELSE 'collaborator'
       END,
       home_authority,
       home_instance_slug,
       home_user_id,
       gbrain_scope,
       approved_at,
       status
  FROM connected_members;

DROP TABLE connected_members;
ALTER TABLE connected_members_new RENAME TO connected_members;

-- Re-create all three indexes that lived on the old table (0055 + 0057).
CREATE UNIQUE INDEX idx_connected_members_active_identity
    ON connected_members (home_instance_slug, home_user_id)
    WHERE status = 'active';

CREATE INDEX idx_connected_members_home_instance
    ON connected_members (home_instance_slug);

CREATE INDEX idx_connected_members_status
    ON connected_members (status);
