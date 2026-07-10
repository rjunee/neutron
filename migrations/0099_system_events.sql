-- 0099_system_events.sql
--
-- O4 (world-class refactor) — product-wide `system_events` degradation
-- journal.
--
-- Generalizes the onboarding `gateway_events` primitive
-- (ts/level/module/event_name/payload_json — the best structured-event
-- shape in the repo) into a product-wide append-only journal for
-- silent fail-soft / degrade decisions.
--
-- WHY A SEPARATE TABLE (not a rename of gateway_events):
--   `gateway_events` carries three onboarding-specific NOT NULL columns —
--   project_slug, user_id, attempt_id — and is read by the
--   `onboarding_metrics` view (0017/0029), the M2 telemetry collectors,
--   and the diagnostics surface. Product-wide degrade events
--   (gbrain_unavailable, prewarm_failed, cron_job_error, …) fire from
--   contexts that have NO onboarding user / attempt, so a rename would
--   force every degrade site to synthesize fake onboarding identity AND
--   force every existing gateway_events reader to change. A fresh table
--   with the SAME primitive but a NULLABLE `project_slug` (and no
--   user_id/attempt_id) preserves every existing reader byte-for-byte
--   while giving degrade emitters a clean home. O5's diagnostics surface
--   re-points its "recent events" section at this table in a follow-up.
--
-- The store (persistence/system-events.ts) follows the gateway_events
-- store idiom verbatim: id/ts/level/module/event_name/payload_json with
-- an optional duration span. STRICT typing; forward-only.

CREATE TABLE IF NOT EXISTS system_events (
    id TEXT PRIMARY KEY NOT NULL,
    ts INTEGER NOT NULL,                                  -- unix-ms
    level TEXT NOT NULL DEFAULT 'warn'
        CHECK (level IN ('info', 'warn', 'error')),
    module TEXT NOT NULL,                                 -- 'gbrain' | 'cores' | 'cron' | …
    event_name TEXT NOT NULL,                             -- degrade decision name
    payload_json TEXT NOT NULL DEFAULT '{}',
    -- Optional instance/project scope. NULL for instance-wide degrade
    -- decisions that have no owning project (most of them).
    project_slug TEXT,
    duration_ms INTEGER                                   -- optional span close
) STRICT;

CREATE INDEX IF NOT EXISTS system_events_ts
    ON system_events (ts);

CREATE INDEX IF NOT EXISTS system_events_module_event
    ON system_events (module, event_name);

-- The diagnostics "recent events" surface + the rising-edge dedup reads
-- (cron_job_error) scan by (event_name, ts DESC); this index serves both.
CREATE INDEX IF NOT EXISTS system_events_name_ts
    ON system_events (event_name, ts);
