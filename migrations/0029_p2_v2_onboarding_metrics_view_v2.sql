-- 0029_p2_v2_onboarding_metrics_view_v2.sql
--
-- P2 v2 S18 — extend `onboarding_metrics` view with three v2 columns
-- per docs/plans/P2-onboarding-v2.md § 14.3:
--
--   * gap_fill_iterations    — COUNT of `onboarding.gap_fill_iteration`
--                              events (each loop of work_interview_gap_fill).
--   * llm_fallback_count     — COUNT of `onboarding.llm_rephrase_completed`
--                              events whose payload sets
--                              `fallback_used` = 1 (LLM driver failed and
--                              the static fallback body was used).
--   * llm_picked_actions     — the `picks` array from the LLM-picker
--                              selection event
--                              (`onboarding.wow_action_selected`),
--                              scoped per-attempt
--                              (project_slug, user_id, attempt_id) per the
--                              Codex r2 P1 fix already applied to the
--                              sean_ellis subquery in 0023.
--
-- Carries forward 0023's `attempt_id` grouping (the view aggregates per
-- (project_slug, user_id, attempt_id) so a re-started or resumed
-- onboarding flow does not collapse with the original attempt's
-- signup_started_at). All subqueries continue to scope on attempt_id
-- so a restart's wow / sean_ellis / picker rows never bleed across
-- attempts.
--
-- v2 wiring note (2026-05-17): the 3 emit sites
-- (`onboarding.gap_fill_iteration`, `onboarding.llm_rephrase_completed`,
-- `onboarding.wow_action_selected`) are NOT yet routed through
-- OnboardingTelemetry → gateway_events; the view is forward-compatible
-- so the columns will populate as those emits are added in subsequent
-- sprints. Until then the new columns will read 0 / NULL — the day-30
-- PASS/FAIL gates in scripts/onboarding-report.sh tolerate this (0 <= 3
-- and 0 <= 2 both PASS, which is the correct "no data yet" behavior).
--
-- Pattern: a brand-new migration that re-DROPs and re-CREATEs the view
-- (0017 + 0023 are already live in prod, so in-place edits would
-- diverge from applied state). The view-parity test
-- (`onboarding/telemetry/__tests__/event-emitter.test.ts`) is updated
-- in the same PR to compare the canonical `.sql` file against THIS
-- migration's CREATE VIEW body modulo whitespace.
--
-- Forward-only. View-only change (no table modifications).

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
