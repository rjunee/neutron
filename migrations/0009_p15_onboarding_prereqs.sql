-- 0009_p15_onboarding_prereqs.sql
--
-- P1.5 — four new tables in the per-project DB.
--
-- 1. `secrets` — multi-secret encrypted-at-rest envelope store. Generalizes
--    the per-instance bot store's single-token shape into a (project_slug, kind,
--    label) keyed table. Owned by `auth/secrets-store.ts`.
-- 2. `api_keys` — thin metadata sidecar over `secrets` so listing BYO API
--    keys does not decrypt every row. Owned by `auth/api-key-store.ts`.
-- 3. `signin_events` — append-only journal of post-signin events for the
--    identity ↔ instance-provisioning bridge. Owned by `identity/api/post-
--    signin-hook.ts` + the instance-provisioning sign-in trigger.
-- 4. `inbound_messages` — append-only audit of cross-instance inbound messages
--    received by this instance. Per § 0a.1 risk row 3, the handler MUST write
--    this row BEFORE invoking the channel router so a router-side throw
--    cannot silently swallow a delivered message. Owned by
--    `connect/api/handlers/on-inbound-message.ts`.
--
-- Forward-only. STRICT tables for the locked column types. No declared
-- FKs across to `secrets.id` from `api_keys.secret_id` — callers maintain
-- referential integrity in code (ApiKeyStore.delete drops both rows;
-- ApiKeyStore.add rolls back the secret on api_keys insert failure).

CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    ciphertext TEXT NOT NULL,                                  -- JSON-encoded EncryptedEnvelope
    created_at INTEGER NOT NULL,
    rotated_at INTEGER,
    expires_at INTEGER,
    UNIQUE (project_slug, kind, label)
) STRICT;

CREATE INDEX IF NOT EXISTS secrets_by_project_kind ON secrets (project_slug, kind);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'gemini')),
    label TEXT NOT NULL,
    secret_id TEXT NOT NULL,                                   -- logical FK into secrets.id
    added_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (project_slug, provider, label)
) STRICT;

CREATE TABLE IF NOT EXISTS signin_events (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    oauth_provider TEXT NOT NULL,
    signup_via TEXT NOT NULL CHECK (signup_via IN ('telegram', 'web')),
    occurred_at INTEGER NOT NULL,
    is_first_signin INTEGER NOT NULL CHECK (is_first_signin IN (0, 1)),
    project_slug TEXT,                                         -- populated by sign-in-trigger after provisionInstance
    redirect_url TEXT,
    start_token TEXT                                           -- ed25519 JWT carried by the redirect; P2 redeems by id
) STRICT;

CREATE INDEX IF NOT EXISTS signin_events_by_user ON signin_events (user_id, occurred_at);

CREATE TABLE IF NOT EXISTS inbound_messages (
    ack_id TEXT PRIMARY KEY NOT NULL,
    origin_instance_slug TEXT NOT NULL,
    origin_user_id TEXT NOT NULL,
    receiving_instance_slug TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    speaker_user_id TEXT NOT NULL,
    channel_hint TEXT,
    body_json TEXT NOT NULL,                                   -- opaque receiver-displays-or-persists payload
    received_at INTEGER NOT NULL,
    routed_at INTEGER,                                         -- nullable; populated after the router accepts
    route_status TEXT,                                         -- 'ok' | 'error' | NULL while pending
    route_error TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS inbound_messages_by_origin
    ON inbound_messages (origin_instance_slug, received_at);
