/**
 * @neutronai/runtime — subagent control surface.
 *
 * Cancel, status, wait. Mirrors OpenClaw's `subagent-control.ts`. All ops are
 * idempotent — calling `cancel(run_id)` twice does not error and does not
 * double-kill.
 *
 * The control surface is decoupled from the actual handle: cancellers register
 * a `Canceller` callback at spawn time; control invokes it. This lets the
 * registry stay JSON-shaped (no embedded process refs) and survive an in-memory
 * snapshot for SQLite persistence in S4.
 */

import type { SubagentRecord, SubagentRegistry } from './registry.ts'

export interface Canceller {
  (reason: 'caller_cancelled' | 'lifecycle_cleanup'): Promise<void>
}

export interface ControlState {
  registry: SubagentRegistry
  cancellers: Map<string, Canceller>
}

export function newControlState(registry: SubagentRegistry): ControlState {
  return { registry, cancellers: new Map() }
}

export function registerCanceller(state: ControlState, run_id: string, canceller: Canceller): void {
  state.cancellers.set(run_id, canceller)
}

export async function cancelRun(
  state: ControlState,
  run_id: string,
  reason: 'caller_cancelled' | 'lifecycle_cleanup' = 'caller_cancelled',
): Promise<void> {
  const rec = state.registry.byRunId(run_id)
  if (!rec) return
  if (rec.status === 'finished' || rec.status === 'cancelled' || rec.status === 'crashed') return
  const c = state.cancellers.get(run_id)
  if (c) {
    try {
      await c(reason)
    } catch {
      // Cancellers are best-effort. If they throw, we still mark cancelled.
    }
  }
  await state.registry.update(run_id, { status: 'cancelled', ended_at: Date.now() })
  state.cancellers.delete(run_id)
}

/**
 * Force a live run into a terminal-FAILED state (`status='crashed'`) with a
 * recorded `failure_reason`. Mirrors `cancelRun` but is the watchdog's verb for
 * "this dispatch died/stuck and must be surfaced", as distinct from a deliberate
 * caller cancellation (which stays `status='cancelled'`).
 *
 * Best-effort terminates any live process via the registered canceller (a
 * `'stuck'` agent may still be running and needs killing; a `'process_dead'`
 * one is already gone and the canceller is a harmless no-op that also frees the
 * handle). Idempotent: failing an already-terminal run is a no-op returning
 * `false`. Returns `true` when this call performed the terminal transition.
 *
 * Race-safe: the canceller is `await`ed, and a concurrent completion handler
 * can mark the run `finished`/`cancelled` while it is in flight. The status is
 * re-checked AFTER the await, so a legitimate terminal completion is never
 * overwritten with `crashed` (and the watchdog never emits a false failure for
 * a run that actually finished).
 */
export async function failRun(
  state: ControlState,
  run_id: string,
  reason: 'process_dead' | 'stuck',
  now: number = Date.now(),
): Promise<boolean> {
  const rec = state.registry.byRunId(run_id)
  if (!rec) return false
  if (rec.status === 'finished' || rec.status === 'cancelled' || rec.status === 'crashed') {
    return false
  }
  const c = state.cancellers.get(run_id)
  if (c) {
    try {
      await c('lifecycle_cleanup')
    } catch {
      // Cancellers are best-effort. If they throw, we still mark failed.
    }
    // Re-read after the await: another path may have driven the run terminal
    // (a real completion landing concurrently) while the canceller ran. Don't
    // clobber a legitimate finish, and don't report a false failure.
    const after = state.registry.byRunId(run_id)
    if (
      !after ||
      after.status === 'finished' ||
      after.status === 'cancelled' ||
      after.status === 'crashed'
    ) {
      state.cancellers.delete(run_id)
      return false
    }
  }
  await state.registry.update(run_id, {
    status: 'crashed',
    ended_at: now,
    failure_reason: reason,
    last_event_at: now,
  })
  state.cancellers.delete(run_id)
  return true
}

export function statusOf(state: ControlState, run_id: string): SubagentRecord | undefined {
  return state.registry.byRunId(run_id)
}

/**
 * Resolve when the run leaves a live state. Polls the registry — cheap given
 * registry is in-memory; S4 swaps for an event-emitter-driven wait.
 */
export async function waitForCompletion(
  state: ControlState,
  run_id: string,
  poll_ms = 100,
): Promise<SubagentRecord> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rec = state.registry.byRunId(run_id)
    if (!rec) throw new Error(`subagent control: unknown run_id ${JSON.stringify(run_id)}`)
    if (rec.status === 'finished' || rec.status === 'cancelled' || rec.status === 'crashed') {
      return rec
    }
    await sleep(poll_ms)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
