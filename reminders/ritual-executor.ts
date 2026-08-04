/**
 * @neutronai/reminders — the RITUAL EXECUTOR (executor-mode reminders, plan task 4).
 *
 * At fire time the tick loop (`reminders/tick.ts`) routes a `ritual_id` row to
 * this executor's `fire()` INSTEAD of the nudge dispatcher. The tick AWAITS
 * fire() — but only its STARTUP (validate → spawn → durable 'running' row); the
 * launched substrate turn is detached INTERNALLY at step (f), so the tick never
 * blocks on an up-to-45-min run. The executor:
 *   1. VALIDATES the ritual fail-CLOSED (`validateRitualFire` + the content-hash
 *      approval checker built from the row's LIVE cadence). A skip verdict lands a
 *      durable `code_ritual_runs` 'skipped' row and spawns NOTHING.
 *   2. SPAWNS a registry `agent_kind:'ritual'` record on the isolated ritual lane
 *      (`spawnSubagent`, spawn_key `ritual:<id>`, on_duplicate 'refuse'). A spawn
 *      refusal (lane cap / duplicate) lands a durable 'failed' row and returns.
 *   3. Records the live attempt as a 'running' row carrying content_hash +
 *      subagent_run_id, flips the registry record to running (best-effort), and
 *   4. LAUNCHES one substrate turn on a `cc-ritual-*` ephemeral REPL — NOT awaited
 *      by `fire()` (the tick must not block up to 45 min on a ritual). On
 *      settlement it drives the run row terminal (finished / failed / timed_out /
 *      crashed) with ended_at + a truncated output_summary and the registry record
 *      terminal.
 *
 * `fire()` RETURNS a {@link RitualFireOutcome} and NEVER awaits the launched turn.
 * A startup failure = validate/spawn/durable-row-write threw so NO
 * `code_ritual_runs` row landed for this occurrence; the outer catch classifies it
 * and answers `{claim:'retry', retry_at_ms}` when — and only when — the cause is
 * stamped TRANSIENT and the occurrence has attempts left, which makes the tick
 * re-arm the row on a backoff (`reminders/tick.ts`) instead of the occurrence being
 * silently consumed with no run + no history (the Argus data-loss class — a claimed
 * occurrence must never vanish without a durable record). Anything else terminates
 * the occurrence with a recorded, VISIBLE failure. A startup that DID land a durable
 * row (skipped / failed / running) answers `{claim:'consume'}` — the claim is
 * legitimately consumed. The detached substrate TURN (step (f)) is fire-and-forget
 * and its settlement is fail-soft (guarded so it can never reject out of `fire()`).
 *
 * BOUNDED TRANSIENT RECOVERY (ISSUES #489). Both failure surfaces — a startup throw
 * and a settled turn — route through ONE policy in `./ritual-retry.ts`: a
 * three-valued classification (transient / permanent / indeterminate) read off the
 * O3 error taxonomy, an attempt cap, and a pure exponential backoff. Only
 * `transient` retries. The re-attempt re-arms the SAME occurrence (so the retry
 * carries the same `reminder_id` and the run history for that morning reads as one
 * occurrence with N attempts), and it is refused outright if anything has already
 * been DELIVERED for that occurrence — the owner must never receive two morning
 * briefs. Success, retry-exhausted, permanent failure and unclassified failure are
 * each distinguishable from `code_ritual_runs` alone via the `failure_reason`
 * prefix, because a background failure has to be answerable without logs (a clean
 * run emits no log line at all).
 *
 * COMPLETION DELIVERY + FAILURE SURFACING (plan task 5): after the durable
 * `code_ritual_runs` row is written FIRST, the settle chain posts through the ONE
 * out-of-turn delivery seam (`deps.outbound`, production
 * `buildButtonStoreReminderOutbound({ deliver })`) to `deps.resolve_topic(reminder)`:
 *   - a `finished` non-silent ritual posts its final text (or a completion
 *     fallback when the output is empty);
 *   - a `silent` ritual posts NOTHING on success (silent suppresses SUCCESS
 *     output only — failure notices below still post);
 *   - every failure terminal (failed / timed_out / crashed, incl. spawn-refusal
 *     'failed' rows) posts exactly one one-line notice carrying ritual id +
 *     status + run id;
 *   - the 3rd consecutive failure additionally posts one escalation notice, once
 *     per streak (a deterministic rule over the last 4 terminal rows — no new
 *     state).
 * All posts are BEST-EFFORT (try/catch + log): the durable row is the record and
 * the detached settle chain must NEVER reject.
 *
 * DECOUPLED FROM agent-dispatch (the DispatchService↔TridentDispatch structural-
 * match precedent, `agent-dispatch/service.ts:104-108`): this module declares a
 * STRUCTURAL `RitualTurn` type compatible with the dispatch `DispatchTurn`, so the
 * composer can hand it the very same `buildCancellableDispatchTurn` closure WITHOUT
 * this module importing `@neutronai/agent-dispatch` (no layering inversion, no
 * second substrate).
 */

import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'
import type { ApprovalManager } from '@neutronai/tools/approval.ts'
import type { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { spawnSubagent } from '@neutronai/runtime/subagent/spawn.ts'
import type { Reminder } from './store.ts'
import {
  RITUAL_MODEL_TIER,
  RITUAL_TIMEOUT_MS,
  validateRitualFire,
  type RitualApprovalCheck,
  type RitualDef,
  type RitualRegistry,
  type RitualScope,
} from './rituals.ts'
import {
  computeRitualContentHash,
  createRitualApprovalCheck,
  ritualCadenceString,
} from './ritual-approval.ts'
import type { RitualRunStore, RitualRunTerminalStatus } from './ritual-runs.ts'
import type { ReminderOutbound } from './dispatcher.ts'
import {
  RITUAL_ESCALATION_CONSECUTIVE_FAILURES,
  collapseAttemptsToOccurrences,
  formatRitualCompletionFallback,
  formatRitualEscalationNotice,
  formatRitualFailureNotice,
  shouldEscalate,
} from './ritual-delivery.ts'
import {
  RITUAL_MAX_ATTEMPTS,
  RitualAttemptLedger,
  RitualDeliveryLatch,
  classifyRitualFailure,
  classifyRitualTurnFailure,
  ritualRetryDelayMs,
  type RitualFailureDisposition,
  type RitualTurnFailureClass,
} from './ritual-retry.ts'

const log = createLogger('ritual-executor')

/**
 * One ritual substrate turn → terminal text. STRUCTURAL match to
 * `agent-dispatch`'s `DispatchTurnInput` (minus the board fields) so the composer
 * passes the SAME `buildCancellableDispatchTurn` closure the dispatch service +
 * Trident loop use — this module does not import agent-dispatch.
 */
export interface RitualTurnInput {
  kind: 'ritual'
  /** Bare kind label — structural only; the ritual persona rides the system prompt file. */
  system: string
  user_message: string
  repo_path: string
  /** The owning registry run_id (audit). */
  trident_run_id: string
  model: string
  timeout_ms: number
  /** The granted tool surface (`--tools`) — the RitualDef `tool_surface`. */
  tools?: ReadonlyArray<string>
  signal?: AbortSignal
}

export interface RitualTurnResult {
  result: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  /**
   * The O3 failure class the substrate stamped, when it stamped one. STRUCTURAL
   * match to `agent-dispatch`'s `DispatchTurnFailure` (same reason as the input
   * type above — the same closure is handed to both, without an import between
   * the modules). Absent means UNCLASSIFIED, which the recovery policy treats as
   * `indeterminate`, never as retryable.
   */
  failure?: RitualTurnFailureClass
}

export interface RitualTurn {
  (input: RitualTurnInput): Promise<RitualTurnResult>
}

export interface RitualExecutorDeps {
  /** The ritual registry (fire-time validation + prompt read). */
  registry: RitualRegistry
  /** The approval manager — first content-hash approval checker source. */
  approvals: ApprovalManager
  /** Owning instance slug (durable run rows + approval scope). */
  project_slug: string
  /** Owning instance key (registry scoping + the ritual lane cap). */
  instance_key: string
  /** The shared subagent registry (one registry, one lane). */
  subagents: SubagentRegistry
  /** One substrate turn → terminal text (production: `buildCancellableDispatchTurn`). */
  turn: RitualTurn
  /** The sole `code_ritual_runs` writer. */
  runs: RitualRunStore
  /**
   * The ONE out-of-turn delivery seam (durable-row-first + best-effort push).
   * Production: `buildButtonStoreReminderOutbound({ deliver })` — the SAME
   * instance the nudge dispatcher posts through.
   */
  outbound: ReminderOutbound
  /**
   * Resolve the delivery topic for a fired ritual reminder. Production: the
   * composer's app-ws General resolver (`resolveAppWsReminderTopic`).
   */
  resolve_topic: (reminder: Reminder) => string
  /** Resolve the concrete model id for `RITUAL_MODEL_TIER` (thunk — live best model). */
  resolve_model: () => string
  /** Resolve the cwd + write-containment root for a ritual scope. */
  scope_cwd: (scope: RitualScope) => string
  /**
   * Re-arm a spent occurrence to fire again at `fire_at_sec` (unix SECONDS, the
   * `reminders` epoch). Production: the composer's `ReminderStore`
   * reopen-then-reschedule pair.
   *
   * Needed ONLY by the detached-turn path. A fire-STARTUP retry is re-armed by
   * the tick, which still holds the compare-and-swap anchor its #319 revert
   * depends on; by the time a 45-minute turn settles that tick is long gone, so
   * the executor has to re-arm the row itself. Returns `false` when the row was
   * not re-armed (cancelled, rescheduled by the owner, already gone) — the
   * caller treats that as "the occurrence moved on" and does not retry.
   */
  rearm: (reminder: Reminder, fire_at_sec: number) => Promise<boolean>
  /** Approval-checker factory seam (tests). Defaults to `createRitualApprovalCheck`. */
  build_approval_check?: (cadence: string) => RitualApprovalCheck
  /** run_id factory (test seam) — minted per fire attempt AND per subagent record. */
  mint_run_id?: () => string
  /** Now-injection (test seam). */
  now?: () => number
}

/**
 * What the tick should do with the occurrence claim it took before calling
 * `fire()`.
 *
 * This used to be signalled by REJECTING — a resolved `fire()` meant "consume",
 * a rejection meant "revert and re-fire next tick". That encoding could only say
 * two things, and it said the second one forever: a fire-startup failure that
 * did not fix itself reverted the claim on every 30 s tick, indefinitely, with
 * no `code_ritual_runs` row to show for any of it (ISSUES #489). A returned
 * verdict can carry WHEN to re-attempt and WHICH attempt this is, which is what
 * makes the recovery bounded and inspectable instead of a loop.
 */
export type RitualFireOutcome =
  /**
   * The occurrence is finished with — a durable row landed (running / skipped /
   * failed), or the fire was legitimately a no-op. The tick keeps its claim.
   */
  | { claim: 'consume' }
  /**
   * A TRANSIENT failure the executor wants re-attempted. The tick re-arms the
   * occurrence at `retry_at_ms` (instead of reverting it to its original,
   * already-due `fire_at`, which is what made the old revert an every-tick
   * loop). `attempt` is 1-based and always < {@link RITUAL_MAX_ATTEMPTS}.
   */
  | {
      claim: 'retry'
      retry_at_ms: number
      attempt: number
      disposition: RitualFailureDisposition
    }

/**
 * The executor seam the tick loop consumes.
 *
 * `fire(reminder)` RESOLVES with a {@link RitualFireOutcome} and does not use
 * rejection as control flow — its whole body is guarded, so a rejection now
 * means a bug in the executor itself and the tick treats it as such (log loudly,
 * consume, do not spin). It still never awaits the detached substrate turn.
 */
export interface RitualExecutor {
  fire(reminder: Reminder): Promise<RitualFireOutcome>
}

function mintId(mint: (() => string) | undefined): string {
  if (mint !== undefined) return mint()
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `rr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * Build the ritual executor. See the module header for the full fire-time
 * contract; `fire()` REJECTS on a STARTUP failure (so the tick can revert its
 * occurrence claim and re-fire) and NEVER awaits the launched substrate turn.
 */
export function createRitualExecutor(deps: RitualExecutorDeps): RitualExecutor {
  const now = deps.now ?? Date.now
  /** Failures per OCCURRENCE (`reminder_id`) — the attempt bound. */
  const attempts = new RitualAttemptLedger()
  /** Occurrences whose ritual OUTPUT has already reached the owner. */
  const delivered = new RitualDeliveryLatch()

  /**
   * Has this occurrence already put its output in front of the owner?
   *
   * Two guards, in the order of how much they can be trusted. The DURABLE one is
   * a `finished` run row for the occurrence: it is the record, and it survives a
   * restart. The in-memory latch closes the one window the row cannot — a turn
   * that completed and posted but whose row write failed.
   *
   * A THROWING read answers `true`. That is deliberate and asymmetric: if the
   * run store cannot tell us whether the brief was already sent, the safe answer
   * is to not send it again. A missed retry costs one late ritual; a wrong retry
   * costs the owner a duplicate morning brief, which is the single outcome this
   * whole recovery path must never produce.
   */
  function alreadyDelivered(reminder: Reminder): boolean {
    if (delivered.has(reminder.id)) return true
    try {
      return deps.runs.listByReminder(reminder.id).some((r) => r.status === 'finished')
    } catch (err) {
      log.warn('ritual_delivery_check_failed', {
        reminder_id: reminder.id,
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }

  /**
   * The ONE recovery decision, shared by the fire-startup path and the settled-
   * turn path so the two can never drift into different policies.
   *
   * Returns the re-attempt instant when — and only when — the failure is
   * classified `transient`, the occurrence has attempts left, and nothing has
   * been delivered for it. `null` means terminal: the caller records a visible
   * failure and stops.
   */
  function planRetry(
    reminder: Reminder,
    disposition: RitualFailureDisposition,
  ): { retry_at_ms: number; attempt: number } | null {
    const attempt = attempts.bump(reminder.id)
    if (disposition !== 'transient') return null
    if (attempt >= RITUAL_MAX_ATTEMPTS) return null
    if (alreadyDelivered(reminder)) return null
    return { retry_at_ms: now() + ritualRetryDelayMs(attempt), attempt }
  }

  /**
   * The `failure_reason` written on a terminal row, prefixed so the three
   * dispositions are distinguishable from `code_ritual_runs` ALONE — the point
   * of the whole exercise being that a background failure must be answerable
   * afterwards without grepping logs (a clean run emits no log line at all).
   */
  function terminalReason(
    disposition: RitualFailureDisposition,
    attempt: number,
    detail: string,
  ): string {
    const prefix =
      disposition === 'transient'
        ? `retry exhausted after ${attempt} attempts`
        : disposition === 'permanent'
          ? 'permanent failure (not retried)'
          : 'unclassified failure (not retried)'
    return `${prefix}: ${detail}`
  }

  /** Best-effort post of one notice body. NEVER throws (the record is the row).
   *  A post()==false (spec §267: the durable reply write was swallowed —
   *  gateway/http/deliver.ts:187-188 → reminder-outbound.ts:41-42) is retried
   *  ONCE, then a still-false result is logged as an un-persisted notice. A
   *  THROWN post keeps the existing catch path ('ritual_notice_post_failed'). */
  async function postNotice(
    topic_id: string,
    owner_slug: string,
    reminder_id: string,
    body: string,
  ): Promise<void> {
    try {
      const ok = await deps.outbound.post({ topic_id, owner_slug, body, reminder_id })
      if (!ok) {
        const retried = await deps.outbound.post({ topic_id, owner_slug, body, reminder_id })
        if (!retried) log.error('ritual_notice_post_not_persisted', { reminder_id, topic_id })
      }
    } catch (err) {
      log.error('ritual_notice_post_failed', {
        reminder_id,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    }
  }

  /**
   * Surface a failure terminal: post the one-line failure notice, THEN — when
   * the last-4-terminal-rows rule crosses 3 consecutive failures — one escalation
   * notice (once per streak). Wrapped so it can NEVER reject the settle chain.
   */
  async function surfaceFailure(
    reminder: Reminder,
    ritual_id: string,
    run_id: string,
    status: RitualRunTerminalStatus,
    failure_reason?: string | null,
  ): Promise<void> {
    try {
      const topic = deps.resolve_topic(reminder)
      const owner = reminder.owner_slug
      await postNotice(
        topic,
        owner,
        reminder.id,
        formatRitualFailureNotice({ ritual_id, status, run_id, failure_reason: failure_reason ?? null }),
      )
      // Read the last N+1 terminal OCCURRENCES after this failure's row is
      // written — the escalation rule is pure over that snapshot (no new state).
      // The window is derived from the streak constant (the 3 newest to check + 1
      // older to gate re-arm), not a hardcoded literal (Argus r1 nit), and is
      // then multiplied by the attempt cap because bounded recovery can leave up
      // to `RITUAL_MAX_ATTEMPTS` rows per occurrence: without the wider read a
      // single retried morning would fill the whole window and the older
      // streak-breaker that re-arms the notice would fall off the end.
      const recent = collapseAttemptsToOccurrences(
        deps.runs.listRecentTerminal({
          ritual_id,
          limit: (RITUAL_ESCALATION_CONSECUTIVE_FAILURES + 1) * RITUAL_MAX_ATTEMPTS,
        }),
      ).slice(0, RITUAL_ESCALATION_CONSECUTIVE_FAILURES + 1)
      if (shouldEscalate(recent)) {
        await postNotice(topic, owner, reminder.id, formatRitualEscalationNotice({ ritual_id, run_id }))
      }
    } catch (err) {
      log.error('ritual_surface_failure_failed', {
        reminder_id: reminder.id,
        ritual_id,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    }
  }

  /** Map a settled turn onto the run-row + registry terminal states, then deliver. */
  async function settleTerminal(
    reminder: Reminder,
    def: RitualDef,
    ritual_id: string,
    runRunId: string,
    subagentRunId: string,
    r: RitualTurnResult,
  ): Promise<void> {
    const runStatus: RitualRunTerminalStatus =
      r.status === 'completed'
        ? 'finished'
        : r.status === 'timed_out'
          ? 'timed_out'
          : r.status === 'cancelled'
            ? 'cancelled'
            : 'failed'
    const registryStatus =
      r.status === 'completed' ? 'finished' : r.status === 'cancelled' ? 'cancelled' : 'crashed'
    // DECIDE RECOVERY BEFORE the durable write, so the row this attempt leaves
    // behind says which of the three verdicts it got. `planRetry` bumps the
    // attempt ledger and must therefore be called EXACTLY ONCE per settled
    // failure — hence here, not inside the branch below.
    const settledDetail = r.result.trim().length > 0 ? r.result.trim() : null
    // A settled turn maps onto exactly four run statuses (`crashed` belongs to
    // `settleCrashed`, where the turn REJECTED rather than settled), so the
    // failure set here is the two below.
    const disposition: RitualFailureDisposition | null =
      runStatus === 'failed' || runStatus === 'timed_out'
        ? classifyRitualTurnFailure({ status: runStatus, failure: r.failure })
        : null
    const retry = disposition === null ? null : planRetry(reminder, disposition)
    // The reason recorded on THIS attempt's row. A scheduled re-attempt says so
    // (so a later reader can tell a retried attempt from the one that gave up);
    // a terminal failure carries the disposition prefix.
    const failureReason: string | undefined =
      disposition === null
        ? undefined
        : retry !== null
          ? `transient, retry ${retry.attempt}/${RITUAL_MAX_ATTEMPTS - 1} scheduled: ${settledDetail ?? runStatus}`
          : terminalReason(
              disposition,
              attempts.peek(reminder.id),
              settledDetail ?? runStatus,
            )
    // Durable row FIRST — the record of the run, before any post. GUARDED: an
    // unguarded throw here previously jumped to settleCrashed, which retried the
    // SAME (still-failing) run store and therefore NEVER reached the registry
    // updateTerminal below — leaking the `ritual:<id>` spawn key (on_duplicate:
    // 'refuse') until process restart (Argus r2 minor). Guarding it keeps the
    // key-free step (below) independent of run-history persistence.
    try {
      await deps.runs.markTerminal({
        run_id: runRunId,
        status: runStatus,
        ended_at_ms: now(),
        output_summary: r.result,
        ...(failureReason !== undefined ? { failure_reason: failureReason } : {}),
      })
    } catch (err) {
      log.error('ritual_run_terminal_persist_failed', {
        run_id: runRunId,
        status: runStatus,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    }
    // Registry terminal — ALWAYS runs, independent of run-history persistence, so
    // a run-store outage can never leak the `ritual:<id>` spawn key. Guarded so a
    // registry hiccup can never reject the detached run promise.
    try {
      await deps.subagents.updateTerminal(subagentRunId, { status: registryStatus, ended_at: now() })
    } catch (err) {
      log.error('ritual_registry_terminal_failed', {
        subagent_run_id: subagentRunId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    }
    // DELIVERY — after the durable row is written.
    if (runStatus === 'finished') {
      // LATCH BEFORE POSTING, not after. The latch is what stops a later failure
      // for this occurrence from re-attempting into a second morning brief, and
      // the moment the output leaves this process it may already be in front of
      // the owner — a post that succeeds and then fails to return (or a settle
      // that is interleaved with another) must not leave the latch unset. Marking
      // first can only ever suppress a retry that was already unsafe.
      delivered.mark(reminder.id)
      attempts.forget(reminder.id)
      if (!def.silent) {
        const text = r.result.trim()
        const body = text.length > 0 ? text : formatRitualCompletionFallback({ ritual_id, run_id: runRunId })
        await postNotice(deps.resolve_topic(reminder), reminder.owner_slug, reminder.id, body)
      }
      // silent → no success post.
    } else if (runStatus === 'cancelled') {
      // Operator/shutdown abort — a durable 'cancelled' row is the record. NOT a
      // merit failure: no scary failure notice, it never feeds the
      // consecutive-failure escalation (Argus r1 minor), and it is not retried
      // (the operator asked for it to stop; re-arming would be an argument).
      attempts.forget(reminder.id)
    } else if (retry !== null) {
      // TRANSIENT, with attempts left and nothing delivered — re-arm the SAME
      // occurrence and stay quiet. No failure notice: the ritual has not failed
      // yet, and telling the owner about an attempt that is about to be repeated
      // is the alarm-fatigue this recovery path is supposed to prevent. The
      // durable row above already records the attempt and says a retry is
      // scheduled, so the silence here is not an absence of record.
      const rearmed = await rearmOrSurface(reminder, ritual_id, runRunId, runStatus, retry, settledDetail)
      if (!rearmed) return
    } else {
      // failed / timed_out / crashed with no re-attempt: permanent, unclassified,
      // or out of attempts. `formatRitualFailureNotice` (ritual-delivery.ts) owns
      // whitespace-collapse THEN the MAX_REASON_CHARS cap — a pre-slice here
      // would truncate BEFORE collapse and could under-fill the notice, so pass
      // the full trimmed text.
      attempts.forget(reminder.id)
      await surfaceFailure(reminder, ritual_id, runRunId, runStatus, settledDetail)
    }
  }

  /**
   * Re-arm the occurrence for a planned re-attempt. Returns `true` when the row
   * was re-armed; on a failure to re-arm it falls back to surfacing the failure
   * so the occurrence never ends in silence, and returns `false`.
   *
   * The fallback is the whole reason this is a function rather than two lines
   * inline: a retry that cannot actually be scheduled is indistinguishable, from
   * the owner's side, from the original bug — the work vanishes and nothing says
   * so. So a `rearm` that returns false (the row was cancelled or rescheduled
   * under us) or throws degrades to the ordinary visible failure notice.
   */
  async function rearmOrSurface(
    reminder: Reminder,
    ritual_id: string,
    runRunId: string,
    runStatus: RitualRunTerminalStatus,
    retry: { retry_at_ms: number; attempt: number },
    detail: string | null,
  ): Promise<boolean> {
    let ok = false
    try {
      ok = await deps.rearm(reminder, Math.floor(retry.retry_at_ms / 1000))
    } catch (err) {
      log.error('ritual_retry_rearm_failed', {
        reminder_id: reminder.id,
        ritual_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (ok) {
      log.info('ritual_retry_scheduled', {
        reminder_id: reminder.id,
        ritual_id,
        run_id: runRunId,
        attempt: retry.attempt,
        retry_at_ms: retry.retry_at_ms,
      })
      return true
    }
    attempts.forget(reminder.id)
    await surfaceFailure(reminder, ritual_id, runRunId, runStatus, detail)
    return false
  }

  /** The turn rejected outright — record a crash on both surfaces, then notice. */
  async function settleCrashed(
    reminder: Reminder,
    ritual_id: string,
    runRunId: string,
    subagentRunId: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    log.error('ritual_turn_crashed', { subagent_run_id: subagentRunId, error: message })
    // Same three-valued decision as the settled path, so a crash that IS stamped
    // transient recovers and one that is not says so on its row. A turn that
    // rejects outright is usually an unstamped fault, i.e. `indeterminate` — which
    // means this ordinarily terminates, and does so with a reason that admits it
    // was never classified rather than one that implies it was.
    const disposition = classifyRitualFailure(err)
    const retry = planRetry(reminder, disposition)
    // GUARDED (Argus r2 minor): the run-store write must not skip the registry
    // key-free below — the `ritual:<id>` spawn key is freed by updateTerminal, and
    // a persistent run-store error must never leave it live (refusing all future
    // fires until restart).
    try {
      await deps.runs.markTerminal({
        run_id: runRunId,
        status: 'crashed',
        ended_at_ms: now(),
        failure_reason: (retry !== null
          ? `transient, retry ${retry.attempt}/${RITUAL_MAX_ATTEMPTS - 1} scheduled: ${message}`
          : terminalReason(disposition, attempts.peek(reminder.id), message)
        ).slice(0, 4000),
      })
    } catch (rerr) {
      log.error('ritual_run_terminal_persist_failed', {
        run_id: runRunId,
        status: 'crashed',
        error: rerr instanceof Error ? (rerr.stack ?? rerr.message) : String(rerr),
      })
    }
    try {
      await deps.subagents.updateTerminal(subagentRunId, { status: 'crashed', ended_at: now() })
    } catch (rerr) {
      log.error('ritual_registry_terminal_failed', {
        subagent_run_id: subagentRunId,
        error: rerr instanceof Error ? (rerr.stack ?? rerr.message) : String(rerr),
      })
    }
    if (retry !== null) {
      if (await rearmOrSurface(reminder, ritual_id, runRunId, 'crashed', retry, message)) return
      return
    }
    attempts.forget(reminder.id)
    await surfaceFailure(reminder, ritual_id, runRunId, 'crashed', message)
  }

  return {
    async fire(reminder: Reminder): Promise<RitualFireOutcome> {
      // fire() RESOLVES with a verdict. A STARTUP failure (no durable row landed)
      // is classified by the outer catch and turned into `{claim:'retry'}` — but
      // only when the cause is a KNOWN-transient one and the occurrence has
      // attempts left; otherwise it is recorded as a visible terminal failure and
      // the claim is consumed. The detached turn is fail-soft and can never reject
      // out of here (see the outer catch + module header).
      try {
        const ritual_id = reminder.ritual_id
        if (ritual_id === null) {
          // Defensive: the tick only routes non-null ritual_id rows here.
          log.error('ritual_fire_null_id', { reminder: reminder.id })
          return { claim: 'consume' }
        }
        const cadence = ritualCadenceString(reminder)
        const checker =
          deps.build_approval_check?.(cadence) ??
          createRitualApprovalCheck({
            manager: deps.approvals,
            project_slug: deps.project_slug,
            cadence,
          })

        // (b) fail-CLOSED validation. Every skip lands a durable 'skipped' row.
        const verdict = await validateRitualFire(deps.registry, checker, ritual_id)
        if (!verdict.ok) {
          await deps.runs.insertSkipped({
            run_id: mintId(deps.mint_run_id),
            ritual_id,
            reminder_id: reminder.id,
            project_slug: deps.project_slug,
            skip_reason: verdict.reason,
            now_ms: now(),
          })
          // A fail-CLOSED skip is a settled verdict, not a fault — the occurrence
          // is done and any earlier attempt count for it is spent.
          attempts.forget(reminder.id)
          return { claim: 'consume' }
        }

        const def = verdict.def
        // (b2) Resolve the scope cwd + write-containment root NOW — BEFORE any
        // durable 'running' row. An unsupported scope fails CLOSED as a durable
        // 'skipped' row rather than a silent owner-wide over-grant (Argus r1
        // MAJOR) or an orphaned 'running' row. v1 (task 5) wires ONLY the
        // 'instance' root; per-project rooting + write-containment is task 6
        // (design doc §Layer 4 / T4, the containment HARD GATE). A skip does NOT
        // count toward the consecutive-failure escalation — an unwired scope is
        // not a merit failure.
        let scope_cwd: string
        try {
          scope_cwd = deps.scope_cwd(def.scope)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.info('ritual_fire_skip', { reminder: reminder.id, ritual_id, reason: 'unsupported_scope', detail: message })
          await deps.runs.insertSkipped({
            run_id: mintId(deps.mint_run_id),
            ritual_id,
            reminder_id: reminder.id,
            project_slug: deps.project_slug,
            skip_reason: 'unsupported_scope',
            now_ms: now(),
          })
          attempts.forget(reminder.id)
          return { claim: 'consume' }
        }
        // (c) the content hash the fire is bound to (recorded on the 'running' row).
        const content_hash = computeRitualContentHash({
          prompt: verdict.prompt,
          tool_surface: def.tool_surface,
          scope: def.scope,
          cadence,
          model_tier: RITUAL_MODEL_TIER,
          timeout_ms: RITUAL_TIMEOUT_MS,
        })

        // (d) spawn on the ritual lane. A refusal (cap / duplicate) is a durable
        // 'failed' run row — no registry row leaks (spawnSubagent throws BEFORE
        // creating a record when a cap is hit).
        let rec
        try {
          const spawnDeps: Parameters<typeof spawnSubagent>[1] = {
            registry: deps.subagents,
            verify_delegation: async () => {
              throw new Error('rituals never nest')
            },
          }
          if (deps.mint_run_id !== undefined) spawnDeps.mint_run_id = deps.mint_run_id
          rec = await spawnSubagent(
            {
              instance_key: deps.instance_key,
              agent_kind: 'ritual',
              spawn_key: `ritual:${def.id}`,
              on_duplicate: 'refuse',
            },
            spawnDeps,
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const refusedRunId = mintId(deps.mint_run_id)
          await deps.runs.insertFailed({
            run_id: refusedRunId,
            ritual_id,
            reminder_id: reminder.id,
            project_slug: deps.project_slug,
            failure_reason: message,
            now_ms: now(),
          })
          // A spawn refusal is a durable 'failed' row → surface it like any other
          // failure terminal (counts toward the consecutive-failure escalation).
          await surfaceFailure(reminder, ritual_id, refusedRunId, 'failed', message)
          attempts.forget(reminder.id)
          return { claim: 'consume' }
        }

        // (e) the live 'running' history row (subagent_run_id + content_hash) is
        // the durable record of the attempt; the run_id IS the subagent run id so
        // the two surfaces cross-reference.
        try {
          await deps.runs.insertRunning({
            run_id: rec.run_id,
            ritual_id,
            reminder_id: reminder.id,
            project_slug: deps.project_slug,
            subagent_run_id: rec.run_id,
            content_hash,
            now_ms: now(),
          })
        } catch (insertErr) {
          // spawnSubagent already persisted a LIVE (`pending`) `ritual:<id>`
          // registry record; if we bail here without freeing it, the
          // `on_duplicate:'refuse'` guard wedges EVERY future fire of this ritual
          // as a duplicate with NO durable run row explaining why (Argus r2).
          // `updateTerminal` NEVER rejects and a terminal record frees the
          // spawn_key (liveByKey counts only pending|running) — so the key-free is
          // the load-bearing, guaranteed step. The durable failed row + notice are
          // best-effort (the run store JUST failed, so they may fail too).
          const message = insertErr instanceof Error ? insertErr.message : String(insertErr)
          const reason = `run-history insert failed after spawn: ${message}`
          await deps.subagents.updateTerminal(rec.run_id, { status: 'crashed', ended_at: now() })
          try {
            const failedRunId = mintId(deps.mint_run_id)
            await deps.runs.insertFailed({
              run_id: failedRunId,
              ritual_id,
              reminder_id: reminder.id,
              project_slug: deps.project_slug,
              failure_reason: reason,
              now_ms: now(),
            })
            await surfaceFailure(reminder, ritual_id, failedRunId, 'failed', reason)
            // A durable 'failed' row landed → the occurrence is legitimately
            // consumed; resolve (no revert).
            attempts.forget(reminder.id)
            return { claim: 'consume' }
          } catch (surfaceErr) {
            // The run store is fully down (insertRunning AND insertFailed both
            // threw): NO durable row exists for this occurrence. Reject so the tick
            // reverts the #319 claim and the occurrence re-fires — the spawn key was
            // already freed above, so a re-fire is clean (the Argus data-loss class).
            log.error('ritual_insert_running_failed', {
              reminder: reminder.id,
              ritual_id,
              subagent_run_id: rec.run_id,
              error: message,
              surface_error: surfaceErr instanceof Error ? surfaceErr.message : String(surfaceErr),
            })
            throw insertErr
          }
        }
        // Best-effort registry running-flip (service.ts:361-380 precedent — a
        // persist hiccup must not abort the launch; the record is already durable
        // at 'pending' from create).
        try {
          await deps.subagents.update(rec.run_id, { status: 'running' })
        } catch (err) {
          log.warn('ritual_running_flip_failed', {
            subagent_run_id: rec.run_id,
            error: err instanceof Error ? err.message : String(err),
          })
        }

        // (f) LAUNCH — NOT awaited. `fire()` resolves once the turn is initiated;
        // the detached run promise drives the terminal bookkeeping. Detached via
        // fireAndForget so a rejection anywhere in the settle chain is logged, not
        // fatal, and never surfaces as an unhandled rejection.
        //
        // The launch CONSTRUCTION — `deps.resolve_model()` and the `deps.turn(...)`
        // call itself — runs SYNCHRONOUSLY during argument evaluation, BEFORE the
        // returned promise (and its `.catch`) exists. A synchronous throw here would
        // otherwise escape to the outer startup catch and re-throw AFTER the durable
        // 'running' row + the LIVE `ritual:<id>` spawn key already exist — reverting
        // the occurrence claim while the key stays live (every re-fire refused as a
        // duplicate; the run stuck 'running' until boot reap). Route such a sync
        // failure through the SAME settleCrashed path as a promise rejection: the run
        // row settles 'crashed', the registry terminal frees the spawn key, and the
        // occurrence is legitimately consumed (`return`, NOT re-throw — re-throwing
        // would claimRevert and re-fire against a just-freed key). settleCrashed is
        // fully guarded and NEVER rejects, so the bare `await` is safe and keeps the
        // settle inside the tick quiescence boundary.
        const runRunId = rec.run_id
        const subagentRunId = rec.run_id
        try {
          fireAndForget(
            'ritual-run',
            deps
              .turn({
                kind: 'ritual',
                system: 'ritual',
                user_message: verdict.prompt,
                repo_path: scope_cwd,
                trident_run_id: subagentRunId,
                model: deps.resolve_model(),
                timeout_ms: RITUAL_TIMEOUT_MS,
                tools: def.tool_surface,
              })
              .then((r) => settleTerminal(reminder, def, ritual_id, runRunId, subagentRunId, r)),
            // A turn (or settleTerminal) rejection routes through the wrapper's
            // onError — settling the run 'crashed' — so the rejection is logged +
            // counted by fireAndForget instead of pre-swallowed by a `.catch`
            // (the F3 pre-swallow gate). settleCrashed is fully guarded (never
            // rejects), matching the prior `.catch` behavior.
            (err) => settleCrashed(reminder, ritual_id, runRunId, subagentRunId, err),
          )
        } catch (launchErr) {
          await settleCrashed(reminder, ritual_id, runRunId, subagentRunId, launchErr)
          return { claim: 'consume' }
        }
        return { claim: 'consume' }
      } catch (err) {
        // STARTUP failure — validate / spawn / durable-row-write threw so NO
        // `code_ritual_runs` row landed for this occurrence. The paths that DID
        // land a durable row (insertSkipped/insertFailed success,
        // insertRunning-then-durable-failed, AND a sync launch-construction failure
        // in step (f) — resolve_model()/turn() throwing after the 'running' row +
        // live spawn key exist, which settleCrashed-settles then returns) never
        // reach here; the detached turn (step (f)) is fire-and-forget and cannot
        // reject through this catch — so reaching here is unambiguously a startup
        // loss.
        //
        // This used to RE-THROW unconditionally, which made the tick revert its
        // #319 claim and re-fire on the very next tick — correct for a blip,
        // catastrophic for anything else. A cause that did not clear re-fired
        // every 30 seconds indefinitely, and because no durable row can be written
        // when the run store is the thing that broke, it did so leaving ZERO
        // evidence and telling the owner nothing (ISSUES #489 REPRO B: 25 ticks,
        // 25 attempts, 0 rows, 0 notices).
        //
        // Now the throw is CLASSIFIED. Only a stamped-transient cause with
        // attempts left earns a re-arm, and it is re-armed on a backoff rather
        // than immediately. Everything else terminates the occurrence with the
        // loudest record still available: a durable `code_ritual_runs` row when
        // the store is reachable, and — either way — the one-line notice, which is
        // what the owner actually sees. Best-effort on both, because the store may
        // be exactly what failed; between them the occurrence can no longer end in
        // total silence.
        const ritual_id = reminder.ritual_id
        const disposition = classifyRitualFailure(err)
        const detail = err instanceof Error ? err.message : String(err)
        const plan = planRetry(reminder, disposition)
        if (plan !== null && ritual_id !== null) {
          log.warn('ritual_fire_startup_retry', {
            reminder: reminder.id,
            ritual_id,
            attempt: plan.attempt,
            retry_at_ms: plan.retry_at_ms,
            disposition,
            error: detail,
          })
          return { claim: 'retry', retry_at_ms: plan.retry_at_ms, attempt: plan.attempt, disposition }
        }
        const spent = attempts.peek(reminder.id)
        attempts.forget(reminder.id)
        log.error('ritual_fire_unexpected', {
          reminder: reminder.id,
          ritual_id,
          disposition,
          attempts: spent,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        })
        if (ritual_id !== null) {
          const reason = terminalReason(disposition, spent, detail)
          const failedRunId = mintId(deps.mint_run_id)
          try {
            await deps.runs.insertFailed({
              run_id: failedRunId,
              ritual_id,
              reminder_id: reminder.id,
              project_slug: deps.project_slug,
              failure_reason: reason,
              now_ms: now(),
            })
          } catch (rowErr) {
            log.error('ritual_startup_terminal_row_failed', {
              reminder: reminder.id,
              ritual_id,
              error: rowErr instanceof Error ? rowErr.message : String(rowErr),
            })
          }
          await surfaceFailure(reminder, ritual_id, failedRunId, 'failed', reason)
        }
        return { claim: 'consume' }
      }
    },
  }
}
