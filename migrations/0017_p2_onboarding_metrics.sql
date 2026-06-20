-- 0017_p2_onboarding_metrics.sql
--
-- P2 S6 — telemetry events table + onboarding_metrics SQL view.
--
-- Per docs/plans/P2-onboarding.md § 5 (telemetry / observability hooks
-- lines 1754-1808), § 9.2 (data collection — onboarding_metrics view),
-- and § 9.5 Pass-2 deepening (telemetry data schema + storage location).
--
-- Two surfaces in this migration:
--
--   1. `gateway_events` — append-only structured event log. Every event
--      emitted via OnboardingTelemetry lands here AND in the structured-
--      JSON log (via the EventLogger sink). The view below aggregates
--      from this table to answer "did onboarding work for Casey?"
--      (§ 9.5 day-30 query).
--
--      The spec says gateway_events was already shipped on main via
--      migration 0004_gateway_core.sql; that's incorrect (verified
--      2026-05-02 — 0004 only ships topics / reminders / tool_approvals
--      / cron_state / watchdog_alerts). This migration creates it.
--
--   2. `onboarding_metrics` view — aggregates gateway_events + wow_events
--      into one row per (project_slug, user_id) with the metrics § 9.5
--      defines: signup_started_at, oauth_complete_at, instance_provisioned_at,
--      import_done_at, persona_committed_at, wow_dispatched_at,
--      completed_at, abandoned_at, failed_at, phase_advances,
--      persona_regens, button_timeouts, wow_actions_fired,
--      wow_actions_succeeded, sean_ellis_response, time_to_wow_ms.
--
-- The view's contract is that callers query it by project_slug; the
-- per-project DB scope already constrains rows. STRICT typing on the
-- table; views inherit column affinity from their source.
--
-- Forward-only.

CREATE TABLE IF NOT EXISTS gateway_events (
    id TEXT PRIMARY KEY NOT NULL,
    ts INTEGER NOT NULL,                                  -- unix-ms
    level TEXT NOT NULL DEFAULT 'info'
        CHECK (level IN ('info', 'warn', 'error')),
    project_slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    module TEXT NOT NULL,                                 -- 'onboarding' | 'signup' | …
    event_name TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    duration_ms INTEGER                                   -- optional span close
) STRICT;

CREATE INDEX IF NOT EXISTS gateway_events_project_event
    ON gateway_events (project_slug, event_name);

CREATE INDEX IF NOT EXISTS gateway_events_ts
    ON gateway_events (ts);

CREATE INDEX IF NOT EXISTS gateway_events_module_event
    ON gateway_events (module, event_name);

-- onboarding_metrics — the view § 9.2 + § 9.5 specify. Aggregates one
-- row per (project_slug, user_id). The day-30 "did onboarding work for
-- Casey?" SQL (§ 9.5) selects directly from this view.
--
-- DROP first so re-applying a fresh schema picks up any future column
-- changes; SQLite has no CREATE OR REPLACE VIEW.

-- Codex r2 P1 fix (2026-05-03): the wow_events + sean_ellis subqueries
-- scope on (project_slug, user_id) so workspace instances with multiple
-- onboarded users don't inherit instance-wide aggregates. Per-instance
-- aggregates (the canonical M2 single-user case) still produce the
-- same numbers.
--
-- wow_events.user_id is sourced from `onboarding.wow_dispatched`'s
-- payload — the dispatcher emits ONE event per onboarding flow, and
-- wow_events rows are always written within that flow's project_slug.
-- For per-user attribution in workspace instances, wow_events rows are
-- correlated via the dispatch's `gateway_events` row (event_name =
-- 'onboarding.wow_action_fired', payload.action_id). Single-instance
-- aggregates remain a backstop for instances where no per-user
-- wow_action_fired events exist.

DROP VIEW IF EXISTS onboarding_metrics;
CREATE VIEW onboarding_metrics AS
SELECT
  e.project_slug,
  e.user_id,
  MIN(CASE WHEN e.event_name = 'signup.started'                    THEN e.ts END) AS signup_started_at,
  MIN(CASE WHEN e.event_name = 'signup.oauth_complete'             THEN e.ts END) AS oauth_complete_at,
  MIN(CASE WHEN e.event_name = 'signup.instance_provisioned'         THEN e.ts END) AS instance_provisioned_at,
  MIN(CASE WHEN e.event_name = 'onboarding.import_pass2_complete'  THEN e.ts END) AS import_done_at,
  MIN(CASE WHEN e.event_name = 'onboarding.persona_committed'      THEN e.ts END) AS persona_committed_at,
  MIN(CASE WHEN e.event_name = 'onboarding.wow_dispatched'         THEN e.ts END) AS wow_dispatched_at,
  MIN(CASE WHEN e.event_name = 'onboarding.completed'              THEN e.ts END) AS completed_at,
  MIN(CASE WHEN e.event_name = 'onboarding.abandoned'              THEN e.ts END) AS abandoned_at,
  MIN(CASE WHEN e.event_name = 'onboarding.failed'                 THEN e.ts END) AS failed_at,
  COUNT(CASE WHEN e.event_name = 'onboarding.phase_advanced'       THEN 1 END)    AS phase_advances,
  COUNT(CASE WHEN e.event_name = 'onboarding.persona_regen'        THEN 1 END)    AS persona_regens,
  COUNT(CASE WHEN e.event_name = 'onboarding.button_timeout'       THEN 1 END)    AS button_timeouts,
  COUNT(CASE WHEN e.event_name = 'onboarding.wow_action_fired'     THEN 1 END)    AS wow_actions_fired,
  COUNT(CASE WHEN e.event_name = 'onboarding.wow_action_fired'
              AND JSON_EXTRACT(e.payload_json, '$.success') = 1    THEN 1 END)    AS wow_actions_succeeded,
  (SELECT JSON_EXTRACT(payload_json, '$.response')
     FROM gateway_events g
    WHERE g.project_slug = e.project_slug
      AND g.user_id = e.user_id
      AND g.event_name = 'onboarding.sean_ellis_response'
    ORDER BY g.ts DESC
    LIMIT 1) AS sean_ellis_response,
  (MIN(CASE WHEN e.event_name = 'onboarding.wow_dispatched' THEN e.ts END) -
   MIN(CASE WHEN e.event_name = 'signup.started'            THEN e.ts END)) AS time_to_wow_ms
FROM gateway_events e
WHERE e.module IN ('onboarding', 'signup')
GROUP BY e.project_slug, e.user_id;
