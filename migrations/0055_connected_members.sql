-- 0055_connected_members.sql
--
-- 2026-06-07 — M2.6 Phase 2 (Neutron Connect: member-identity namespacing +
-- the Connect Server). Adds the per-project `connected_members` table — the
-- meeting-point's record of every member that has joined ONE owner's session.
--
-- Per docs/plans/m26-ph2-connect-server-brief.md § 2.2 +
-- docs/research/neutron-oss-cross-org-syndication-2026-06-06.md § 7.2.
--
-- This table is TRANSPORT / IDENTITY ONLY — it is NOT a memory store. It maps
-- a joining member to a meeting-point-assigned, collision-free `local_slug`
-- that matches the LOCKED origin-tag grammar (^[a-z][a-z0-9-]{2,30}$,
-- connect/api/origin-tag.ts:55), so two members named "Sam" from
-- two different home authorities never collide on identity OR on the
-- `origin_instance` attribution tag the Ph1 quarantine guard already inspects.
--
-- Columns (brief § 2.2):
--   local_slug       PK; meeting-point-assigned; matches the origin-tag grammar.
--                    Every turn the member routes is stampOriginTenant(payload,
--                    local_slug). The assigner (tenancy/connect/local-slug.ts)
--                    guarantees grammar-validity + local uniqueness.
--   display_name     human label ("Sam", "Casey"); rendered with the trust badge.
--   trust_class      'owner' | 'trusted' | 'guest'. owner = project creator
--                    (NULL origin_instance home). trusted = a Managed joiner on
--                    the hosted auth service (the M2.5 path — the ONLY class Ph2
--                    creates end-to-end). guest = an OSS self-hosted joiner —
--                    SCHEMA-SUPPORTED here but not creatable until Ph3 wires the
--                    guest-auth handshake + public ingress.
--   home_authority   'auth.example.test' (trusted) | guest handle (Ph3) |
--                    NULL (owner).
--   home_instance_slug ADDITIVE resolution key (not in the brief's column list;
--                    required plumbing to make brief tests #3/#5 implementable —
--                    documented in the PR). The caller's JWT-authenticated origin
--                    instance slug (ConnectAuthContext.origin_instance_slug).
--                    Inbound member turns resolve their `local_slug` by SELECTing
--                    the ACTIVE row whose home_instance_slug = ctx.origin_instance_slug.
--                    NOT UNIQUE — a member that leaves (revoked) then rejoins gets
--                    a fresh active row; at most one row per home_instance_slug is
--                    'active' at a time (enforced in the join handler). NULL (owner).
--   home_user_id     ADDITIVE audit field: the caller's platform user id
--                    (ConnectAuthContext.origin_user_id) at accept time.
--   gbrain_scope     'admin' | 'write' | 'read'. RECORDED in Ph2, CONSUMED by the
--                    Ph4 memory layer. owner → admin; contributor → write (brief
--                    § 2.2). Forward-compatible plumbing only — Ph2 does NOT
--                    provision GBrain scopes / per-contributor OAuth clients.
--   approved_at      ISO-8601 UTC accept timestamp; NULL while 'pending'.
--   status           'pending' | 'active' | 'revoked'. A revoked member's next
--                    authenticated POST /connect/v1/messages 403s (the
--                    resolve_member gate finds no active row).
--
-- Migration mechanics:
--   STRICT table; CREATE ... atomic under the runner's BEGIN/COMMIT. The CHECK
--   constraints pin the enum domains (matches repo discipline — every enum-ish
--   column in the per-project set carries a CHECK). Forward-only; never edited.
--   Snapshot regen required (bun run migrations/regen-snapshot.ts).
--
-- Verification (post-migration, per-project DB):
--   SELECT COUNT(*) FROM connected_members;   -- 0 on a fresh instance
--   SELECT name FROM sqlite_master WHERE type='table' AND name='connected_members';
--
-- Rollback path: dropping an empty net-new table has no data-loss risk.

CREATE TABLE connected_members (
    local_slug       TEXT PRIMARY KEY,
    display_name     TEXT NOT NULL,
    trust_class      TEXT NOT NULL
                         CHECK (trust_class IN ('owner', 'trusted', 'guest')),
    home_authority   TEXT,
    home_instance_slug TEXT,
    home_user_id     TEXT,
    gbrain_scope     TEXT NOT NULL
                         CHECK (gbrain_scope IN ('admin', 'write', 'read')),
    approved_at      TEXT,
    status           TEXT NOT NULL
                         CHECK (status IN ('pending', 'active', 'revoked'))
) STRICT;

CREATE INDEX idx_connected_members_home_instance
    ON connected_members (home_instance_slug);

CREATE INDEX idx_connected_members_status
    ON connected_members (status);
