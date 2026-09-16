import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { FireOutcome, InnerLoopInput, TridentWorkflowFirer } from './inner-loop.ts'
import { createProjectBuildHost, type ProjectBuildHostOptions, type ProjectBuildOutcome } from './project-build-host.ts'
import type { TridentRunStore } from './store.ts'

const projectDriverGatewaySession = crypto.randomUUID()

type ProjectBuildDriverReservation = {
  kind: 'in-process-driver'
  gateway_session: string
}

function driverReservation(raw: string | null): ProjectBuildDriverReservation | null {
  try {
    const parsed = JSON.parse(raw ?? 'null')
    const reservation = parsed?.projectBuildReservation
    return parsed?.projectBuild?.kind === 'unknown' &&
      reservation?.kind === 'in-process-driver' && typeof reservation.gateway_session === 'string'
      ? reservation
      : null
  } catch { return null }
}

/** The canonical result field also carries nonterminal driver uncertainty. */
export function projectBuildPending(raw: string | null): boolean {
  try { return JSON.parse(raw ?? 'null')?.projectBuild?.kind === 'unknown' } catch { return false }
}

/**
 * A driver outcome that MEASURED and could not find out — and therefore has NO
 * OWNER LEFT. Returns its detail, or null when the row is not that.
 *
 * `projectBuildPending` is true for two states that are not the same thing:
 *
 *   (a) a RESERVATION this gateway authored before starting the driver promise —
 *       something is still running, and waiting is correct;
 *   (b) a SETTLED driver outcome of kind `unknown` — `projectBuildResult` below
 *       writes `{ projectBuild: outcome }` with no reservation, because the
 *       driver had already resolved and exited.
 *
 * Collapsing them is the `unknown`/`false` collapse in its most expensive form:
 * the orchestrator's short-circuit waits on (b) forever. Nothing re-fires over a
 * pending row (line 82 below), nothing rewrites `inner_result` without the
 * reservation bytes, and the in-flight ceiling is never reached because the
 * short-circuit runs ahead of it — measured, and recorded in the comment on the
 * rejection handler below. Two live acceptance runs parked in `forge-init` on
 * exactly this, and the park is invisible: `compareProjectBuildResult`
 * (`store.ts:1044`) writes `inner_result` ALONE — no `last_advanced_at` restamp
 * and no stage event — so a driver that settled `unknown` at its 15-minute wall
 * is indistinguishable, in both of those signals, from one that never returned.
 *
 * The distinguishing FACT is the reservation, not the kind: (b) is exactly a
 * pending marker with no reservation on it.
 */
export function projectBuildMeasuredUnknown(raw: string | null): string | null {
  if (!projectBuildPending(raw) || driverReservation(raw) !== null) return null
  try {
    const detail = JSON.parse(raw ?? 'null')?.projectBuild?.detail
    return typeof detail === 'string' && detail.trim() !== '' ? detail : 'driver recorded no detail'
  } catch { return 'driver recorded no detail' }
}

/** A reservation is process-owned; an authored `unknown` deliberately has no owner. */
export function projectBuildDriverReservationFromPriorGateway(raw: string | null): boolean {
  const reservation = driverReservation(raw)
  return reservation !== null && reservation.gateway_session !== projectDriverGatewaySession
}

/** The exact reservation bytes are the store claim's compare-and-swap witness. */
export function projectBuildDriverReservation(raw: string | null): string | null {
  return projectBuildDriverReservationFromPriorGateway(raw) ? raw : null
}

export function projectBuildResult(outcome: ProjectBuildOutcome, input: InnerLoopInput): string {
  if (outcome.kind === 'unknown') return JSON.stringify({ projectBuild: outcome })
  const snapshot = 'snapshot' in outcome ? outcome.snapshot : null
  return JSON.stringify({
    projectBuild: outcome,
    ok: outcome.kind === 'merged' || outcome.kind === 'built' || outcome.kind === 'continued',
    prMerged: outcome.kind === 'merged',
    publishRequested: outcome.kind === 'continued',
    built: outcome.kind === 'built' || outcome.kind === 'continued',
    verdict: outcome.kind === 'merged' ? 'APPROVE' : null,
    branch: input.run.branch, worktreePath: input.run.worktree,
    prNumber: snapshot?.pr?.number ?? input.run.pr,
    commitSha: snapshot?.head, reviewedHead: snapshot?.head,
    remainingTasks: outcome.kind === 'continued' ? outcome.remainingTasks : undefined,
    checkpoint: outcome.kind === 'merged' ? 'merged' : outcome.kind === 'built' ? 'wave-member-built' : outcome.kind === 'continued' ? 'ralph-task-built' : 'inner-error',
    terminalCauseKind: outcome.kind === 'failed' ? outcome.cause : undefined,
    terminalCause: outcome.kind === 'blocked' ? outcome.on : 'detail' in outcome ? outcome.detail : undefined,
  })
}

export interface ProjectLauncherOptions {
  store: TridentRunStore
  prepare(input: InnerLoopInput, signal: AbortSignal): Promise<ProjectBuildHostOptions>
  onError(error: unknown): void
  settleMs?: number
}

/** Start the typed driver in the host process; completion belongs to the store. */
export function createProjectLauncher(options: ProjectLauncherOptions): TridentWorkflowFirer {
  return async input => {
    const controller = new AbortController()
    // This is not the driver's measured `unknown`: this gateway authored it before
    // starting an in-process promise. The session marker lets the next gateway recover
    // a dead promise while preserving a measured driver `unknown` for reconciliation.
    const reservation = JSON.stringify({
      projectBuild: { kind: 'unknown', phase: 'plan', step_id: null, detail: 'Project driver started; awaiting durable outcome' },
      projectBuildReservation: { kind: 'in-process-driver', gateway_session: projectDriverGatewaySession },
    })
    let reserved = false
    const started = Date.now()
    const launch = (async (): Promise<FireOutcome> => {
      try {
        if (projectBuildPending(options.store.get(input.run.id)?.inner_result ?? null)) {
          return { status: 'unconfirmed', error: 'Existing project build requires reconciliation' }
        }
        // Reserve before invoking work. A process death cannot turn an uncertain step into a replay.
        const saved = await options.store.compareProjectBuildResult(input.run.id, null, reservation)
        if (!saved) return { status: 'unconfirmed', error: 'Project launch reservation was not acquired' }
        reserved = true
        const host = await createProjectBuildHost(await options.prepare(input, controller.signal))
        const mode = input.run.bound_pr !== null ? 'bound_pr' : input.run.parent_run_id !== null ? 'wave' : input.run.ralph ? 'ralph' : 'pr'
        const running = host.run({ mode, start: input.resume_checkpoint ? 'resume' : 'fresh',
          ...(input.run.bound_pr !== null ? { bound_pr: input.run.bound_pr } : {}),
          ...(input.run.wave_task_id !== null ? { pinnedTaskId: input.run.wave_task_id } : {}),
        }, controller.signal)
        // A REJECTION IS NOT THE DRIVER'S `unknown`, AND MUST NOT BE LEFT PENDING.
        // The driver authors `unknown` when it MEASURED and could not find out; that
        // outcome legitimately keeps the reservation, because `step()` short-circuits
        // on `projectBuildPending` and the row is preserved for reconciliation. A
        // thrown error is the other thing: nobody measured anything, and it is the
        // same class as the construction failure the `catch` below already maps to
        // `inner-error`. Without this rejection handler the reservation survives, and
        // because the pending short-circuit runs BEFORE the in-flight ceiling in
        // `step()`, the run is immortal — measured: a `dead` worker observation a full
        // day past `maxInflightMs` still returned `waiting: true, changed: false`.
        // The original error is rethrown either way so `onError` still reports it.
        fireAndForget('project-build-outcome', running.then(async outcome => {
          const written = await options.store.compareProjectBuildResult(input.run.id, reservation, projectBuildResult(outcome, { ...input, run: options.store.get(input.run.id) ?? input.run }))
          if (!written) throw Error('Project outcome write was not confirmed')
          // THE DRIVER SETTLING IS OTHERWISE UNOBSERVABLE, and that blindness cost two
          // acceptance runs. `compareProjectBuildResult` writes `inner_result` and nothing
          // else: `last_advanced_at` does not move (`store.ts:1044-1051`) and no stage event
          // is recorded anywhere on this path — so "the driver hit its 15-minute wall and
          // reported `unknown`" and "the driver never returned" look IDENTICAL in both
          // signals an operator reads. They need opposite fixes, so they must be
          // distinguishable before either is diagnosed.
          //
          // WHAT THIS EVENT IS NOW SUBJECT TO: stage events are the hang watchdog's
          // POSITIVE liveness evidence (`run-driving.ts:230-238` answers `stage-alive`, and
          // the wakeup sweep defers on it). That is bounded and acceptable here — the
          // orchestrator turns a settled-`unknown` row terminal on its next tick, and
          // `terminal` outranks `stage-alive` — but it is the reason this is recorded AFTER
          // the outcome write is confirmed, never before it.
          //
          // Telemetry cannot undo a written outcome: a failure here must not reach the
          // rejection handler below, which would try to stamp `inner-error` over a result
          // that is already durable.
          try {
            await options.store.recordStageEvent(input.run.id, 'build-driver-settled',
              JSON.stringify({ kind: outcome.kind, ...('detail' in outcome ? { detail: outcome.detail } : {}) }))
          } catch (error) { options.onError(error) }
        }).catch(async (error: unknown) => {
          await options.store.compareProjectBuildResult(input.run.id, reservation, JSON.stringify({ ok: false, checkpoint: 'inner-error', terminalCause: String(error) })).catch(options.onError)
          throw error
        }), options.onError)
        return { status: 'fired', error: null }
      } catch (error) {
        if (reserved) await options.store.compareProjectBuildResult(input.run.id, reservation, JSON.stringify({ ok: false, checkpoint: 'inner-error', terminalCause: String(error) })).catch(options.onError)
        return { status: 'failed', error: String(error) }
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = options.settleMs ?? 10_000
    try {
      return await Promise.race([launch, new Promise<FireOutcome>(resolve => {
        timer = setTimeout(() => resolve({ status: 'unconfirmed', error: 'Project launch confirmation timed out',
          elapsed_ms: Date.now() - started, budget_ms: budget, turn_cancelled: false, settled: launch }), budget)
      })])
    } finally { clearTimeout(timer) }
  }
}
