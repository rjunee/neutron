-- 0092_project_credentials.sql
--
-- Per-project credential store (Settings-tab credential system, FOUNDATION).
--
-- A credential (a static, long-lived service token — e.g. Meta Ads, Google
-- Ads, an Apify key) can be set at PER-PROJECT scope or at GLOBAL (instance-
-- wide) scope. Resolution is per-project → global → unset (see
-- `ProjectCredentialStore.resolve`), so a single-owner install that only sets
-- global credentials keeps working unchanged, and a project can override a
-- service with its own token.
--
-- This is a NEW table, deliberately NOT an overload of `secrets`. `secrets`
-- keys on a column misleadingly named `project_slug` that actually stores the
-- FROZEN instance `internal_handle` (renaming an instance once silently wiped
-- lookups — see auth/secrets-store.ts header). Genuinely instance-level
-- material (OAuth client, Max tokens) stays in `secrets`; genuinely
-- per-project service tokens live here, keyed on the REAL project id.
--
-- Column rationale:
--
-- * `id` — opaque ULID primary key (sortable, mirrors work_board_items / the
--   notes / comments stores). Rows are ordered by (owner_slug, project_id),
--   never by id.
--
-- * `owner_slug` — the SERVER-derived instance handle (the bearer's
--   `project_slug`, i.e. the owner boundary). Always resolved from the auth
--   token, NEVER client-supplied. This is what keeps one owner from ever
--   reading another owner's credentials: every read binds owner_slug from the
--   bearer, so the per-project dimension below can only ever scope WITHIN a
--   single owner.
--
-- * `project_id` — the REAL per-project id (the value carried on the app-ws
--   upgrade + the `/api/app/projects/<project_id>/...` path, the same id the
--   Cores segment data by). Empty string '' is the GLOBAL sentinel — a real
--   project id is always 1..128 chars (see sanitizeProjectId), so '' can never
--   collide with a project. The scope/sentinel invariant is CHECK-enforced.
--
-- * `scope` — 'project' (project_id is a real project) | 'global' (project_id
--   is the '' sentinel, applies instance-wide as the fallback default).
--
-- * `service` — the credentialed service key, e.g. 'meta_ads', 'google_ads',
--   'apify'. Together with (owner_slug, project_id) it is UNIQUE, so a re-set
--   overwrites in place (upsert at the store).
--
-- * `ciphertext` — the AES-256-GCM envelope JSON (v/iv_b64/ct_b64/tag_b64),
--   produced by the SAME crypto the `secrets` store uses (shared
--   `.neutron-aes-key` keyfile). Plaintext tokens never touch this table.
--
-- * `label` — optional human label the owner typed (e.g. "prod token").
--
-- * `created_at` / `updated_at` / `expires_at` — ISO-8601 UTC TEXT timestamps
--   (match the 0090 / 0077 / 0032 convention, NOT epoch INTEGER). `expires_at`
--   is optional; an expired row resolves as unset (honored at the store).
--
-- Indexes:
--   * the list + resolve path → (owner_slug, project_id).
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE project_credentials (
    id            TEXT PRIMARY KEY NOT NULL,   -- ULID
    owner_slug    TEXT NOT NULL,               -- server-derived instance handle (owner boundary)
    project_id    TEXT NOT NULL,               -- real per-project id; '' == GLOBAL sentinel
    scope         TEXT NOT NULL
                      CHECK (scope IN ('project', 'global')),
    service       TEXT NOT NULL,
    ciphertext    TEXT NOT NULL,               -- AES-256-GCM envelope JSON (never plaintext)
    label         TEXT,
    created_at    TEXT NOT NULL,               -- ISO-8601 UTC
    updated_at    TEXT NOT NULL,               -- ISO-8601 UTC
    expires_at    TEXT,                        -- ISO-8601 UTC; NULL == no expiry
    -- The scope/sentinel invariant: a global row uses the '' project_id, a
    -- project row uses a real (non-empty) project id. Prevents inconsistent
    -- rows from ever landing.
    CHECK (
        (scope = 'global'  AND project_id = '') OR
        (scope = 'project' AND project_id <> '')
    ),
    -- One credential per (owner, project-or-global, service). A re-set
    -- overwrites in place (the store upserts on this key).
    UNIQUE (owner_slug, project_id, service)
) STRICT;

-- The list (one project's credentials) + resolve (per-project → global)
-- paths both scan by owner + project.
CREATE INDEX idx_project_credentials_scope
    ON project_credentials (owner_slug, project_id);
