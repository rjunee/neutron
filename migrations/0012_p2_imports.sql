-- 0012_p2_imports.sql
--
-- P2 S3 — history-import job tracking + chunk-level idempotency dedup +
-- final aggregated results.
--
-- Per docs/plans/P2-onboarding.md § 2.3 (history-import locked design —
-- two-pass map-reduce, $5 per-instance ceiling, per-source caps, idempotent
-- chunk hashing) + § 4.7 (job-runner contract: ImportJob shape).
--
-- Three tables, one per concern:
--
--   1. `import_jobs` — one row per import attempt (ChatGPT zip, Claude.ai
--      zip, Gmail OAuth, Calendar OAuth). Tracks status, dollars spent,
--      timing, error. The job-runner reads this row on every status poll;
--      mid-run crashes leave the row at the last-written status and the
--      next reboot can decide whether to resume or mark failed.
--
--   2. `import_pass1_chunks` — one row per Pass-1-analyzed chunk. The
--      chunk_hash PK is `sha256(conversation_id + ':' + chunk_index +
--      ':' + chunk_text_bytes)` per § 2.3 idempotency rule. Re-running
--      an import a month later hits this table and skips already-
--      analyzed chunks at $0 cost. `dollars_billed` is summed into
--      `import_jobs.dollars_spent` by the job-runner.
--
--   3. `import_results` — one row per completed (or budget-exceeded
--      partial) Pass-2 synthesis. JSON-blob columns hold the final
--      proposed projects / tasks / reminders / entities for the wow-
--      moment dispatcher (S4) + persona-gen voice signals (S2 hookup).
--
-- Forward-only. STRICT typing. No FKs across to the registry's instance
-- table (the per-project DB is logically scoped to one project_slug already; STRICT keeps
-- the column-type guarantees we want).

CREATE TABLE IF NOT EXISTS import_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    source TEXT NOT NULL
        CHECK (source IN (
            'chatgpt-zip',
            'claude-zip',
            'gmail-oauth',
            'calendar-oauth',
            'drive-oauth',
            'notion-oauth',
            'slack-oauth'
        )),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued',
            'pass1-running',
            'pass2-running',
            'completed',
            'failed',
            'budget-exceeded',
            'cancelled'
        )),
    dollars_spent REAL NOT NULL DEFAULT 0,
    pass1_chunks_done INTEGER NOT NULL DEFAULT 0,
    pass1_chunks_total INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error_code TEXT,
    error_message TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS import_jobs_project_status
    ON import_jobs (project_slug, status);

CREATE INDEX IF NOT EXISTS import_jobs_started_at
    ON import_jobs (started_at);

-- Codex r3 P1: composite PK (project_slug, source, chunk_hash) so two
-- instances that happen to import the same chunk text never alias each
-- other's analysis rows. The chunk_hash itself remains content-
-- addressed (sha256(conversation_id, chunk_index, chunk_text_bytes))
-- so re-runs within the same (instance, source) still dedupe correctly,
-- but a brand-new instance always starts at zero cache hits.
CREATE TABLE IF NOT EXISTS import_pass1_chunks (
    project_slug TEXT NOT NULL,
    source TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    job_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_byte_length INTEGER NOT NULL,
    candidate_entities_json TEXT NOT NULL DEFAULT '[]',
    candidate_topics_json TEXT NOT NULL DEFAULT '[]',
    candidate_tasks_json TEXT NOT NULL DEFAULT '[]',
    voice_signals_json TEXT NOT NULL DEFAULT '{}',
    dollars_billed REAL NOT NULL DEFAULT 0,
    analyzed_at INTEGER NOT NULL,
    -- Codex r5 P1: distinguish a finalized chunk (analyzed=1) from a
    -- placeholder claim (analyzed=0). Cache hits ONLY land on
    -- analyzed=1 rows. A budget-stop or substrate-error before
    -- finalize deletes the placeholder so retries can re-process.
    analyzed INTEGER NOT NULL DEFAULT 0
        CHECK (analyzed IN (0, 1)),
    PRIMARY KEY (project_slug, source, chunk_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS import_pass1_chunks_job
    ON import_pass1_chunks (job_id);

CREATE INDEX IF NOT EXISTS import_pass1_chunks_project_source
    ON import_pass1_chunks (project_slug, source);

CREATE TABLE IF NOT EXISTS import_results (
    job_id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    source TEXT NOT NULL,
    projects_json TEXT NOT NULL DEFAULT '[]',
    tasks_json TEXT NOT NULL DEFAULT '[]',
    topics_json TEXT NOT NULL DEFAULT '[]',
    reminders_json TEXT NOT NULL DEFAULT '[]',
    entities_json TEXT NOT NULL DEFAULT '[]',
    voice_signals_json TEXT NOT NULL DEFAULT '{}',
    facts_json TEXT NOT NULL DEFAULT '{}',
    finalized_at INTEGER NOT NULL,
    partial INTEGER NOT NULL DEFAULT 0
        CHECK (partial IN (0, 1))
) STRICT;

CREATE INDEX IF NOT EXISTS import_results_project
    ON import_results (project_slug, finalized_at);
