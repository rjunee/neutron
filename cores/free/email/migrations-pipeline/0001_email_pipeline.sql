-- 0001_email_pipeline.sql — the INSTANCE-level email pipeline sidecar.
--
-- Per docs/plans/2026-08-06-email-core-consolidation-plan.md § 5. Lives under
-- cores/free/email/migrations-pipeline/ — its OWN migration tree, applied via
-- `applyProjectScopedMigrations(db, dir)` against
-- `<owner_home>/email/pipeline.db`.
--
-- WHY A SECOND TREE (and why it starts at 0001): a migration namespace is
-- per-DB-FILE — each sidecar gets its own `_migrations` bookkeeping table
-- (migrations/runner.ts:58-63). Reusing the per-project cache tree
-- (`migrations/0001_email_cache.sql`) would drag `triage_cache` /
-- `summary_cache` / `draft_audit` into the pipeline DB and would pin this
-- schema's numbering to a file it shares nothing with. Numbering restarts
-- at 0001 for the same reason the comments sidecar does.
--
-- WHY INSTANCE-LEVEL (not per-project): the inbox is instance-scoped. The
-- multi-account client MERGES accounts into one stream, so a per-project
-- sidecar would have to answer "which project owns this message?" before the
-- classifier has run. Per-project sidecars (triage/summary/draft caches) are
-- untouched by this tree.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so a re-run
-- is a no-op.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;
PRAGMA busy_timeout = 100;

CREATE TABLE IF NOT EXISTS emails (
  -- One row per message the poller has SEEN. Existence of the row is the
  -- idempotency spine: an escalated message stays in INBOX (so the owner
  -- still sees it), and it is this table — not the label set — that stops
  -- the next tick reprocessing it.
  id                   TEXT PRIMARY KEY,
  thread_id            TEXT NOT NULL,
  -- WHICH connected account this was read from, when the fan-out client
  -- stamped one. NULL on a single-account client.
  account_id           TEXT,
  sender               TEXT NOT NULL,
  subject              TEXT NOT NULL,
  snippet              TEXT NOT NULL DEFAULT '',
  body_text            TEXT,
  received_at          INTEGER NOT NULL,
  processed_at         INTEGER NOT NULL,
  -- NULL category = NEVER CLASSIFIED. That is the go-live cutoff record:
  -- mail that predates `checkpoints.go_live_after` is archived without the
  -- classifier ever being invoked on it.
  category             TEXT,
  -- 'escalate' | 'archive'.
  handling             TEXT NOT NULL,
  -- Reserved for the P2 twice-daily brief (the brief this row was reported in).
  brief_id             INTEGER,
  -- FOLDED ESCALATION STATE. Replaces the old standalone
  -- `email_processing_state` table AND the audit-log-based notification
  -- dedup: `escalated_at IS NOT NULL` IS the "already told the owner" guard,
  -- on the same row as the message it guards.
  escalated_at         INTEGER,
  escalation_attempts  INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT
);

-- The resume query's index: pending escalations are
-- (handling='escalate' AND escalated_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_emails_handling_escalated
  ON emails (handling, escalated_at);

CREATE TABLE IF NOT EXISTS sender_cache (
  -- Learned classifications. Bounds LLM cost: a sender classified once is
  -- classified from this table forever after, with no model call.
  sender      TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sender_rules (
  -- Owner-editable sender/domain rules. SHIPS EMPTY — deliberately. There is
  -- no seed row anywhere in this tree: every rule is owner data and lands at
  -- RUNTIME only (P2.5 survey/interview, or the P4 importer). A shipped
  -- taxonomy would be someone else's inbox baked into the product.
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('sender', 'domain')),
  category    TEXT,
  handling    TEXT,
  -- protected=1 ⇒ always important, immune to the mass-mailer downgrade.
  protected   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  -- Keys in use:
  --   go_live_after      — epoch-ms cutoff; mail older than this is archived
  --                        WITHOUT being classified (first-run backlog).
  --   last_poll_at       — epoch-ms of the last successful tick.
  --   consecutive_errors — tick-level failure streak.
  --   scribe_watermark   — reserved for P3 (the email→memory fan-out moves
  --                        off the daily scheduler onto this poller).
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
