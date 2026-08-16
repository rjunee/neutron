/**
 * @neutronai/trident — instance-scoped run store.
 *
 * CRUD over the per-project `code_trident_runs` table (migration 0077).
 * One row == one autonomous Forge→Argus→merge pipeline. This is the
 * SQLite translation of the legacy harness's `/trident` skill state file: where the legacy harness
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
 * Verbatim from the legacy harness's `/trident` SKILL.md phase enum, plus `stopped`
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

export class TridentRunReferenceAmbiguousError extends Error {
  constructor(reference: string) {
    super(`trident run reference is ambiguous: ${reference}`)
    this.name = 'TridentRunReferenceAmbiguousError'
  }
}

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
   * MID-LOOP RESUME (migration 0122) — the branch head OID the checkpoint above
   * was RECORDED AGAINST, written by the inner workflow in the SAME
   * `trident/checkpoint.sh` UPDATE as the checkpoint name, so the pair is atomic
   * and can never drift apart. A relaunched run compares it with the LIVE branch
   * head: equal → the prior phase's outcome is about exactly this code and the run
   * may skip forward; different, unreadable, or NULL (a row written before this
   * column existed) → re-review. It is the ONLY source a resumed run may take a
   * `reviewedHead` from (#545) — a live probe can name a commit pushed after the
   * review, and pinning the merge to that would certify unreviewed code.
   */
  inner_checkpoint_head: string | null
  /**
   * MID-LOOP RESUME (migration 0122) — the synthesised findings the
   * `argus-request-changes` checkpoint was recorded with, as compact JSON. A
   * resume that skips forward to the fix round fixes THESE; absent/unparseable →
   * the run re-reviews rather than sending Forge in with nothing to act on.
   */
  inner_checkpoint_findings: string | null
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
  /**
   * RC2 (migration 0102) — the durable OUTER-HARVEST marker (ms-epoch). Written
   * EXCLUSIVELY by `orchestrator.applyResult` (the outer loop decoded a typed
   * `inner_result` and made a decision), and NEVER by the inner workflow nor by
   * the out-of-band `terminalTransition`. So `harvested_at !== null` is the
   * force-terminate-proof "the outer loop harvested" signal the RC2 nexus
   * producer keys on (`isTridentHarvestTerminal`) — a cancelled/force-terminated
   * run (which may still carry an inner-written `inner_verdict`) has it null.
   * Null until (and unless) the outer loop harvests.
   */
  harvested_at: number | null
  /**
   * CRASH-RECOVERY BUDGET SPENT (migration 0123) — how many times a launcher
   * crash on this run has been recovered by relaunching the build as a
   * continuation instead of reaping it. Legacy rows (NULL) read as 0.
   *
   * RECOVERY-OWNED, SINGLE WRITER: only {@link TridentRunStore.beginCrashRecovery}
   * ever writes it. It is DELIBERATELY absent from `TridentRunUpdate`, `update()`,
   * `save()` and `saveIfActive()` — same ownership discipline as `inner_result`
   * (workflow-owned) and `harvested_at` (harvest-owned), so no full-snapshot save
   * carrying a stale in-memory copy can ever refund budget that was already spent.
   *
   * DURABLE on purpose: the cause it bounds is a gateway deploy loop (three
   * restarts in 53 min on 2026-08-14), and every gateway boot resets in-memory
   * state — an in-process counter cannot cap the very loop that restarts the
   * process. SEPARATE from `round`/`ralph_round`: a launcher crash is not the
   * agent's failure and must not consume its fix rounds.
   */
  crash_recoveries: number
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
  /** Defaults to 10 — the review-round cap the fix loop bounds on. See `create`. */
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
  /** Workflow-owned (0122); patchable for the workflow-sim writes in tests. */
  inner_checkpoint_head?: string | null
  /** Workflow-owned (0122); patchable for the workflow-sim writes in tests. */
  inner_checkpoint_findings?: string | null
  inner_verdict?: 'APPROVE' | 'REQUEST_CHANGES' | null
  /** Phase 2a (0091) — the inner workflow's typed terminal result (compact JSON). */
  inner_result?: string | null
  /** RC2 (0102) — the outer-harvest marker (ms-epoch); set ONLY by
   *  `applyResult`. See `TridentRun.harvested_at`. */
  harvested_at?: number | null
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
  inner_checkpoint_head: string | null
  inner_checkpoint_findings: string | null
  inner_verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  inner_result: string | null
  started_at: string
  last_advanced_at: string
  harvested_at: number | null
  crash_recoveries: number | null
}

/** Exported solely so tests can pin the column-count invariant. */
export const COLS =
  'id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round, ' +
  'max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status, ' +
  'repo_path, worktree, task, chat_id, thread_id, channel_kind, failure_reason, ' +
  'workflow_run_id, inner_checkpoint, inner_checkpoint_head, ' +
  'inner_checkpoint_findings, inner_verdict, inner_result, ' +
  'started_at, last_advanced_at, harvested_at, crash_recoveries'

// Derived from COLS so placeholder-count = column-count BY CONSTRUCTION. A
// hand-miscounted `?` list silently corrupts every insert and no type error
// catches it — so the list is never typed by hand.
const INSERT_PLACEHOLDERS = COLS.split(', ')
  .map(() => '?')
  .join(', ')

/** Phases the tick driver never loads — see `state-machine.ts`. */
const TERMINAL_PHASE_SQL = "('done', 'failed', 'stopped')"

/**
 * Split a {@link TridentRunStore.changeSignature} into `run id → last_advanced_at`.
 *
 * The watcher only ever needs string equality on the whole signature; this is for
 * the ONE caller that needs to know WHICH run moved — `tick.ts`'s settle, which
 * must tell its own sweep writes apart from an out-of-process checkpoint that
 * landed during the same sweep. The separator is a TAB, which neither an ISO
 * timestamp nor a run id can contain, so the split is unambiguous; a line without
 * one is skipped rather than guessed at.
 */
export function changeSignatureEntries(signature: string): Map<string, string> {
  const entries = new Map<string, string>()
  if (signature === '') return entries
  for (const line of signature.split('\n')) {
    const cut = line.indexOf('\t')
    if (cut < 0) continue
    entries.set(line.slice(cut + 1), line.slice(0, cut))
  }
  return entries
}

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
      // THE EFFECTIVE REVIEW-ROUND CAP. This is the value the fix loop actually
      // bounds on: it is written to the run row, `buildWorkflowArgs` threads it to
      // the inner workflow as `maxRounds`, and `round < maxRounds` gates re-Forge.
      // The `DEFAULT 8` on the column (migrations/0077) is dead for runs created
      // here — this path always supplies the field — and the migration is left
      // alone because an applied migration is not edited. Raising the fallback in
      // `inner-workflow.mjs` alone would have changed NOTHING for a real lane.
      max_rounds: input.max_rounds ?? 10,
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
      inner_checkpoint_head: null,
      inner_checkpoint_findings: null,
      inner_verdict: null,
      inner_result: null,
      started_at: ts,
      last_advanced_at: ts,
      harvested_at: null,
      crash_recoveries: 0,
    }
    await this.db.run(
      `INSERT INTO code_trident_runs (${COLS})
       VALUES (${INSERT_PLACEHOLDERS})`,
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
        run.inner_checkpoint_head,
        run.inner_checkpoint_findings,
        run.inner_verdict,
        run.inner_result,
        run.started_at,
        run.last_advanced_at,
        run.harvested_at,
        run.crash_recoveries,
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

  /** Resolve the user-facing run references emitted by `/code`: full id, id
   * prefix, or slug. Full ids are globally unique in this single-owner DB;
   * shorthand references resolve only when unambiguous across all projects. */
  resolveReference(reference: string): TridentRun | null {
    if (reference.length === 0) return null
    const exact = this.get(reference)
    if (exact !== null) return exact
    const rows = this.db
      .prepare<TridentRunDbRow, [string, string, string]>(
        `SELECT ${COLS} FROM code_trident_runs
          WHERE id LIKE ? ESCAPE '\\' OR slug = ?
          ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END, last_advanced_at DESC
          LIMIT 2`,
      )
      .all(`${reference.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, reference, reference)
      .map(rowToRun)
    if (rows.length === 0) return null
    const first = rows[0]
    if (first === undefined) return null
    if (rows.length > 1) throw new TridentRunReferenceAmbiguousError(reference)
    return first
  }

  /**
   * The MOST-RECENTLY-advanced run for a project scope, or null when the scope
   * has never run a build. M1 UX REDESIGN: the rail's SECONDARY failure net.
   * Since #340 the terminal reconcile (`work-board/store.ts` detachRun) KEEPS
   * `linked_run_id` on failure and sets the item's durable `status='failed'`,
   * so the bound item is the PRIMARY "this build failed" signal. This
   * latest-run check backs it up for the cases the item can't cover — the
   * item was deleted, or a retry re-bound it and only the run row survived.
   * "The project's latest run is `failed`" stays true until a fresh live/done
   * run for the same scope supersedes it (Codex review [P2]).
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
   * A signature of "did anything a tick would care about change?" — the
   * wake-on-change watcher's ONE query, and the thing the sweep's own settle
   * compares against. One `<last_advanced_at>\t<id>` line per NON-TERMINAL run,
   * ordered by id; the empty active set is the empty string. No git, no gh, no
   * joins — a single indexed scan of the live set, safe to run every ~2 s.
   *
   * PER-RUN, NOT AGGREGATE, AND THAT IS THE WHOLE POINT (Argus r2, confirmed by two
   * independent repros). The first shape of this was `COUNT(*)|MAX(last_advanced_at)`,
   * which cannot distinguish "the sweep re-stamped the run it advanced" from "an
   * out-of-process checkpoint landed while the sweep was reading" — MAX moves the
   * same way for both, so the tick could only choose between absorbing its own
   * writes (and swallowing the external checkpoint, which then waited out the 90 s
   * backstop — the exact latency this card removes) and not absorbing them (and
   * re-firing a full 50-run git/gh sweep on every 2 s cadence). Per-run stamps make
   * that a decidable question: {@link changeSignatureEntries} + the sweep's record
   * of what IT wrote (`tick.ts`) tells the two apart exactly, with no window in
   * which a wake is lost.
   *
   * MIXED-PRECISION STAMPS NEED NO NORMALISATION HERE. `store.now()` writes
   * milliseconds (`…T03:15:45.900Z`) and `trident/checkpoint.sh` whole seconds
   * (`…T03:15:45Z`); the old MAX compared them as TEXT, where 'Z' (0x5A) sorts above
   * '.' (0x2E) and a whole-second stamp could mask a LATER millisecond one on
   * another run. Comparison here is per-run EQUALITY, so any re-stamp in any shape
   * — earlier, later, same second — is a difference. Ordering never enters into it.
   *
   * Unbounded on purpose: the row set is the LIVE runs (terminal rows are excluded
   * by the same predicate `listNonTerminal` uses), and a cap would create a blind
   * window in which a checkpoint is invisible to the detector — the failure mode
   * this method exists to prevent. Tens of rows in practice; the sweep it gates
   * does per-run git/gh work on up to 50 of them.
   */
  changeSignature(): string {
    const rows = this.db
      .prepare<{ id: string; at: string }, []>(
        `SELECT id AS id, COALESCE(last_advanced_at, '') AS at
           FROM code_trident_runs
          WHERE phase NOT IN ${TERMINAL_PHASE_SQL}
          ORDER BY id`,
      )
      .all()
    return rows.map((r) => `${r.at}\t${r.id}`).join('\n')
  }

  /** Durably latch one dead launcher generation and crash only its workflows. */
  async crashRunningByLauncher(session_key: string, failure_reason: string): Promise<void> {
    await this.db.transaction((tx) => {
      const now = this.now()
      tx.runSync(
        `INSERT INTO trident_launcher_crashes (session_key, failure_reason, crashed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET failure_reason = excluded.failure_reason`,
        [session_key, failure_reason, now],
      )
      // Generation keys are unique per spawn. Keep the short race window needed
      // by an in-flight launcher completion, while bounding durable tombstones.
      tx.runSync(
        `DELETE FROM trident_launcher_crashes
          WHERE datetime(crashed_at) < datetime(?, '-7 days')`,
        [now],
      )
      tx.runSync(
        `UPDATE code_trident_runs
            SET subagent_status = 'crashed', failure_reason = ?, last_advanced_at = ?
          WHERE workflow_run_id = ?
            AND subagent_status = 'running'
            AND phase NOT IN ${TERMINAL_PHASE_SQL}`,
        [failure_reason, now, session_key],
      )
    })
  }

  /**
   * Atomically CLAIM a crashed run for recovery: clear the crash latch, release the
   * sub-agent slot, null the (tombstoned) launcher generation so `launch()`'s
   * `?? workflow_run_id` fallback can never re-adopt a dead generation, and spend one
   * unit of the durable crash-recovery budget — ONE conditional UPDATE, so a racing
   * terminate / second tick loses cleanly. Returns the reloaded run, or null if the
   * claim lost (row terminal, already recovered, or gone).
   *
   * WHY RAW SQL RATHER THAN `update()`: `update()`'s statusGuard and `saveIfActive`'s
   * crash veto both REFUSE a non-crashed write onto a latched row, and that veto is
   * load-bearing for every other path (it is what stopped the unbounded re-fire) — so
   * it stays. Recovery goes around it DELIBERATELY, in one atomic claim, and is the
   * only writer of `crash_recoveries`.
   */
  async beginCrashRecovery(id: string): Promise<TridentRun | null> {
    const won = await this.db.transaction((tx) => {
      const res = tx.runSync(
        `UPDATE code_trident_runs
            SET subagent_status = NULL,
                subagent_run_id = NULL,
                workflow_run_id = NULL,
                crash_recoveries = COALESCE(crash_recoveries, 0) + 1,
                last_advanced_at = ?
          WHERE id = ? AND subagent_status = 'crashed'
            AND phase NOT IN ${TERMINAL_PHASE_SQL}`,
        [this.now(), id],
      )
      return res.changes > 0
    })
    return won ? this.get(id) : null
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
    if (patch.inner_checkpoint_head !== undefined) push('inner_checkpoint_head', patch.inner_checkpoint_head)
    if (patch.inner_checkpoint_findings !== undefined)
      push('inner_checkpoint_findings', patch.inner_checkpoint_findings)
    if (patch.inner_verdict !== undefined) push('inner_verdict', patch.inner_verdict)
    if (patch.inner_result !== undefined) push('inner_result', patch.inner_result)
    if (patch.harvested_at !== undefined) push('harvested_at', patch.harvested_at)
    // Always advance the cursor timestamp.
    push('last_advanced_at', this.now())
    params.push(id)
    const statusGuard = patch.subagent_status !== undefined && patch.subagent_status !== 'crashed'
      ? ` AND subagent_status IS NOT 'crashed'`
      : ''
    await this.db.run(
      `UPDATE code_trident_runs SET ${sets.join(', ')} WHERE id = ?${statusGuard}`,
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
      // RETRACT A STALE IN-FLIGHT CLAIM. `subagent_status` is documented as the
      // CURRENTLY in-flight subagent (migration 0077), so a terminal row that still
      // says 'running' asserts something false about THIS RUN: the run is over —
      // nothing will advance it again — and the column still presents it as working.
      // Observed live on 2026-08-10: a cancelled run sat at `phase='stopped'` with
      // `subagent_status='running'`.
      //
      // Note what is deliberately NOT claimed: that the child process is dead. It
      // very often is not (see DURABILITY below). The column is wrong about the RUN,
      // not necessarily about the process — which is why the fix is two-part rather
      // than a one-line write here.
      //
      // WHICH READERS THIS PROTECTS — the honest list, because the obvious
      // candidates do NOT apply and it would be easy to write a confident wrong
      // rationale here. #143's harvest/terminal gate (`orchestrator.ts` step (1)/(1a))
      // and orphan recovery are both UNREACHABLE on a terminal row: `step()` returns
      // early on `isTerminalPhase(run.phase)` before either one. The hang watchdog
      // keys on `last_advanced_at`, not on this column. What IS load-bearing is
      // `update()`'s CRASH VETO (`AND subagent_status IS NOT 'crashed'`, above): on a
      // terminal row it is the only thing latching a crash, because `update()` is the
      // only writer REACHABLE on such a row that both lacks a
      // `phase NOT IN (terminal)` predicate and carries the veto. The other two writers
      // are each excluded for their own reason, and it is worth naming which:
      // `saveIfActive()` (below) has the identical veto but ALSO the phase predicate, so
      // it cannot land on a terminal row whatever this column says — its veto is
      // unreachable here. `save()` (below) likewise has no phase predicate AND no veto
      // at all, so it would clobber a 'crashed' latch outright — it is harmless only
      // because it has ZERO production callers (every production commit goes through
      // `saveIfActive`, `trident/tick.ts:263`); if one is ever added it needs the
      // predicate. Beyond `update()`, the readers that matter are every human or tool
      // read of a finished row, which is where the false claim was first spotted.
      //
      // ONLY A LIVE CLAIM IS CLEARED ('running' / 'pending'), and that restriction is
      // load-bearing: nulling unconditionally would erase a 'crashed' marker whenever
      // anything terminated an already-crashed run as 'failed', silently disarming
      // `update()`'s veto while looking like a cleanup.
      // 'completed'/'failed'/'crashed' are OUTCOMES worth keeping; 'running' and
      // 'pending' are the only values that ASSERT a child is in flight, so they are
      // the only ones a terminal transition has any business touching.
      //
      // NULL rather than a new 'cancelled' enum value: the column carries a CHECK
      // constraint (migration 0077:107-108) that SQLite cannot alter without a table
      // rebuild, and `null` already means "nothing in flight" here
      // (`trident/orchestrator.ts` writes it on the no-subagent paths). No
      // information is lost — the reason for the stop lives in `failure_reason`, and
      // `subagent_run_id` is deliberately NOT cleared, so "was a child in flight when
      // this run was cancelled?" stays answerable structurally. That matters because
      // `/code stop` and board-cancel supply no reason at all.
      //
      // DURABILITY: this write alone is not enough. Cancelling does not kill the
      // detached workflow (rjunee/neutron#177 — it keeps running to completion),
      // whose next checkpoint would put 'running' straight back — so
      // `trident/checkpoint.sh` freezes the same two liveness columns on a terminal
      // row, and the two halves must stay in sync. It freezes ONLY those two: the
      // orphan's branch/pr/result still land there, because while #177 stands they
      // are the only trail back to a PR it opened after the cancel.
      sets.push(
        `subagent_status = CASE WHEN subagent_status IN ('running', 'pending') THEN NULL ELSE subagent_status END`,
      )
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
   *
   * `inner_checkpoint_head`/`inner_checkpoint_findings` (0122) are excluded for the
   * same reason AND a sharper one: they are only meaningful PAIRED with the
   * `inner_checkpoint` they were written beside. The workflow writes all three in
   * ONE atomic UPDATE; an outer-loop snapshot that carried a checkpoint name
   * forward without them could pair a fresh name with a stale OID, and that pair is
   * exactly what a resumed run reads to decide whether prior review work — up to
   * and including an APPROVE — may be trusted.
   */
  async save(run: TridentRun): Promise<void> {
    await this.db.run(
      `UPDATE code_trident_runs
          SET phase = ?, round = ?, ralph_round = ?, branch = ?, pr = ?,
              merge_mode = ?, subagent_run_id = ?, subagent_status = ?,
              worktree = ?, failure_reason = ?, workflow_run_id = ?,
              inner_checkpoint = ?, inner_verdict = ?, harvested_at = ?,
              last_advanced_at = ?
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
        run.harvested_at,
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
                inner_checkpoint = ?, inner_verdict = ?, harvested_at = ?,
                last_advanced_at = ?
          WHERE id = ? AND phase NOT IN ${TERMINAL_PHASE_SQL}
            AND (subagent_status IS NOT 'crashed' OR ? = 'crashed')
            AND (
              ? IS NOT 'running'
              OR ? IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM trident_launcher_crashes
                 WHERE session_key = ?
              )
            )`,
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
          run.harvested_at,
          this.now(),
          run.id,
          run.subagent_status,
          run.subagent_status,
          run.workflow_run_id,
          run.workflow_run_id,
        ],
      )
      if (res.changes === 0 && run.subagent_status === 'running' && run.workflow_run_id !== null) {
        const crash = tx.get<{ failure_reason: string }>(
          `SELECT failure_reason FROM trident_launcher_crashes WHERE session_key = ?`,
          [run.workflow_run_id],
        )
        if (crash !== null) {
          tx.runSync(
            `UPDATE code_trident_runs
                SET subagent_status = 'crashed', failure_reason = ?, last_advanced_at = ?
              WHERE id = ? AND phase NOT IN ${TERMINAL_PHASE_SQL}`,
            [crash.failure_reason, this.now(), run.id],
          )
        }
      }
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
    inner_checkpoint_head: row.inner_checkpoint_head,
    inner_checkpoint_findings: row.inner_checkpoint_findings,
    inner_verdict: row.inner_verdict,
    inner_result: row.inner_result,
    started_at: row.started_at,
    last_advanced_at: row.last_advanced_at,
    harvested_at: row.harvested_at,
    // Legacy rows predate migration 0123 and read NULL — no budget spent yet.
    crash_recoveries: row.crash_recoveries ?? 0,
  }
}
