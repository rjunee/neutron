-- 0016_p2_invites.sql
--
-- P2 S5 — `invites` table.
--
-- Per docs/plans/P2-onboarding.md § 6 S5 line 2157 + § 6a's
-- `tests/integration/promote-to-group-cross-instance.test.ts` Given/When/Then.
-- One row per invite token minted by `onboarding/api/invite-link-generate.ts`.
-- Consumed exactly once by `onboarding/api/invite-accept.ts`; the row is
-- the audit + idempotency surface for one-time-use semantics.
--
-- Idempotency contract: `consumed_at_ms IS NULL` is the active state. The
-- `claim()` path runs:
--
--   UPDATE invites
--      SET consumed_at_ms = ?
--    WHERE token_id = ? AND consumed_at_ms IS NULL
--
-- A claim wins when rowsAffected = 1; loses when it = 0 (already
-- consumed). This avoids the SELECT/UPDATE race two near-simultaneous
-- accept calls would otherwise hit, mirroring the same primitive used
-- by `signup/start-token.ts:claim`.
--
-- Forward-only. STRICT typing. The migration is idempotent on re-run:
-- `IF NOT EXISTS` on every CREATE.
--
-- Columns:
--   * token_id              — JWT jti claim (canonical UUID), PRIMARY KEY.
--   * workspace_instance_slug — the workspace the invitee will join.
--   * invitee_email_hash    — sha256(lowercase(invitee_email)) hex; we
--                              never store the plaintext email.
--   * project_id            — the workspace-side project id the invite
--                              grants access to. Joined via topic
--                              membership; NOT FK-enforced because the
--                              workspace instance lives on a different
--                              host's per-project DB and this row is in
--                              the inviter's DB.
--   * inviter_user_id       — opaque user_id of the user who created
--                              the invite (audit-only).
--   * expires_at_ms         — wall-clock unix-ms after which the token
--                              is rejected by `verifyInviteToken`.
--   * consumed_at_ms        — NULL while pending; populated atomically
--                              when the invitee accepts.
--   * created_at_ms         — wall-clock unix-ms when the invite was
--                              minted (for retention sweeps).

CREATE TABLE IF NOT EXISTS invites (
    token_id TEXT PRIMARY KEY NOT NULL,
    workspace_instance_slug TEXT NOT NULL,
    invitee_email_hash TEXT NOT NULL,
    project_id TEXT NOT NULL,
    inviter_user_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    consumed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS invites_workspace
    ON invites (workspace_instance_slug, created_at_ms);

CREATE INDEX IF NOT EXISTS invites_pending_expiry
    ON invites (expires_at_ms)
    WHERE consumed_at_ms IS NULL;
