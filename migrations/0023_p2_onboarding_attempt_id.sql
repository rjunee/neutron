-- 0021_p2_onboarding_attempt_id.sql
--
-- Sprint 30 (S6.5 deferred from Sprint 17) — per-attempt onboarding
-- metrics. Adds `attempt_id` to `gateway_events` AND to `onboarding_state`
-- and rebuilds the `onboarding_metrics` view to GROUP BY (project_slug,
-- user_id, attempt_id) so a re-started or resumed onboarding flow no
-- longer collapses with the original attempt's signup_started_at.
--
-- Why this matters:
--   - Sprint 17 shipped `onboarding_metrics` keyed on (project_slug,
--     user_id). A user who restarts onboarding (re-signin after the
--     first attempt timed out, manually wiped state, etc.) overwrites
--     `signup_started_at` via the view's MIN() / re-emits a fresh
--     `signup.started` event whose ts collapses with the prior row's
--     phase_advances counter. The day-30 query in P2 § 9.5 cannot
--     distinguish a clean first-pass from a recovered restart.
--   - Threading `attempt_id` through `OnboardingTelemetry.emit` and
--     grouping the view by it is the locked fix.
--
-- Where the canonical attempt_id lives:
--   - `onboarding_state.attempt_id` is the source of truth. The engine
--     mints a fresh UUID when a brand-new row is created (initial
--     `signup` → `name_chosen` transition); a resumed row keeps its
--     value. An admin reset deletes the row entirely; the next start
--     mints a new id.
--   - Telemetry resolves the attempt_id via the composer-wired hook
--     that reads this column.
--
-- Backfill policy:
--   - Existing `gateway_events` rows (pre-S30) and any pre-existing
--     `onboarding_state` rows get `attempt_id = 'legacy-pre-S30'` so
--     historical aggregates collapse to one row per instance rather
--     than NULL-vs-NEW two-row noise. The view treats this as just
--     another attempt; the rollup query in M2 dashboards filters it
--     when needed.
--
-- Forward-only.

ALTER TABLE gateway_events ADD COLUMN attempt_id TEXT NOT NULL DEFAULT 'legacy-pre-S30';

CREATE INDEX IF NOT EXISTS gateway_events_attempt
    ON gateway_events (project_slug, user_id, attempt_id);

ALTER TABLE onboarding_state ADD COLUMN attempt_id TEXT NOT NULL DEFAULT 'legacy-pre-S30';

-- Rebuild the onboarding_metrics view: aggregate by (project_slug,
-- user_id, attempt_id). The wow_actions / sean_ellis subqueries
-- continue to scope on (project_slug, user_id, attempt_id) so a
-- restart's wow row never bleeds into the prior attempt's aggregate.
DROP VIEW IF EXISTS onboarding_metrics;
CREATE VIEW onboarding_metrics AS
SELECT
  e.project_slug,
  e.user_id,
  e.attempt_id,
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
      AND g.attempt_id = e.attempt_id
      AND g.event_name = 'onboarding.sean_ellis_response'
    ORDER BY g.ts DESC
    LIMIT 1) AS sean_ellis_response,
  (MIN(CASE WHEN e.event_name = 'onboarding.wow_dispatched' THEN e.ts END) -
   MIN(CASE WHEN e.event_name = 'signup.started'            THEN e.ts END)) AS time_to_wow_ms
FROM gateway_events e
WHERE e.module IN ('onboarding', 'signup')
GROUP BY e.project_slug, e.user_id, e.attempt_id;
