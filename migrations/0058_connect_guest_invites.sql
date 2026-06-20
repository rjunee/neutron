-- 0058_connect_guest_invites.sql
--
-- 2026-06-07 — M2.6 Phase 3 (Neutron Connect: public HTTPS ingress + the
-- OSS-guest auth tier). Adds the per-project `connect_guest_invites` table — the
-- owner-issued, project-scoped, single-use, expiring credential a guest presents
-- at the public `POST /connect/v1/guest-auth` handshake.
--
-- Per docs/plans/m26-ph3-connect-public-ingress-brief.md § 3.1 / § 3.5 (3.10) +
-- docs/research/neutron-oss-cross-org-syndication-2026-06-06.md § 4.1, § 8 #3.
--
-- WHY THIS EXISTS: a guest's Neutron is OSS self-hosted — it has NO account on
-- the hosted auth service, so it cannot obtain the federated multi-aud JWT the
-- trusted path relies on. The relay (connect node) is the SOLE guest authority
-- (research § 8 #3): a guest authenticates by redeeming an invite the owner
-- issued out-of-band, and the connect node mints the guest bearer. This table is
-- that invite ledger. It is TRANSPORT / IDENTITY only — never a memory store.
--
-- SECURITY: the raw invite token is a bearer-like secret. We store ONLY its
-- SHA-256 hash (`token_hash`) so a DB read never leaks a usable invite — the
-- handshake hashes the presented token and matches the hash. Redemption is
-- ATOMIC + SINGLE-USE: a successful claim sets `redeemed_at` under a
-- `redeemed_at IS NULL` guard, so a replayed invite finds 0 rows to claim and
-- 409s (brief § 3.4 invariant 3, test #4c). An expired invite (`expires_at_ms <=
-- now`) is refused before any member write.
--
-- Columns:
--   token_hash         PK; SHA-256 hex of the raw single-use invite token. The
--                      raw token is returned to the owner at issuance and NEVER
--                      stored.
--   project_id         The owner's project (in this instance) the guest joins.
--                      project-scoped: the minted guest bearer carries exactly
--                      this one project membership.
--   display_name_hint  Optional owner-supplied label suggestion (the guest still
--                      self-asserts its own display_name at handshake time).
--   gbrain_scope       'write' | 'read' — RECORDED onto the connected_members
--                      row at accept; CONSUMED by the Ph4 memory layer. Guest
--                      default 'write' (brief capability matrix). 'admin' is
--                      owner-only and not a valid guest invite scope.
--   created_at_ms      Issuance wall-clock (ms since epoch).
--   expires_at_ms      Expiry wall-clock (ms). A claim past this is refused.
--   redeemed_at_ms     NULL until claimed; the single-use marker. Set atomically
--                      under a `redeemed_at_ms IS NULL` guard.
--   redeemed_by_slug   Audit: the meeting-point `local_slug` the redemption
--                      assigned the guest. NULL until redeemed.
--
-- Migration mechanics:
--   STRICT table; CREATE ... atomic under the runner's BEGIN/COMMIT. CHECK pins
--   the gbrain_scope domain (matches repo discipline). Forward-only; never
--   edited. Snapshot regen required (bun run migrations/regen-snapshot.ts).
--
-- Verification (post-migration, per-project DB):
--   SELECT COUNT(*) FROM connect_guest_invites;  -- 0 on a fresh instance
--   SELECT name FROM sqlite_master WHERE type='table' AND name='connect_guest_invites';
--
-- Rollback path: dropping an empty net-new table has no data-loss risk.

CREATE TABLE connect_guest_invites (
    token_hash        TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    display_name_hint TEXT,
    gbrain_scope      TEXT NOT NULL DEFAULT 'write'
                          CHECK (gbrain_scope IN ('write', 'read')),
    created_at_ms     INTEGER NOT NULL,
    expires_at_ms     INTEGER NOT NULL,
    redeemed_at_ms    INTEGER,
    redeemed_by_slug  TEXT
) STRICT;

CREATE INDEX idx_connect_guest_invites_project
    ON connect_guest_invites (project_id);

CREATE INDEX idx_connect_guest_invites_unredeemed
    ON connect_guest_invites (expires_at_ms)
    WHERE redeemed_at_ms IS NULL;
