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
import { parseCheckpointFindings } from './checkpoint-findings.ts'
import { phaseForCheckpoint } from './checkpoint-phase.ts'
import { checkpointRound } from './checkpoint-round.ts'

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

export type TridentVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'REVIEW_NOT_RUN'

export class TridentRunReferenceAmbiguousError extends Error {
  constructor(reference: string) {
    super(`trident run reference is ambiguous: ${reference}`)
    this.name = 'TridentRunReferenceAmbiguousError'
  }
}

export class TridentEmptyFindingsRejectionError extends Error {
  constructor(id: string, source: 'update' | 'save' | 'saveIfActive') {
    super(`refusing to record inner_verdict='REQUEST_CHANGES' with no findings for trident run ${id} (via ${source}): an empty finding set is either an approval or an infrastructure failure, never a rejection — record REVIEW_NOT_RUN instead`)
    this.name = 'TridentEmptyFindingsRejectionError'
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
  /** The origin/<base> commit the build branch was cut from, read in code at launch; null for legacy rows/local-mode failures. */
  base_sha: string | null
  /** How many commits local <base> was behind origin/<base> at cut time; observability only. */
  base_behind: number | null
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
   * Host-recorded brief-integrity refusal; null until the build wrapper detects
   * one. Intentionally sticky for this run: a bridge retry can recover and let
   * the run continue, but the card must still reveal that refusal. A manual
   * retry creates a new run row with a fresh null.
   */
  brief_alert: string | null
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
   * Trident v2 (migration 0089) — the terminal verdict recorded by the outer
   * orchestrator. `REVIEW_NOT_RUN` means the run reached terminal without a
   * reviewer producing a verdict (crash, infrastructure stop, provenance reject,
   * or lost round); it is never a judgement about the code. Null while in flight.
   */
  inner_verdict: TridentVerdict | null
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
  /** Repo-relative paths this run has CLAIMED, so two dispatches cannot edit the
   *  same file concurrently. Stored as JSON; an explicitly-empty set is `'[]'`. */
  claimed_paths: string[]
  /**
   * INFRASTRUCTURE AUTO-RETRY BUDGET SPENT (migration 0126) — how many
   * harvested executor/transport failures have been atomically claimed for a
   * continuation retry. Legacy rows (NULL) read as 0.
   *
   * RETRY-OWNED, SINGLE WRITER: only {@link TridentRunStore.beginInfraRetry}
   * writes it. It is deliberately absent from `TridentRunUpdate`, `update()`,
   * `save()` and `saveIfActive()`, so a stale full-row snapshot cannot refund a
   * budget unit. Durable across restarts, and separate from agent fix rounds and
   * from launcher `crash_recoveries`.
   */
  infra_retries: number
  /** FIX-ROUND CONTRACT (migration 0124), pinned at dispatch, enforced by publishBuiltCommit; null = unconstrained (every pre-existing row). Dispatch-owned and deliberately absent from update/save. */
  reviewed_head: string | null
  /** FIX-ROUND CONTRACT (migration 0124), pinned at dispatch, enforced by publishBuiltCommit; null = unconstrained (every pre-existing row). Dispatch-owned and deliberately absent from update/save. */
  bound_pr: number | null
  /** FIX-ROUND CONTRACT (migration 0124), pinned at dispatch, enforced by publishBuiltCommit; null = unconstrained (every pre-existing row). Dispatch-owned and deliberately absent from update/save. */
  fenced_paths: string | null
  /** WAVE FAN-OUT (migration 0137): the run id this row is a wave MEMBER of; null for every ordinary run. CREATE-ONCE, dispatch-owned: deliberately absent from TridentRunUpdate/update()/save()/saveIfActive(), so no snapshot can ever re-parent a row. */
  parent_run_id: string | null
  /** WAVE FAN-OUT (migration 0137): the plan-graph task id (e.g. 'T3') this member builds; non-null iff parent_run_id is non-null; the pair is covered by the partial UNIQUE index so wave spawn is idempotent. */
  wave_task_id: string | null
}

export interface TridentStageEvent {
  id: number
  run_id: string
  stage: string
  at: string
  meta: string | null
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
  reviewed_head?: string | null
  bound_pr?: number | null
  fenced_paths?: string | null
  /** Paths this run claims. Omitted → the EMPTY set, never undefined: a run with no
   *  declared claim must hold nothing rather than hold everything. */
  claimed_paths?: string[]
  /** Both-or-neither; `create` refuses a half-declared pair. */
  parent_run_id?: string | null
  wave_task_id?: string | null
  /**
   * SALVAGE-RESUME SEED — a PRIOR terminal run's built-but-never-reviewed
   * evidence, carried onto this fresh row so `launch()` takes the resume path and
   * routes the existing commit to REVIEW instead of rebuilding it. Written only by
   * the dispatch chokepoint, and only after it has verified the live branch tip
   * still resolves to exactly this head. Omitted → null, which is the byte-
   * identical fresh-dispatch shape every other caller keeps.
   */
  inner_checkpoint?: string | null
  /** Salvage-resume seed — see `inner_checkpoint`. The recorded commit the seeded
   *  checkpoint was stamped against; the resume comparison is meaningless without it. */
  inner_checkpoint_head?: string | null
  /** Salvage-resume seed — see `inner_checkpoint`. Carried verbatim, because the
   *  workflow reads these back on resume exactly as the prior round recorded them. */
  inner_checkpoint_findings?: string | null
  /**
   * Salvage-resume seed — see `inner_checkpoint`. The origin/<base> tip the SEEDED
   * head was cut from, carried from the prior run.
   *
   * Required, not optional, for a seeded row: `launch()` pins a base only on a
   * FRESH build (`inner_checkpoint === null && base_sha === null`), so a seeded row
   * would be born with a null pin forever — and the publish-time refusal "branch
   * does not contain the origin/<base> tip pinned at launch" is gated on
   * `base_sha !== null`, so it could never fire for a salvaged run or any re-seed
   * chained off one. Seeding the prior run's pin keeps that gate live.
   */
  base_sha?: string | null
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
  base_sha?: string | null
  base_behind?: number | null
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
  inner_verdict?: TridentVerdict | null
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
  base_sha: string | null
  base_behind: number | null
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
  brief_alert: string | null
  workflow_run_id: string | null
  inner_checkpoint: string | null
  inner_checkpoint_head: string | null
  inner_checkpoint_findings: string | null
  inner_verdict: TridentVerdict | null
  inner_result: string | null
  started_at: string
  last_advanced_at: string
  harvested_at: number | null
  crash_recoveries: number | null
  claimed_paths: string | null
  infra_retries: number | null
  reviewed_head: string | null
  bound_pr: number | null
  fenced_paths: string | null
  parent_run_id: string | null
  wave_task_id: string | null
}

/** Exported solely so tests can pin the column-count invariant. */
export const COLS =
  'id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round, ' +
  'max_ralph_rounds, branch, pr, merge_mode, subagent_run_id, subagent_status, ' +
  'repo_path, worktree, task, chat_id, thread_id, channel_kind, failure_reason, brief_alert, ' +
  'workflow_run_id, inner_checkpoint, inner_checkpoint_head, ' +
  'inner_checkpoint_findings, inner_verdict, inner_result, ' +
  'started_at, last_advanced_at, harvested_at, crash_recoveries, infra_retries, ' +
  'reviewed_head, bound_pr, fenced_paths, base_sha, base_behind, parent_run_id, wave_task_id, ' +
  'claimed_paths'

// `base_behind` deliberately backfills through its database NULL default; all
// inserted columns still derive their placeholders here. A hand-miscounted `?`
// list silently corrupts every insert and no type error catches it — so the list
// is never typed by hand.
//
// `base_sha` USED to backfill the same way and no longer can: the salvage-resume
// seed has to write it AT CREATE, because a seeded row is not a fresh launch and
// `launch()` therefore never re-pins it (see `CreateTridentRunInput.base_sha`).
// It stays NULL for every other caller, which is the shape they already had.
const INSERT_COLS = COLS.split(', ').filter((col) => col !== 'base_behind')
const INSERT_PLACEHOLDERS = INSERT_COLS
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
    const parentRunId = input.parent_run_id ?? null
    const waveTaskId = input.wave_task_id ?? null
    const pairProblems = [
      parentRunId === null ? 'parent_run_id is missing' : parentRunId === '' ? 'parent_run_id is empty' : null,
      waveTaskId === null ? 'wave_task_id is missing' : waveTaskId === '' ? 'wave_task_id is empty' : null,
    ].filter((problem): problem is string => problem !== null)
    if ((parentRunId === null) !== (waveTaskId === null) || parentRunId === '' || waveTaskId === '') {
      throw new Error(
        `wave child rows need BOTH parent_run_id and wave_task_id (${pairProblems.join(', ')})`,
      )
    }
    const id = input.id ?? crypto.randomUUID()
    const ts = this.now()
    const run: TridentRun = {
      id,
      // Omitted → the EMPTY set. A run with no declared claim must hold NOTHING; the
      // alternative (undefined) would read downstream as "no restriction" and let two
      // dispatches edit the same file, which is the whole thing holds exist to prevent.
      claimed_paths: input.claimed_paths ?? [],
      slug: input.slug,
      project_slug: input.project_slug,
      // A SALVAGE-SEEDED row is born at `forge-init` LIKE ANY OTHER, and
      // `phaseForCheckpoint` is deliberately NOT applied to `input.inner_checkpoint`
      // here (Argus r3 nit). That mapping exists for the INNER workflow's own
      // checkpoints — the phase a run has REACHED — while this row has reached
      // nothing: it has not fired, and `launch()` is what advances a `forge-init`
      // row. Deriving `argus` from a seeded `fix-round-N` would create a row the
      // launcher's own phase handling has to be taught about, to describe a phase
      // that has not happened yet. The seeded checkpoint is the resume evidence;
      // the phase is where this row IS.
      phase: input.phase ?? 'forge-init',
      // The ROUND, by contrast, IS taken from the seeded checkpoint: the row is
      // resuming that round's work, not starting over. A fresh run seeds no
      // checkpoint and stays at 1.
      round: Math.max(1, checkpointRound(input.inner_checkpoint ?? null) ?? 1),
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
      // SALVAGE-RESUME SEED (see `CreateTridentRunInput`): normally null, and
      // non-null only when the dispatch chokepoint has proven a prior terminal run
      // of this card built work that was never reviewed and the branch tip still
      // holds exactly that commit — in which case the prior run's base pin
      // describes this row's head too, and is what keeps the publish-time
      // cut-from-origin refusal armed on a row `launch()` will not re-pin.
      base_sha: input.base_sha ?? null,
      base_behind: null,
      // NEVER seeded: `launch()` resolves the PR with
      // `run.pr ?? await detectExistingPr(run)`, and a carried-over number would
      // short-circuit that probe onto a PR that may since have been closed.
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
      brief_alert: null,
      workflow_run_id: null,
      inner_checkpoint: input.inner_checkpoint ?? null,
      inner_checkpoint_head: input.inner_checkpoint_head ?? null,
      inner_checkpoint_findings: input.inner_checkpoint_findings ?? null,
      // NEVER seeded: a verdict belongs to a review THIS run has not had yet.
      inner_verdict: null,
      inner_result: null,
      started_at: ts,
      last_advanced_at: ts,
      harvested_at: null,
      crash_recoveries: 0,
      infra_retries: 0,
      reviewed_head: input.reviewed_head ?? null,
      bound_pr: input.bound_pr ?? null,
      fenced_paths: input.fenced_paths ?? null,
      parent_run_id: parentRunId,
      wave_task_id: waveTaskId,
    }
    await this.db.run(
      `INSERT INTO code_trident_runs (${INSERT_COLS.join(', ')})
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
        run.brief_alert,
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
        run.infra_retries,
        run.reviewed_head,
        run.bound_pr,
        run.fenced_paths,
        // COLS order: base_sha sits here, between fenced_paths and parent_run_id
        // (base_behind, the only filtered column, is skipped).
        run.base_sha,
        run.parent_run_id,
        run.wave_task_id,
        // Stored as JSON, matching COLS order. The placeholder count is DERIVED from
        // COLS, so a column added there without a value here fails every insert with
        // "expected N values, received N-1" — which is how this was caught.
        JSON.stringify(run.claimed_paths ?? []),
      ],
    )
    return run
  }

  /**
   * Atomically admit a run only when none of its paths is owned by a live run
   * in the same repository. The read and the INSERT share one transaction,
   * closing the check-then-create race between concurrent dispatches.
   *
   * An EMPTY claim set skips the scan entirely and always admits: the gate
   * cannot hold on paths it never measured.
   */
  async createIfClaimsAvailable(
    input: CreateTridentRunInput,
  ): Promise<{ ok: true; run: TridentRun } | { ok: false; holding_run: TridentRun; path: string }> {
    return this.db.transaction(async () => {
      const wanted = new Set(input.claimed_paths ?? [])
      if (wanted.size > 0) {
        for (const live of this.listNonTerminalByRepo(input.repo_path)) {
          const path = live.claimed_paths.find((candidate) => wanted.has(candidate))
          if (path !== undefined) return { ok: false as const, holding_run: live, path }
        }
      }
      return { ok: true as const, run: await this.create(input) }
    })
  }

  get(id: string): TridentRun | null {
    const row = this.db
      .prepare<TridentRunDbRow, [string]>(
        `SELECT ${COLS} FROM code_trident_runs WHERE id = ?`,
      )
      .get(id)
    return row === null ? null : rowToRun(row)
  }

  async recordStageEvent(
    run_id: string,
    stage: string,
    meta?: string | null,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO code_trident_stage_events (run_id, stage, at, meta)
       VALUES (?, ?, ?, ?)`,
      [run_id, stage, this.now(), meta ?? null],
    )
  }

  /**
   * The timestamp of the MOST RECENT stage event for a run, or null when it has
   * none. ONE row, deliberately — this is read on the hang watchdog's hot path
   * (`buildTridentOrchestrator`'s `latest_stage_event_at`), where pulling a run's
   * whole history every tick would make a cheap check expensive.
   *
   * WHY IT EXISTS. `last_advanced_at` only moves at CHECKPOINT boundaries, and
   * checkpoints land BETWEEN phases; during a long Forge step the field is stale by
   * construction, so a reaper keyed on it asks "has a phase ended recently", not "is
   * anything alive". Stage events are written MID-PHASE (`wrapper-start`,
   * `codex-exec-start`, …), which makes them the positive liveness evidence that
   * field is not.
   */
  latestStageEventAt(run_id: string): string | null {
    const row = this.db
      .prepare<{ at: string }, [string]>(
        `SELECT at
           FROM code_trident_stage_events
          WHERE run_id = ?
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get(run_id)
    return row === null ? null : row.at
  }

  stageEvents(run_id: string): TridentStageEvent[] {
    return this.db
      .prepare<TridentStageEvent, [string]>(
        `SELECT id, run_id, stage, at, meta
           FROM code_trident_stage_events
          WHERE run_id = ?
          ORDER BY id`,
      )
      .all(run_id)
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
   * The MOST RECENT FINISHED run of this card, or null if the card has only ever
   * had live rows. Read-only, and the one input the dispatch chokepoint needs to
   * decide whether a re-dispatch is resuming built work or starting fresh:
   * `getBySlug` is uniqueness-scoped to LIVE rows, so it cannot answer "what
   * happened last time".
   *
   * `started_at, id` DESC because two rows can share a timestamp on a fast clock
   * (and do, in tests) — the id tiebreak makes "latest" total rather than
   * whichever row SQLite happened to visit first.
   *
   * LATEST-STARTED, not latest-FINISHED, and that bound is deliberate: a long run
   * started before a short one can finish after it, and this returns the short
   * one. Ordering on a finish timestamp would need one that every terminal path
   * writes, which no column guarantees. The consequence is bounded to a stale
   * PICK, never a wrong action — the caller re-reads the live branch tip and a
   * head that does not match the picked row seeds nothing at all.
   */
  latestTerminalBySlug(project_slug: string, slug: string): TridentRun | null {
    const row = this.db
      .prepare<TridentRunDbRow, [string, string]>(
        `SELECT ${COLS} FROM code_trident_runs
          WHERE project_slug = ? AND slug = ? AND phase IN ${TERMINAL_PHASE_SQL}
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
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
            -- Wave members are internal machinery: the parent is project-facing,
            -- and a member's later stamp or failure must not shadow it on the board rail.
            AND parent_run_id IS NULL
          ORDER BY last_advanced_at DESC
          LIMIT 1`,
      )
      .get(project_slug)
    return row === null ? null : rowToRun(row)
  }

  /** Every wave member spawned by this parent, in spawn order; empty for a run with no wave. */
  listChildren(parentId: string): TridentRun[] {
    return this.db
      .prepare<TridentRunDbRow, [string]>(
        `SELECT ${COLS}
           FROM code_trident_runs
          WHERE parent_run_id = ?
          ORDER BY started_at ASC, id ASC`,
      )
      .all(parentId)
      .map(rowToRun)
  }

  /**
   * Every run whose phase is NOT terminal, oldest-advanced first. This is
   * the tick driver's load query: it advances each returned run. Capped
   * at `limit` so a single tick stays bounded.
   */
  /**
   * Every non-terminal run in ONE repo. The path-claim check reads only these, so a
   * run going terminal — harvest, cancel, crash-reap, anything — releases its claim
   * BY DEFINITION. There is no release write to be missed, which is what makes a
   * crashed run structurally incapable of stranding a claim on a file forever.
   */
  listNonTerminalByRepo(repo_path: string): TridentRun[] {
    return this.db
      .prepare<TridentRunDbRow, [string]>(
        `SELECT ${COLS}
           FROM code_trident_runs
          WHERE repo_path = ? AND phase NOT IN ${TERMINAL_PHASE_SQL}
          ORDER BY started_at ASC`,
      )
      .all(repo_path)
      .map(rowToRun)
  }

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

  /** Failed PR-mode rows eligible for startup git-truth reconciliation,
   *  newest-advanced first and bounded so boot work stays finite. */
  listFailedPrRuns(limit: number = 50): TridentRun[] {
    return this.db
      .prepare<TridentRunDbRow, [number]>(
        `SELECT ${COLS}
           FROM code_trident_runs
          WHERE phase = 'failed'
            AND merge_mode = 'pr'
          ORDER BY last_advanced_at DESC
          LIMIT ?`,
      )
      .all(limit)
      .map(rowToRun)
  }

  /** Every repository ever named by a run, including terminal leaked runs. */
  listRepoPaths(): string[] {
    return this.db
      .prepare<{ repo_path: string }, []>(
        `SELECT DISTINCT repo_path
           FROM code_trident_runs
          ORDER BY repo_path`,
      )
      .all()
      .map((row) => row.repo_path)
  }

  /** Every actively running row with an external launcher generation.
   * Unbounded deliberately: liveness must not inherit the expensive sweep's
   * per-tick cap or leave newer lanes invisible behind older rows. */
  listRunningLaunchers(): TridentRun[] {
    return this.db
      .prepare<TridentRunDbRow, []>(
        `SELECT ${COLS}
           FROM code_trident_runs
          WHERE phase NOT IN ${TERMINAL_PHASE_SQL}
            AND subagent_status = 'running'
            AND workflow_run_id IS NOT NULL
            AND workflow_run_id <> ''
          ORDER BY last_advanced_at ASC`,
      )
      .all()
      .map(rowToRun)
  }

  /**
   * Distinct repositories across ALL runs — TERMINAL INCLUDED — newest activity
   * first, using each repository's most recent run to choose its merge mode. The
   * as-built catch-up must attempt each repo at most once per tick, and a fold the
   * post-merge pass missed belongs to a run that is already `done`, so
   * `listNonTerminal` cannot provide this inventory.
   */
  listDistinctRepos(): { repo_path: string; merge_mode: MergeMode }[] {
    return this.db
      .prepare<{ repo_path: string; merge_mode: string }, []>(
        `SELECT run.repo_path, run.merge_mode
           FROM code_trident_runs AS run
          WHERE run.id = (
            SELECT recent.id
              FROM code_trident_runs AS recent
             WHERE recent.repo_path = run.repo_path
             ORDER BY recent.last_advanced_at DESC, recent.id DESC
             LIMIT 1
          )
          ORDER BY run.last_advanced_at DESC, run.id DESC`,
      )
      .all()
      .map((row) => ({ repo_path: row.repo_path, merge_mode: row.merge_mode === 'pr' ? 'pr' : 'local' }))
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
   * TERMINAL AGENT-WAKE CLAIM (migration 0127) — atomically claim the right to
   * dispatch this run's ONE terminal agent-wake turn. Returns true exactly once
   * per run (the winning claim); false when already claimed, when the run is not
   * terminal, or when the id does not exist — so redelivery, retry, and a
   * gateway boot that re-runs terminal observers can never fan out duplicate
   * agent turns. SINGLE WRITER of `agent_waked_at`: the column is DELIBERATELY
   * absent from `TridentRun`, `TridentRunUpdate`, `update()`, `save()` and
   * `saveIfActive()` (same ownership discipline as `crash_recoveries`), so no
   * full-snapshot save can ever un-claim a delivered wake.
   */
  async claimAgentWake(id: string): Promise<boolean> {
    return this.db.transaction((tx) => {
      const res = tx.runSync(
        `UPDATE code_trident_runs
            SET agent_waked_at = ?
          WHERE id = ? AND agent_waked_at IS NULL
            AND phase IN ${TERMINAL_PHASE_SQL}`,
        [Date.now(), id],
      )
      return res.changes > 0
    })
  }

  /**
   * Atomically CLAIM a measured infrastructure failure for retry: spend one
   * durable budget unit, clear the harvested result + its stale verdict, and
   * release every dispatch slot in ONE conditional UPDATE. A racing terminal
   * transition, second tick, or crash latch wins cleanly and returns null. This
   * is the only writer of `infra_retries`; agent rounds and `harvested_at` are
   * intentionally untouched.
   */
  async beginInfraRetry(id: string): Promise<TridentRun | null> {
    const won = await this.db.transaction((tx) => {
      const res = tx.runSync(
        `UPDATE code_trident_runs
            SET infra_retries = COALESCE(infra_retries, 0) + 1,
                inner_result = NULL,
                inner_verdict = NULL,
                subagent_run_id = NULL,
                subagent_status = NULL,
                workflow_run_id = NULL,
                last_advanced_at = ?
          WHERE id = ? AND phase NOT IN ${TERMINAL_PHASE_SQL}
            AND subagent_status IS NOT 'crashed'`,
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
    if (patch.base_sha !== undefined) push('base_sha', patch.base_sha)
    if (patch.base_behind !== undefined) push('base_behind', patch.base_behind)
    if (patch.pr !== undefined) push('pr', patch.pr)
    if (patch.merge_mode !== undefined) push('merge_mode', patch.merge_mode)
    if (patch.subagent_run_id !== undefined) push('subagent_run_id', patch.subagent_run_id)
    if (patch.subagent_status !== undefined) push('subagent_status', patch.subagent_status)
    if (patch.worktree !== undefined) push('worktree', patch.worktree)
    if (patch.failure_reason !== undefined) push('failure_reason', patch.failure_reason)
    if (patch.workflow_run_id !== undefined) push('workflow_run_id', patch.workflow_run_id)
    if (patch.inner_checkpoint !== undefined) push('inner_checkpoint', patch.inner_checkpoint)
    // CANARY round-persist: `round` was dead — 1 on all 195 measured rows while
    // inner_checkpoint recorded fix-round-2..7. Derive the real round from the
    // checkpoint being persisted, in the SAME UPDATE, monotonic in SQL (MAX
    // against the STORED value — never lowered). An explicit patch.round
    // (tests/sim) still wins and skips the derivation.
    if (patch.round === undefined && patch.inner_checkpoint !== undefined) {
      const derived = checkpointRound(patch.inner_checkpoint)
      if (derived !== null) {
        sets.push('round = MAX(round, ?)')
        params.push(derived)
      }
    }
    // CANARY phase-persist, the same shape as the round derivation above and for
    // the same reason. `checkpoint.sh` applies the canonical table
    // (`phaseForCheckpoint`) at the choke point the INNER workflow checkpoints
    // through, so a run driven by the inner loop moves off `forge-init` correctly.
    // The orchestrator does NOT go through that script — it writes
    // `inner_checkpoint` here, at ~9 sites (`orchestrator.ts` `argus-approved`,
    // `pr-merged`, `built`, the bound-review pair, …) — so every checkpoint the
    // OUTER loop stamps used to leave `phase` exactly as it found it. That is the
    // same decorative-column defect the table was written to end, surviving in the
    // half of the system the bash mirror cannot reach.
    //
    // Semantics are the mirror's, not a second opinion:
    //   * an explicit `patch.phase` (the orchestrator's own terminal writes,
    //     tests, the sim) WINS and skips the derivation entirely;
    //   * `null` from the table means the checkpoint implies NOTHING — terminal-
    //     adjacent, an outer-loop marker, or a name never seen — and the column is
    //     left untouched rather than guessed at;
    //   * a terminal phase is FROZEN in SQL, exactly as `checkpoint.sh`'s
    //     `frozen()` does it. A late checkpoint landing on a finished row must not
    //     resurrect it into a live phase.
    if (patch.phase === undefined && patch.inner_checkpoint !== undefined) {
      const derivedPhase = phaseForCheckpoint(patch.inner_checkpoint)
      if (derivedPhase !== null) {
        sets.push(`phase = CASE WHEN phase IN ${TERMINAL_PHASE_SQL} THEN phase ELSE ? END`)
        params.push(derivedPhase)
      }
    }
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
    if (patch.inner_verdict !== undefined || patch.inner_checkpoint_findings !== undefined) {
      await this.db.transaction((tx) => {
        const row = tx
          .prepare<Pick<TridentRunDbRow, 'inner_verdict' | 'inner_checkpoint_findings'>, [string]>(
            `SELECT inner_verdict, inner_checkpoint_findings FROM code_trident_runs WHERE id = ?`,
          )
          .get(id)
        if (row !== null) {
          const effectiveVerdict = patch.inner_verdict !== undefined
            ? patch.inner_verdict
            : row.inner_verdict
          const effectiveFindings = patch.inner_checkpoint_findings !== undefined
            ? patch.inner_checkpoint_findings
            : row.inner_checkpoint_findings
          // T1's production discriminator cannot reach this state. The guard makes
          // findings-free rejection structurally unwritable by in-process writers;
          // checkpoint.sh remains out-of-process SQL and bypasses it by construction.
          if (
            effectiveVerdict === 'REQUEST_CHANGES' &&
            parseCheckpointFindings(effectiveFindings).length === 0
          ) {
            throw new TridentEmptyFindingsRejectionError(id, 'update')
          }
        }
        tx.runSync(
          `UPDATE code_trident_runs SET ${sets.join(', ')} WHERE id = ?${statusGuard}`,
          params,
        )
      })
    } else {
      await this.db.run(
        `UPDATE code_trident_runs SET ${sets.join(', ')} WHERE id = ?${statusGuard}`,
        params,
      )
    }
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
   * `project_slug`, `repo_path`, `task`, `started_at`, the caps,
   * `chat_id`/`thread_id`, and `parent_run_id`/`wave_task_id` are write-once at
   * create time.
   *
   * `inner_result` and `brief_alert` are DELIBERATELY NOT written here: both are
   * WORKFLOW-OWNED, out-of-band writes that the OUTER loop only ever READS.
   * Excluding them from this full-snapshot save means an orchestrator `save()`
   * (e.g. a launch persist whose in-memory run still carries a stale null) can
   * never clobber a result or recovered integrity alert. Use
   * `update({inner_result})` for the workflow-sim result write in tests;
   * `brief_alert` is written by `trident/checkpoint.sh`.
   *
   * `inner_checkpoint_head` (0122) is excluded for the
   * same reason AND a sharper one: it is only meaningful PAIRED with the
   * `inner_checkpoint` it was written beside. The known cost of that exclusion
   * (Argus r3, minor): a save carrying a NULL checkpoint — the launcher's dropped
   * salvage seed is the one live producer — leaves the head of the seed
   * behind it, so the persisted row is a null name beside a stale OID. It is not
   * corrected HERE, because "checkpoint null → null the pair" cannot tell that write
   * from an outer-loop snapshot whose in-memory checkpoint is merely STALE (the
   * workflow writes checkpoints out of band, through checkpoint.sh), and nulling a
   * live head on one of those would destroy evidence rather than tidy it. No reader
   * is affected: `terminalRunDisposition` and every resume path key off the
   * checkpoint NAME, which is null, so the orphaned OID is inert.
   * The workflow writes all three in
   * ONE atomic UPDATE; an outer-loop snapshot that carried a checkpoint name
   * forward without them could pair a fresh name with a stale OID, and that pair is
   * exactly what a resumed run reads to decide whether prior review work — up to
   * and including an APPROVE — may be trusted.
   *
   * `inner_checkpoint_findings` is the ONE of that trio this writer does touch, and
   * only through `COALESCE` — see the guard below. A snapshot that brings no
   * findings still leaves the column alone, so the exclusion above holds for every
   * caller that has one; a snapshot that brings a REJECTION must be able to bring
   * its evidence in the same statement, or the guard it has to satisfy is
   * unanswerable.
   */
  async save(run: TridentRun): Promise<void> {
    if (run.inner_verdict === 'REQUEST_CHANGES') {
      // SAME PRECEDENCE AS saveIfActive — incoming findings first, the stored row
      // as the fallback (Argus r1, nit). Reading only the STORED column while this
      // writer never populated it made the guard unsatisfiable by construction: a
      // caller arriving WITH findings had no way to satisfy it, and `tick.ts`
      // swallows the throw as `advance_failed`, so the run would retry forever.
      // The COALESCE below is the other half — the verdict and the evidence for it
      // land in the SAME statement, which is what makes the guard answerable.
      // save() has no production callers, so its non-transactional pre-read is acceptable.
      //
      // PATCH-WINS, exactly as `update()` at the top of this class already does (Argus
      // r1, blocker). The stored row is a fallback ONLY when the incoming column is
      // NULL, because NULL is the one value the COALESCE below leaves the stored
      // evidence alone for. A NON-null incoming value — `'[]'` above all — OVERWRITES
      // that column, so judging it against evidence it is about to erase let a caller
      // clear the guard and then land the exact `REQUEST_CHANGES` + `[]` row this whole
      // card exists to make unwritable.
      if (parseCheckpointFindings(run.inner_checkpoint_findings).length === 0) {
        if (run.inner_checkpoint_findings !== null) {
          throw new TridentEmptyFindingsRejectionError(run.id, 'save')
        }
        const row = this.get(run.id)
        if (row !== null && parseCheckpointFindings(row.inner_checkpoint_findings).length === 0) {
          throw new TridentEmptyFindingsRejectionError(run.id, 'save')
        }
      }
    }
    await this.db.run(
      `UPDATE code_trident_runs
          SET phase = ?, round = MAX(round, ?, ?), ralph_round = ?, branch = ?, pr = ?,
              merge_mode = ?, subagent_run_id = ?, subagent_status = ?,
              worktree = ?, failure_reason = ?, workflow_run_id = ?,
              inner_checkpoint = ?, inner_verdict = ?, harvested_at = ?,
              -- COALESCE, NOT A PLAIN ASSIGNMENT, exactly as in saveIfActive: a bare
              -- assignment would let every snapshot save blank the column, while
              -- COALESCE writes only when the caller actually brought findings.
              -- (Keep this comment free of question marks: the driver counts every one
              -- in the statement text as a bind parameter, comments included.)
              inner_checkpoint_findings = COALESCE(?, inner_checkpoint_findings),
              base_sha = ?, base_behind = ?,
              last_advanced_at = ?
        WHERE id = ?`,
      [
        run.phase,
        run.round,
        checkpointRound(run.inner_checkpoint) ?? 0,
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
        run.inner_checkpoint_findings,
        run.base_sha,
        run.base_behind,
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
      if (run.inner_verdict === 'REQUEST_CHANGES') {
        // VALIDATE WHAT WILL BE PERSISTED, NOT ONLY WHAT IS ALREADY THERE. This used to
        // read `inner_checkpoint_findings` from the STORED row while the UPDATE below
        // never wrote that column — so a caller arriving with findings in hand could not
        // satisfy the guard by any means. The only two outcomes were a downgraded verdict
        // (a real blocker recorded as REVIEW_NOT_RUN) or, once a caller started passing
        // findings, a throw on every tick and a run that retried forever without leaving
        // `forge-init`. A guard that reads a column its own writer cannot populate is
        // unsatisfiable by construction.
        //
        // The incoming value wins when it carries findings; otherwise fall back to the
        // stored row, so a save that legitimately leaves the column alone is still judged
        // against the evidence already on record. Both empty is still a refusal — that is
        // the thesis and it is intact: an empty finding set is an approval or an
        // infrastructure failure, never a rejection.
        //
        // PATCH-WINS, exactly as `update()` does (Argus r1, blocker). The stored row is
        // consulted ONLY when the incoming column is NULL — the one value the COALESCE
        // below leaves the stored evidence alone for. A NON-null incoming value, `'[]'`
        // above all, OVERWRITES that column in this same statement, so weighing it
        // against evidence it is about to erase cleared the guard and then landed the
        // exact `REQUEST_CHANGES` + `[]` row this card exists to make unwritable.
        const incoming = parseCheckpointFindings(run.inner_checkpoint_findings)
        if (incoming.length === 0) {
          if (run.inner_checkpoint_findings !== null) {
            throw new TridentEmptyFindingsRejectionError(run.id, 'saveIfActive')
          }
          const row = tx
            .prepare<{ inner_checkpoint_findings: string | null }, [string]>(
              'SELECT inner_checkpoint_findings FROM code_trident_runs WHERE id = ?',
            )
            .get(run.id)
          if (row !== null && parseCheckpointFindings(row.inner_checkpoint_findings).length === 0) {
            throw new TridentEmptyFindingsRejectionError(run.id, 'saveIfActive')
          }
        }
      }
      const res = tx.runSync(
        `UPDATE code_trident_runs
            SET phase = ?, round = MAX(round, ?, ?), ralph_round = ?, branch = ?, pr = ?,
                merge_mode = ?, subagent_run_id = ?, subagent_status = ?,
                worktree = ?, failure_reason = ?, workflow_run_id = ?,
                inner_checkpoint = ?, inner_verdict = ?, harvested_at = ?,
                -- COALESCE, NOT A PLAIN ASSIGNMENT. The verdict and the evidence for it
                -- must land in the SAME statement or the guard above can never be
                -- satisfied. But most callers of saveIfActive never touch findings, and a
                -- bare assignment would let each of them blank the column on an unrelated
                -- save. COALESCE writes only when the caller actually brought something.
                -- (Keep this comment free of question marks: the driver counts every one
                -- in the statement text as a bind parameter, comments included.)
                inner_checkpoint_findings = COALESCE(?, inner_checkpoint_findings),
                base_sha = ?, base_behind = ?,
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
          checkpointRound(run.inner_checkpoint) ?? 0,
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
          run.inner_checkpoint_findings,
          run.base_sha,
          run.base_behind,
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

/** Repo-relative claimed paths, stored as JSON. Every malformed shape degrades to the
 *  EMPTY set rather than throwing: a run whose claim cannot be read holds no paths, so a
 *  parse failure can never widen what a run is allowed to touch. */
function parseClaimedPaths(raw: string | null): string[] {
  if (raw === null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
  } catch {
    return []
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
    base_sha: row.base_sha,
    base_behind: row.base_behind ?? null,
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
    brief_alert: row.brief_alert,
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
    // Legacy rows predate migration 0126 and read NULL — no retry budget spent.
    infra_retries: row.infra_retries ?? 0,
    reviewed_head: row.reviewed_head,
    bound_pr: row.bound_pr,
    fenced_paths: row.fenced_paths,
    claimed_paths: parseClaimedPaths(row.claimed_paths),
    parent_run_id: row.parent_run_id,
    wave_task_id: row.wave_task_id,
  }
}

/**
 * The slug a wave member runs under. The live-slug UNIQUE index (migration
 * 0120) spans (project_slug, slug) on LIVE rows, so a member can never reuse
 * its live parent's slug; this deterministic suffix dodges that collision and
 * keeps members identifiable.
 */
export function waveChildSlug(parentSlug: string, taskId: string): string {
  return `${parentSlug}--w${taskId}`
}
