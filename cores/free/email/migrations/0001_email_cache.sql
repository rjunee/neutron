-- 0001_email_cache.sql — Email-Managed Core S1 per-project sidecar schema.
--
-- Per docs/plans/email-managed-core-tier1-brief.md § 6.2.
--
-- Lives under cores/free/email-managed/migrations/ — the Core's own
-- migration tree, applied via `applyProjectScopedMigrations(db, dir)`
-- against each project's
-- `<OWNER_HOME>/Projects/<project_id>/email/email-cache.db` sidecar.
--
-- The Gmail API is the source of truth. This cache is a fast-render
-- store for the launcher tile preview, the triage / draft audit
-- logs (durable record never re-derivable from Gmail), the prose-
-- brief summary cache (24h TTL — avoids re-LLM on repeat
-- `/email summarize <thread>` calls), and the per-project label-id
-- cache (avoids a `users.labels.list` round-trip on every per-
-- project email operation).
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so
-- a re-run is a no-op.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;
PRAGMA busy_timeout = 100;

CREATE TABLE IF NOT EXISTS triage_cache (
  -- One row per triage fire. The launcher tile's "today's triage"
  -- preview reads the most-recent row; the daily-triage tab (P5.x)
  -- reads the full history.
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fired_at        INTEGER NOT NULL,
  model           TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  prompt_hash     TEXT NOT NULL,
  top5_json       TEXT NOT NULL,
  chat_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_triage_cache_fired_at
  ON triage_cache(fired_at DESC);

CREATE TABLE IF NOT EXISTS summary_cache (
  -- One row per (message_id, prompt-template-hash) — the LLM-composed
  -- 2-3 sentence brief. TTL'd by `cached_at` (default 24h).
  message_id    TEXT NOT NULL,
  template_hash TEXT NOT NULL,
  brief_text    TEXT NOT NULL,
  model         TEXT NOT NULL,
  prompt_hash   TEXT NOT NULL,
  cached_at     INTEGER NOT NULL,
  PRIMARY KEY (message_id, template_hash)
);

CREATE INDEX IF NOT EXISTS idx_summary_cache_cached_at
  ON summary_cache(cached_at DESC);

CREATE TABLE IF NOT EXISTS draft_audit (
  -- One row per draft. Ops uses this to investigate "did the 4-point
  -- requirement get applied" complaints.
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id         TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  project_id       TEXT,
  applied_labels   TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  model            TEXT,
  outcome          TEXT NOT NULL,
  prompt_hash      TEXT,
  response_excerpt TEXT,
  chat_message_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_draft_audit_created_at
  ON draft_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS email_project_label_cache (
  -- Per-project Gmail user-label resolution cache. ONE row per
  -- project_id; gmail_label_id is the Gmail-side id (looks like
  -- `Label_4567890`).
  project_id     TEXT PRIMARY KEY,
  gmail_label_id TEXT NOT NULL,
  label_name     TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_meta (
  -- Single-row table. Defence-in-depth against a sidecar copied
  -- between projects — the resolver throws EmailSidecarMismatchError
  -- when `project_id` doesn't match the directory.
  schema_version INTEGER NOT NULL,
  project_id     TEXT NOT NULL,
  initialised_at INTEGER NOT NULL
);
