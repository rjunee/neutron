-- 0057_connected_members_active_identity_unique.sql
--
-- 2026-06-07 — M2.6 Phase 2 (Neutron Connect). Hardens the member-accept path
-- against a TOCTOU race: the `acceptTrustedMember` idempotency pre-check
-- (resolveActiveByHomeIdentity) runs OUTSIDE the insert transaction, so two
-- concurrent accepts for the SAME home identity could both observe "no active
-- row" and both insert an ACTIVE connected_members row.
--
-- Per Argus r1 MINOR-2 (PR #396) + docs/plans/m26-ph2-connect-server-brief.md.
--
-- Invariant (post-0055 security fix — resolution keys on instance slug AND user
-- id, not slug alone): AT MOST ONE active membership per FULL home identity
-- (home_instance_slug, home_user_id). A partial UNIQUE index enforces it at the
-- DB so the losing transaction in a race fails on the constraint and rolls back
-- (both connected_members and project_members writes), rather than stranding a
-- duplicate active identity that the resolver could route to.
--
-- WHERE status = 'active' is deliberate: a member that leaves (status='revoked')
-- then rejoins must be able to mint a FRESH active row while the old revoked
-- row(s) remain for audit. Only active rows participate in the uniqueness set,
-- so revoked/pending duplicates are unconstrained.
--
-- Migration mechanics:
--   Net-new partial UNIQUE index; no table rewrite, no data backfill. A fresh
--   A fresh instance has 0 connected_members rows so there is nothing to conflict. The
--   join handler already maintained "≤1 active per identity" in application
--   code, so any pre-existing project DB also satisfies the invariant.
--   Forward-only; never edited. Snapshot regen required
--   (bun run migrations/regen-snapshot.ts).
--
-- Verification (post-migration, per-project DB):
--   SELECT name FROM sqlite_master WHERE type='index'
--     AND name='idx_connected_members_active_identity';
--
-- Rollback path: dropping an index has no data-loss risk.

CREATE UNIQUE INDEX idx_connected_members_active_identity
    ON connected_members (home_instance_slug, home_user_id)
    WHERE status = 'active';
