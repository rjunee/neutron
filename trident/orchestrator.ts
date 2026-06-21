/**
 * @neutronai/trident — the PR-3 orchestration step.
 *
 * Wires the real Forge/Argus substrate sessions into the PR-2 state
 * machine. The tick loop calls `step(run)` for every non-terminal run;
 * the step does exactly three things, in order:
 *
 *   1. SPAWN-IF-NEEDED. A live phase with no in-flight sub-agent
 *      (`subagent_run_id === null`) gets its sub-agent launched now:
 *      render the phase's prompt, `session.spawn(...)`, and persist the
 *      returned id + `running` on the row. This is the ONLY place a
 *      sub-agent is spawned, and it is guarded by the null check — once
 *      a non-null id is persisted, a re-entrant tick takes the POLL path
 *      instead, so a session is never double-spawned (the resume-safe
 *      invariant from the brief).
 *
 *   2. POLL + TRANSITION. With an agent in flight, defer to the pure
 *      `advanceTridentRun` (PR-2) using the session manager's
 *      `classify`. running → wait; crashed → failed; completed → the
 *      pure transition graph advances the phase and CLEARS the sub-agent
 *      slot, so step (1) on the next tick spawns the next phase's agent.
 *
 *   3. MERGE-ON-DONE. When the transition lands on `done` (Argus
 *      APPROVE), run the merge + cleanup for the run's git-mode. A merge
 *      failure routes the run to `failed` (recoverable: re-run) rather
 *      than leaving a half-merged terminal state.
 *
 * The step is the composition root; the pieces (session manager, merge
 * deps, prompt renderers, diff-size probe) are all injected so the whole
 * loop is exercised against a scripted fake dispatch + fake git/gh.
 */

import {
  loadAgentSystemPrompt,
  type DispatchAgentKind,
} from './agent-prompts.ts'
import { cleanupAfterMerge, type MergeCleanupDeps } from './git-mode.ts'
import { buildMergeCleanupDeps, detectBaseBranch, type RunHostCommand } from './merge.ts'
import {
  ARGUS_DIFF_LINE_LIMIT,
  renderArgusPrompt,
  renderForgeFixPrompt,
  renderForgePrompt,
  renderRalphPlanPrompt,
  renderRalphTaskPrompt,
} from './prompts.ts'
import { TridentSessionManager } from './session.ts'
import {
  advanceTridentRun,
  isTerminalPhase,
  type AdvanceOutcome,
} from './state-machine.ts'
import type { TridentPhase, TridentRun } from './store.ts'

/**
 * Defensive guard: raised if `spawnForPhase` is ever asked to spawn for a
 * phase with no spawner. As of PR-4 every LIVE phase (forge-init, forge-fix,
 * argus, ralph-plan, ralph-task) is wired; only the terminal phases hit the
 * default, and `step` short-circuits those before spawn. So this is now a
 * never-should-happen backstop, not an expected control-flow path.
 */
export class TridentPhaseNotWiredError extends Error {
  constructor(readonly phase: TridentPhase) {
    super(`trident: no sub-agent spawner wired for phase '${phase}'`)
    this.name = 'TridentPhaseNotWiredError'
  }
}

export interface TridentStep {
  (run: TridentRun): Promise<AdvanceOutcome>
}

export interface BuildTridentOrchestratorOptions {
  session: TridentSessionManager
  /** Host command runner — diff-size probe, base-branch detect, merge. */
  run_host: RunHostCommand
  /** ISO-8601 UTC clock. Defaults to wall-clock. */
  now?: () => string
  /** Forge model id. Default 'claude-sonnet-4-6'. */
  forge_model?: string
  /** Argus model id. Default 'claude-sonnet-4-6'. */
  argus_model?: string
  /** Per-sub-agent wall-clock budget. Default 30 min. */
  subagent_timeout_ms?: number
  /** Override base-branch resolution (else detected/`main`). */
  base_branch?: string
  /** Override the merge/cleanup deps (else built from `run_host`). */
  merge_deps?: MergeCleanupDeps
  /**
   * Resolve a dispatchable agent's SYSTEM prompt. Defaults to
   * `loadAgentSystemPrompt(kind).content`, which loads the on-disk
   * `prompts/<kind>.md` execution contract (falling back to a minimal
   * inline identity if the file is missing). Overridable so tests can
   * assert the loaded contract reaches the dispatch without touching the
   * real filesystem.
   */
  agent_system_prompt?: (kind: DispatchAgentKind) => string
  /**
   * What to do with an ORPHANED in-flight run on a tick — one whose
   * `subagent_run_id` is persisted (non-null) but which the session
   * manager no longer tracks (`session.isTracked === false`). This is the
   * restart / "session never became ready" case: a sub-agent launched by
   * a PRIOR control-plane process whose in-memory dispatch was lost when
   * this process booted.
   *
   *   • `'redispatch'` (default) — RESUME the run by re-launching the same
   *     phase's sub-agent (clear the slot so the spawn path re-fires).
   *     BOUNDED to one re-dispatch per run per process (a re-spawned
   *     session registers synchronously, so steady state never re-enters
   *     this path; the per-process guard stops a crash-restart storm from
   *     spinning). This is NOT a double-spawn: the prior in-process agent
   *     is already gone, so exactly one agent is ever live for the phase.
   *   • `'wait'` — leave the run untouched and keep polling (the prior
   *     conservative default — an operator can `/trident stop` a genuine
   *     orphan).
   *   • `'fail'` — mark the run failed immediately (loud reap).
   */
  on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
}

const DEFAULT_FORGE_MODEL = 'claude-sonnet-4-6'
const DEFAULT_ARGUS_MODEL = 'claude-sonnet-4-6'
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60_000

/**
 * Sum changed lines from `git diff --numstat <base>..HEAD`. Conservative
 * on failure: a probe that can't measure returns OVER the ceiling so the
 * oversized-diff guard takes the safe meaty-commits path rather than
 * pushing a possibly-huge diff at Argus.
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

export function buildTridentOrchestrator(
  opts: BuildTridentOrchestratorOptions,
): { step: TridentStep } {
  const now = opts.now ?? (() => new Date().toISOString())
  const forge_model = opts.forge_model ?? DEFAULT_FORGE_MODEL
  const argus_model = opts.argus_model ?? DEFAULT_ARGUS_MODEL
  const timeout_ms = opts.subagent_timeout_ms ?? DEFAULT_SUBAGENT_TIMEOUT_MS
  const merge_deps = opts.merge_deps ?? buildMergeCleanupDeps(opts.run_host)
  const session = opts.session
  const on_orphaned = opts.on_orphaned_session ?? 'redispatch'
  // Resolve each dispatched agent's SYSTEM prompt from its on-disk
  // `prompts/<kind>.md` contract (was a literal kind label). Default loads
  // + falls back; tests inject a stub.
  const agentSystemPrompt =
    opts.agent_system_prompt ?? ((kind: DispatchAgentKind) => loadAgentSystemPrompt(kind).content)
  // Run ids re-dispatched in THIS process — the per-process bound on the
  // resume/reap recovery so a crash-restart loop can't spin forever.
  const redispatched = new Set<string>()

  async function resolveBase(run: TridentRun): Promise<string> {
    if (opts.base_branch !== undefined) return opts.base_branch
    return detectBaseBranch(opts.run_host, run.repo_path)
  }

  async function spawnForPhase(run: TridentRun): Promise<string> {
    const base = await resolveBase(run)
    switch (run.phase) {
      case 'forge-init': {
        return session.spawn({
          kind: 'forge',
          phase: run.phase,
          system: agentSystemPrompt('forge'),
          user_message: renderForgePrompt(run, base),
          repo_path: run.worktree ?? run.repo_path,
          trident_run_id: run.id,
          model: forge_model,
          timeout_ms,
        })
      }
      case 'forge-fix': {
        const findings = session.findingsFor(run.id)
        return session.spawn({
          kind: 'forge',
          phase: run.phase,
          system: agentSystemPrompt('forge'),
          user_message: renderForgeFixPrompt(run, base, findings, run.round),
          repo_path: run.worktree ?? run.repo_path,
          trident_run_id: run.id,
          model: forge_model,
          timeout_ms,
        })
      }
      case 'ralph-plan': {
        // A fresh, docs-only planning pass: diff SPEC.md against the code
        // and (re)write IMPLEMENTATION_PLAN.md. Reports REMAINING_TASKS +
        // NEXT_TASK (parsed by the session manager's ralph-plan branch).
        return session.spawn({
          kind: 'forge',
          phase: run.phase,
          system: agentSystemPrompt('forge'),
          user_message: renderRalphPlanPrompt(run, base),
          repo_path: run.worktree ?? run.repo_path,
          trident_run_id: run.id,
          model: forge_model,
          timeout_ms,
        })
      }
      case 'ralph-task': {
        // A fresh Forge with a clean context that implements ONLY the single
        // task the prior planning pass surfaced.
        const next_task = session.nextTaskFor(run.id)
        return session.spawn({
          kind: 'forge',
          phase: run.phase,
          system: agentSystemPrompt('forge'),
          user_message: renderRalphTaskPrompt(run, base, next_task),
          repo_path: run.worktree ?? run.repo_path,
          trident_run_id: run.id,
          model: forge_model,
          timeout_ms,
        })
      }
      case 'argus': {
        const diff_line_count = await computeDiffLineCount(
          opts.run_host,
          run.worktree ?? run.repo_path,
          base,
        )
        const prompt = renderArgusPrompt({
          branch: run.branch ?? `trident/${run.slug}`,
          pr_number: run.pr ?? 0,
          round: run.round,
          max_rounds: run.max_rounds,
          base_branch: base,
          diff_line_count,
        })
        return session.spawn({
          kind: 'argus',
          phase: run.phase,
          system: agentSystemPrompt('argus'),
          user_message: prompt,
          repo_path: run.worktree ?? run.repo_path,
          trident_run_id: run.id,
          model: argus_model,
          timeout_ms,
        })
      }
      default:
        // Terminal phases only — `step` short-circuits them before here.
        throw new TridentPhaseNotWiredError(run.phase)
    }
  }

  async function step(run: TridentRun): Promise<AdvanceOutcome> {
    if (isTerminalPhase(run.phase)) {
      return { run, changed: false, waiting: false, note: `no-op (already ${run.phase})` }
    }

    // (0) Resume / reap. A non-null persisted sub-agent the manager does
    //     NOT track is an ORPHAN — launched by a prior control-plane
    //     process and lost on restart (the in-memory dispatch is gone), or
    //     one that never became ready. Recover per `on_orphaned_session`
    //     BEFORE poll/spawn so a fresh process resumes in-flight runs from
    //     their persisted `subagent_run_id`/`subagent_status` rather than
    //     polling a phantom forever.
    if (run.subagent_run_id !== null && !session.isTracked(run.subagent_run_id)) {
      const orphanId = run.subagent_run_id
      if (on_orphaned === 'fail') {
        const failed: TridentRun = {
          ...run,
          phase: 'failed',
          subagent_status: 'crashed',
          failure_reason: `orphaned ${run.phase} sub-agent ${orphanId} (lost after restart / never became ready)`,
          last_advanced_at: now(),
        }
        return { run: failed, changed: true, waiting: false, note: `${run.phase} → failed (orphaned sub-agent reaped)` }
      }
      if (on_orphaned === 'wait' || redispatched.has(run.id)) {
        // 'wait' policy, OR we already re-dispatched this run once this
        // process (the new session registers synchronously, so re-arriving
        // here means even the re-dispatch was lost — don't spin; wait for
        // an operator). Keep polling without spawning: no double-spawn.
        return { run, changed: false, waiting: true, note: `waiting on orphaned ${run.phase} sub-agent ${orphanId}` }
      }
      // 'redispatch' (default): resume by clearing the slot so the
      // spawn-if-needed path below re-launches THIS phase. The prior agent
      // is already gone (in-process), so exactly one agent is ever live.
      redispatched.add(run.id)
      run = { ...run, subagent_run_id: null, subagent_status: null }
    }

    // (1) Spawn-if-needed — the single, null-guarded spawn site.
    if (run.subagent_run_id === null) {
      try {
        const id = await spawnForPhase(run)
        const next: TridentRun = {
          ...run,
          subagent_run_id: id,
          subagent_status: 'running',
          last_advanced_at: now(),
        }
        return {
          run: next,
          changed: true,
          waiting: true,
          note: `spawned ${run.phase} sub-agent ${id}`,
        }
      } catch (err) {
        // An un-spawnable phase (e.g. Ralph pre-PR-4) fails the run loudly
        // and bounded, never an infinite spawn-retry loop.
        const reason =
          err instanceof Error ? err.message : `failed to spawn ${run.phase} sub-agent`
        const failed: TridentRun = {
          ...run,
          phase: 'failed',
          subagent_status: 'failed',
          failure_reason: reason,
          last_advanced_at: now(),
        }
        return { run: failed, changed: true, waiting: false, note: `${run.phase} → failed (${reason})` }
      }
    }

    // (2) Poll + transition via the pure state machine.
    const wasForge =
      run.phase === 'forge-init' ||
      run.phase === 'forge-fix' ||
      run.phase === 'ralph-plan' ||
      run.phase === 'ralph-task'
    let out = await advanceTridentRun(run, {
      now,
      classify: (r) => session.classify(r),
    })

    // (2a) Fold the completed Forge turn's PR/branch/worktree onto the run
    // the tick persists. Done HERE (single writer) rather than from the
    // background dispatch, which would race this step's own save.
    if (out.changed && wasForge) {
      const meta = session.forgeMetaFor(run.id)
      if (meta !== null) {
        out = {
          ...out,
          run: { ...out.run, pr: meta.pr, branch: meta.branch, worktree: meta.worktree },
        }
      }
    }

    // (3) Merge-on-done.
    if (out.changed && out.run.phase === 'done') {
      try {
        const res = await cleanupAfterMerge(out.run, merge_deps)
        return { ...out, note: `${out.note}; ${res.note}` }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'merge failed'
        const failed: TridentRun = {
          ...out.run,
          phase: 'failed',
          subagent_status: 'failed',
          failure_reason: `merge failed: ${reason}`,
          last_advanced_at: now(),
        }
        return { run: failed, changed: true, waiting: false, note: `done → failed (${reason})` }
      }
    }

    return out
  }

  return { step }
}
