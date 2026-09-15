-- Incremental transcript accounting. One accepted token_count line becomes one event.
CREATE TABLE transcript_usage_watermarks (
    source_path TEXT PRIMARY KEY NOT NULL,
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0)
) STRICT;

CREATE TABLE transcript_usage_events (
    source_path TEXT NOT NULL,
    line_offset INTEGER NOT NULL CHECK (line_offset >= 0),
    observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
    project TEXT NOT NULL,
    topic TEXT NOT NULL,
    agent TEXT NOT NULL,
    phase TEXT NOT NULL,
    run_id TEXT,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
    PRIMARY KEY (source_path, line_offset),
    CHECK (cache_read_tokens <= input_tokens),
    CHECK (reasoning_tokens <= output_tokens)
) STRICT;

CREATE INDEX idx_transcript_usage_events_run ON transcript_usage_events (run_id);
CREATE INDEX idx_transcript_usage_events_observed ON transcript_usage_events (observed_at);
