-- 0110_connect_guest_invites_revoked.sql
--
-- 2026-07-30 — ISSUES #421 residual: an invite could not be REVOKED.
--
-- THE DEFECT. `connect_guest_invites` had exactly two terminal states, and the
-- owner controlled neither of them: `redeemed_at_ms` is set by the GUEST at the
-- handshake, and `expires_at_ms` is set once at issuance and then only elapses.
-- So an owner who sent an invite link to the wrong address, or simply changed
-- their mind, had no way to withdraw it and had to wait out the 7-day ceiling
-- (`DEFAULT_CONNECT_INVITE_TTL_MS`).
--
-- WHY THAT IS WORSE THAN ONE UNWANTED GUEST. Since #421, `connect/surface-gate.ts`
-- opens the WHOLE `/connect/v1` cross-boundary prefix while a LIVE invite exists.
-- An outstanding unwanted invite therefore does not merely risk one join — it
-- holds the entire cross-instance API reachable from the internet until it
-- lapses. Revocation is the only thing that can close that door on demand.
--
-- WHY A STATUS TRANSITION AND NOT A DELETE. `DELETE FROM connect_guest_invites`
-- would also close the gate, and it was the smaller change. It is the wrong one:
--
--   * The owner loses the audit trail. A deleted row cannot answer "did I ever
--     invite that person, and when did I take it back?" — precisely the question
--     an owner asks after sending a link to the wrong address. `revoked_at_ms`
--     keeps issuance time, expiry, scope, and the moment of withdrawal.
--   * The public edge loses the ability to tell a WITHDRAWN token from one that
--     never existed. With the row gone, a revoked token hashes to nothing and
--     takes the `not_found` path; with the row present, the refusal is a
--     deliberate, informed decision at the boundary (see `guest-invite-store.ts`
--     — revoked is collapsed onto the EXPIRED response on purpose, which is a
--     choice the code can only make if the row still exists).
--   * A hard delete is unrecoverable and racy against an in-flight handshake;
--     a guarded UPDATE composes with the existing single-use claim guard.
--
-- The column is nullable with no default: NULL means "not revoked", which is the
-- state of every existing row, so no backfill is needed and no live invite
-- changes meaning. It mirrors `redeemed_at_ms` exactly — same type, same NULL
-- sentinel, same "set once under a guard" discipline.
--
-- INDEX. `idx_connect_guest_invites_unredeemed` is the partial index the surface
-- gate's hot probe rides (`redeemed_at_ms IS NULL AND expires_at_ms > ?`). That
-- probe now also requires `revoked_at_ms IS NULL`, so the partial predicate is
-- widened to match; SQLite can only use a partial index for a query whose WHERE
-- provably implies the index predicate, and leaving it as-is would keep the
-- index usable but force a residual check on every candidate row. Dropping and
-- recreating an index is not a table rebuild and carries no data-loss risk.
--
-- Migration mechanics: ALTER TABLE ADD COLUMN on a STRICT table (allowed — the
-- added column is a declared INTEGER); atomic under the runner's BEGIN/COMMIT.
-- Forward-only; never edited. Snapshot regen required
-- (bun run migrations/regen-snapshot.ts).
--
-- Verification (post-migration, per-project DB):
--   SELECT COUNT(*) FROM connect_guest_invites WHERE revoked_at_ms IS NOT NULL; -- 0
--
-- Rollback path: the column is additive and nullable; nothing reads it as
-- required. Reverting the code leaves the column inert.

ALTER TABLE connect_guest_invites ADD COLUMN revoked_at_ms INTEGER;

DROP INDEX idx_connect_guest_invites_unredeemed;

CREATE INDEX idx_connect_guest_invites_unredeemed
    ON connect_guest_invites (expires_at_ms)
    WHERE redeemed_at_ms IS NULL AND revoked_at_ms IS NULL;
