/**
 * @neutronai/trident — instance-scoped run store.
 *
 * CRUD over the per-project `code_trident_runs` table (migration 0077).
 * One row == one autonomous Forge→Argus→merge pipeline. This is the
 * SQLite translation of Vajra's `/trident` skill state file: where Vajra
 * kept one JSON file per run on disk, Neutron persists each run as a row
 * here and the in-process tick loop (`tick.ts`) advances every
 * non-terminal row via `advanceTridentRun` (`state-machine.ts`).
 *
 * Shape mirrors `reminders/store.ts`: a thin typed wrapper over
 * `ProjectDb`, async writes (busy-retry under the hood), sync reads.
 *
 * PR-2 scope: the store + the state-machine skeleton. The Forge/Argus
 * spawning (PR-3) and the Ralph plan↔task loop (PR-4) read + write these
 * rows; this PR lands the persistence so neither needs a schema change.
 */

import type { Topic } from '@neutronai/channels/types.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

/**
 * The state-machine cursor. The first five are live (in-flight) phases;
 * the last three are terminal (see `state-machine.ts` TERMINAL_PHASES).
 * Verbatim from Vajra's `/trident` SKILL.md phase enum, plus `stopped`
 * for the `/trident stop` terminal.
 */
export type TridentPhase =
  | 'forge-init'
  | 'ralph-plan'
  | 'ralph-task'
  | 'argus'
  | 'forge-fix'
  | 'done'
  | 'failed'
  | 'stopped'

/**
 * Git integration mode, auto-detected per run by `detectMergeMode`
 * (`git-mode.ts`). `'pr'` when the repo has a GitHub origin AND `gh` is
 * available; `'local'` otherwise (the default — branch-merge without a
 * remote PR). Ryan-locked: build both, auto-detect, no user config.
 */
export type MergeMode = 'local' | 'pr'

/**
 * Status of the currently in-flight sub-agent, persisted on the run row
 * (NOT in the disconnected generic `runtime/subagent/` registry) so a
 * gateway restart can resume the loop from the last-known sub-agent
 * state. `null` between phases (no sub-agent in flight).
 */
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'crashed'

export interface TridentRun {
  id: string
  slug: string
  project_slug: string
  phase: TridentPhase
  round: number
  max_rounds: number
  /** Ralph build-mode flag (PR-4). Stored as 0/1; surfaced as boolean. */
  ralph: boolean
  ralph_round: number
  max_ralph_rounds: number
  branch: string | null
  pr: number | null
  merge_mode: MergeMode
  subagent_run_id: string | null
  subagent_status: SubagentStatus | null
  repo_path: string
  worktree: string | null
  task: string
  chat_id: string | null
  thread_id: string | null
  /**
   * Originating channel of the run's `chat_id`/`thread_id` (#317). The
   * terminal-delivery hook derives the result-post topic's `channel_kind` from
   * THIS field, so a `/code` build dispatched from the app-WebSocket surface
   * delivers back to that surface instead of misrouting to Telegram. Defaults
   * to `'telegram'` (migration 0081) for legacy rows + Telegram-origin builds.
   */
  channel_kind: Topic['channel_kind']
  failure_reason: string | null
  /**
   * Trident v2 (migration 0089) — the CC workflow run id of the last
   * inner-loop dispatch. Observability only (correlate the row with its
   * workflow transcript); null until the inner loop has launched.
   */
  workflow_run_id: string | null
  /**
   * Trident v2 (migration 0089) — C1 per-phase checkpoint written by the
   * inner workflow's own Bash steps (`forge-done`, `argus-approved` /
   * `argus-request-changes`, `fix-round-N`). A relaunched (crash-resumed)
   * workflow reads this as `resumeCheckpoint` to skip finished phases +
   * reuse the existing PR rather than rebuild from zero. Null pre-launch.
   */
  inner_checkpoint: string | null
  /**
   * Trident v2 (migration 0089) — the inner loop's final synthesised Argus
   * verdict (`APPROVE` → merge; `REQUEST_CHANGES` → failed after maxRounds).
   * Null while in flight.
   */
  inner_verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  /**
   * Work Board Phase 2a (migration 0091) — the inner workflow's TYPED terminal
   * result (`{ok, prNumber, branch, verdict, round, checkpoint}` as compact
   * JSON), written EXACTLY ONCE by the workflow's own Bash step on its terminal
   * path. The EXEC-MODEL rearchitecture fires the `Workflow` tool + settles the
   * launching turn immediately (no `claude -p` draining stdout), so there is no
   * process capturing a `TRIDENT_RESULT=` line; the OUTER loop HARVESTS this
   * column by `runId` instead — non-null is the harvest-ready signal. Null while
   * in flight (or pre-launch). See `parseInnerResult` (`inner-loop.ts`).
   */
  inner_result: string | null
  /** ISO-8601 UTC. */
  started_at: string
  /** ISO-8601 UTC; re-stamped on every state-machine transition. */
  last_advanced_at: string
}

export interface CreateTridentRunInput {
  /** Optional caller-supplied id; UUID generated if absent. */
  id?: string
  slug: string
  project_slug: string
  repo_path: string
  task: string
  /** Defaults to 'forge-init'. */
  phase?: TridentPhase
  /** Defaults to 8 (the skill's default round cap). */
  max_rounds?: number
  /** Defaults to false. */
  ralph?: boolean
  /** Defaults to 20. */
  max_ralph_rounds?: number
  /** Defaults to 'local'; set by `detectMergeMode` at creation. */
  merge_mode?: MergeMode
  branch?: string | null
  worktree?: string | null
  chat_id?: string | null
  thread_id?: string | null
  /** Originating channel of `chat_id`/`thread_id` (#317). Defaults 'telegram'. */
  channel_kind?: Topic['channel_kind']
}

/**
 * Partial update applied by the state machine + spawn layer. Every field
 * is optional; only the provided columns are written. `last_advanced_at`
 * is always re-stamped by `save`/`update` so callers never pass it.
 */
export interface TridentRunUpdate {
  phase?: TridentPhase
  round?: number
  ralph_round?: number
  branch?: string | null
  pr?: number | null
  merge_mode?: MergeMode
  subagent_run_id?: string | null
  subagent_status?: SubagentStatus | null
  worktree?: string | null
  failure_reason?: string | null
  workflow_run_id?: string | null
  inner_checkpoint?: string | null
  inner_verdict?: 'APPROVE' | 'REQUEST_CHANGES' | null
  /** Phase 2a (0091) — the inner workflow's typed terminal result (compact JSON). */
  inner_result?: string | null
}

interface TridentRunDbRow {
  id: string
  slug: string
  project_slug: string
  phase: TridentPhase
  round: number
  max_rounds: number
  ralph: number
  ralph_round: number
  max_ralph_rounds: number
  branch: string | null
  pr: number | null
  merge_mode: MergeMode
  subagent_run_id: string | null
  subagent_status: SubagentStatus | null
  repo_path: string
  worktree: string | null
  task: string
  chat_id: string | null
  thread_id: string | null
  channel_kind: Topic['channel_kind']
  failure_reason: string | null
  workflow_run_id: string | null
  inner_checkpoint: string | null
  inner_verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  inner_result: string | null
  started_at: string
  last_advanced_at: string
}

const COLS =
  'id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round, ' +
  'max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status, ' +
  'repo_path, worktree, task, chat_id, thread_id, channel_kind, failure_reason, ' +
  'workflow_run_id, inner_checkpoint, inner_verdict, inner_result, ' +
  'started_at, last_advanced_at'

/** Phases the tick driver never loads — see `state-machine.ts`. */
const TERMINAL_PHASE_SQL = "('done', 'failed', 'stopped')"

export class TridentRunStore {
  constructor(
    private readonly db: ProjectDb,
    /** Injectable clock for tests; defaults to wall-clock ISO-8601. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async create(input: CreateTridentRunInput): Promise<TridentRun> {
    const id = input.id ?? crypto.randomUUID()
    const ts = this.now()
    const run: TridentRun = {
      id,
      slug: input.slug,
      project_slug: input.project_slug,
      phase: input.phase ?? 'forge-init',
      round: 1,
      max_rounds: input.max_rounds ?? 8,
      ralph: input.ralph ?? false,
      ralph_round: 0,
      max_ralph_rounds: input.max_ralph_rounds ?? 20,
      branch: input.branch ?? null,
      pr: null,
      merge_mode: input.merge_mode ?? 'local',
      subagent_run_id: null,
      subagent_status: null,
      repo_path: input.repo_path,
      worktree: input.worktree ?? null,
      task: input.task,
      chat_id: input.chat_id ?? null,
      thread_id: input.thread_id ?? null,
      channel_kind: input.channel_kind ?? 'telegram',
      failure_reason: null,
      workflow_run_id: null,
      inner_checkpoint: null,
      inner_verdict: null,
      inner_result: null,
      started_at: ts,
      last_advanced_at: ts,
    }
    await this.db.run(
      `INSERT INTO code_trident_runs (${COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.slug,
        run.project_slug,
        run.phase,
        run.round,
        run.max_rounds,
        run.ralph ? 1 : 0,
        run.ralph_round,
        run.max_ralph_rounds,
        run.branch,
        run.pr,
        run.merge_mode,
        run.subagent_run_id,
        run.subagent_status,
        run.repo_path,
        run.worktree,
        run.task,
        run.chat_id,
        run.thread_id,
        run.channel_kind,
        run.failure_reason,
        run.workflow_run_id,
        run.inner_checkpoint,
        run.inner_verdict,
        run.inner_result,
        run.started_at,
        run.last_advanced_at,
      ],
    )
    return run
  }

  get(id: string): TridentRun | null {
    const row = this.db
      .prepare<TridentRunDbRow, [string]>(
        `SELECT ${COLS} FROM code_trident_runs WHERE id = ?`,
      )
      .get(id)
    return row === null ? null : rowToRun(row)
  }

  getBySlug(project_slug: string, slug: string): TridentRun | null {
    const row = this.db
      .prepare<TridentRunDbRow, [string, string]>(
        `SELECT ${COLS} FROM code_trident_runs WHERE project_slug = ? AND slug = ?`,
      )
      .get(project_slug, slug)
    return row === null ? null : rowToRun(row)
  }

  /**
   * The MOST-RECENTLY-advanced run for a project scope, or null when the scope
   * has never run a build. M1 UX REDESIGN: the rail's durable failure signal — a
   * failed build is auto-detached from its board item on terminal reconcile
   * (`board-reconcile.ts`), so the item alone can't keep surfacing `attention`
   * (Codex review [P2]). The run ROW persists, so "the project's latest run is
   * `failed`" is the durable "this build failed and hasn't been superseded"
   * signal — a fresh live/done run for the same scope replaces it.
   */
  latestByProjectScope(project_slug: string): TridentRun | null {
    const row = this.db
      .prepare<TridentRunDbRow, [string]>(
        `SELECT ${COLS}
           FROM code_trident_runs
          WHERE project_slug = ?
          ORDER BY last_advanced_at DESC
          LIMIT 1`,
      )
      .get(project_slug)
    return row === null ? null : rowToRun(row)
  }

  /**
   * Every run whose phase is NOT terminal, oldest-advanced first. This is
   * the tick driver's load query: it advances each returned run. Capped
   * at `limit` so a single tick stays bounded.
   */
  listNonTerminal(limit: number = 50): TridentRun[] {
    return this.db
      .prepare<TridentRunDbRow, [number]>(
        `SELECT ${COLS}
           FROM code_trident_runs
          WHERE phase NOT IN ${TERMINAL_PHASE_SQL}
          ORDER BY last_advanced_at ASC
          LIMIT ?`,
      )
      .all(limit)
      .map(rowToRun)
  }

  /**
   * Apply a partial update by id, re-stamping `last_advanced_at`. Only the
   * provided fields are written. Returns the reloaded row (or `null` if
   * the id no longer exists).
   */
  async update(id: string, patch: TridentRunUpdate): Promise<TridentRun | null> {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    const push = (col: string, val: string | number | null): void => {
      sets.push(`${col} = ?`)
      params.push(val)
    }
    if (patch.phase !== undefined) push('phase', patch.phase)
    if (patch.round !== undefined) push('round', patch.round)
    if (patch.ralph_round !== undefined) push('ralph_round', patch.ralph_round)
    if (patch.branch !== undefined) push('branch', patch.branch)
    if (patch.pr !== undefined) push('pr', patch.pr)
    if (patch.merge_mode !== undefined) push('merge_mode', patch.merge_mode)
    if (patch.subagent_run_id !== undefined) push('subagent_run_id', patch.subagent_run_id)
    if (patch.subagent_status !== undefined) push('subagent_status', patch.subagent_status)
    if (patch.worktree !== undefined) push('worktree', patch.worktree)
    if (patch.failure_reason !== undefined) push('failure_reason', patch.failure_reason)
    if (patch.workflow_run_id !== undefined) push('workflow_run_id', patch.workflow_run_id)
    if (patch.inner_checkpoint !== undefined) push('inner_checkpoint', patch.inner_checkpoint)
    if (patch.inner_verdict !== undefined) push('inner_verdict', patch.inner_verdict)
    if (patch.inner_result !== undefined) push('inner_result', patch.inner_result)
    // Always advance the cursor timestamp.
    push('last_advanced_at', this.now())
    params.push(id)
    await this.db.run(
      `UPDATE code_trident_runs SET ${sets.join(', ')} WHERE id = ?`,
      params,
    )
    return this.get(id)
  }

  /**
   * ATOMIC terminal transition — the race-safe write the terminal chokepoint
   * (`buildTridentTerminator`, §F6a) needs. Flip a run to `phase` (+ optional
   * `failure_reason`) ONLY when it is currently non-terminal, and report whether
   * THIS caller won the transition.
   *
   * Why conditional: an out-of-band caller (board X-cancel / delete) reads a
   * non-terminal row, then — after an `await` gap — asks to terminate it. In that
   * gap the tick loop can persist a real terminal result (`done` + delivery). An
   * unconditional `update` would clobber that `done` with `stopped` AND re-fire
   * the observer chain, corrupting the final result and double-notifying. The
   * `AND phase NOT IN (terminal)` predicate makes the winner unambiguous: exactly
   * one transition lands (`changes === 1`); a loser (`changes === 0`) leaves the
   * already-terminal row untouched and learns it must NOT run observers.
   *
   * Wrapped in a `transaction` so the conditional UPDATE + its `changes` read are
   * one mutex-held, busy-retry-covered unit on this connection.
   */
  async terminalTransition(
    id: string,
    patch: { phase: TridentPhase; failure_reason?: string | null },
  ): Promise<{ run: TridentRun | null; won: boolean }> {
    const won = await this.db.transaction((tx) => {
      const sets: string[] = ['phase = ?']
      const params: (string | number | null)[] = [patch.phase]
      if (patch.failure_reason !== undefined) {
        sets.push('failure_reason = ?')
        params.push(patch.failure_reason)
      }
      sets.push('last_advanced_at = ?')
      params.push(this.now())
      params.push(id)
      const res = tx.runSync(
        `UPDATE code_trident_runs SET ${sets.join(', ')}
          WHERE id = ? AND phase NOT IN ${TERMINAL_PHASE_SQL}`,
        params,
      )
      return res.changes > 0
    })
    return { run: this.get(id), won }
  }

  /**
   * Persist a full run snapshot (the shape `advanceTridentRun` returns).
   * Re-stamps `last_advanced_at`. Mutable columns only — `id`, `slug`,
   * `project_slug`, `repo_path`, `task`, `started_at`, the caps, and
   * `chat_id`/`thread_id` are write-once at create time.
   *
   * `inner_result` is DELIBERATELY NOT written here (Phase 2a): it is
   * WORKFLOW-OWNED — only the inner workflow's own Bash step writes it (the
   * harvest-ready signal), and the OUTER loop only ever READS it. Excluding it
   * from this full-snapshot save means an orchestrator `save()` (e.g. the launch
   * persist, whose in-memory run still carries a stale null) can never clobber a
   * result the detached workflow wrote out-of-band. Use `update({inner_result})`
   * for the workflow-sim write in tests.
   */
  async save(run: TridentRun): Promise<void> {
    await this.db.run(
      `UPDATE code_trident_runs
          SET phase = ?, round = ?, ralph_round = ?, branch = ?, pr = ?,
              merge_mode = ?, subagent_run_id = ?, subagent_status = ?,
              worktree = ?, failure_reason = ?, workflow_run_id = ?,
              inner_checkpoint = ?, inner_verdict = ?, last_advanced_at = ?
        WHERE id = ?`,
      [
        run.phase,
        run.round,
        run.ralph_round,
        run.branch,
        run.pr,
        run.merge_mode,
        run.subagent_run_id,
        run.subagent_status,
        run.worktree,
        run.failure_reason,
        run.workflow_run_id,
        run.inner_checkpoint,
        run.inner_verdict,
        this.now(),
        run.id,
      ],
    )
  }

  /**
   * CONDITIONAL full-snapshot save — the tick loop's race-safe terminal commit
   * (§F6a). Identical to {@link save} but the write only lands when the row is
   * currently NON-terminal; returns whether THIS caller won.
   *
   * Why the tick needs it: the in-band tick reads a non-terminal run, `await`s a
   * long `step`, and during that gap an out-of-band `terminate()` (board
   * X-cancel/delete) can win the terminal transition + fire its observers. An
   * unconditional `save` here would then overwrite that terminal phase with the
   * step's outcome AND fire the tick's own terminal observers again — a lost
   * update + a double notification. The `AND phase NOT IN (terminal)` predicate
   * makes terminal a SINK state: whoever transitions the row first wins, and no
   * later writer (tick or terminate) moves it back out. A loser (`false`) tells
   * the tick to skip its observer fire entirely.
   */
  async saveIfActive(run: TridentRun): Promise<boolean> {
    return this.db.transaction((tx) => {
      const res = tx.runSync(
        `UPDATE code_trident_runs
            SET phase = ?, round = ?, ralph_round = ?, branch = ?, pr = ?,
                merge_mode = ?, subagent_run_id = ?, subagent_status = ?,
                worktree = ?, failure_reason = ?, workflow_run_id = ?,
                inner_checkpoint = ?, inner_verdict = ?, last_advanced_at = ?
          WHERE id = ? AND phase NOT IN ${TERMINAL_PHASE_SQL}`,
        [
          run.phase,
          run.round,
          run.ralph_round,
          run.branch,
          run.pr,
          run.merge_mode,
          run.subagent_run_id,
          run.subagent_status,
          run.worktree,
          run.failure_reason,
          run.workflow_run_id,
          run.inner_checkpoint,
          run.inner_verdict,
          this.now(),
          run.id,
        ],
      )
      return res.changes > 0
    })
  }

  /** Delete a run by id (the `/trident stop` hard-delete path). */
  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM code_trident_runs WHERE id = ?`, [id])
  }
}

function rowToRun(row: TridentRunDbRow): TridentRun {
  return {
    id: row.id,
    slug: row.slug,
    project_slug: row.project_slug,
    phase: row.phase,
    round: row.round,
    max_rounds: row.max_rounds,
    ralph: row.ralph === 1,
    ralph_round: row.ralph_round,
    max_ralph_rounds: row.max_ralph_rounds,
    branch: row.branch,
    pr: row.pr,
    merge_mode: row.merge_mode,
    subagent_run_id: row.subagent_run_id,
    subagent_status: row.subagent_status,
    repo_path: row.repo_path,
    worktree: row.worktree,
    task: row.task,
    chat_id: row.chat_id,
    thread_id: row.thread_id,
    channel_kind: row.channel_kind,
    failure_reason: row.failure_reason,
    workflow_run_id: row.workflow_run_id,
    inner_checkpoint: row.inner_checkpoint,
    inner_verdict: row.inner_verdict,
    inner_result: row.inner_result,
    started_at: row.started_at,
    last_advanced_at: row.last_advanced_at,
  }
}
