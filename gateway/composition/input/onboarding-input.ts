import type {
  OnboardingTelemetry,
  EventLogger as OnboardingEventLogger,
  SeanEllisChannel,
} from '@neutronai/onboarding/telemetry/index.ts'
import type { MorningBriefDeliverInput } from '@neutronai/onboarding/overnight/morning-brief.ts'
import type { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'

export interface OnboardingCompositionInput {
  /**
   * Optional onboarding telemetry config. When unset, the
   * `onboarding-telemetry` module still composes
   * `OnboardingTelemetry` + the typed sinks but does NOT register the
   * Sean Ellis cron (the cron requires a real channel + resolveContext
   * adapter the per-instance gateway boot supplies). The module always
   * exposes the `composed` sinks so other modules can consume them.
   *
   * Per docs/plans/P2-onboarding.md § 5 + § 9.5 + Codex r3 P1 follow-up
   * (2026-05-03). Production composition supplies these once the per-
   * instance Telegram + topic-resolution adapters are wired (S6.5 / S7).
   */
  onboarding_telemetry?: {
    /** Optional structured-JSON log sink. Defaults to a stdout writer. */
    eventLogger?: OnboardingEventLogger
    /** Sean Ellis cron config — register only when this is supplied. */
    sean_ellis?: {
      channel: SeanEllisChannel
      resolveContext: (input: { project_slug: string; user_id: string }) => Promise<
        { topic_id: string } | null
      >
      /** Override hourly tick interval; defaults to 1h. */
      interval_ms?: number
    }
    /**
     * P2-v2 S22 (2026-05-17) — pre-built `OnboardingTelemetry` instance.
     * The realmode composer constructs the telemetry early (so it can
     * thread the `importOnSonnetFallback` callback into
     * `buildLandingStack`) and passes the SAME instance through so the
     * module graph reuses it instead of constructing a duplicate. When
     * omitted, the module builds its own with the same `eventLogger` +
     * `resolveAttemptId` deps it always has.
     *
     * Threading a pre-built instance avoids a second OnboardingTelemetry
     * writing to the same `gateway_events` table (which would still work
     * — both reuse `input.db` — but is unnecessary churn) and keeps a
     * single source of truth for telemetry config across the composer
     * and the graph.
     */
    instance?: OnboardingTelemetry
  }
  /**
   * S12 (2026-05-16) — import-running cron-tick config. When supplied,
   * the composer wires a per-instance 15s cron that scans
   * `onboarding_state` for rows at `phase=import_running` with
   * `import_job_id` non-null and calls
   * `engine.pollImportRunningTick(...)` so the runner's terminal status
   * gets detected without requiring a user inbound first.
   *
   * Optional — when omitted, `notifyImportUpload` still polls once
   * after `runner.start(...)` (existing behavior). Wiring the cron
   * closes the v0.1.33 stall where Pass-1+Pass-2 finishes but the
   * engine never advances to `import_analysis_presented`.
   *
   * Per docs/plans/P2-onboarding-v2.md § 3.4 + § S5.
   */
  onboarding_import_running_cron?: {
    /** The per-instance InterviewEngine. */
    engine: InterviewEngine
    /** Override the 15s sweep cadence (testing seam). */
    interval_ms?: number
  }
  /**
   * Autonomous Overnight-Work engine config (`overnight_handler`). Action
   * 07 registers the per-project `overnight-<slug>` JOB at wow-moment
   * dispatch time, but the HANDLER must exist in the production
   * `CronHandlerRegistry` or every tick logs "skipping job … handler
   * overnight_handler not registered". The composer registers the handler
   * UNCONDITIONALLY (it is harmless for instances with no overnight job);
   * this config only supplies the optional delivery surface for the
   * morning brief. When omitted, the handler still registers and the
   * reporter records 'skipped' ticks instead of scheduler errors.
   *
   * 2026-06-22 (overnight-dispatcher disentangle) — renamed from
   * `onboarding_wow_overnight_cron` and repointed at the real engine's
   * `MorningBriefDeliverInput` when the preview-only `wow_overnight_handler`
   * check-in stub (`onboarding/wow-moment/overnight-cron.ts`) was removed.
   */
  onboarding_overnight_cron?: {
    /**
     * Deliver the morning brief to the user's topic (production: the
     * shared web sender registry). Returns true when an active surface
     * accepted the message.
     */
    deliver?: (input: MorningBriefDeliverInput) => boolean | Promise<boolean>
  }
}
