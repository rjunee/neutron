/**
 * @neutronai/onboarding/wow-moment — dispatcher.
 *
 * P2 v2 § 5 + § 5.4 (docs/plans/P2-onboarding-v2.md). v1's fixed-order
 * walk over all 7 actions is replaced with an LLM-driven middle:
 *
 *   1. ALWAYS fire `07-overnight-pass` FIRST so the cron lands even if
 *      the rest of dispatch fails.
 *   2. Call the LLM picker over the candidate set
 *      (02, 03, 04, 05, 06-interest-check-in). The picker returns 2-3
 *      ids. On any LLM error / parse failure the picker falls back to
 *      the deterministic predicates; the dispatcher is given
 *      `is_fallback: true` and writes the selection event accordingly.
 *   3. Fire each picked action in returned order, pausing
 *      `inter_action_pause_ms` between them and handling freeform
 *      inbound (pause + ack; kept-typing → reschedule).
 *   4. ALWAYS fire `01-first-week-brief` LAST so it can summarize what
 *      landed.
 *
 * Every fired action's row in `wow_events.redacted_payload_json`
 * carries the picker's `explanation` string when the LLM chose it; the
 * dispatcher threads the explanation through `runner.run(...)`.
 *
 * Picker telemetry: a single `onboarding.wow_action_selected` event with
 * the picked ids, the per-id explanations, and the `fallback_used` flag.
 *
 * Per-action freeform / reschedule semantics from v1 are preserved.
 */

import type { CronJobRegistry } from '../../cron/jobs.ts'
import type { CronStateStore } from '../../cron/state.ts'
import type { ProjectDb } from '../../persistence/index.ts'
import type { ReminderStore } from '../../reminders/store.ts'
import type {
  BriefSubstrate,
  CapturedProject,
  GmailDraftClient,
  GmailScopeState,
  RitualEntry,
  StalledEmailThread,
  WowActionContext,
  WowChannelAdapter,
  WowInterviewState,
} from './action-types.ts'
import { ALWAYS_FIRE_FIRST, ALWAYS_FIRE_LAST, CANDIDATE_IDS, getActionModule } from './catalogue.ts'
import { ActionRunner } from './action-runner.ts'
import type { WowTelemetry, WowActionId } from './telemetry.ts'
import type { ImportResult } from '../history-import/types.ts'
import type { LlmCallFn } from '../interview/phase-spec-resolver.ts'
import type { ProjectMaterializer } from './project-materializer.ts'
import { pickWowActions, type WowSelectorCollectedData, type WowSelectorLogger } from './llm-selector.ts'

export const DEFAULT_INTER_ACTION_PAUSE_MS = 5_000
export const DEFAULT_FREEFORM_PAUSE_MS = 60_000
export const DEFAULT_KEEP_TYPING_BUDGET_MS = 60_000
/**
 * ISSUES #95 — picker LLM timeout. The pre-#95 selector inherited its
 * 4 000 ms default from the interview LLM-driver, but the wow picker is a
 * COLD `claude -p` CC-spawn (no warm streaming session to reuse), and a
 * cold spawn runs ~4.6 s before first token (see the `claude --bare`
 * latency reference). At 4 s the picker timed out EVERY run → the
 * selector logged `deterministic fallback (llm_error)` on the prod
 * instance t-88888888 across all 4 re-fires. The dispatch fires on the
 * post-onboarding `wow_fired` transition + the overnight pass — both
 * latency-tolerant — so a generous 20 s budget lets the cold spawn land
 * without touching the interview driver's tighter budget. The
 * deterministic fallback remains a true fallback; #95 makes it write
 * NAMED projects regardless, so the wow no longer depends on the picker.
 */
export const DEFAULT_PICKER_TIMEOUT_MS = 20_000
/** Default wait for the user to resolve a prompt-emitting action before
 *  moving to the next candidate. 30 minutes is long enough for the user
 *  to read the prompt, decide, and tap; shorter than the cron retry
 *  cadence so the dispatcher returns cleanly on real abandonment. */
export const DEFAULT_SERIALIZE_PROMPT_TIMEOUT_MS = 30 * 60_000

export interface DispatchInput {
  project_slug: string
  topic_id: string
  owner_home: string
  interview: WowInterviewState
  import_result: ImportResult | null
  rituals: RitualEntry[]
  captured_projects: CapturedProject[]
  /**
   * 2026-05-28 sprint — true iff the engine observed the user
   * confirming at `projects_proposed` (any write of
   * `primary_projects_confirmed`, including the deliberate `[]` from
   * the zero-state skip-ahead). 03-project-shells uses this to
   * distinguish "user confirmed zero projects" (skip the import_result
   * fallback) from "user never reached confirmation" (fall back to the
   * import-derived candidate set per the legacy contract). Defaults to
   * `false` when omitted by a caller — legacy callers (m2-casey-fixture,
   * gateway/realmode-composer/build-wow-dispatcher.ts pre-update) keep
   * the pre-fix import-fallback behavior.
   */
  projects_confirmed?: boolean
  /**
   * v1 contemplative-tradition keyword corpus. v2's interest-check-in
   * action does not read this; it is preserved on the input so existing
   * callers (engine wow_fired hook, m2-casey-fixture) compile.
   */
  contemplative_keywords: string[]
  stalled_threads: StalledEmailThread[]
  gmail_scopes: GmailScopeState | null
  /** Backed by project.db. Real ReminderStore in production; in-memory mock in tests. */
  reminders: ReminderStore
  cron_jobs: CronJobRegistry
  cron_state: CronStateStore
  db: ProjectDb
  channel: WowChannelAdapter
  gmail: GmailDraftClient | null
  substrate?: BriefSubstrate
  /** Optional substrate for the LLM-driven picker. Production wires Haiku 4.5. */
  picker_llm?: LlmCallFn
  /** Optional override for the redacted user-context summary handed to the picker. */
  picker_collected_data?: WowSelectorCollectedData
  /**
   * Item 4 — enriched project materializer for action 03 (CC-substrate
   * doc composer + GBrain page indexer in production, wired by
   * `build-wow-dispatcher.ts`). When absent, action 03 default-builds a
   * deterministic materializer from ctx (template docs, no index).
   */
  materializer?: ProjectMaterializer
}

export interface DispatchOutcome {
  /** Action ids that fired successfully (result.fired === true). */
  fired: WowActionId[]
  /** Action ids whose trigger predicate was false. */
  skipped_no_trigger: WowActionId[]
  /** Action ids that errored mid-run. */
  failed: Array<{ action_id: WowActionId; reason: string }>
  /** True iff dispatch was rescheduled because the user kept typing past the 60s freeform window. */
  rescheduled: boolean
  /** The LLM-picker selection record (always populated). */
  selection: {
    pick: ReadonlyArray<WowActionId>
    explanations: Readonly<Record<string, string>>
    is_fallback: boolean
  }
  /**
   * 2026-05-28 Argus r2 — the brief's affordance prompt_id (action 01).
   * Set when the brief fired AND emitted its [A] Start overnight pass
   * button; absent when the brief skipped (no_trigger) or failed mid-run.
   * The engine uses this to stamp `phase_state.active_prompt_id` so the
   * user's tap on [A] (or freeform reply) routes back through
   * `consumeWowFallbackChoice` instead of returning noop_terminal.
   */
  brief_prompt_id?: string
}

/**
 * Probes for inbound freeform activity. The dispatcher polls between
 * actions; the production wiring is the inbound-message router (which
 * sets a flag in shared state). Tests inject a deterministic stub.
 */
export interface FreeformProbe {
  /** Returns true if the user has sent a freeform message since the last call. */
  hasInbound(): boolean
  /** Acknowledges the inbound and clears the flag. The agent's reply is the ack. */
  acknowledge(): Promise<void>
}

/**
 * 2026-05-28 wow-cleanup sprint — when an action emits a button prompt
 * the dispatcher uses this probe to wait for the user to tap before
 * firing the next action. Without serialization, prompts stack
 * vertically in chat (Sam's verbatim feedback 2026-05-28: "before I
 * had time to answer the keep/drop project list, immediately a several
 * notifications appeared. They should only come one at a time after
 * the previous one is answered.").
 *
 * Implementations:
 *  - Production: poll `button_prompts.resolved_at` until set, timeout
 *    after `serialize_prompt_timeout_ms` (default 30 min).
 *  - Tests: stub that resolves immediately or on demand.
 *  - Absent: dispatcher skips the wait and preserves the legacy
 *    fixed-pause behavior (back-compat for callers that haven't
 *    wired the probe yet).
 */
export interface PromptResolutionProbe {
  /**
   * Wait until the user resolves the given prompt OR until `timeout_ms`
   * elapses. Returns 'resolved' when the prompt was answered, 'timeout'
   * otherwise.
   */
  waitFor(prompt_id: string, timeout_ms: number): Promise<'resolved' | 'timeout'>
}

/**
 * 2026-05-28 wow-cleanup sprint — sink the dispatcher uses to persist
 * its picked queue + the in-flight head so the operator (and any future
 * engine-side resume hook) can observe what is queued up. Optional —
 * when absent the dispatcher still serializes via the resolution probe
 * but does not externalize the queue.
 */
export type PendingQueueSink = (input: {
  project_slug: string
  pending_wow_queue: ReadonlyArray<WowActionId>
  active_wow_action_id: WowActionId | null
  active_wow_prompt_id: string | null
}) => void | Promise<void>

/**
 * Optional reschedule callback — fires when the user keeps typing past
 * the 60s freeform window. Production wires `cron/scheduler.ts:fireOnce`
 * with a `wow_dispatch_<project_slug>` slug; tests inject a recorder.
 */
export type RescheduleHook = (input: {
  project_slug: string
  remaining_actions: WowActionId[]
  reason: 'kept_typing'
}) => Promise<void>

/**
 * Optional telemetry sink the dispatcher uses to record the picker's
 * selection event (`onboarding.wow_action_selected`). Production wires
 * `gateway/logger.ts` / `OnboardingTelemetry.emit(...)`. Tests pass a
 * recorder.
 */
export type WowSelectionLogger = (input: {
  project_slug: string
  picks: ReadonlyArray<WowActionId>
  explanations: Readonly<Record<string, string>>
  fallback_used: boolean
}) => void | Promise<void>

export interface WowDispatcherDeps {
  telemetry: WowTelemetry
  /** Pause between actions; default 5s per v1 § 2.5. */
  inter_action_pause_ms?: number
  /** Freeform pause budget; default 60s per v1 § 2.5. */
  freeform_pause_ms?: number
  /** Reschedule trigger threshold; default 60s. */
  keep_typing_budget_ms?: number
  /** Sleep override (test seam). Default `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>
  /** Probe for inbound freeform activity. */
  freeform_probe?: FreeformProbe
  /** Reschedule callback (only invoked if user keeps typing). */
  reschedule?: RescheduleHook
  /** Action-runner — defaults to a fresh one over `telemetry`. */
  runner?: ActionRunner
  /** Test seam for clock + uuid. */
  now?: () => number
  uuid?: () => string
  /** Picker telemetry sink — receives `onboarding.wow_action_selected`. */
  on_selection?: WowSelectionLogger
  /** Optional structured logger threaded into the picker. */
  picker_log?: WowSelectorLogger
  /**
   * ISSUES #95 — hard timeout for the picker LLM call. Defaults to
   * `DEFAULT_PICKER_TIMEOUT_MS` (20 s) so a cold CC-spawn lands instead
   * of timing out at the interview driver's 4 s. Tests pass a small
   * value (or a stub LLM) to keep wall-clock bounded.
   */
  picker_timeout_ms?: number
  /**
   * 2026-05-28 wow-cleanup sprint — when set, the dispatcher waits for
   * the previously-fired prompt to be resolved (button tap) before
   * firing the next prompt-emitting action. Absent → preserves the
   * legacy fixed-pause behavior.
   */
  prompt_resolution_probe?: PromptResolutionProbe
  /**
   * Timeout for `prompt_resolution_probe.waitFor`. Default 30 min;
   * tests typically inject 100ms or override the probe to resolve
   * synchronously.
   */
  serialize_prompt_timeout_ms?: number
  /**
   * 2026-05-28 wow-cleanup sprint — when set, the dispatcher writes
   * the picked queue + the current head to phase_state via this sink
   * so observability + a future engine-side resume path can see what
   * is queued up. Optional; serialization works without it.
   */
  on_pending_queue?: PendingQueueSink
}

export class WowDispatcher {
  private readonly telemetry: WowTelemetry
  private readonly interActionPauseMs: number
  private readonly freeformPauseMs: number
  private readonly keepTypingBudgetMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly freeformProbe?: FreeformProbe
  private readonly reschedule?: RescheduleHook
  private readonly runner: ActionRunner
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly onSelection?: WowSelectionLogger
  private readonly pickerLog?: WowSelectorLogger
  private readonly pickerTimeoutMs: number
  private readonly promptResolutionProbe?: PromptResolutionProbe
  private readonly serializePromptTimeoutMs: number
  private readonly onPendingQueue?: PendingQueueSink

  constructor(deps: WowDispatcherDeps) {
    this.telemetry = deps.telemetry
    this.interActionPauseMs = deps.inter_action_pause_ms ?? DEFAULT_INTER_ACTION_PAUSE_MS
    this.freeformPauseMs = deps.freeform_pause_ms ?? DEFAULT_FREEFORM_PAUSE_MS
    this.keepTypingBudgetMs = deps.keep_typing_budget_ms ?? DEFAULT_KEEP_TYPING_BUDGET_MS
    this.sleep = deps.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms))
    if (deps.freeform_probe !== undefined) this.freeformProbe = deps.freeform_probe
    if (deps.reschedule !== undefined) this.reschedule = deps.reschedule
    this.runner =
      deps.runner ??
      new ActionRunner({
        telemetry: this.telemetry,
        sleep: this.sleep,
      })
    this.now = deps.now ?? ((): number => Date.now())
    this.uuid = deps.uuid ?? ((): string => crypto.randomUUID())
    if (deps.on_selection !== undefined) this.onSelection = deps.on_selection
    if (deps.picker_log !== undefined) this.pickerLog = deps.picker_log
    this.pickerTimeoutMs = deps.picker_timeout_ms ?? DEFAULT_PICKER_TIMEOUT_MS
    if (deps.prompt_resolution_probe !== undefined) {
      this.promptResolutionProbe = deps.prompt_resolution_probe
    }
    this.serializePromptTimeoutMs =
      deps.serialize_prompt_timeout_ms ?? DEFAULT_SERIALIZE_PROMPT_TIMEOUT_MS
    if (deps.on_pending_queue !== undefined) this.onPendingQueue = deps.on_pending_queue
  }

  /**
   * P2 v2 § 5.4 flow:
   *   1. Always fire 07-overnight-pass FIRST.
   *   2. Run the LLM picker over the candidate set.
   *   3. Fire each picked action in order with inter-action pauses +
   *      freeform handling.
   *   4. Always fire 01-first-week-brief LAST.
   */
  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    const outcome: DispatchOutcome = {
      fired: [],
      skipped_no_trigger: [],
      failed: [],
      rescheduled: false,
      selection: { pick: [], explanations: {}, is_fallback: true },
    }

    const baseCtx = this.buildContext(input)

    // 1. 07-overnight-pass — always fires FIRST.
    await this.fireOne({
      action_id: ALWAYS_FIRE_FIRST,
      ctx: baseCtx,
      outcome,
    })

    // 2. Decide the middle. The picker is a pure function — telemetry is
    //    the dispatcher's responsibility.
    const candidate_ctx = baseCtx
    const candidate_modules: Record<string, ReturnType<typeof getActionModule>> = {}
    for (const id of CANDIDATE_IDS) candidate_modules[id] = getActionModule(id)

    const selectorDeps: Parameters<typeof pickWowActions>[1] = {
      llm: input.picker_llm ?? defaultLlm,
      fallback_ctx: candidate_ctx,
      candidate_modules,
      // ISSUES #95 — give the cold CC-spawn picker room to land instead
      // of timing out at the interview driver's 4 s default.
      timeout_ms: this.pickerTimeoutMs,
    }
    if (this.pickerLog !== undefined) selectorDeps.log = this.pickerLog

    const selection = await pickWowActions(
      {
        project_slug: input.project_slug,
        collected_data: input.picker_collected_data ?? this.deriveCollectedData(input),
        import_result: input.import_result,
        candidates: CANDIDATE_IDS,
      },
      selectorDeps,
    )
    outcome.selection = selection

    if (this.onSelection !== undefined) {
      try {
        await this.onSelection({
          project_slug: input.project_slug,
          picks: selection.pick,
          explanations: selection.explanations,
          fallback_used: selection.is_fallback,
        })
      } catch (err) {
        // Telemetry errors must never stop dispatch.
        console.error('wow-dispatcher onSelection threw:', err)
      }
    }

    // 2026-05-28 wow-cleanup sprint — publish the full picked queue (in
    // fire order, including ALWAYS_FIRE_LAST) so the operator can see
    // what is queued up. Head is set after each action fires.
    const pending_wow_queue: ReadonlyArray<WowActionId> = [
      ...selection.pick,
      ALWAYS_FIRE_LAST,
    ]
    await this.publishPendingQueue({
      project_slug: input.project_slug,
      pending_wow_queue,
      active_wow_action_id: ALWAYS_FIRE_FIRST,
      active_wow_prompt_id: null,
    })

    // 3. Inter-action pause + middle dispatch. Pause AFTER 07 (entering
    //    the picked set) so the picked actions don't run back-to-back.
    if (selection.pick.length > 0) {
      const after07 = await this.pauseWithFreeformAck(this.interActionPauseMs)
      if (after07 === 'kept_typing') {
        return this.handleKeptTyping({
          outcome,
          project_slug: input.project_slug,
          remaining: [...selection.pick, ALWAYS_FIRE_LAST],
        })
      }
    }
    for (let i = 0; i < selection.pick.length; i++) {
      const action_id = selection.pick[i]!
      const explanation = selection.explanations[action_id]
      // Publish the active head BEFORE firing so observers see "X is
      // in-flight" rather than the previous step.
      await this.publishPendingQueue({
        project_slug: input.project_slug,
        pending_wow_queue,
        active_wow_action_id: action_id,
        active_wow_prompt_id: null,
      })
      const fireResult = await this.fireOne({
        action_id,
        ctx: this.cloneCtx(baseCtx, input, explanation),
        outcome,
        ...(explanation !== undefined ? { explanation } : {}),
      })

      // 2026-05-28 wow-cleanup sprint — when this action emitted a
      // button prompt that needs a user response AND we have a
      // resolution probe wired, SERIALIZE by waiting for the user to
      // tap before firing the next prompt-emitting action. This
      // prevents the "several notifications appeared all at once"
      // pile-up Sam saw on 2026-05-28.
      if (fireResult.followup_prompt_id !== undefined) {
        await this.publishPendingQueue({
          project_slug: input.project_slug,
          pending_wow_queue,
          active_wow_action_id: action_id,
          active_wow_prompt_id: fireResult.followup_prompt_id,
        })
        const serialized = await this.waitForPromptResolution(
          fireResult.followup_prompt_id,
        )
        if (serialized === 'timeout') {
          // User abandoned. Stop here; reschedule remaining actions.
          const remaining_middle = selection.pick.slice(i + 1)
          return this.handleKeptTyping({
            outcome,
            project_slug: input.project_slug,
            remaining: [...remaining_middle, ALWAYS_FIRE_LAST],
          })
        }
      } else {
        // No prompt emitted; preserve the legacy fixed-pause behavior
        // so observability and freeform handling remain identical.
        const after = await this.pauseWithFreeformAck(this.interActionPauseMs)
        if (after === 'kept_typing') {
          const remaining_middle = selection.pick.slice(i + 1)
          return this.handleKeptTyping({
            outcome,
            project_slug: input.project_slug,
            remaining: [...remaining_middle, ALWAYS_FIRE_LAST],
          })
        }
      }
    }

    // 4. 01-first-week-brief — always fires LAST.
    await this.publishPendingQueue({
      project_slug: input.project_slug,
      pending_wow_queue,
      active_wow_action_id: ALWAYS_FIRE_LAST,
      active_wow_prompt_id: null,
    })
    const briefResult = await this.fireOne({
      action_id: ALWAYS_FIRE_LAST,
      ctx: this.cloneCtx(baseCtx, input),
      outcome,
    })

    // The brief's affordance prompt is the last surface; publish it so
    // observers see the in-flight prompt id.
    await this.publishPendingQueue({
      project_slug: input.project_slug,
      pending_wow_queue,
      active_wow_action_id: null,
      active_wow_prompt_id: briefResult.followup_prompt_id ?? null,
    })

    // 2026-05-28 Argus r2 — surface the brief's affordance prompt_id on
    // the outcome so the engine's wow_fired success-path can stamp it as
    // the active_prompt_id and route the [A] Start overnight pass tap
    // through `consumeWowFallbackChoice`. Without this the choice value
    // landed at phase=completed (terminal) and returned noop_terminal.
    if (briefResult.followup_prompt_id !== undefined) {
      outcome.brief_prompt_id = briefResult.followup_prompt_id
    }

    return outcome
  }

  private async fireOne(args: {
    action_id: WowActionId
    ctx: WowActionContext
    outcome: DispatchOutcome
    explanation?: string
  }): Promise<{ followup_prompt_id?: string }> {
    const module = getActionModule(args.action_id)
    const result = await this.runner.run({ module, ctx: args.ctx, ...(args.explanation !== undefined ? { explanation: args.explanation } : {}) })
    if (result.fired) {
      args.outcome.fired.push(args.action_id)
    } else if (result.reason === 'no_trigger') {
      args.outcome.skipped_no_trigger.push(args.action_id)
    } else {
      args.outcome.failed.push({ action_id: args.action_id, reason: result.reason })
    }
    const out: { followup_prompt_id?: string } = {}
    if (result.followup_prompt_id !== undefined) out.followup_prompt_id = result.followup_prompt_id
    return out
  }

  /**
   * 2026-05-28 wow-cleanup sprint — wait for the previously-emitted
   * prompt to be resolved (button tap) before continuing. When no
   * probe is wired, fall back to the legacy fixed pause so callers
   * that haven't migrated still see the same UX.
   */
  private async waitForPromptResolution(prompt_id: string): Promise<'resolved' | 'timeout'> {
    if (this.promptResolutionProbe === undefined) {
      await this.sleep(this.interActionPauseMs)
      return 'resolved'
    }
    try {
      return await this.promptResolutionProbe.waitFor(
        prompt_id,
        this.serializePromptTimeoutMs,
      )
    } catch (err) {
      // Probe errors must not stop dispatch — fall back to fixed pause
      // and continue rather than abandoning the user.
      console.error('wow-dispatcher prompt_resolution_probe threw:', err)
      await this.sleep(this.interActionPauseMs)
      return 'resolved'
    }
  }

  private async publishPendingQueue(input: {
    project_slug: string
    pending_wow_queue: ReadonlyArray<WowActionId>
    active_wow_action_id: WowActionId | null
    active_wow_prompt_id: string | null
  }): Promise<void> {
    if (this.onPendingQueue === undefined) return
    try {
      await this.onPendingQueue(input)
    } catch (err) {
      // Persistence errors must not stop dispatch.
      console.error('wow-dispatcher on_pending_queue threw:', err)
    }
  }

  private handleKeptTyping(args: {
    outcome: DispatchOutcome
    project_slug: string
    remaining: WowActionId[]
  }): DispatchOutcome {
    args.outcome.rescheduled = true
    if (this.reschedule !== undefined) {
      void this.reschedule({
        project_slug: args.project_slug,
        remaining_actions: args.remaining,
        reason: 'kept_typing',
      }).catch((err) => {
        console.error('wow-dispatcher reschedule hook threw:', err)
      })
    }
    return args.outcome
  }

  /**
   * Sleep for `total_ms`. If the freeform probe reports an inbound
   * during the wait, ack + sleep an additional `freeformPauseMs`. If
   * the user keeps typing through the 60s budget window, return
   * 'kept_typing' so the dispatcher can reschedule.
   */
  private async pauseWithFreeformAck(total_ms: number): Promise<'ok' | 'kept_typing'> {
    if (this.freeformProbe === undefined) {
      await this.sleep(total_ms)
      return 'ok'
    }
    await this.sleep(total_ms)
    if (!this.freeformProbe.hasInbound()) return 'ok'
    await this.freeformProbe.acknowledge()
    await this.sleep(this.freeformPauseMs)
    if (!this.freeformProbe.hasInbound()) return 'ok'
    return 'kept_typing'
  }

  private buildContext(input: DispatchInput): WowActionContext {
    const ctx: WowActionContext = {
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      owner_home: input.owner_home,
      interview: input.interview,
      import_result: input.import_result,
      rituals: input.rituals,
      captured_projects: input.captured_projects,
      projects_confirmed: input.projects_confirmed === true,
      contemplative_keywords: input.contemplative_keywords,
      stalled_threads: input.stalled_threads,
      gmail_scopes: input.gmail_scopes,
      reminders: input.reminders,
      cron_jobs: input.cron_jobs,
      cron_state: input.cron_state,
      db: input.db,
      channel: input.channel,
      gmail: input.gmail,
      now: this.now,
      uuid: this.uuid,
    }
    if (input.substrate !== undefined) ctx.substrate = input.substrate
    if (input.materializer !== undefined) ctx.materializer = input.materializer
    return ctx
  }

  private cloneCtx(
    base: WowActionContext,
    _input: DispatchInput,
    _explanation?: string,
  ): WowActionContext {
    // Context is per-action invocation; cloning is currently a pass-through
    // because no per-action mutation occurs in v2. The seam is preserved
    // so future fields (e.g. per-action seed) can land cleanly.
    return base
  }

  private deriveCollectedData(input: DispatchInput): WowSelectorCollectedData {
    const out: WowSelectorCollectedData = {}
    const ps = input.interview.phase_state_json ?? {}
    const display_name = typeof ps['user_first_name'] === 'string'
      ? (ps['user_first_name'] as string)
      : input.interview.display_name
    if (typeof display_name === 'string') out.user_first_name = display_name
    if (typeof ps['agent_personality'] === 'string') {
      out.agent_personality = ps['agent_personality'] as string
    }
    if (Array.isArray(ps['work_themes'])) out.work_themes = ps['work_themes'].filter(isString)
    const projects = input.captured_projects.map((p) => p.name)
    if (projects.length > 0) out.primary_projects = projects
    if (Array.isArray(ps['non_work_interests'])) {
      const list: { name: string; cadence_hint?: string }[] = []
      for (const raw of ps['non_work_interests'] as unknown[]) {
        if (typeof raw === 'string' && raw.trim().length > 0) {
          list.push({ name: raw.trim() })
        } else if (typeof raw === 'object' && raw !== null) {
          const obj = raw as Record<string, unknown>
          if (typeof obj['name'] === 'string') {
            const entry: { name: string; cadence_hint?: string } = { name: obj['name'] }
            if (typeof obj['cadence_hint'] === 'string') entry.cadence_hint = obj['cadence_hint']
            list.push(entry)
          }
        }
      }
      if (list.length > 0) out.non_work_interests = list
    }
    const rituals = input.rituals.map((r) => `${r.kind} ${r.label} @ ${r.time_of_day}`)
    if (rituals.length > 0) out.rituals = rituals
    if (Array.isArray(ps['inner_circle'])) out.inner_circle = ps['inner_circle'].filter(isString)
    return out
  }
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

/**
 * Default substrate stub. Production callers MUST pass `picker_llm` —
 * this stub immediately rejects so the picker falls back to deterministic
 * predicates rather than silently emitting "picked nothing".
 */
const defaultLlm: LlmCallFn = async () => {
  throw new Error('wow-dispatcher: picker_llm not configured')
}
