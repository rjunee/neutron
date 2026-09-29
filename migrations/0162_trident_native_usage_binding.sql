-- Optional accounting provenance outlives child admission. It grants no result,
-- dispatch, or lease-release authority. Existing attempts remain unbound.
CREATE TABLE IF NOT EXISTS code_trident_native_usage_bindings (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    binding TEXT NOT NULL CHECK (json_valid(binding)),
    checked_at INTEGER CHECK (checked_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (run_id, step_id, attempt_id),
    FOREIGN KEY (run_id, step_id, attempt_id)
      REFERENCES code_trident_attempts(run_id, step_id, attempt_id) ON DELETE CASCADE
) STRICT;
