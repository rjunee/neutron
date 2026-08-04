-- 0115_project_account_selection.sql
--
-- Per-project CONNECTED-ACCOUNT selection (ISSUES #500).
--
-- Connecting an account stays GLOBAL: one consent, one access token, one
-- refresh token, one thing to rotate. What becomes per-project is which of the
-- already-connected accounts a project READS. Without this, every project
-- sweeps every connected account, so a question asked inside a work project
-- reads a personal calendar and mailbox, and each newly connected account makes
-- every query in every project noisier and slower.
--
-- ── WHY THIS IS A DISABLE LIST, NOT AN ENABLE LIST ─────────────────────────
--
-- The observable default MUST be unchanged behaviour:
--
--   * a project that has never been configured sees ALL accounts;
--   * a newly connected account is visible in EVERY project, including ones
--     that already narrowed their selection.
--
-- An enable-list cannot express either of those without a second "has this
-- project been configured yet?" bit, and a newly connected account would be
-- invisible everywhere until each project was re-visited — silently breaking
-- "connect once, works everywhere". A DISABLE list gets both for free by
-- construction: absence of a row IS enablement, so unset means enabled and a
-- brand-new account_id can never match an existing row.
--
-- Column rationale:
--
-- * `owner_slug` — the SERVER-derived instance handle (the bearer's
--   `project_slug`, the owner boundary), never client-supplied. Same boundary
--   discipline as `project_credentials` (0092); registered in
--   `migrations/scope-rekey.ts` so a rename re-keys these rows too.
--
-- * `project_id` — the REAL per-project id. Unlike `project_credentials` there
--   is NO global sentinel row: a disable is only ever meaningful inside one
--   project, and '' (the no-project/General frame) must always resolve to "no
--   selection → every account". The CHECK below makes storing '' impossible,
--   so the General topic can never inherit a narrowing.
--
-- * `service` — the service key the account belongs to (`google_calendar`,
--   `gmail_compose`, `google_workspace`, …). The same key
--   `CoreCredentialResolver.accountsFor(service)` is called with.
--
-- * `account_id` — the account's stable id WITHIN that service, exactly the
--   `ResolvedAccount.account_id` the resolver tags results with (an OAuth
--   grant's `account_key`, or the `'default'` sentinel for a legacy un-keyed
--   grant). Storing the resolver's own id — rather than an email — means the
--   filter is an id-set membership test with no re-derivation, and a
--   re-connected account keeps its selection because its key is derived from
--   the same address.
--
-- * `disabled_at` — ISO-8601 UTC TEXT (the 0092 / 0090 convention), so the
--   surface can show when a project turned an account off.
--
-- The composite PRIMARY KEY is also the read index: the resolver's hot path
-- looks up (owner_slug, project_id, service), a prefix of the key, so no
-- secondary index is needed.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE project_account_selection (
    owner_slug  TEXT NOT NULL,               -- server-derived instance handle (owner boundary)
    project_id  TEXT NOT NULL,               -- REAL project id; '' is never stored
    service     TEXT NOT NULL,               -- resolver service key
    account_id  TEXT NOT NULL,               -- ResolvedAccount.account_id
    disabled_at TEXT NOT NULL,               -- ISO-8601 UTC
    -- '' is the no-project frame (General topic / cron / system dispatch). It
    -- must always mean "no selection", so it can never carry a disable row.
    CHECK (project_id <> ''),
    CHECK (service <> ''),
    CHECK (account_id <> ''),
    PRIMARY KEY (owner_slug, project_id, service, account_id)
) STRICT;
