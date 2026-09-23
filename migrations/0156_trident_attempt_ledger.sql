-- A host-owned identity per actual dispatch; retries are distinct attempts.
CREATE TABLE IF NOT EXISTS code_trident_attempts (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL CHECK (length(trim(step_id)) > 0),
    attempt_id TEXT NOT NULL CHECK (length(trim(attempt_id)) > 0),
    phase TEXT NOT NULL,
    task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0),
    head_sha TEXT NOT NULL CHECK (length(trim(head_sha)) > 0),
    role TEXT NOT NULL CHECK (length(trim(role)) > 0),
    review_seat TEXT,
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    requested_model TEXT NOT NULL CHECK (length(trim(requested_model)) > 0),
    resolved_model TEXT NOT NULL CHECK (length(trim(resolved_model)) > 0),
    placement TEXT NOT NULL CHECK (placement IN ('in-repl', 'headless')),
    queued_at INTEGER NOT NULL CHECK (queued_at BETWEEN 0 AND 9007199254740991),
    prepared_at INTEGER CHECK (prepared_at BETWEEN queued_at AND 9007199254740991),
    started_at INTEGER CHECK (started_at BETWEEN queued_at AND 9007199254740991),
    ended_at INTEGER CHECK (ended_at BETWEEN queued_at AND 9007199254740991),
    outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'refused', 'failed', 'unknown', 'interrupted')),
    PRIMARY KEY (run_id, step_id, attempt_id),
    FOREIGN KEY (run_id, phase) REFERENCES code_trident_phase_usage(run_id, phase) ON DELETE CASCADE,
    CHECK (prepared_at IS NULL OR started_at IS NULL OR prepared_at <= started_at),
    CHECK (started_at IS NULL OR ended_at IS NULL OR started_at <= ended_at),
    CHECK (prepared_at IS NULL OR ended_at IS NULL OR prepared_at <= ended_at),
    CHECK ((outcome IS NULL) = (ended_at IS NULL))
) STRICT;

-- Absolute provider observations for ONE attempt, never phase deltas.
CREATE TABLE IF NOT EXISTS code_trident_attempt_receipts (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL CHECK (length(trim(receipt_id)) > 0),
    source TEXT NOT NULL CHECK (length(trim(source)) > 0),
    observed_at INTEGER NOT NULL CHECK (observed_at BETWEEN 0 AND 9007199254740991),
    model_reported TEXT,
    input_tokens INTEGER CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
    output_tokens INTEGER CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
    cache_read_tokens INTEGER CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
    cache_creation_tokens INTEGER CHECK (cache_creation_tokens BETWEEN 0 AND 9007199254740991),
    cost_usd REAL CHECK (cost_usd BETWEEN 0 AND 1.7976931348623157e308),
    PRIMARY KEY (run_id, step_id, attempt_id),
    UNIQUE (run_id, source, receipt_id),
    FOREIGN KEY (run_id, step_id, attempt_id) REFERENCES code_trident_attempts(run_id, step_id, attempt_id) ON DELETE CASCADE
) STRICT;
