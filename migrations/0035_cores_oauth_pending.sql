-- 0035_cores_oauth_pending.sql
--
-- Cores OAuth pending-flow store. One row per in-flight Google OAuth
-- code exchange. The per-instance gateway writes a row in
-- /api/cores/oauth/google/start with the CSRF state + PKCE code_verifier
-- + the labels the user is granting; the gateway's ingest handler
-- (called by identity after the platform-callback returns) consumes the
-- row, exchanges the code, writes secrets, and deletes the row.
--
-- TTL 10 minutes; expired rows are swept by a periodic cron.
--
-- Cross-refs:
--   docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 3.2

CREATE TABLE cores_oauth_pending (
    state               TEXT PRIMARY KEY NOT NULL,
    project_slug         TEXT NOT NULL,              -- frozen internal_handle
    code_verifier       TEXT NOT NULL,              -- PKCE; Google validates against authorize-time code_challenge
    labels_json         TEXT NOT NULL,              -- JSON array of labels this grant covers
    redirect_uri        TEXT NOT NULL,              -- the auth service callback URL
    started_at          INTEGER NOT NULL,           -- ms epoch
    expires_at          INTEGER NOT NULL,           -- started_at + 10*60*1000
    consumed_at         INTEGER                     -- set on successful exchange; row pruned after
) STRICT;

CREATE INDEX cores_oauth_pending_expires
    ON cores_oauth_pending(expires_at);
