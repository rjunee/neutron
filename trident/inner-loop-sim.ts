/**
 * @neutronai/trident — TEST-ONLY inner-loop fire/harvest simulation helpers.
 *
 * The Phase 2a exec model splits the inner loop into two halves the OUTER loop
 * coordinates through the DB:
 *   1. the FIRER invokes the `Workflow` tool + settles the launching turn, and
 *   2. the detached workflow later writes its TYPED terminal result to
 *      `code_trident_runs.inner_result` (the harvest-ready signal).
 *
 * Unit tests have no live `Workflow` tool, so they inject a FAKE
 * `TridentWorkflowFirer` (`buildSimFirer`) that records its inputs + ENQUEUES the
 * workflow's terminal write, and a `drain()` the test calls BETWEEN ticks to
 * simulate the workflow finishing. Deferring the write to a drain (rather than
 * writing synchronously inside the fire) mirrors production timing — the workflow
 * writes minutes AFTER the launch tick's `save()` — so the fake never races the
 * launch persist. A test that never drains models a still-in-flight workflow.
 *
 * NOT shipped on any runtime path (only `*.test.ts` import this).
 */

import type { FireOutcome, InnerLoopInput, TridentWorkflowFirer } from './inner-loop.ts'
import type { TridentRunStore } from './store.ts'

/** The fields a simulated inner workflow writes into `inner_result` (the typed
 *  terminal payload `inner-workflow.mjs` persists). */
export interface SimResult {
  ok?: boolean
  prNumber?: number | null
  branch?: string | null
  verdict?: 'APPROVE' | 'REQUEST_CHANGES' | null
  round?: number
  /** The `checkpoint` field inside the result JSON (self-asserted). */
  checkpoint?: string | null
  /** RALPH RE-FIRE (#362) — tasks still unbuilt after this iteration; `> 0` drives
   *  an outer re-fire. Omit (→ undefined, serialized absent) for single-task runs. */
  remainingTasks?: number | null
}

/** Build the compact JSON the workflow writes into `inner_result`. */
export function simResultJson(sim: SimResult): string {
  return JSON.stringify({
    ok: sim.ok ?? true,
    prNumber: sim.prNumber ?? null,
    branch: sim.branch ?? null,
    verdict: sim.verdict ?? null,
    round: sim.round ?? 1,
    checkpoint: sim.checkpoint ?? null,
    // Only emit when the test set it (mirrors the .mjs, which omits it for
    // non-Ralph runs); `parseInnerResult` treats an absent field as null.
    ...(sim.remainingTasks !== undefined ? { remainingTasks: sim.remainingTasks } : {}),
  })
}

/**
 * Simulate the inner workflow's TERMINAL write: persist `inner_result` (typed
 * JSON) + the Argus-phase `inner_checkpoint` + `inner_verdict` + completed
 * sub-status onto the row — exactly what `inner-workflow.mjs`'s
 * `writeTerminalResult` does. `argusCheckpoint` is the SERVER-recorded provenance
 * the OUTER loop gates merge-eligibility on (`'argus-approved'` to allow a merge,
 * anything else to fail). Defaults to the result's own checkpoint.
 */
export async function writeSimulatedResult(
  store: TridentRunStore,
  runId: string,
  sim: SimResult,
  argusCheckpoint?: string,
): Promise<void> {
  const checkpoint = argusCheckpoint ?? sim.checkpoint ?? 'argus-request-changes'
  await store.update(runId, {
    inner_result: simResultJson({ ...sim, checkpoint: sim.checkpoint ?? checkpoint }),
    inner_checkpoint: checkpoint,
    inner_verdict: sim.verdict === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES',
    subagent_status: 'completed',
  })
}

/** A test's per-run plan for what the simulated fire + workflow do. */
export interface SimPlan {
  /** What the FIRE seam returns (did the launching turn settle?). Default fired. */
  fire?: FireOutcome
  /** The terminal result the workflow writes on the next `drain()`. Omit (or set
   *  null) to leave the run IN FLIGHT (no terminal result written). */
  result?: SimResult | null
  /** The SERVER-recorded `inner_checkpoint` the merge gate reads. Defaults to
   *  `'argus-approved'` for an APPROVE result, else `'argus-request-changes'`. */
  argusCheckpoint?: string
}

export interface SimFirer {
  fire_workflow: TridentWorkflowFirer
  /** Every `InnerLoopInput` the firer was called with (assert resume/PR folding). */
  inputs: InnerLoopInput[]
  /** Flush every queued workflow completion (write its `inner_result` to the DB).
   *  Call between ticks to simulate the detached workflows finishing. */
  drain: () => Promise<void>
}

/**
 * Build a fake `TridentWorkflowFirer` for orchestrator/tick tests. `plan(input)`
 * decides, per fire, whether the launching turn settles and what terminal result
 * the workflow eventually writes. The write is DEFERRED to `drain()` so it lands
 * after the launch tick's `save()` (production-faithful, race-free).
 */
export function buildSimFirer(
  store: TridentRunStore,
  plan: (input: InnerLoopInput) => SimPlan,
): SimFirer {
  const inputs: InnerLoopInput[] = []
  const pending: Array<() => Promise<void>> = []
  const fire_workflow: TridentWorkflowFirer = async (input) => {
    inputs.push(input)
    const p = plan(input)
    const outcome = p.fire ?? { status: 'fired', error: null }
    if (outcome.status === 'fired' && p.result != null) {
      const result = p.result
      const checkpoint =
        p.argusCheckpoint ?? (result.verdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes')
      pending.push(() => writeSimulatedResult(store, input.run.id, result, checkpoint))
    }
    return outcome
  }
  const drain = async (): Promise<void> => {
    for (const w of pending.splice(0)) await w()
  }
  return { fire_workflow, inputs, drain }
}
