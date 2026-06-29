/**
 * @neutronai/trident — the orchestration step (Trident v2 hard cutover).
 *
 * The durable OUTER loop (`tick.ts` + the `code_trident_runs` SQLite table)
 * calls `step(run)` for every non-terminal run. As of Trident v2 the INNER
 * Forge→Argus→fix loop is ONE native CC Dynamic Workflow
 * (`trident/inner-workflow.mjs`), launched once per run via a `TridentInnerLoop`
 * (`trident/inner-loop.ts`). The v1 substrate-per-phase inner mechanism
 * (`session.spawn`/`spawnForPhase`/the per-phase state graph) is REMOVED from
 * this prod step — the workflow owns the Forge build, the parallel Argus review,
 * the synthesis, and the bounded fix loop internally.
 *
 * What this step still owns (the OUTER concerns):
 *
 *   1. LAUNCH-IF-NEEDED. A live run with no in-flight dispatch
 *      (`subagent_run_id === null`) gets the inner loop launched now: mint a
 *      uuid, persist it + `subagent_status='running'`, and run the workflow in
 *      the BACKGROUND. Idempotent crash-resume: before launch, fold any existing
 *      PR/branch + the last `inner_checkpoint` into the dispatch so the workflow
 *      REUSES the PR (no duplicate) and skips finished phases.
 *
 *   2. ORPHAN RECOVERY. A persisted `subagent_run_id` this process does NOT track
 *      (lost on restart) is recovered per `on_orphaned_session` (redispatch /
 *      wait / fail). Redispatch relaunches a FRESH workflow that resumes from the
 *      persisted checkpoint — never a double-launch, bounded to one per process.
 *
 *   3. POLL + TERMINATE. With a dispatch in flight, defer until it settles. On
 *      `APPROVE` → phase `done` (persist pr/branch/inner_checkpoint/inner_verdict)
 *      then merge + cleanup (`cleanupAfterMerge`, the outer/human gate). On
 *      `REQUEST_CHANGES` (maxRounds exhausted) or a crashed/timed-out dispatch →
 *      phase `failed` with a named reason (recoverable: re-run), never a silent
 *      success.
 *
 * `state-machine.ts` (`computeTransition`/`advanceTridentRun`) is intentionally
 * KEPT intact (its unit tests + one-commit revertibility) even though this prod
 * step no longer drives the per-phase graph for the inner loop.
 */

import { cleanupAfterMerge, type MergeCleanupDeps } from './git-mode.ts'
import type { InnerLoopResult, TridentInnerLoop } from './inner-loop.ts'
import { buildMergeCleanupDeps, detectBaseBranch, type RunHostCommand } from './merge.ts'
import { ARGUS_DIFF_LINE_LIMIT } from './prompts.ts'
import { isTerminalPhase, type AdvanceOutcome } from './state-machine.ts'
import type { TridentRun } from './store.ts'

export interface TridentStep {
  (run: TridentRun): Promise<AdvanceOutcome>
}

export interface BuildTridentOrchestratorOptions {
  /** The inner-loop launcher (Trident v2). Drives Forge→Argus→fix as one CC
   *  Dynamic Workflow; see `buildWorkflowInnerLoop`. */
  inner_loop: TridentInnerLoop
  /** Absolute sqlite file path threaded to the workflow's checkpoint Bash steps. */
  db_path: string
  /** Host command runner — base-branch detect, existing-PR probe, merge. */
  run_host: RunHostCommand
  /** ISO-8601 UTC clock. Defaults to wall-clock. */
  now?: () => string
  /** Override base-branch resolution (else detected/`main`). */
  base_branch?: string
  /** Override the merge/cleanup deps (else built from `run_host`). */
  merge_deps?: MergeCleanupDeps
  /** Mint the per-dispatch tracking id (test seam). Defaults to crypto.randomUUID. */
  mint_run_id?: () => string
  /**
   * What to do with an ORPHANED in-flight run on a tick — one whose
   * `subagent_run_id` is persisted but which THIS process no longer tracks (the
   * restart case: the inner-loop dispatch was launched by a prior control-plane
   * process and lost when this one booted).
   *
   *   • `'redispatch'` (default) — RESUME by relaunching a FRESH workflow that
   *     reads `inner_checkpoint`/`pr`/`branch` and idempotently skips finished
   *     phases + reuses the PR. Bounded to one redispatch per run per process.
   *   • `'wait'` — leave untouched, keep polling (operator can `/trident stop`).
   *   • `'fail'` — reap the orphan loudly to `failed`.
   */
  on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
}

/**
 * Sum changed lines from `git diff --numstat <base>..HEAD`. RETAINED as an
 * exported helper (its Vajra-parity tests + revertibility) though the inner
 * workflow now does its own oversized-diff guard internally. Conservative on
 * failure: returns OVER the ceiling so an unmeasurable diff is treated as large.
 */
export async function computeDiffLineCount(
  run_host: RunHostCommand,
  repo_path: string,
  base_branch: string,
): Promise<number> {
  let res
  try {
    res = await run_host(
      ['git', '-C', repo_path, 'diff', '--numstat', `${base_branch}..HEAD`],
      repo_path,
    )
  } catch {
    return ARGUS_DIFF_LINE_LIMIT + 1
  }
  if (!res.ok) return ARGUS_DIFF_LINE_LIMIT + 1
  let total = 0
  for (const line of res.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 2) continue
    const added = parseInt(cols[0] ?? '', 10)
    const removed = parseInt(cols[1] ?? '', 10)
    if (Number.isFinite(added)) total += added
    if (Number.isFinite(removed)) total += removed
  }
  return total
}

/** In-process tracking of the ONE inner-loop dispatch per run, keyed by the
 *  minted `subagent_run_id`. Mirrors `TridentSessionManager`'s spawn/classify
 *  but with a single dispatch per run (the workflow owns the inner phases). */
type InnerDispatch = { status: 'running' } | { status: 'done'; result: InnerLoopResult }

export function buildTridentOrchestrator(
  opts: BuildTridentOrchestratorOptions,
): { step: TridentStep; drain: () => Promise<void> } {
  const now = opts.now ?? (() => new Date().toISOString())
  const inner_loop = opts.inner_loop
  const db_path = opts.db_path
  const merge_deps = opts.merge_deps ?? buildMergeCleanupDeps(opts.run_host)
  const on_orphaned = opts.on_orphaned_session ?? 'redispatch'
  const mint = opts.mint_run_id ?? (() => crypto.randomUUID())

  const dispatches = new Map<string, InnerDispatch>()
  const inflight = new Set<Promise<void>>()
  // Run ids redispatched in THIS process — the per-process bound on orphan
  // recovery so a crash-restart loop can't spin forever.
  const redispatched = new Set<string>()

  async function resolveBase(run: TridentRun): Promise<string> {
    if (opts.base_branch !== undefined) return opts.base_branch
    return detectBaseBranch(opts.run_host, run.repo_path)
  }

  /** Best-effort probe for an existing PR on the run's branch (idempotent resume
   *  — never open a duplicate). Only meaningful in `pr` mode; never throws. */
  async function detectExistingPr(run: TridentRun): Promise<number | null> {
    if (run.merge_mode !== 'pr') return null
    const branch = run.branch ?? `trident/${run.slug}`
    try {
      const res = await opts.run_host(
        ['gh', 'pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number // empty'],
        run.repo_path,
      )
      if (res.ok) {
        const n = parseInt(res.stdout.trim(), 10)
        if (Number.isFinite(n) && n > 0) return n
      }
    } catch {
      // probe failure → treat as no existing PR (the workflow opens one).
    }
    return null
  }

  function failedRun(run: TridentRun, reason: string, keepSubagentId: boolean): TridentRun {
    return {
      ...run,
      phase: 'failed',
      subagent_status: 'failed',
      subagent_run_id: keepSubagentId ? run.subagent_run_id : null,
      failure_reason: reason,
      last_advanced_at: now(),
    }
  }

  /** Launch the inner loop in the background; persist the tracking id. Folds any
   *  existing PR + the last checkpoint into the dispatch for idempotent resume. */
  async function launch(run: TridentRun): Promise<AdvanceOutcome> {
    const base = await resolveBase(run)
    const resume_checkpoint = run.inner_checkpoint
    const existingPr = run.pr ?? (await detectExistingPr(run))
    const launchRun: TridentRun = existingPr !== null && run.pr === null ? { ...run, pr: existingPr } : run

    const id = mint()
    if (typeof id !== 'string' || id.length === 0) {
      return {
        run: failedRun(run, 'trident: mint_run_id produced an empty id', false),
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (empty dispatch id)`,
      }
    }
    dispatches.set(id, { status: 'running' })
    const p = (async (): Promise<void> => {
      let result: InnerLoopResult
      try {
        result = await inner_loop({
          run: launchRun,
          base_branch: base,
          db_path,
          max_rounds: run.max_rounds,
          resume_checkpoint,
        })
      } catch (err) {
        result = {
          status: 'failed',
          verdict: null,
          pr_number: null,
          branch: null,
          round: 0,
          checkpoint: null,
          raw: err instanceof Error ? err.message : String(err),
        }
      }
      dispatches.set(id, { status: 'done', result })
    })()
    inflight.add(p)
    void p.finally(() => inflight.delete(p))

    const next: TridentRun = {
      ...launchRun,
      subagent_run_id: id,
      subagent_status: 'running',
      last_advanced_at: now(),
    }
    return {
      run: next,
      changed: true,
      waiting: true,
      note: `launched inner loop ${id}${resume_checkpoint !== null ? ` (resume ${resume_checkpoint})` : ''}`,
    }
  }

  /** Apply a settled inner-loop result to the run (merge on APPROVE, else fail). */
  async function applyResult(run: TridentRun, id: string, result: InnerLoopResult): Promise<AdvanceOutcome> {
    dispatches.delete(id)

    if (result.status !== 'completed') {
      // Crashed / timed_out inner loop → fail LOUDLY (never a silent success).
      const failed = failedRun(run, `inner loop ${result.status}`, true)
      return { run: failed, changed: true, waiting: false, note: `inner loop ${result.status} → failed` }
    }

    if (result.verdict === 'APPROVE') {
      const doneRun: TridentRun = {
        ...run,
        phase: 'done',
        pr: result.pr_number ?? run.pr,
        branch: result.branch ?? run.branch,
        inner_checkpoint: result.checkpoint ?? 'argus-approved',
        inner_verdict: 'APPROVE',
        workflow_run_id: run.workflow_run_id ?? id,
        subagent_run_id: id,
        subagent_status: 'completed',
        failure_reason: null,
        last_advanced_at: now(),
      }
      try {
        const res = await cleanupAfterMerge(doneRun, merge_deps)
        return { run: doneRun, changed: true, waiting: false, note: `inner loop APPROVE → done; ${res.note}` }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'merge failed'
        return {
          run: { ...failedRun(doneRun, `merge failed: ${reason}`, true), inner_verdict: 'APPROVE' },
          changed: true,
          waiting: false,
          note: `done → failed (${reason})`,
        }
      }
    }

    // REQUEST_CHANGES — the inner loop exhausted maxRounds without an APPROVE.
    const failed: TridentRun = {
      ...failedRun(run, `inner loop exhausted ${run.max_rounds} round(s) without Argus APPROVE`, true),
      pr: result.pr_number ?? run.pr,
      branch: result.branch ?? run.branch,
      inner_checkpoint: result.checkpoint ?? 'argus-request-changes',
      inner_verdict: 'REQUEST_CHANGES',
      workflow_run_id: run.workflow_run_id ?? id,
    }
    return { run: failed, changed: true, waiting: false, note: 'inner loop REQUEST_CHANGES (max rounds) → failed' }
  }

  async function step(run: TridentRun): Promise<AdvanceOutcome> {
    if (isTerminalPhase(run.phase)) {
      return { run, changed: false, waiting: false, note: `no-op (already ${run.phase})` }
    }

    // (0) Orphan recovery. A persisted dispatch id this process does NOT track is
    //     an orphan (lost on restart). Recover per policy BEFORE launch/poll.
    if (run.subagent_run_id !== null && !dispatches.has(run.subagent_run_id)) {
      const orphanId = run.subagent_run_id
      if (on_orphaned === 'fail') {
        // Loud reap — keep the 'crashed' sub-status (an orphan is a lost agent,
        // distinct from a clean self-failure), so the audit trail reads truthfully.
        const reaped: TridentRun = {
          ...run,
          phase: 'failed',
          subagent_status: 'crashed',
          failure_reason: `orphaned inner-loop dispatch ${orphanId} (lost after restart / never became ready)`,
          last_advanced_at: now(),
        }
        return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (orphaned dispatch reaped)` }
      }
      if (on_orphaned === 'wait' || redispatched.has(run.id)) {
        return { run, changed: false, waiting: true, note: `waiting on orphaned inner-loop dispatch ${orphanId}` }
      }
      // redispatch (default): clear the slot so the launch path relaunches a
      // FRESH workflow that resumes from the persisted checkpoint.
      redispatched.add(run.id)
      run = { ...run, subagent_run_id: null, subagent_status: null }
    }

    // (1) Launch-if-needed — the single launch site (null-guarded).
    if (run.subagent_run_id === null) {
      return launch(run)
    }

    // (2) Poll the in-flight dispatch.
    const d = dispatches.get(run.subagent_run_id)
    if (d === undefined || d.status === 'running') {
      return { run, changed: false, waiting: true, note: `waiting on inner-loop dispatch ${run.subagent_run_id}` }
    }

    // (3) Settled — apply the result (merge-on-APPROVE or fail).
    return applyResult(run, run.subagent_run_id, d.result)
  }

  /** Resolve once every in-flight background inner-loop dispatch has settled
   *  (tests + graceful shutdown). */
  async function drain(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.all([...inflight])
    }
  }

  return { step, drain }
}
