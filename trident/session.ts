/**
 * @neutronai/trident — sub-agent session manager.
 *
 * Bridges the BLOCKING `dispatch` surface (a Forge/Argus turn that runs
 * to terminal text — the same shape `cores/free/code-gen`'s
 * `buildRuntimeSubagentDispatch` produces) onto the trident tick loop's
 * NON-blocking, poll-every-tick model:
 *
 *   • `spawn(input)` records a `running` entry under a freshly-minted
 *     `subagent_run_id`, fires the dispatch in the BACKGROUND, and
 *     returns the id immediately — the tick persists it on the run row.
 *   • each later tick calls `classify(run)`, which looks the session up
 *     by `run.subagent_run_id` and reports running / completed(result) /
 *     crashed. On completion the dispatch's terminal text is parsed per
 *     the phase that produced it (Forge contract lines → `remaining`;
 *     Argus verdict → `approved`).
 *
 * This is where Vajra's battle-tested spawn/reap fixes map onto the
 * substrate:
 *   • Spawn-validation / no phantom id — the `running` entry is written
 *     SYNCHRONOUSLY before `spawn` returns, so a subsequent `classify`
 *     can never poll an id the manager doesn't know about (the phantom-ID
 *     stuck-loop bug). A genuinely empty mint throws at spawn time.
 *   • No-silent-exit — a Forge turn that finishes without the locked
 *     PR/BRANCH/WORKTREE contract lines is surfaced as `crashed` (a
 *     forge-init contract breach), never silently treated as success.
 *     A Ralph bootstrap/planner that emits the PR lines but omits
 *     REMAINING_TASKS yields `remaining: null`, which the state machine
 *     fails LOUDLY on (it must not review a partial governed build).
 */

import {
  parseArgusFindings,
  parseArgusVerdict,
  parseForgeOutput,
  parseRalphPlan,
} from './prompts.ts'
import type { SubagentOutcome } from './state-machine.ts'
import type { DispatchAgentKind } from './agent-prompts.ts'
import type { TridentPhase, TridentRun } from './store.ts'

export interface TridentDispatchInput {
  /**
   * Sub-agent kind. The trident state machine only ever spawns `'forge'`
   * and `'argus'`; the wider `DispatchAgentKind` union lets the SAME
   * one-turn dispatch closure also serve a phase-less `'atlas'` /
   * `'sentinel'` dispatch (see `agent-dispatch.ts`).
   */
  kind: DispatchAgentKind
  /**
   * The trident phase that produced this dispatch (drives result
   * parsing). Omitted for phase-less typed dispatches (Atlas / Sentinel
   * one-shots) that do not run inside the Forge→Argus state machine.
   */
  phase?: TridentPhase
  /**
   * Fully-rendered SYSTEM prompt. For the build-loop agents this is the
   * NATIVE bare kind label (`'forge'` / `'argus'`) — their execution
   * contract rides the `user_message` (rendered from `trident/prompts.ts`),
   * which is what `parseForgeOutput` / `parseArgusVerdict` depend on. For a
   * phase-less Atlas / Sentinel dispatch it is the persona loaded from
   * `prompts/<kind>.md` via `loadAgentSystemPrompt` (see `agent-dispatch.ts`).
   */
  system: string
  /** Fully-rendered user message. */
  user_message: string
  /** The repo / worktree the sub-agent operates in. */
  repo_path: string
  /** Owning trident run id (audit + forge-meta persistence). */
  trident_run_id: string
  /** Resolved model id. */
  model: string
  /** Wall-clock budget for this sub-agent. */
  timeout_ms: number
}

export interface TridentDispatchResult {
  /** The sub-agent's terminal output text. */
  result: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
}

export interface TridentDispatch {
  (input: TridentDispatchInput): Promise<TridentDispatchResult>
}

/** Forge metadata captured off a successful forge-init/fix parse. */
export interface ForgeMeta {
  pr: number
  branch: string
  worktree: string
}

export interface TridentSessionManagerOptions {
  dispatch: TridentDispatch
  /** Sub-agent run_id factory (test seam). Defaults to crypto.randomUUID(). */
  mint_run_id?: () => string
  /**
   * What to report for a `subagent_run_id` the manager has no entry for
   * (e.g. after a process restart that lost the in-memory map). Default
   * `'running'` — safe: the non-null id blocks a re-spawn (no double
   * spawn), and an operator can stop a genuinely-orphaned run. Set
   * `'crashed'` to fail orphans loudly instead.
   */
  unknown_session?: 'running' | 'crashed'
}

type SessionState =
  | { status: 'running' }
  | { status: 'completed'; result: { remaining?: number | null; approved?: boolean } }
  | { status: 'crashed'; reason: string }

interface SessionEntry {
  state: SessionState
  phase?: TridentPhase
  trident_run_id: string
}

const FORGE_KINDS: ReadonlySet<TridentPhase> = new Set<TridentPhase>([
  'forge-init',
  'forge-fix',
  'ralph-plan',
  'ralph-task',
])

export class TridentSessionManager {
  private readonly dispatch: TridentDispatch
  private readonly mint: () => string
  private readonly unknownSession: 'running' | 'crashed'

  private readonly sessions = new Map<string, SessionEntry>()
  /** Last Argus findings, keyed by the OWNING trident run id (survives the
   *  session-id clear so a later forge-fix spawn can thread them). */
  private readonly lastFindings = new Map<string, string[]>()
  /**
   * Forge-emitted PR/branch/worktree, keyed by the OWNING trident run id.
   * Captured in-memory (NOT written to the row from the background
   * dispatch — that races the tick's own `save`). The single-writer tick
   * step reads this via `forgeMetaFor` and folds it into the run it
   * persists on the forge transition.
   */
  private readonly forgeMeta = new Map<string, ForgeMeta>()
  /**
   * The single next task a Ralph planning pass surfaced (`NEXT_TASK=`),
   * keyed by the OWNING trident run id. Threaded into the following
   * ralph-task spawn so the fresh Forge knows exactly which one task to
   * build (the plan↔task handoff). Survives the session-id clear, mirroring
   * `lastFindings` for the argus→forge-fix handoff.
   */
  private readonly nextTask = new Map<string, string | null>()
  /** Background dispatch promises — exposed via `drain()` for tests. */
  private readonly inflight = new Set<Promise<void>>()

  constructor(opts: TridentSessionManagerOptions) {
    this.dispatch = opts.dispatch
    this.mint = opts.mint_run_id ?? (() => crypto.randomUUID())
    this.unknownSession = opts.unknown_session ?? 'running'
  }

  /**
   * Launch a sub-agent in the background. Returns its `subagent_run_id`
   * immediately; the `running` entry is recorded BEFORE return so a
   * follow-up `classify` is never a phantom poll.
   */
  spawn(input: TridentDispatchInput): string {
    const run_id = this.mint()
    if (typeof run_id !== 'string' || run_id.length === 0) {
      throw new Error('TridentSessionManager: mint_run_id produced an empty id')
    }
    const entry: SessionEntry = {
      state: { status: 'running' },
      trident_run_id: input.trident_run_id,
    }
    if (input.phase !== undefined) entry.phase = input.phase
    this.sessions.set(run_id, entry)
    const p = this.runDispatch(run_id, input)
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
    return run_id
  }

  private async runDispatch(run_id: string, input: TridentDispatchInput): Promise<void> {
    let res: TridentDispatchResult
    try {
      res = await this.dispatch(input)
    } catch (err) {
      this.setState(run_id, {
        status: 'crashed',
        reason: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (res.status !== 'completed') {
      this.setState(run_id, {
        status: 'crashed',
        reason: `sub-agent ${res.status}`,
      })
      return
    }
    await this.recordCompletion(run_id, input, res.result)
  }

  private async recordCompletion(
    run_id: string,
    input: TridentDispatchInput,
    raw: string,
  ): Promise<void> {
    if (input.kind === 'argus') {
      const verdict = parseArgusVerdict(raw)
      if (verdict === 'REQUEST_CHANGES') {
        this.lastFindings.set(input.trident_run_id, parseArgusFindings(raw))
      } else {
        this.lastFindings.delete(input.trident_run_id)
      }
      this.setState(run_id, { status: 'completed', result: { approved: verdict === 'APPROVE' } })
      return
    }

    // Ralph PLANNING pass — a docs-only turn with NO PR contract lines.
    // Parse its REMAINING_TASKS / NEXT_TASK and thread the next task to the
    // following ralph-task spawn. A missing/garbled count → remaining:null,
    // which the state machine fails LOUDLY on (never review a partial
    // governed build).
    if (input.phase === 'ralph-plan') {
      const plan = parseRalphPlan(raw)
      this.nextTask.set(input.trident_run_id, plan.next_task)
      this.setState(run_id, { status: 'completed', result: { remaining: plan.remaining } })
      return
    }

    // Forge-family turn (forge-init / forge-fix / ralph-task).
    const parsed = parseForgeOutput(raw)
    if (parsed === null) {
      if (input.phase === 'forge-init') {
        // A forge-init that never emitted the PR/BRANCH/WORKTREE contract
        // is a real failure — surface it, never treat as silent success.
        this.setState(run_id, {
          status: 'crashed',
          reason: 'Forge emitted no PR_NUMBER/BRANCH/WORKTREE contract lines',
        })
        return
      }
      // forge-fix / ralph-task: transition ignores the result; the branch
      // already exists. Treat as a clean completion.
      this.setState(run_id, { status: 'completed', result: {} })
      return
    }

    this.forgeMeta.set(input.trident_run_id, {
      pr: parsed.pr_number,
      branch: parsed.branch,
      worktree: parsed.worktree,
    })
    this.setState(run_id, { status: 'completed', result: { remaining: parsed.remaining } })
  }

  private setState(run_id: string, state: SessionState): void {
    const entry = this.sessions.get(run_id)
    if (entry === undefined) return
    entry.state = state
  }

  /**
   * Whether this manager currently tracks an in-memory session for the
   * given `subagent_run_id`. Returns `false` after a control-plane
   * restart (the in-memory `sessions` map starts empty) even though the
   * id is still persisted on the run row. The orchestrator uses this to
   * detect an ORPHANED in-flight run — a session that was launched in a
   * prior process and lost when this one booted, or one that never became
   * ready — and recover it (re-dispatch / fail / wait per policy) instead
   * of polling a phantom forever. This is the Open-substrate analog of
   * Vajra's "is the tmux window / PID still alive?" reap check.
   */
  isTracked(subagent_run_id: string): boolean {
    return this.sessions.has(subagent_run_id)
  }

  /** Poll the in-flight sub-agent for `run` by its persisted id. */
  async classify(run: TridentRun): Promise<SubagentOutcome> {
    const id = run.subagent_run_id
    if (id === null) {
      // No agent in flight — the orchestrator's spawn step handles this
      // BEFORE classify runs, so reaching here means "still pending".
      return { status: 'running' }
    }
    const entry = this.sessions.get(id)
    if (entry === undefined) {
      if (this.unknownSession === 'crashed') {
        return { status: 'crashed', reason: `session ${id} not tracked (lost after restart?)` }
      }
      return { status: 'running' }
    }
    const s = entry.state
    if (s.status === 'running') return { status: 'running' }
    if (s.status === 'crashed') return { status: 'crashed', reason: s.reason }
    return { status: 'completed', result: s.result }
  }

  /** The findings from the most recent REQUEST_CHANGES on this run. */
  findingsFor(trident_run_id: string): string[] {
    return this.lastFindings.get(trident_run_id) ?? []
  }

  /** The single next task the most recent Ralph planning pass surfaced
   *  (`NEXT_TASK=`), or null if none / not yet planned. The orchestrator
   *  threads this into the ralph-task spawn's prompt. */
  nextTaskFor(trident_run_id: string): string | null {
    return this.nextTask.get(trident_run_id) ?? null
  }

  /** The PR/branch/worktree the most recent Forge turn emitted for this
   *  run, or null if no Forge turn has completed yet. The tick step folds
   *  this into the run row on the forge transition (single writer). */
  forgeMetaFor(trident_run_id: string): ForgeMeta | null {
    return this.forgeMeta.get(trident_run_id) ?? null
  }

  /** Resolve once every in-flight background dispatch has settled (tests). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight])
    }
  }

  /** Count of sessions currently tracked as running (tests/diagnostics). */
  runningCount(): number {
    let n = 0
    for (const e of this.sessions.values()) {
      if (e.state.status === 'running') n++
    }
    return n
  }
}
