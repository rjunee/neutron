/**
 * @neutronai/trident — the orchestration step (Trident v2 · Work Board Phase 2a
 * EXEC-MODEL rearchitecture).
 *
 * The durable OUTER loop (`tick.ts` + the `code_trident_runs` SQLite table)
 * calls `step(run)` for every non-terminal run. As of Phase 2a the INNER
 * Forge→Argus→fix loop is ONE native CC Dynamic Workflow
 * (`trident/inner-workflow.mjs`), FIRED per run via a `TridentWorkflowFirer`
 * (`trident/inner-loop.ts`) on a WARM substrate whose launching turn settles
 * immediately. The workflow then runs DETACHED in the background and persists
 * its TYPED terminal result to the run row (`inner_result`); this step HARVESTS
 * that result from the DB by `runId` — deterministic TS, never an LLM-parsed
 * stdout line, never an in-memory build-result map.
 *
 * What this step owns (the OUTER concerns):
 *
 *   1. LAUNCH-IF-NEEDED. A live run with no in-flight dispatch
 *      (`subagent_run_id === null`) gets the workflow FIRED now: mint a tracking
 *      uuid, FIRE the workflow (the launching turn settles in seconds), and on a
 *      clean fire persist the id + `subagent_status='running'`. Idempotent
 *      crash-resume: before firing, fold any existing PR/branch + the last
 *      `inner_checkpoint` into the args so the workflow REUSES the PR (no
 *      duplicate) and skips finished phases.
 *
 *   2. HARVEST. With a workflow in flight, read the run's `inner_result` each
 *      tick. Once the workflow has written its TYPED terminal result, decode it
 *      (`parseInnerResult`), SERVER-GATE a merge-eligible `APPROVE` against the
 *      Argus-phase-recorded `inner_checkpoint='argus-approved'` (never a
 *      self-asserted result line), then on APPROVE → phase `done`
 *      (persist pr/branch/inner_verdict) + merge (`cleanupAfterMerge`, the
 *      outer/human gate); on REQUEST_CHANGES / failed-provenance → phase `failed`
 *      with a named reason (recoverable: re-run), never a silent success.
 *
 *   3. CRASH RECOVERY. The durable row is authoritative; harvest works across a
 *      process restart because the result lives in the DB, not in memory. A
 *      persisted `subagent_run_id` this process did NOT fire (lost on restart)
 *      AND no `inner_result` yet is an ORPHAN — re-fired per
 *      `on_orphaned_session` (a redispatch resumes from `inner_checkpoint`,
 *      bounded to one per process; a workflow that already merged is terminal so
 *      never re-fired → no double-merge). A workflow that fired but goes silent
 *      past `max_inflight_ms` with no checkpoint is reaped as a stalled run.
 *
 * `state-machine.ts` (`computeTransition`/`advanceTridentRun`) is intentionally
 * KEPT intact (its unit tests + one-commit revertibility) even though this prod
 * step no longer drives the per-phase graph for the inner loop.
 */

import { cleanupAfterMerge, type MergeCleanupDeps } from './git-mode.ts'
import {
  parseInnerResult,
  type FireOutcome,
  type InnerResult,
  type TridentWorkflowFirer,
} from './inner-loop.ts'
import { buildMergeCleanupDeps, detectBaseBranch, type RunHostCommand } from './merge.ts'
import { ARGUS_DIFF_LINE_LIMIT } from './prompts.ts'
import { isTerminalPhase, type AdvanceOutcome } from './state-machine.ts'
import type { TridentRun } from './store.ts'

export interface TridentStep {
  (run: TridentRun): Promise<AdvanceOutcome>
}

export interface BuildTridentOrchestratorOptions {
  /** The inner-workflow FIRER (Phase 2a). Fires the inner CC Dynamic Workflow on
   *  a warm substrate + settles the launching turn; see `buildWorkflowFirer`. */
  fire_workflow: TridentWorkflowFirer
  /** Absolute sqlite file path threaded to the workflow's checkpoint +
   *  terminal-result Bash steps. */
  db_path: string
  /** Host command runner — base-branch detect, existing-PR probe, merge. */
  run_host: RunHostCommand
  /** ISO-8601 UTC clock. Defaults to wall-clock. */
  now?: () => string
  /** Override base-branch resolution (else detected/`main`). */
  base_branch?: string
  /** Static Codex credential dir (CODEX_HOME) for the OPTIONAL cross-model
   *  review, threaded into the inner workflow. Resolved from NEUTRON_CODEX_HOME
   *  env / per-project config at wiring time. Undefined/null → codex "not
   *  connected" → the review is Claude-only (never a merge blocker). Ignored when
   *  `resolve_codex_home` is supplied. */
  codex_home?: string | null
  /** Per-run CODEX_HOME resolver (preferred over `codex_home`). Called on every
   *  tick with the launching run so the review resolves the credential through
   *  the #149 store resolver (`CodexCredentialService.resolveActiveCodexHome`:
   *  project override → global → unset) with self-healing materialization —
   *  never a raw static path. Trident runs are instance-scoped by `project_slug`
   *  (no per-project id), so a run resolves the GLOBAL default; the resolver
   *  honors a project override wherever a real project id is supplied. Returns
   *  null → codex not connected → Claude-only review. */
  resolve_codex_home?: (run: TridentRun) => string | null
  /** Override the merge/cleanup deps (else built from `run_host`). */
  merge_deps?: MergeCleanupDeps
  /** Mint the per-dispatch tracking id (test seam). Defaults to crypto.randomUUID. */
  mint_run_id?: () => string
  /**
   * How long a FIRED workflow may run with no terminal `inner_result` AND no
   * fresh checkpoint before it is reaped as stalled (the build runs detached, so
   * the tick loop owns build liveness). Measured from `last_advanced_at`, which
   * the workflow re-stamps on every checkpoint — so a healthy, checkpointing
   * build never trips this. Default 2 h.
   */
  max_inflight_ms?: number
  /**
   * PER-AGENT HANG WATCHDOG (M1 trident-UX hardening, item 2). The PRIMARY
   * fail-fast reap: a non-terminal run with an in-flight dispatch whose
   * `last_advanced_at` has not moved for this long — with no harvestable
   * `inner_result` — is treated as a suspected agent hang (the incident: a
   * zero-token model hang stalled a run 30+ min with NO error because nothing
   * detected it) and reaped to `failed`, so it surfaces on the Plan item + the
   * terminal delivery notification fires instead of sitting silent.
   *
   * A HEALTHY build re-stamps `last_advanced_at` on every inner-workflow
   * checkpoint (`forge-done`, `argus-*`, `fix-round-N`), so it never trips this;
   * only a genuinely wedged agent() (or a stalled orphan) does. This is
   * deliberately SHORTER than `max_inflight_ms` (the 2h absolute ceiling, kept
   * as a defense-in-depth backstop). Default `NO_ADVANCE_HANG_MS` (15 min).
   */
  no_advance_hang_ms?: number
  /**
   * What to do with an ORPHANED in-flight run on a tick — one whose
   * `subagent_run_id` is persisted but which THIS process never fired (the
   * restart case: the workflow was fired by a prior control-plane process and
   * died with it) AND which has not yet written an `inner_result`.
   *
   *   • `'redispatch'` (default) — RESUME by re-firing a FRESH workflow that
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

const DEFAULT_MAX_INFLIGHT_MS = 2 * 60 * 60_000

/**
 * Per-agent hang watchdog default (M1 trident-UX hardening, item 2). A
 * non-terminal run whose `last_advanced_at` has not moved for this long while a
 * dispatch is in flight is reaped as a suspected agent hang. 15 min: long enough
 * that a healthy build (which checkpoints between phases) never trips it, short
 * enough to catch the exact 30+ min silent wedge that motivated this.
 */
const NO_ADVANCE_HANG_MS = 15 * 60_000

export function buildTridentOrchestrator(
  opts: BuildTridentOrchestratorOptions,
): { step: TridentStep; drain: () => Promise<void> } {
  const now = opts.now ?? (() => new Date().toISOString())
  const fireWorkflow = opts.fire_workflow
  const db_path = opts.db_path
  const merge_deps = opts.merge_deps ?? buildMergeCleanupDeps(opts.run_host)
  const on_orphaned = opts.on_orphaned_session ?? 'redispatch'
  const mint = opts.mint_run_id ?? (() => crypto.randomUUID())
  const maxInflightMs = opts.max_inflight_ms ?? DEFAULT_MAX_INFLIGHT_MS
  const noAdvanceHangMs = opts.no_advance_hang_ms ?? NO_ADVANCE_HANG_MS

  // This-process liveness: run ids whose workflow THIS process fired (and whose
  // launching turn settled). A persisted `subagent_run_id` whose run.id is NOT
  // in this set is an orphan from a prior process. Crash-safe: lost on restart
  // (so all prior-process dispatches become orphans + re-fire idempotently).
  const fired = new Set<string>()
  // Run ids redispatched in THIS process — the per-process bound on orphan
  // recovery so a crash-restart loop can't spin forever.
  const redispatched = new Set<string>()
  // In-flight FIRE turns (tests + graceful shutdown drain). Each settles in
  // seconds; the build itself runs detached and is NOT tracked here.
  const inflight = new Set<Promise<void>>()

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

  /** Fire the inner workflow on the warm substrate; the launching turn settles
   *  immediately and the workflow runs detached. Persists the tracking id on a
   *  clean fire. Folds any existing PR + the last checkpoint into the args for
   *  idempotent resume. */
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

    // FIRE the workflow. The launching turn settles in seconds; the build runs
    // detached in the background and persists its own result to the DB. Tracked
    // in `inflight` only so tests/shutdown can drain the (fast) fire turn.
    const firePromise = fireWorkflow({
      run: launchRun,
      base_branch: base,
      db_path,
      max_rounds: run.max_rounds,
      resume_checkpoint,
      // Prefer the per-run resolver (store-backed, self-healing) over any static
      // dir; either resolves the CODEX_HOME the inner review threads.
      codex_home: opts.resolve_codex_home
        ? opts.resolve_codex_home(launchRun)
        : (opts.codex_home ?? null),
    })
    const tracked = firePromise.then(
      () => undefined,
      () => undefined,
    )
    inflight.add(tracked)
    let outcome: FireOutcome
    try {
      outcome = await firePromise
    } catch (e) {
      // `buildWorkflowFirer` already converts throws to a `failed` outcome, but
      // stay defensive: a rejecting firer is a crashed launcher, never a success.
      outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) }
    } finally {
      inflight.delete(tracked)
    }

    if (outcome.status !== 'fired') {
      // The launching turn never settled cleanly — the workflow was NOT fired.
      // Fail loudly (recoverable: a re-run re-fires). paused ≠ finished.
      return {
        run: failedRun(run, `inner workflow fire failed: ${outcome.error ?? 'unknown'}`, false),
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (fire did not settle)`,
      }
    }

    fired.add(run.id)
    const next: TridentRun = {
      ...launchRun,
      subagent_run_id: id,
      subagent_status: 'running',
      workflow_run_id: launchRun.workflow_run_id ?? id,
      last_advanced_at: now(),
    }
    return {
      run: next,
      changed: true,
      waiting: true,
      note: `fired inner workflow ${id}${resume_checkpoint !== null ? ` (resume ${resume_checkpoint})` : ''}`,
    }
  }

  /** Apply a harvested, decoded inner result to the run (merge on a SERVER-GATED
   *  APPROVE, else fail). */
  async function applyResult(run: TridentRun, result: InnerResult): Promise<AdvanceOutcome> {
    fired.delete(run.id)
    redispatched.delete(run.id)

    const pr = result.pr_number ?? run.pr
    const branch = result.branch ?? run.branch

    // SERVER-GATED verdict provenance: a merge-eligible APPROVE must be backed by
    // the Argus phase's OWN recorded checkpoint (`inner_checkpoint='argus-approved'`,
    // written by the workflow's synthesis-phase Bash step), NEVER just the
    // self-asserted verdict in the harvested result line. A result claiming
    // APPROVE without that recorded provenance is rejected — failed, not merged.
    const argusApproved = run.inner_checkpoint === 'argus-approved'

    if (result.verdict === 'APPROVE' && argusApproved) {
      const doneRun: TridentRun = {
        ...run,
        phase: 'done',
        pr,
        branch,
        inner_checkpoint: result.checkpoint ?? 'argus-approved',
        inner_verdict: 'APPROVE',
        subagent_status: 'completed',
        failure_reason: null,
        last_advanced_at: now(),
      }
      try {
        const res = await cleanupAfterMerge(doneRun, merge_deps)
        return { run: doneRun, changed: true, waiting: false, note: `APPROVE (argus-approved) → done; ${res.note}` }
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

    if (result.verdict === 'APPROVE' && !argusApproved) {
      // Provenance gate tripped — a self-asserted APPROVE with no recorded
      // argus-approved checkpoint. Never merge on an unverified verdict.
      const failed: TridentRun = {
        ...failedRun(
          run,
          'inner workflow reported APPROVE but no recorded argus-approved checkpoint (provenance gate)',
          true,
        ),
        pr,
        branch,
        inner_verdict: 'REQUEST_CHANGES',
      }
      return { run: failed, changed: true, waiting: false, note: 'APPROVE rejected (provenance gate) → failed' }
    }

    // REQUEST_CHANGES / null — the inner loop exhausted maxRounds without an APPROVE.
    const failed: TridentRun = {
      ...failedRun(run, `inner loop exhausted ${run.max_rounds} round(s) without Argus APPROVE`, true),
      pr,
      branch,
      inner_checkpoint: run.inner_checkpoint ?? result.checkpoint ?? 'argus-request-changes',
      inner_verdict: 'REQUEST_CHANGES',
    }
    return { run: failed, changed: true, waiting: false, note: 'inner loop REQUEST_CHANGES (max rounds) → failed' }
  }

  /** Elapsed ms since the run last advanced (checkpoint / launch). Conservative
   *  on an unparseable timestamp: returns 0 (never falsely reaps a run). */
  function elapsedSinceAdvance(run: TridentRun): number {
    const t = Date.parse(run.last_advanced_at)
    if (!Number.isFinite(t)) return 0
    const n = Date.parse(now())
    if (!Number.isFinite(n)) return 0
    return Math.max(0, n - t)
  }

  async function step(run: TridentRun): Promise<AdvanceOutcome> {
    if (isTerminalPhase(run.phase)) {
      fired.delete(run.id)
      redispatched.delete(run.id)
      return { run, changed: false, waiting: false, note: `no-op (already ${run.phase})` }
    }

    // (1) HARVEST FIRST — a written terminal result wins over orphan recovery, so
    //     a run whose workflow finished before a restart harvests (never re-fires
    //     → never double-merges). Deterministic TS read of the typed DB column.
    if (run.subagent_run_id !== null) {
      const result = parseInnerResult(run.inner_result)
      if (result !== null) {
        return applyResult(run, result)
      }
    }

    // (1b) HANG WATCHDOG (M1 trident-UX hardening, item 2) — the PRIMARY
    //     fail-fast detector. A dispatch is in flight (subagent_run_id set) with
    //     NO harvestable result (the harvest above already returned otherwise),
    //     and `last_advanced_at` has not moved for `noAdvanceHangMs`. A healthy
    //     build re-stamps that timestamp on every inner-workflow checkpoint, so
    //     only a genuinely wedged agent() (the zero-token model hang that stalled
    //     a run 30+ min with no error) — or a stalled orphan that hasn't been
    //     redispatched — sits here. Reap it to `failed` NOW so the Plan item
    //     flips to "failed" + the terminal delivery notification fires, rather
    //     than waiting on the 2h `maxInflightMs` ceiling below. Checked BEFORE
    //     orphan recovery so a wedged orphan is reaped instead of redispatched.
    if (run.subagent_run_id !== null && elapsedSinceAdvance(run) > noAdvanceHangMs) {
      fired.delete(run.id)
      redispatched.delete(run.id)
      const mins = Math.round(noAdvanceHangMs / 60_000)
      const reaped = failedRun(
        run,
        `no progress for ${mins} min — suspected agent hang (inner workflow stopped advancing)`,
        false,
      )
      return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (suspected hang)` }
    }

    // (2) ORPHAN RECOVERY. A persisted dispatch id this process never fired AND no
    //     terminal result yet → the workflow died with a prior process. Recover
    //     per policy.
    if (run.subagent_run_id !== null && !fired.has(run.id)) {
      const orphanId = run.subagent_run_id
      if (on_orphaned === 'fail') {
        const reaped: TridentRun = {
          ...run,
          phase: 'failed',
          subagent_status: 'crashed',
          failure_reason: `orphaned inner-loop dispatch ${orphanId} (lost after restart / never wrote a result)`,
          last_advanced_at: now(),
        }
        return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (orphaned dispatch reaped)` }
      }
      if (on_orphaned === 'wait' || redispatched.has(run.id)) {
        return { run, changed: false, waiting: true, note: `waiting on orphaned inner-loop dispatch ${orphanId}` }
      }
      // redispatch (default): clear the slot so the launch path re-fires a FRESH
      // workflow that resumes from the persisted checkpoint.
      redispatched.add(run.id)
      run = { ...run, subagent_run_id: null, subagent_status: null }
    }

    // (3) Launch-if-needed — the single fire site (null-guarded).
    if (run.subagent_run_id === null) {
      return launch(run)
    }

    // (4) In flight (fired by THIS process, no result yet). Reap a stalled
    //     workflow that has gone silent past the budget (no checkpoint refresh);
    //     otherwise keep waiting for it to write its result.
    if (elapsedSinceAdvance(run) > maxInflightMs) {
      fired.delete(run.id)
      const reaped = failedRun(
        run,
        `inner workflow stalled (no terminal result within ${Math.round(maxInflightMs / 60_000)} min)`,
        false,
      )
      return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (stalled)` }
    }
    return { run, changed: false, waiting: true, note: `waiting on inner-loop dispatch ${run.subagent_run_id}` }
  }

  /** Resolve once every in-flight FIRE turn has settled (tests + graceful
   *  shutdown). The detached builds are NOT awaited here — the tick loop harvests
   *  their results from the DB. */
  async function drain(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.all([...inflight])
    }
  }

  return { step, drain }
}
