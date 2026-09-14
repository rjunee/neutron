-- Phase keys mirror the model-phase registry; the accounting test enforces parity.
CREATE TABLE code_trident_usage_phases (
    phase TEXT PRIMARY KEY NOT NULL
) STRICT;
INSERT INTO code_trident_usage_phases (phase) VALUES
    ('decomposition'), ('build'), ('build_mechanical'), ('review_rubric'),
    ('review_adversarial'), ('review_codex'), ('review_kimi'), ('synthesis'), ('bookkeeping');

-- Each report replaces the absolute cumulative totals for one phase of one run.
-- NULL always means unreported, including for phases that have never run.
CREATE TABLE code_trident_phase_usage (
    run_id TEXT NOT NULL REFERENCES code_trident_runs(id) ON DELETE CASCADE,
    phase TEXT NOT NULL REFERENCES code_trident_usage_phases(phase),
    status TEXT NOT NULL DEFAULT 'unknown',
    input_tokens INTEGER CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
    output_tokens INTEGER CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
    cache_read_tokens INTEGER CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
    cache_creation_tokens INTEGER CHECK (cache_creation_tokens BETWEEN 0 AND 9007199254740991),
    cost_usd REAL CHECK (cost_usd >= 0 AND cost_usd <= 1.7976931348623157e308),
    source TEXT,
    observed_at INTEGER CHECK (observed_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (run_id, phase),
    CHECK (
        (status = 'unknown' AND source IS NULL AND observed_at IS NULL
            AND input_tokens IS NULL AND output_tokens IS NULL
            AND cache_read_tokens IS NULL AND cache_creation_tokens IS NULL AND cost_usd IS NULL)
        OR
        (status IN ('partial', 'complete') AND source IS NOT NULL AND length(trim(source)) > 0
            AND observed_at IS NOT NULL
            AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                OR cache_read_tokens IS NOT NULL OR cache_creation_tokens IS NOT NULL OR cost_usd IS NOT NULL)
            AND ((status = 'complete') = (input_tokens IS NOT NULL AND output_tokens IS NOT NULL
                AND cache_read_tokens IS NOT NULL AND cache_creation_tokens IS NOT NULL AND cost_usd IS NOT NULL)))
    )
) STRICT;

INSERT INTO code_trident_phase_usage (run_id, phase)
    SELECT r.id, p.phase FROM code_trident_runs r CROSS JOIN code_trident_usage_phases p;

CREATE TRIGGER code_trident_runs_seed_usage AFTER INSERT ON code_trident_runs
BEGIN
    INSERT INTO code_trident_phase_usage (run_id, phase)
        SELECT NEW.id, phase FROM code_trident_usage_phases;
END;
