-- onboarding-metrics-view.sql — canonical view definition.
--
-- Per docs/plans/P2-onboarding.md § 9.2 + § 9.5 Pass-2 deepening,
-- evolved by:
--   * 0023_p2_onboarding_attempt_id.sql — added `attempt_id` to the
--     grouping key so a re-started onboarding doesn't collapse with
--     the original attempt's signup_started_at.
--   * 0029_p2_v2_onboarding_metrics_view_v2.sql — added three v2
--     columns per docs/plans/P2-onboarding-v2.md § 14.3.
--   * 0066_project_slug_self_identity.sql — OSS-split C4-a1: gateway_events
--     columns renamed to project vocabulary (project_slug → project_slug);
--     event names deliberately unchanged there.
--   * 0069_telemetry_instance_provisioned.sql — OSS-split C4-a2: canonical
--     rebuild emitting the 'signup.instance_provisioned' event family with the
--     derived alias instance_provisioned_at.
--
-- This file is the human-readable canonical statement of the view. The
-- runtime DDL is shipped via the migrations above; this file must stay
-- byte-identical (mod whitespace) to the LATEST migration's CREATE VIEW
-- body so a doc-only refresh of the spec is a single grep target. The
-- `onboarding/telemetry/__tests__/event-emitter.test.ts` view-parity
-- test asserts the latest migration body matches this file modulo
-- whitespace.
--
-- "Did onboarding work for Casey?" — the operational SQL Sam runs on
-- day-30 lives at docs/plans/P2-onboarding.md § 9.5 (the literal day-30
-- query) and is wrapped by scripts/onboarding-report.sh.

-- Codex r2 P1 fix (2026-05-03): the wow_events + sean_ellis subqueries
-- scope on (project_slug, user_id, attempt_id) so workspace instances with
-- multiple onboarded users — or one user with multiple restart attempts
-- — don't inherit aggregates that cross those boundaries. The v2
-- `llm_picked_actions` subquery (added 2026-05-17) inherits the same
-- pattern. Per-instance single-attempt aggregates (the canonical M2 case)
-- still produce the same numbers.
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
