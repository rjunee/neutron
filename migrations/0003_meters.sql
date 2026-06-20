-- 0003_meters.sql
--
-- Per docs/engineering-plan.md § D.2 ("Add `meters` table for D.2 cost
-- records (one row per substrate dispatch)").
--
-- One row per substrate dispatch. The sessions table already records aggregate
-- token + cost columns (Hermes-baseline columns at 0001 lift), but those collapse
-- a multi-call session into one row. The Private substrate (P4) and the cost-
-- attribution observability story (D.2) need per-call granularity — e.g. which
-- substrate_instance_id served each call, what the price-version was at dispatch
-- time, and whether the dispatch errored.
--
-- Conservative scope per Sprint 4 prompt ("only add tables that S1 actually needs;
-- if uncertain, defer to S2+ migrations"): meters lands in S1 because the cost-
-- record shape is locked by D.2 and S3's substrate-adapter implementations will
-- consume it. Topics / projects / linked_sources tables are deferred to S4+ where
-- the consumer schema becomes concrete (channel-bindings JSON, kind/privacy_mode
-- enums, both-sides-consent records).
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS). Wrapped in BEGIN/COMMIT
-- by migrations/runner.ts.

CREATE TABLE IF NOT EXISTS meters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    substrate_kind TEXT NOT NULL,                        -- 'cc' | 'gpt-5-5-codex-cli' | 'gpt-5-5-api' | 'open-weight-h100' | etc.
    substrate_instance_id TEXT,                          -- which CC sub / H100 node / OpenAI account served this call (per § B.P1)
    model TEXT,                                          -- model id at dispatch time
    started_at REAL NOT NULL,                            -- unix seconds
    ended_at REAL,                                       -- unix seconds; NULL until completion event arrives
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    pricing_version TEXT,                                -- which pricing snapshot the cost calc used; doubles as drift-detect for retroactive recalc
    error TEXT                                           -- adapter-emitted error string when the dispatch errored; NULL on success
);

CREATE INDEX IF NOT EXISTS idx_meters_session_id ON meters(session_id);
CREATE INDEX IF NOT EXISTS idx_meters_substrate_kind ON meters(substrate_kind);
CREATE INDEX IF NOT EXISTS idx_meters_substrate_instance_id ON meters(substrate_instance_id);
CREATE INDEX IF NOT EXISTS idx_meters_started_at ON meters(started_at);
