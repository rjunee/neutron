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

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { FireOutcome, InnerLoopInput, TridentWorkflowFirer } from './inner-loop.ts'
import type { TridentRunStore } from './store.ts'

/** The fields a simulated inner workflow writes into `inner_result` (the typed
 *  terminal payload `inner-workflow.mjs` persists). */
export interface SimResult {
  ok?: boolean
  prNumber?: number | null
  branch?: string | null
  verdict?: 'APPROVE' | 'REQUEST_CHANGES' | null
  // `blockKind` and `findings` are declared further down, where they arrived with
  // #240/T4 — re-declaring them here is a duplicate the test runner cannot see and
  // only `tsc` reports.
  round?: number
  /** The `checkpoint` field inside the result JSON (self-asserted). */
  checkpoint?: string | null
  /** RALPH RE-FIRE (#362) — tasks still unbuilt after this iteration; `> 0` drives
   *  an outer re-fire. Omit (→ undefined, serialized absent) for single-task runs. */
  remainingTasks?: number | null
  /** #545 — the head OID the review judged, which the pr-mode merge pins with
   *  `--match-head-commit`. Defaults to `SIM_REVIEWED_HEAD` (the workflow always
   *  records one); set `null` to simulate a workflow that recorded NO head — the
   *  merge must then REFUSE (fail-closed). */
  reviewedHead?: string | null
  /** #563 — the workflow stopped because the PR was ALREADY merged. Emitted only
   *  when the test sets it (the field is absent on every other terminal path), so
   *  `parseInnerResult` decodes the default to `false`. */
  prMerged?: boolean
  publishRequested?: boolean
  publishHead?: string | null
  /** #240 — why the workflow stopped ('infra-only' means no review seat judged the code). */
  blockKind?: 'none' | 'code' | 'infra-only' | 'round-lost' | null
  /** T4 — the review findings the terminal result carried. Emitted only when the test sets
   *  it (the wrapper's catch path writes `findings: []`, and legacy rows omit it entirely),
   *  so the absent-field default decodes to `findings_present: false`. */
  findings?: unknown[]
  /** The build's Forge reported it deviated from the Ralph exec spec. Emitted only
   *  when the test sets it (the workflow writes it on the publish handoff), so the
   *  absent-field default keeps every other test on the unsuffixed checkpoint. */
  deviatedFromSpec?: boolean
}

/** The stand-in reviewed head OID a simulated workflow records (#545). Real
 *  40-hex shape, because `--match-head-commit` only accepts a full OID; exported
 *  so tests can assert the exact pinned merge command. */
export const SIM_REVIEWED_HEAD = '0123456789abcdef0123456789abcdef01234567'

/** Build the compact JSON the workflow writes into `inner_result`. */
export function simResultJson(sim: SimResult): string {
  return JSON.stringify({
    ok: sim.ok ?? true,
    prNumber: sim.prNumber ?? null,
    branch: sim.branch ?? null,
    verdict: sim.verdict ?? null,
    ...(sim.blockKind !== undefined ? { blockKind: sim.blockKind } : {}),
    ...(sim.findings !== undefined ? { findings: sim.findings } : {}),
    round: sim.round ?? 1,
    checkpoint: sim.checkpoint ?? null,
    // Only emit when the test set it (mirrors the .mjs, which omits it for
    // non-Ralph runs); `parseInnerResult` treats an absent field as null.
    ...(sim.remainingTasks !== undefined ? { remainingTasks: sim.remainingTasks } : {}),
    // #563 — same rule: emitted only when the test asks for it, so the absent-field
    // default (no merge already performed) is what every other test exercises.
    ...(sim.prMerged !== undefined ? { prMerged: sim.prMerged } : {}),
    ...(sim.publishRequested !== undefined ? { publishRequested: sim.publishRequested } : {}),
    ...(sim.publishHead !== undefined ? { publishHead: sim.publishHead } : {}),
    ...(sim.blockKind !== undefined ? { blockKind: sim.blockKind } : {}),
    // T4 — same rule: only what the test asked for, so every other test exercises the
    // absent-field default (no findings recorded).
    ...(sim.findings !== undefined ? { findings: sim.findings } : {}),
    ...(sim.deviatedFromSpec !== undefined ? { deviatedFromSpec: sim.deviatedFromSpec } : {}),
    // #545 — production ALWAYS records the reviewed head, so the default models
    // that; an explicit null models the workflow that failed to (and the pr-mode
    // merge must then refuse rather than merge an unpinned head).
    reviewedHead: sim.reviewedHead === undefined ? SIM_REVIEWED_HEAD : sim.reviewedHead,
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
  db: ProjectDb,
  store: TridentRunStore,
  runId: string,
  sim: SimResult,
  argusCheckpoint?: string,
): Promise<void> {
  const checkpoint = argusCheckpoint ?? sim.checkpoint ?? 'argus-request-changes'
  await store.update(runId, {
    inner_result: simResultJson({ ...sim, checkpoint: sim.checkpoint ?? checkpoint }),
    inner_checkpoint: checkpoint,
    subagent_status: 'completed',
  })
  // The verdict lands raw, modeling the FIXED out-of-process checkpoint.sh writer
  // (post-T3 discriminator); it stays raw because production's writer is never the
  // guarded store API.
  await db.run(
    'UPDATE code_trident_runs SET inner_verdict = ? WHERE id = ?',
    [
      sim.verdict === 'APPROVE'
        ? 'APPROVE'
        : sim.verdict === 'REQUEST_CHANGES' &&
            sim.blockKind === 'code' &&
            Array.isArray(sim.findings) &&
            sim.findings.length > 0
          ? 'REQUEST_CHANGES'
          : 'REVIEW_NOT_RUN',
      runId,
    ],
  )
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
  db: ProjectDb,
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
      pending.push(() => writeSimulatedResult(db, store, input.run.id, result, checkpoint))
    }
    return outcome
  }
  const drain = async (): Promise<void> => {
    for (const w of pending.splice(0)) await w()
  }
  return { fire_workflow, inputs, drain }
}

export function buildSimMutationProofGate(
  outcome: { ok?: boolean; reason?: string; exempt?: boolean } = {},
  /** Every gate call, in order — so a test can assert WHAT was handed to the
   *  prover (the run it was asked to prove, and on which branch). */
  seen: Array<{ branch: string | null; run_id: string }> = [],
): (input: unknown) => Promise<{ ok: boolean; reason: string; exempt: boolean; evidence: null }> {
  const ok = outcome.ok ?? true
  return async (input) => {
    const run = (input as { run?: { branch?: string | null; id?: string } }).run
    seen.push({ branch: run?.branch ?? null, run_id: run?.id ?? '' })
    return {
      ok,
      reason: outcome.reason ?? (ok ? 'simulated mutation proof' : 'simulated mutation proof failure'),
      // An EXEMPT outcome is a merge on which the gate never ran. It defaults to
      // false so every existing caller keeps proving; a test that wants the
      // exemption asks for it, and asserts the run record says so.
      exempt: outcome.exempt ?? false,
      evidence: null,
    }
  }
}
