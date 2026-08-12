-- 0001_email_pipeline.sql — the OWNER-level email pipeline sidecar.
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
-- WHY OWNER-LEVEL (not per-project): the inbox belongs to the owner. The
-- multi-account client MERGES their accounts into one stream, so a per-project
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
  id                   TEXT NOT NULL,
  thread_id            TEXT NOT NULL,
  -- WHICH connected account this was read from. Gmail message ids are
  -- ACCOUNT-LOCAL, so the id ALONE is not an identity: two connected mailboxes
  -- can carry the same id, and keying on `id` would make the second one look
  -- already-handled and silently drop it — a message the owner never hears
  -- about. '' is the single-account sentinel rather than NULL, because NULL
  -- never compares equal in a composite key, which would let the same message
  -- insert twice and escalate twice.
  account_id           TEXT NOT NULL DEFAULT '',
  sender               TEXT NOT NULL,
  subject              TEXT NOT NULL,
  snippet              TEXT NOT NULL DEFAULT '',
  body_text            TEXT,
  received_at          INTEGER NOT NULL,
  processed_at         INTEGER NOT NULL,
  -- NULL category = NEVER CLASSIFIED. That is the BACKLOG record: mail already
  -- in the inbox when the pipeline was switched on is marked without the
  -- classifier ever being invoked on it.
  category             TEXT,
  -- 'escalate' | 'archive' | 'preexisting'. The last is the backlog
  -- marker: recorded as handled and then left completely alone — never
  -- classified, never escalated, never briefed, and never label-mutated. The
  -- owner had already triaged that mail by hand (decision 2026-08-12), which
  -- SUPERSEDES the original archive-on-cutoff design.
  handling             TEXT NOT NULL,
  -- FOLDED ESCALATION STATE. Replaces the old standalone
  -- `email_processing_state` table AND the audit-log-based notification
  -- dedup: `escalated_at IS NOT NULL` IS the "already told the owner" guard,
  -- on the same row as the message it guards.
  escalated_at         INTEGER,
  escalation_attempts  INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  -- GMAIL-SIDE MUTATION STATE, deliberately SEPARATE from "seen".
  --
  -- The row is written BEFORE the label/archive call, so a message can never
  -- be mutated in Gmail without a durable record of it. But that makes the
  -- row's existence mean only "seen", not "finished": if the mutation then
  -- fails, `hasEmail` would skip the message on every future tick, the
  -- archive would never happen, and — because escalation used to follow the
  -- mutation — the owner would never be told. A data-loss bug traded for a
  -- silent-escalation-loss bug.
  --
  -- So completion is its own fact. `mutated_at IS NULL` on a row whose
  -- handling is 'escalate' or 'archive' means the Gmail write is still owed,
  -- and the poller's retry pass picks it up. `preexisting` rows are complete
  -- on insert: the backlog is deliberately never mutated at all.
  mutated_at           INTEGER,
  mutation_attempts    INTEGER NOT NULL DEFAULT 0,
  -- PUSH state, separate again. Mobile push is best-effort and fires ALONGSIDE
  -- the chat post, so it is not delivery — but it is also not free to repeat.
  -- A chat delivery that fails is retried by the resume pass, and without its
  -- own mark the push went out again on every attempt: the owner's phone buzzed
  -- five times for one email while the chat post never landed. The chat
  -- idempotency key cannot dedupe this; push has no such key.
  pushed_at            INTEGER,
  -- Identity is (account, message), never the message id alone.
  PRIMARY KEY (account_id, id)
);

-- The resume query's index: pending escalations are
-- (handling='escalate' AND escalated_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_emails_handling_escalated
  ON emails (handling, escalated_at);

-- The mutation-retry query: rows still owing a Gmail write are
-- (mutated_at IS NULL AND handling <> 'preexisting').
CREATE INDEX IF NOT EXISTS idx_emails_mutated
  ON emails (mutated_at, handling);

CREATE TABLE IF NOT EXISTS sender_cache (
  -- Learned classifications. Bounds LLM cost: a sender classified once is
  -- classified from this table forever after, with no model call.
  sender      TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  -- The IMPORTANCE decision, stored alongside the category because it is a
  -- SEPARATE fact. Reconstructing it as (category === 'important') silently
  -- dropped every verdict where the two disagree — a receipt that needs the
  -- owner's eye escalated once and was archived from then on.
  important   INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
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
  --   go_live_after      — epoch-ms stamp of first run. PROVENANCE ONLY (P2
  --                        reports from it); it is NOT a per-message gate.
  --   backlog_marked[:id] — the one-time sweep's completion, per account. The
  --                        connected set is dynamic, so a mailbox added later
  --                        gets its own sweep rather than having its history
  --                        read as new mail.
  --   backlog_cursor(s)  — resume cursors for an in-flight sweep.
  --   last_poll_at       — epoch-ms of the last successful tick.
  --   consecutive_errors — tick-level failure streak.
  --   poll_cursor(s)     — continuation cursors for the steady-state walk.
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
