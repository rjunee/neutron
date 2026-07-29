-- 0069: telemetry vocabulary — the `onboarding_metrics` view's canonical
-- definition (OSS-split C4-a2; execution brief § 4 C4-(a) telemetry item).
--
-- Post-collapse (A2 migration-collapse): the historical `gateway_events`
-- columns are emitted in PROJECT vocabulary directly (0017 onward), and the
-- onboarding telemetry event family is emitted in INSTANCE vocabulary
-- (`signup.instance_provisioned`) by the TS emitter
-- (onboarding/telemetry/event-emitter.ts) from a fresh install — there is no
-- prior-vocabulary row to UPDATE (no prod users; the forward data-rewrite that
-- once lived here is dropped). This migration is now purely the canonical,
-- deterministic rebuild of the `onboarding_metrics` view so its definition in
-- sqlite_master is fixed (not SQLite's mechanical rewrite of an earlier view).
--
-- The view consumers (instance-provisioning/onboarding-api/
-- admin-observability.ts) keep their existing TS row shape by aliasing the
-- `instance_provisioned_at` column in their own SELECT — symbol renames are C4-b.
--
-- Migration mechanics: forward-only; view rebuild only (views carry no data).
-- Atomic under the runner's per-migration BEGIN/COMMIT.
--
-- Verification (post-migration, per-instance DB):
--   SELECT instance_provisioned_at FROM onboarding_metrics LIMIT 0;  -- parses

DROP VIEW IF EXISTS onboarding_metrics;

CREATE VIEW onboarding_metrics AS
SELECT
  e.project_slug,
  e.user_id,
  e.attempt_id,
  MIN(CASE WHEN e.event_name = 'signup.started'                    THEN e.ts END) AS signup_started_at,
  MIN(CASE WHEN e.event_name = 'signup.oauth_complete'             THEN e.ts END) AS oauth_complete_at,
  MIN(CASE WHEN e.event_name = 'signup.instance_provisioned'       THEN e.ts END) AS instance_provisioned_at,
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
  COUNT(CASE WHEN e.event_name = 'onboarding.gap_fill_iteration'   THEN 1 END)    AS gap_fill_iterations,
  COUNT(CASE WHEN e.event_name = 'onboarding.llm_rephrase_completed'
              AND JSON_EXTRACT(e.payload_json, '$.fallback_used') = 1 THEN 1 END) AS llm_fallback_count,
  (SELECT JSON_EXTRACT(payload_json, '$.response')
     FROM gateway_events g
    WHERE g.project_slug = e.project_slug
      AND g.user_id = e.user_id
      AND g.attempt_id = e.attempt_id
      AND g.event_name = 'onboarding.sean_ellis_response'
    ORDER BY g.ts DESC
    LIMIT 1) AS sean_ellis_response,
  (SELECT JSON_EXTRACT(payload_json, '$.picks')
     FROM gateway_events g
    WHERE g.project_slug = e.project_slug
      AND g.user_id = e.user_id
      AND g.attempt_id = e.attempt_id
      AND g.event_name = 'onboarding.wow_action_selected'
    LIMIT 1) AS llm_picked_actions,
  (MIN(CASE WHEN e.event_name = 'onboarding.wow_dispatched' THEN e.ts END) -
   MIN(CASE WHEN e.event_name = 'signup.started'            THEN e.ts END)) AS time_to_wow_ms
FROM gateway_events e
WHERE e.module IN ('onboarding', 'signup')
GROUP BY e.project_slug, e.user_id, e.attempt_id;
