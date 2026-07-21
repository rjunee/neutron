/**
 * @neutronai/reminders — the RITUAL EXECUTOR (executor-mode reminders, plan task 4).
 *
 * At fire time the tick loop (`reminders/tick.ts`) routes a `ritual_id` row to
 * this executor's `fire()` (fire-and-forget) INSTEAD of the nudge dispatcher. The
 * executor:
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
 * `fire()` NEVER throws (a fire-time error must not wedge the tick loop) and NEVER
 * awaits the launched turn.
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
  formatRitualCompletionFallback,
  formatRitualEscalationNotice,
  formatRitualFailureNotice,
  shouldEscalate,
} from './ritual-delivery.ts'

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
  /** Approval-checker factory seam (tests). Defaults to `createRitualApprovalCheck`. */
  build_approval_check?: (cadence: string) => RitualApprovalCheck
  /** run_id factory (test seam) — minted per fire attempt AND per subagent record. */
  mint_run_id?: () => string
  /** Now-injection (test seam). */
  now?: () => number
}

/** The executor seam the tick loop consumes: `fire(reminder)` never rejects. */
export interface RitualExecutor {
  fire(reminder: Reminder): Promise<void>
}

function mintId(mint: (() => string) | undefined): string {
  if (mint !== undefined) return mint()
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `rr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * Build the ritual executor. See the module header for the full fire-time
 * contract; `fire()` NEVER throws and NEVER awaits the launched substrate turn.
 */
export function createRitualExecutor(deps: RitualExecutorDeps): RitualExecutor {
  const now = deps.now ?? Date.now

  /** Best-effort post of one notice body. NEVER throws (the record is the row). */
  async function postNotice(
    topic_id: string,
    owner_slug: string,
    reminder_id: string,
    body: string,
  ): Promise<void> {
    try {
      await deps.outbound.post({ topic_id, owner_slug, body, reminder_id })
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
        formatRitualFailureNotice({ ritual_id, status, run_id, failure_reason }),
      )
      // Read the last 4 terminal rows AFTER this failure's row is written — the
      // escalation rule is pure over that snapshot (no new state).
      const recent = deps.runs.listRecentTerminal({ ritual_id, limit: 4 })
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
            ? 'failed'
            : 'failed'
    const registryStatus =
      r.status === 'completed' ? 'finished' : r.status === 'cancelled' ? 'cancelled' : 'crashed'
    // Durable row FIRST — the record of the run, before any post.
    await deps.runs.markTerminal({
      run_id: runRunId,
      status: runStatus,
      ended_at_ms: now(),
      output_summary: r.result,
    })
    // Registry terminal — best-effort (updateTerminal never rejects, but a
    // late-detached call is defensively guarded so a registry hiccup can never
    // reject the detached run promise).
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
      if (!def.silent) {
        const text = r.result.trim()
        const body = text.length > 0 ? text : formatRitualCompletionFallback({ ritual_id, run_id: runRunId })
        await postNotice(deps.resolve_topic(reminder), reminder.owner_slug, reminder.id, body)
      }
      // silent → no success post.
    } else {
      // failed / timed_out. A turn-settled failure carries the turn's own text as
      // the reason only when non-empty; otherwise no reason.
      const settledReason = r.result.trim().length > 0 ? r.result.trim().slice(0, 160) : null
      await surfaceFailure(reminder, ritual_id, runRunId, runStatus, settledReason)
    }
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
    await deps.runs.markTerminal({
      run_id: runRunId,
      status: 'crashed',
      ended_at_ms: now(),
      failure_reason: message.slice(0, 4000),
    })
    try {
      await deps.subagents.updateTerminal(subagentRunId, { status: 'crashed', ended_at: now() })
    } catch (rerr) {
      log.error('ritual_registry_terminal_failed', {
        subagent_run_id: subagentRunId,
        error: rerr instanceof Error ? (rerr.stack ?? rerr.message) : String(rerr),
      })
    }
    await surfaceFailure(reminder, ritual_id, runRunId, 'crashed', message)
  }

  return {
    async fire(reminder: Reminder): Promise<void> {
      // fire() NEVER throws — a fire-time error must not wedge the tick loop.
      try {
        const ritual_id = reminder.ritual_id
        if (ritual_id === null) {
          // Defensive: the tick only routes non-null ritual_id rows here.
          log.error('ritual_fire_null_id', { reminder: reminder.id })
          return
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
          return
        }

        const def = verdict.def
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
          return
        }

        // (e) the live 'running' history row (subagent_run_id + content_hash) is
        // the durable record of the attempt; the run_id IS the subagent run id so
        // the two surfaces cross-reference.
        await deps.runs.insertRunning({
          run_id: rec.run_id,
          ritual_id,
          reminder_id: reminder.id,
          project_slug: deps.project_slug,
          subagent_run_id: rec.run_id,
          content_hash,
          now_ms: now(),
        })
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
        const runRunId = rec.run_id
        const subagentRunId = rec.run_id
        fireAndForget(
          'ritual-run',
          deps
            .turn({
              kind: 'ritual',
              system: 'ritual',
              user_message: verdict.prompt,
              repo_path: deps.scope_cwd(def.scope),
              trident_run_id: subagentRunId,
              model: deps.resolve_model(),
              timeout_ms: RITUAL_TIMEOUT_MS,
              tools: def.tool_surface,
            })
            .then((r) => settleTerminal(reminder, def, ritual_id, runRunId, subagentRunId, r))
            .catch((err) => settleCrashed(reminder, ritual_id, runRunId, subagentRunId, err)),
        )
      } catch (err) {
        log.error('ritual_fire_unexpected', {
          reminder: reminder.id,
          ritual_id: reminder.ritual_id,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        })
      }
    },
  }
}
