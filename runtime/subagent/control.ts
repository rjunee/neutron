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
  state.registry.update(run_id, { status: 'cancelled', ended_at: Date.now() })
  state.cancellers.delete(run_id)
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
