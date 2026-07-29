-- 0001_research_claims.sql — Research Core S1 per-project sidecar schema.
--
-- Per docs/plans/research-core-tier1-brief.md § 6.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so a
-- re-run is a no-op. The Research Core's own migration tree, applied
-- via `applyProjectScopedMigrations(db, dir)` against each project's
-- `<OWNER_HOME>/Projects/<project_id>/research/research.db` sidecar.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;
PRAGMA busy_timeout = 100;

CREATE TABLE IF NOT EXISTS research_tasks (
  id                   TEXT PRIMARY KEY,
  project_slug          TEXT NOT NULL,
  project_id           TEXT NOT NULL,
  query                TEXT NOT NULL,
  depth                TEXT NOT NULL CHECK(depth IN ('quick','standard','deep')),
  sources_json         TEXT NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  brief_json           TEXT,
  topic                TEXT,
  key_findings_flat    TEXT,
  recommendations_flat TEXT,
  confidence_level     TEXT CHECK(confidence_level IN ('low','medium','high')),
  claim_count          INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER
);

CREATE INDEX IF NOT EXISTS research_tasks_tenant_project_status_idx
  ON research_tasks(project_slug, project_id, status, completed_at DESC);

CREATE TABLE IF NOT EXISTS research_claims (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  project_slug  TEXT NOT NULL,
  claim        TEXT NOT NULL,
  evidence     TEXT,
  citation     TEXT,
  confidence   TEXT NOT NULL CHECK(confidence IN ('low','medium','high','unverified')),
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS research_claims_task_confidence_idx
  ON research_claims(task_id, confidence);

-- Sources-cited invariant: at the DB level we cannot enforce
-- (citation IS NOT NULL OR confidence='unverified') via CHECK
-- without rewriting the row from the application — so the
-- enforcement lives in `assertSourcesCited` (called by the
-- orchestrator BEFORE claim rows write). The schema accepts both
-- states; the application gates them.

CREATE TABLE IF NOT EXISTS research_sub_agent_runs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  project_slug     TEXT NOT NULL,
  model           TEXT NOT NULL,
  budget_ms       INTEGER NOT NULL,
  elapsed_ms      INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL,
  outcome         TEXT NOT NULL CHECK(outcome IN ('ok','timeout','error','concurrency_rejected')),
  error           TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

-- Hybrid lex+vec search over prior briefs. Lex via SQLite FTS5;
-- vec is a deterministic-rank stub for v1 (embeddings land in S2).
-- The `key_findings_flat` + `recommendations_flat` columns are
-- joined-on-write so FTS5 indexes the bullet bodies, not the JSON.
CREATE VIRTUAL TABLE IF NOT EXISTS research_briefs_fts
USING fts5(
  task_id UNINDEXED,
  topic,
  key_findings_flat,
  recommendations_flat
);

-- Sentinel table — every per-project sidecar gets one row written at
-- migration time so cross-project leakage (an attacker pointing the
-- Core at the wrong DB) surfaces as a typed mismatch error instead of
-- a silent data leak. Bootstrap row written by store-resolver.ts on
-- first open; conflicting project_id throws.
CREATE TABLE IF NOT EXISTS research_meta (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version  INTEGER NOT NULL,
  project_slug     TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  initialised_at  INTEGER NOT NULL
);
