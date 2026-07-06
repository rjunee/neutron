/**
 * @neutronai/gateway/realmode-composer — wow-moment dispatcher hook builder
 * (T2 r3, 2026-05-13).
 *
 * Argus r1 [BLOCKING] on PR #98: the original T2 sprint shipped the
 * engine-side wiring (the `WowDispatcherHook` interface + the
 * `dispatchWowAndAdvance` branch in `consumeChoice`) but never wired
 * a real `WowDispatcher` into the production composer. That left
 * production users tapping "Fire it!" → the engine emitted "Setting
 * up your first week — drafting your brief…" → nothing fired. Textbook
 * active-lie pattern per the CLAUDE.md spec-conformance hard rule.
 *
 * This module fills the gap. It constructs a real `WowDispatcher` with
 * the heavy-fixture closures (channel adapter over the web sender,
 * ReminderStore + CronStateStore over the per-project DB, the SHARED
 * CronJobRegistry, WowTelemetry) and returns a `WowDispatcherHook` the
 * engine treats as opaque. The hook pins the FROZEN `internal_handle`
 * (NOT the mutable url_slug) as the dispatch identity so rename across
 * the wow_fired transition does not orphan persisted rows (reminders,
 * cron_state, wow_events).
 *
 * T2 r3 (2026-05-13) — Codex cross-model + Argus follow-up fixes the
 * two production-path gaps r2 deferred:
 *
 *   1. `cron_jobs` MUST be the SAME instance the gateway composition's
 *      `CronScheduler` reads from. Production wires this via
 *      `BuildLandingStackInput.cronJobs` →
 *      `BuildWowDispatcherHookInput.cronJobs` → THIS file's `cron_jobs`
 *      binding, and `gateway/index.ts` pre-constructs one
 *      `CronJobRegistry` instance and passes it to BOTH
 *      `buildLandingStack` AND `CompositionInput.cron_jobs`. Without
 *      this, action 07 (overnight-pass) records a `cron_state` row
 *      that says "scheduled" but the scheduler never auto-fires the
 *      job — silently dropping tomorrow morning's brief.
 *
 *   2. `WowChannelAdapter.sendText` THROWS on undelivered (no active
 *      WS) instead of returning a `'undelivered'` synthetic message_id.
 *      Action 01 (first-week-brief) only calls `sendText` — it does not
 *      inspect message_id — so r2's silent-success path meant a user
 *      whose WS dropped mid-dispatch silently got `phase=completed` +
 *      no brief. Throwing routes through the action-runner's per-action
 *      try/catch → `outcome.failed` carries the brief failure → the
 *      engine treats action 01 in `failed[]` as a dispatch failure and
 *      stays at `wow_fired` so the user reconnects to the retry/skip
 *      fallback prompt instead of `completed`.
 *
 *   3. (2026-05-28 wow-cleanup r3 BLOCKER follow-up — Codex cross-model,
 *      Argus r3) `WowChannelAdapter.emitPrompt` mirrors the same
 *      throw-on-undelivered shape AND peeks `webRegistry.has(topic_id)`
 *      BEFORE persisting via `buttonStore.emit`. Previously emitPrompt
 *      persisted the row regardless of WS state; on `webRegistry.send
 *      → false`, the dispatcher's ButtonStoreResolutionProbe peeked the
 *      persisted-but-undelivered row, observed `resolved_at = null`,
 *      and looped for the full 30-min `serialize_prompt_timeout_ms`.
 *      `handleKeptTyping` then set `rescheduled=true` and action 01 was
 *      never fired → engine saw no brief failure + no `brief_prompt_id`
 *      → silently auto-advanced to `completed` (active-lie failure).
 *      With the peek-then-throw shape, a prompt-emitting action 03/04
 *      lands in `outcome.failed[]` → fireOne's `followup_prompt_id`
 *      stays undefined → the dispatcher's else-branch fires the next
 *      action 0ms later → action 01 hits the same throw via `sendText`
 *      → engine emits the retry/skip fallback on reconnect.
 *
 * Remaining intentional limitations:
 *
 *   - `gmail` is null. Action 05 (follow-up email draft) skips when
 *     `gmail === null && gmail_scopes === null` per its trigger
 *     predicate; the gmail-compose pipeline (Sprint 32) wires this.
 *
 *   - `substrate` is undefined. Action 01 (first-week-brief) falls
 *     back to its templated body (the action implementation accepts
 *     `substrate?` per `action-types.ts`); the real Anthropic-backed
 *     composer lands with T1.
 *
 *   - Telegram-side `sendText` is unwired. When the user is on
 *     Telegram (no active web WS) `sendText` throws and action 01
 *     lands in `failed[]`; the engine emits the fallback prompt so
 *     the user can retry from the Telegram side once the dedicated
 *     bot-driver wiring lands.
 *
 * Tests inject a recorder hook directly via the `wowDispatcher` field
 * on `BuildLandingStackInput` — this builder is only invoked when no
 * caller-supplied hook is present.
 */

import type { ProjectDb } from '../../persistence/index.ts'
import type { ButtonStore } from '../../channels/button-store.ts'
import type { ButtonPrompt } from '../../channels/button-primitive.ts'
import type { WebChatSenderRegistry } from '../http/chat-sender-registry.ts'
import { renderButtonPromptForWeb } from '../http/chat-bridge.ts'
import { ReminderStore } from '../../reminders/store.ts'
import { CronJobRegistry } from '../../cron/jobs.ts'
import { CronStateStore } from '../../cron/state.ts'
import {
  ActionRunner,
  WowDispatcher,
  WowTelemetry,
  type WowChannelAdapter,
} from '../../onboarding/wow-moment/index.ts'
import {
  buildProjectMaterializer,
  type ProjectDocComposer,
  type ProjectPageIndexFn,
} from '../../onboarding/wow-moment/project-materializer.ts'
import type { PromptResolutionProbe } from '../../onboarding/wow-moment/dispatcher.ts'
import type {
  WowDispatcherHook,
  WowDispatcherHookInput,
  WowDispatcherHookOutcome,
} from '../../onboarding/interview/engine.ts'
import type { LlmCallFn } from '../../onboarding/interview/phase-spec-resolver.ts'

export interface BuildWowDispatcherHookInput {
  db: ProjectDb
  owner_home: string
  /**
   * Web sender registry — same instance the engine's `sendButtonPrompt`
   * routes through. The WowChannelAdapter's `sendText` + `emitPrompt`
   * close over this so a wow-moment action's outbound surface uses the
   * SAME WS the user is connected to.
   */
  webRegistry: WebChatSenderRegistry
  /**
   * Per-project ButtonStore — required by the channel adapter's
   * `emitPrompt` so a button-bearing wow-moment action persists its
   * prompt row (idempotency, choice routing) the same way the engine
   * does.
   */
  buttonStore: ButtonStore
  /**
   * T2 r3 (2026-05-13) — shared `CronJobRegistry`. Production composer
   * threads the SAME instance into both this builder AND the cron
   * module's `CronScheduler`, so action 07 (overnight-pass) registers
   * its job in the registry the scheduler walks at tick time. Without
   * it the registration goes into a dead local registry and the
   * scheduler never fires the job.
   *
   * Optional for back-compat — when omitted, the builder constructs a
   * fresh local registry (the pre-r3 behaviour). Tests using a recorder
   * `wowDispatcher` never reach this builder.
   */
  cronJobs?: CronJobRegistry
  /**
   * T2 r3 (2026-05-13) — test seam — inter-action pause override.
   * Production omits (uses the 5s default per § 2.5). Tests pass 0 to
   * keep wall-clock time bounded.
   */
  interActionPauseMs?: number
  /**
   * T2 r3 (2026-05-13) — test seam — sleep override. When supplied,
   * threaded into BOTH the WowDispatcher (pause-between-actions +
   * freeform-ack windows) AND the ActionRunner (substrate-error retry
   * delay; default 30s, used by action 01 + 02). Production omits and
   * gets `Bun.sleep`.
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * 2026-06-10 (wow-hang-resilience) — per-action hard timeout threaded
   * into the ActionRunner. Production omits (60s default per
   * `DEFAULT_ACTION_TIMEOUT_MS`); tests pass a small value so a
   * deliberately-hung action settles within test wall-clock. See the
   * ActionRunnerDeps.action_timeout_ms docblock for the prod-incident
   * rationale.
   */
  actionTimeoutMs?: number
  /**
   * P2 v2 S9 — picker LLM (Haiku 4.5 in production). Threaded into
   * `WowDispatcher.dispatch(... picker_llm: ...)` so the LLM-selection
   * path per § 5.3 actually runs. When ABSENT, every dispatch falls
   * back to the deterministic predicate set (per § 5.3 fallback
   * contract) AND the dispatcher logs a structured warning on first
   * call so production startup is loud about the missing dependency
   * (Codex S9-r1 P1: silent fallback was the production reality
   * before this field landed because the composer never wired it).
   */
  pickerLlm?: LlmCallFn
  /**
   * 2026-05-28 wow-cleanup r3 (Codex cross-model BLOCKER, Argus r2) —
   * inter-action prompt-resolution probe. Without this, the dispatcher
   * receives `prompt_resolution_probe: undefined` and its serialization
   * branch (`waitForPromptResolution`) collapses to a flat 5s sleep —
   * so for instances whose picked actions emit button prompts
   * (03-project-shells, 02-lifestyle-reminders, 06-interest-check-in),
   * Fix D's "wait for tap, THEN fire next prompt" guarantee never
   * activates and notifications STACK in chat exactly as Sam reported
   * 2026-05-28.
   *
   * Production default: a `ButtonStoreResolutionProbe` over `buttonStore`
   * is built when this field is undefined. Tests inject a deterministic
   * stub (or pass an explicit probe instance) so wall-clock time stays
   * bounded.
   */
  promptResolutionProbe?: PromptResolutionProbe
  /**
   * 2026-05-28 wow-cleanup r3 — override the default probe's poll
   * interval. Production omits (uses the 500ms default — fast enough
   * to feel instant to a user tapping, slow enough to keep SQLite
   * traffic trivial). Tests pass 5-20ms so the probe loop spins
   * tightly under bun:test fake timers.
   */
  promptResolutionPollMs?: number
  /**
   * 2026-05-28 wow-cleanup r3 — probe-internal sleep override (test
   * seam). Defaults to `Bun.sleep`. Distinct from `input.sleep` because
   * the dispatcher's `sleep` drives inter-action pauses (which the
   * probe SHORT-CIRCUITS), whereas this one drives the probe's own
   * poll loop. Tests inject a no-op so unit runs don't burn wall-clock.
   */
  promptResolutionSleep?: (ms: number) => Promise<void>
  /**
   * 2026-05-28 wow-cleanup r3 — probe-internal `now()` override (test
   * seam). Defaults to `Date.now`. Tests inject a deterministic clock
   * to make the timeout deadline reproducible.
   */
  promptResolutionNow?: () => number
  /**
   * Item 4 — LLM doc composer for the project materializer (README +
   * transcript-summary synthesis over the CC substrate). Optional: when
   * absent, materialized docs use the deterministic templates. Production
   * threads `buildProjectDocComposer(...)` from `build-landing-stack.ts`.
   */
  materializerComposer?: ProjectDocComposer
  /**
   * Item 4 — memory-layer indexer for the project materializer
   * (`writeEntity(kind='project')` + GBrain sync hook). Optional: when
   * absent, materialized projects are not indexed (entities-only recall,
   * acceptable degradation). Production threads
   * `buildProjectPageIndexer(...)` from `build-landing-stack.ts`.
   */
  materializerIndexer?: ProjectPageIndexFn
}

/**
 * Build a `WowDispatcherHook` that wraps a fresh `WowDispatcher`. The
 * outer hook function closes over the dispatcher + the fixtures; per
 * the WowDispatcher contract, every call to `hook.dispatch(...)` walks
 * the catalogue in fixed order and resolves with `{fired,
 * skipped_no_trigger, failed, rescheduled}`.
 */
export function buildWowDispatcherHook(
  input: BuildWowDispatcherHookInput,
): WowDispatcherHook {
  const telemetry = new WowTelemetry({ db: input.db })
  const reminders = new ReminderStore(input.db)
  // T2 r3 (2026-05-13) — Argus BLOCKING #1: reuse the caller-supplied
  // shared registry when present. Production composer threads the SAME
  // instance into the cron module's CronScheduler so action 07's
  // overnight-pass registration is visible to the scheduler at tick
  // time. Without sharing, the scheduler walks `this.jobs.list()` and
  // never sees the wow-moment job.
  const cron_jobs = input.cronJobs ?? new CronJobRegistry()
  const cron_state = new CronStateStore(input.db)
  const channel: WowChannelAdapter = buildWowChannelAdapter({
    webRegistry: input.webRegistry,
    buttonStore: input.buttonStore,
  })
  const runner = new ActionRunner({
    telemetry,
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.actionTimeoutMs !== undefined ? { action_timeout_ms: input.actionTimeoutMs } : {}),
  })
  // 2026-05-28 wow-cleanup r3 (Codex cross-model BLOCKER, Argus r2) —
  // when no caller-supplied probe is present, default-build a
  // ButtonStore-backed probe so the production dispatcher actually
  // serializes prompt-emitting actions. r2 omitted this and the
  // dispatcher's `prompt_resolution_probe` field stayed undefined →
  // the `waitForPromptResolution` undefined-probe branch fell through
  // to a flat 5s sleep, so for instances with rich signals (project-
  // shells + lifestyle-reminders both queueing prompts), notifications
  // STACKED in chat exactly as Sam reported 2026-05-28. Threading a
  // real probe is what makes Fix D's serialization guarantee land in
  // production. See `ButtonStoreResolutionProbe` below for the
  // implementation; tests can override via `input.promptResolutionProbe`.
  const promptResolutionProbe: PromptResolutionProbe =
    input.promptResolutionProbe ??
    new ButtonStoreResolutionProbe({
      buttonStore: input.buttonStore,
      ...(input.promptResolutionPollMs !== undefined
        ? { poll_interval_ms: input.promptResolutionPollMs }
        : {}),
      ...(input.promptResolutionSleep !== undefined
        ? { sleep: input.promptResolutionSleep }
        : {}),
      ...(input.promptResolutionNow !== undefined
        ? { now: input.promptResolutionNow }
        : {}),
    })
  const dispatcher = new WowDispatcher({
    telemetry,
    runner,
    ...(input.interActionPauseMs !== undefined
      ? { inter_action_pause_ms: input.interActionPauseMs }
      : {}),
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    prompt_resolution_probe: promptResolutionProbe,
  })
  // P2 v2 S9 (Codex S9-r1 P1) — log a structured warning at builder time
  // when the production composer didn't thread a picker LLM. Without
  // this, every dispatch silently uses the dispatcher's failing-stub
  // `defaultLlm` and falls back to the deterministic predicate set —
  // the v2 LLM-selection path designed in spec § 5.3 never runs and the
  // per-pick `wow_events.explanation` strings stay empty.
  if (input.pickerLlm === undefined) {
    console.warn(
      '[build-wow-dispatcher] WARNING: pickerLlm not configured for this project; every wow-moment dispatch will use the deterministic fallback path. Wire BuildLandingStackInput.wowPickerLlm to enable the spec § 5.3 LLM picker.',
    )
  }
  return {
    async dispatch(hookInput: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> {
      // Item 4 — enriched materializer for action 03 (project shells →
      // on-disk git repo + doc set + transcript slices + memory index).
      // Built per dispatch because project_slug arrives on the hook input;
      // construction is closure-cheap (no I/O until materialize()).
      const materializer = buildProjectMaterializer({
        owner_home: hookInput.owner_home ?? input.owner_home,
        project_slug: hookInput.project_slug,
        db: input.db,
        now: () => Date.now(),
        composer: input.materializerComposer ?? null,
        indexer: input.materializerIndexer ?? null,
      })
      const outcome = await dispatcher.dispatch({
        project_slug: hookInput.project_slug,
        topic_id: hookInput.topic_id,
        owner_home: hookInput.owner_home ?? input.owner_home,
        interview: hookInput.signals.interview,
        import_result: hookInput.signals.import_result,
        rituals: [...hookInput.signals.rituals],
        captured_projects: [...hookInput.signals.captured_projects],
        projects_confirmed: hookInput.signals.projects_confirmed === true,
        contemplative_keywords: [...hookInput.signals.contemplative_keywords],
        stalled_threads: [...hookInput.signals.stalled_threads],
        gmail_scopes: hookInput.signals.gmail_scopes,
        reminders,
        cron_jobs,
        cron_state,
        db: input.db,
        channel,
        gmail: null,
        materializer,
        ...(input.pickerLlm !== undefined ? { picker_llm: input.pickerLlm } : {}),
      })
      const hookOutcome: WowDispatcherHookOutcome = {
        fired: outcome.fired,
        skipped_no_trigger: outcome.skipped_no_trigger,
        failed: outcome.failed.map((f) => ({ action_id: f.action_id, reason: f.reason })),
        rescheduled: outcome.rescheduled,
      }
      // 2026-05-28 Argus r2 — forward the brief's affordance prompt_id
      // so the engine's wow_fired success-path can stamp it as the
      // active_prompt_id and route the [A] Start overnight pass tap
      // back through `consumeWowFallbackChoice`.
      if (outcome.brief_prompt_id !== undefined) {
        hookOutcome.brief_prompt_id = outcome.brief_prompt_id
      }
      return hookOutcome
    },
  }
}

/** Dependencies for {@link buildWowChannelAdapter}. */
export interface WowChannelAdapterDeps {
  /** Same web sender registry the engine's `sendButtonPrompt` routes through. */
  webRegistry: WebChatSenderRegistry
  /** Per-project button-prompt store — the chat-history store on disk. */
  buttonStore: ButtonStore
}

/**
 * Build the `WowChannelAdapter` the WowDispatcher uses for its outbound
 * surface. Extracted from `buildWowDispatcherHook` (2026-06-20 chat-polish)
 * so the adapter's persistence behaviour is unit-testable directly with a
 * real `ButtonStore` + a stub `webRegistry`, rather than only reachable
 * through a full wow dispatch.
 */
export function buildWowChannelAdapter(deps: WowChannelAdapterDeps): WowChannelAdapter {
  return {
    async emitPrompt(opts: { prompt: ButtonPrompt; topic_id: string }): Promise<{ prompt_id: string }> {
      // 2026-05-28 wow-cleanup r3 BLOCKER (Codex cross-model, Argus r3):
      // peek WS availability BEFORE persisting the button_prompts row,
      // then throw on undelivered. The previous shape persisted the row
      // regardless of WS state — then `webRegistry.send` returned false
      // (WS dropped), the dispatcher's ButtonStoreResolutionProbe peeked
      // the persisted-but-undelivered row, observed `resolved_at=null`,
      // and looped for the full 30-min `serialize_prompt_timeout_ms`.
      // `handleKeptTyping` then set `outcome.rescheduled=true` and
      // action 01 (the brief) was NEVER fired. The engine saw no brief
      // failure + no `brief_prompt_id` → silently auto-advanced to
      // `completed`. Net: a WS-disconnect mid-dispatch put the user at
      // `phase=completed` having seen nothing — textbook active-lie
      // failure per the CLAUDE.md spec-conformance hard rule. The wow
      // dispatcher's `active_wow_prompt_id` is never re-emitted on
      // reconnect, so the 30-min wait was dead time too.
      //
      // The fix mirrors r2's `sendText` throw-on-undelivered pattern:
      // the action-runner's per-action try/catch converts the throw to
      // `outcome.failed[<this-action>]`. `fireOne`'s `followup_prompt_id`
      // stays undefined → the dispatcher's else-branch runs its 0ms
      // pause and fires the next action → action 01 (which also calls
      // `sendText` first) hits the same throw path and lands in
      // `outcome.failed[01-first-week-brief]` → the engine emits the
      // retry/skip fallback prompt + stays at `wow_fired` with
      // `wow_dispatch_error` set. No dead button_prompts row, no 30-min
      // wait, no silent advance to `completed`.
      if (!deps.webRegistry.has(opts.topic_id)) {
        throw new Error(
          `wow-channel emitPrompt undelivered for topic ${opts.topic_id} (no active WS)`,
        )
      }
      const emit = await deps.buttonStore.emit(opts.prompt, { topic_id: opts.topic_id })
      const delivered = deps.webRegistry.send(
        opts.topic_id,
        // P1a — stamp topic_id so the client routes this wow prompt to its own
        // topic (a wow-moment can fire while the user is on a different topic).
        renderButtonPromptForWeb(emit.prompt, opts.topic_id),
      )
      if (!delivered) {
        // Race: WS dropped between `has()` and `send()`. Throw so this
        // action lands in `outcome.failed[]` exactly as the
        // pre-persist case does. The persisted row is harmless dead
        // data — its prompt_id never escapes this scope (we throw
        // before returning), so no caller references it. The cron-tick
        // `sweepExpired` will time it out at `expires_at`.
        throw new Error(
          `wow-channel emitPrompt undelivered for topic ${opts.topic_id} (WS dropped mid-send)`,
        )
      }
      await deps.buttonStore.markDelivered(emit.prompt_id, Date.now())
      return { prompt_id: emit.prompt_id }
    },
    async sendText(opts: { topic_id: string; body: string }): Promise<{ message_id: string }> {
      // T2 r3 (2026-05-13) — Argus IMPORTANT: throw on undelivered.
      // r2 returned `{ message_id: 'undelivered' }` and action 01
      // (first-week-brief) does NOT inspect message_id — it
      // unconditionally returns `{ fired: true }`. A user whose WS
      // dropped mid-dispatch (or who reached wow_fired via Telegram
      // with no web WS bound) silently saw `phase=completed` and never
      // got the brief. Throwing routes through the action-runner's
      // per-action try/catch — outcome.failed carries the brief failure
      // and the engine's wow_fired-failure branch emits the retry/skip
      // fallback. Fail-fast + single error-handling path; no per-action
      // boilerplate.
      const ok = deps.webRegistry.send(opts.topic_id, {
        type: 'agent_message',
        body: opts.body,
        // P1a — stamp topic_id so the client routes this wow text to its own
        // topic, not whatever is focused when the wow-moment fires.
        topic_id: opts.topic_id,
      })
      if (!ok) {
        throw new Error(
          `wow-channel sendText undelivered for topic ${opts.topic_id} (no active WS)`,
        )
      }
      // 2026-06-20 (chat-polish A, owner live-dogfood) — persist the
      // delivered text to `button_prompts` as an INERT, already-resolved
      // history turn so it hydrates on reload. THE BUG: a wow-moment
      // `sendText` (notably action 01's first-week brief — the
      // projects+overnight summary) ONLY did the live `webRegistry.send`
      // above; it never wrote to the chat-history store that
      // `GET /api/v1/chat/history` reads (`button_prompts`). So the brief
      // showed live during onboarding then VANISHED on General reload —
      // the owner's DB confirmed 10 turns in `button_prompts`, none the
      // brief. `emitPrompt` persists via `buttonStore.emit`; `sendText`
      // did not. Mirror that here for every wow `sendText` (all are
      // user-facing agent statements that SHOULD survive reload).
      //
      // Shape: a SINGLE atomic INSERT (`persistInertAgentTurn`) writes an
      // already-resolved, zero-option row carrying the text as its body.
      // That satisfies the history filter `(resolved_at IS NOT NULL OR
      // expires_at > now)` AND renders as an agent-only bubble:
      // `renderHistoricalTurn` paints the agent body and skips the user
      // bubble when `resolution_text` is empty. No button keyboard, no
      // user-side bubble — exactly an inert agent statement.
      //
      // One atomic write (NOT emit + resolve): a two-step emit-then-resolve
      // could leave an UNRESOLVED row if the resolve step threw/was
      // interrupted, and an unresolved zero-option row is treated as the
      // topic's ACTIVE prompt by the re-emit + live-agent user-turn paths
      // — so the user's next message would attach to the brief instead of
      // it staying inert (Codex cross-model review, 2026-06-20). The
      // single INSERT has no intermediate unresolved state to leak.
      //
      // CRITICAL: best-effort and must NEVER fail delivery. The
      // throw-on-undelivered semantics above are load-bearing (the
      // action-runner's per-action try/catch routes them into
      // `outcome.failed[]`); persistence runs ONLY after a confirmed
      // `ok` send and is wrapped so a DB hiccup logs + continues rather
      // than turning a delivered message into a dispatch failure.
      //
      // No double-render: the live envelope above carries no prompt_id, so
      // the client's prompt_id-keyed dedup (`renderedPromptIds`) never
      // collides with this history row.
      try {
        await deps.buttonStore.persistInertAgentTurn({
          topic_id: opts.topic_id,
          body: opts.body,
        })
      } catch (err) {
        console.warn(
          `[build-wow-dispatcher] sendText history-persist failed for topic ${opts.topic_id} (delivery already succeeded; chat-history turn skipped):`,
          err,
        )
      }
      return { message_id: `web-${Date.now()}` }
    },
  }
}

/**
 * 2026-05-28 wow-cleanup r3 (Codex cross-model BLOCKER, Argus r2) —
 * production `PromptResolutionProbe` backed by the per-project
 * `ButtonStore`. Polls `button_prompts.resolved_at` for the supplied
 * `prompt_id` until the row resolves OR the supplied timeout elapses.
 *
 * Resolution semantics: a row resolves when its `resolved_at` column is
 * non-null. That happens on (a) a user tap routed through
 * `ButtonStore.resolve(...)` OR (b) the cron-tick `sweepExpired(...)`
 * timing the row out with `__timeout__`. Both surface as "stop
 * waiting" to the dispatcher — the next action either fires (real
 * answer landed) or the dispatcher's own
 * `serialize_prompt_timeout_ms` returns 'resolved' on the swept row's
 * resolved_at and the next dispatch tick advances. Either way, the
 * "notifications stacked" pile-up from r2 is gone.
 *
 * Test seams: `poll_interval_ms` (default 500ms) caps the poll
 * cadence; `sleep` + `now` are injectable so unit tests can drive the
 * loop without burning wall-clock time.
 *
 * Instance isolation: the probe holds a reference to ONE instance's
 * `ButtonStore` instance (which owns its own `ProjectDb`). A
 * `prompt_id` collision across instances is structurally impossible
 * because (1) each instance has a private SQLite file and (2) the
 * `ButtonStore` only ever reads from that file.
 */
export class ButtonStoreResolutionProbe implements PromptResolutionProbe {
  private readonly buttonStore: ButtonStore
  private readonly pollIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly nowFn: () => number

  constructor(opts: {
    buttonStore: ButtonStore
    poll_interval_ms?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }) {
    this.buttonStore = opts.buttonStore
    this.pollIntervalMs = opts.poll_interval_ms ?? 500
    this.sleep = opts.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms))
    this.nowFn = opts.now ?? ((): number => Date.now())
  }

  async waitFor(prompt_id: string, timeout_ms: number): Promise<'resolved' | 'timeout'> {
    const deadline = this.nowFn() + timeout_ms
    // Check once before sleeping — covers the case where the user
    // tapped between the action's emit and the dispatcher's first
    // poll (race that the unit test exercises directly via
    // `buttonStore.resolve(...)` before the probe loop starts).
    while (true) {
      const row = await this.buttonStore.peek(prompt_id)
      if (row !== null && row.resolved_at !== null) return 'resolved'
      const remaining = deadline - this.nowFn()
      if (remaining <= 0) return 'timeout'
      await this.sleep(Math.min(this.pollIntervalMs, remaining))
    }
  }
}
