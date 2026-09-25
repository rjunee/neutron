/**
 * @neutronai/trident — board-bound build dispatch (Work Board Phase 2b).
 *
 * THE trident dispatch chokepoint. Every autonomous Forge→Argus→merge build
 * MUST be bound to a Work Board ("Plan") item — Ryan-locked, no untracked
 * dispatches. Both entries that start a trident build funnel through
 * `dispatchBoardBoundBuild`:
 *
 *   - the agent-native `work_board_dispatch_build` tool (the orchestrator fires
 *     N of these for N parallel builds — `work-board-build-tool.ts`), and
 *   - the human `/code --item <id> <task>` chat command (`code-command.ts`).
 *
 * The chokepoint enforces four rules in order, BEFORE any `code_trident_runs`
 * row is written (so a rejected dispatch leaves zero state):
 *
 *   1. REQUIRED board_item_id — a dispatch with none is REJECTED (`missing_board_item`).
 *   2. The item must EXIST on this project's board (`unknown_board_item`).
 *   3. ASK-BEFORE-ACTING — the item must be specified enough to act on
 *      (`assessDispatchReadiness`: a design_doc_ref OR a detailed title), else
 *      the dispatch is REJECTED (`underspecified`) and the caller's contract is
 *      to ask the owner a clarifying question rather than proceed on guesses.
 *   4. ALREADY-LANDED work refuses (`already_landed`) — the three 2026-08-17
 *      rebuild occurrences proved a reusable card branch must be checked for a
 *      merged PR before another run can claim it.
 *
 * It also SALVAGES a build that already exists. When the card's latest terminal
 * run is built-but-never-reviewed (`run-disposition.ts`) and the live branch tip
 * still resolves to exactly the commit that run recorded, the new row is created
 * already carrying that run's checkpoint evidence — so `launch()` takes its
 * existing resume path and the commit goes to REVIEW instead of being rebuilt from
 * scratch.
 *
 * AND, ON A SEPARATE GATE, IT CARRIES THE CARD'S TASK SPEND (#519) — `task_iteration`
 * together with the cap it is measured against, `min(prior, this dispatch)` — for ANY
 * governed prior the card names, EXHAUSTED included, since the gate is the link and not
 * the disposition. A run that died mid-budget keeps its count and its plan-refresh
 * cadence instead of restarting them; a run that died at its cap stays at its cap. The
 * gate is the board link alone
 * (`item.linked_run_id`), not the commit proof: identity is what the link
 * establishes, and a budget carry is monotone — `min` can only tighten a bound,
 * never authorise work — so a task-text edit past the slug's 35th character does not
 * cost a card its budget while it does still refuse the commit.
 *
 * #629 MOVES THE AUTHORITY TO THE CARD. The linked prior remains a compatibility
 * source for cards that have not yet recorded their durable snapshot;
 * once the card has a snapshot, clearing or replacing `linked_run_id` cannot reset
 * the spend. Dispatch refuses an at-cap card with `task_budget_exhausted`.
 *
 * Every other shape dispatches exactly as it did before, and now SAYS SO: one
 * `dispatch_resume_seed` line per dispatch that had a prior terminal run AND created
 * a row, naming what was carried (commit and budget are reported separately, because
 * one word cannot honestly cover two gates) or the proof that failed.
 *
 * Before creating the run it resolves THIS project's own git-initialized build
 * workspace (the card-selected repo, via `ensureProjectBuildWorkspace`)
 * and writes that onto the run row's `repo_path` — so a brand-new project with
 * no pre-existing code repo is still buildable (the inner workflow's
 * `git worktree add` needs a real repo with a commit). A fresh local project has
 * no GitHub origin, so merge mode degrades to `'local'` (branch + local merge).
 *
 * On success it creates the run AND immediately binds it to the item
 * (`store.attachRun` → `linked_run_id` + status=in_progress), so the board
 * lights the fork `⑂` icon the moment the build starts. The durable
 * `TridentTickLoop` then fires the inner Workflow + harvests by runId; the
 * terminal-reconcile path (`build-core-modules` on_terminal) keeps the terminal
 * evidence binding and sets the lane (done / failed) when the run lands.
 *
 * Layering: depends only on the run store (`TridentRunStore`), the git-mode /
 * execution_strategy detection helpers, and a STRUCTURAL board binder interface (satisfied
 * by `WorkBoardStore` at the composition root) — never imports `work-board`
 * directly, so trident stays decoupled + unit-testable with a stub binder.
 */

import type { Topic } from '@neutronai/channels/types.ts'
import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { createLogger } from '@neutronai/logger'
import { githubProcessEnv, readGitHubToken } from '@neutronai/github/credential.ts'
import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import {
  assessDispatchReadiness,
  type DispatchReadinessTarget,
} from '@neutronai/work-board/dispatch-readiness.ts'
import {
  detectMergeMode,
  defaultGitModeProbe,
  makeCredentialedHostRunner,
  makeLazyCredentialedHostRunner,
  spawnCapture,
  type EnvCapableHostRunner,
  type PublisherCredentialSource,
} from './git-mode.ts'
import { ensureProjectBuildWorkspace } from './build-workspace.ts'
import { TASK_CONTINUATION_CHECKPOINT, builtButNeverReviewedSeed, carriedTaskBudget } from './run-disposition.ts'
import { isTaskContinuationSource, retryModeSource } from './build-mode-state.ts'
import { detectBaseBranch } from './merge.ts'
import { slugifyTask } from './slugify-task.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { DispatchHoldInput, DispatchHoldPayload, DispatchHoldStore } from './dispatch-holds.ts'
import type { DispatchAdmission, DispatchAdmitted } from './dispatch-admission.ts'
import { deriveClaimedPaths } from './claimed-paths.ts'
import { defaultBranchHolderProbe, type BranchHolderProbe } from './fire-evidence-probes.ts'
import type { MergeMode, TridentRun, TridentRunStore } from './store.ts'
import { DEFAULT_MAX_TASK_ITERATIONS, isTaskCap, isTaskIteration } from './task-budget.ts'

const log = createLogger('trident')

/**
 * Every answer the dispatch's seed ladder can give to "what does this retry inherit
 * from the run before it?" — one per arm of the ladder in {@link dispatchBoardBoundBuild}.
 * `no_prior_terminal_run` is the only one that is not a statement about a prior run.
 */
export type ResumeSeedReason =
  | 'no_prior_terminal_run'
  | 'card_names_no_run'
  | 'card_names_an_unknown_run'
  | 'card_names_a_different_run'
  | 'card_names_a_live_run'
  | 'prior_run_task_text_differs'
  | 'prior_run_has_no_resumable_build'
  | 'resumed'
  | 'resumed_continuation'
  | 'branch_tip_moved'
  | 'branch_tip_unreadable_or_absent'

/** The values the dispatch has ALREADY decided for the new row — the note is built
 *  from these and nothing else, so the card text cannot disagree with the row. */
export interface ResumeNoteRow {
  inner_checkpoint: string | null
  inner_checkpoint_head: string | null
  execution_strategy: 'single' | 'task_sequence' | null
  task_iteration: number
  max_task_iterations: number
  /** Whether the card's Task spend was inherited (`budget !== null` in the dispatch). */
  budget_carried: boolean
}

const NOT_RESUMED_BECAUSE: Record<Exclude<ResumeSeedReason, 'no_prior_terminal_run' | 'resumed' | 'resumed_continuation'>, string> = {
  card_names_no_run: 'the card names no prior run',
  card_names_an_unknown_run: 'the run the card names no longer exists',
  card_names_a_different_run: "the run the card names belongs to another project",
  card_names_a_live_run: 'the run the card names is still live',
  prior_run_task_text_differs: "the card's task text changed since the last run",
  prior_run_has_no_resumable_build: 'the last run left no build to resume',
  branch_tip_moved: "the branch moved off the last run's commit",
  branch_tip_unreadable_or_absent: 'the branch tip could not be read or the branch is gone',
}

/**
 * THE CARD SENTENCE FOR A RETRY (spec item a-retry-must-resume-from-the-checkpoint,
 * acceptance 1: "carries … forward, OR states plainly on the card that it will not").
 *
 * A retry that declines to resume is a byte-identical fresh dispatch — a row with a null
 * checkpoint and round 0 looks exactly like a first attempt, and before this the only
 * place the refusal existed was a `dispatch_resume_seed` log line no owner reads. So the
 * dispatch writes ONE sentence onto the row (`code_trident_runs.resume_note`), which
 * `run_progress` carries to the card.
 *
 * Null ONLY for `no_prior_terminal_run`: a first dispatch has nothing to state. Every
 * other reason yields a sentence naming whether the checkpoint was carried and, for a
 * selected task sequence or a carried budget, the iteration and cap the row holds. No path, host or
 * identity is ever interpolated — the only variable parts are the checkpoint NAME, a
 * 7-character commit prefix and two integers.
 *
 * A CARRIED CHECKPOINT IS WORDED AS THE DISPATCH'S DECISION, NOT THE OUTCOME. The note
 * is written once, here, from the dispatch-time tip proof, and nothing may restate it
 * (`code_trident_runs.resume_note`, trident/store.ts). A branch that moves between this
 * dispatch and the launch is caught by the driver's G038 head check, which rebuilds
 * instead (trident/build-run.ts) — so "Resumed from …" would claim an outcome the run
 * can still decline. The sentence says what the dispatch did and names that exception.
 */
export function resumeNote(reason: ResumeSeedReason, row: ResumeNoteRow): string | null {
  if (reason === 'no_prior_terminal_run') return null
  // A carried allowance remains visible under either strategy.
  const budgetNote = row.execution_strategy !== 'task_sequence' && !row.budget_carried
    ? '.'
    : row.budget_carried
      ? `; Task round ${row.task_iteration}/${row.max_task_iterations} carried.`
      : `; fresh Task budget ${row.task_iteration}/${row.max_task_iterations}.`
  if (reason === 'resumed' || reason === 'resumed_continuation') {
    const at = row.inner_checkpoint_head !== null ? ` at ${row.inner_checkpoint_head.slice(0, 7)}` : ''
    return `Dispatched to resume from ${row.inner_checkpoint ?? 'the last checkpoint'}${at} (rebuilds if the branch moves before launch)${budgetNote}`
  }
  return `Not resumed: ${NOT_RESUMED_BECAUSE[reason]}, so this is a fresh build${budgetNote}`
}

export interface AlreadyLandedFinding {
  pr: number
  merged_at: string | null
  head_on_base: boolean | null
  base: string
}

export type DispatchLandedProbe = (
  repo_path: string,
  branch: string,
) => Promise<AlreadyLandedFinding | null>

/** Build the outer-loop merged-PR probe used by every production dispatch. */
export function makeDispatchLandedProbe(run: EnvCapableHostRunner): DispatchLandedProbe {
  return async (repo_path, branch) => {
    try {
      const res = await run(
        [
          'gh',
          'pr',
          'list',
          '--head',
          branch,
          '--state',
          'merged',
          '--json',
          'number,headRefOid,mergedAt',
          '--jq',
          '.[0] // empty',
        ],
        repo_path,
      )
      if (!res.ok || res.stdout.trim().length === 0) return null

      const parsed = JSON.parse(res.stdout) as Record<string, unknown>
      const pr = parsed['number']
      if (typeof pr !== 'number' || !Number.isFinite(pr) || !Number.isInteger(pr) || pr <= 0) {
        return null
      }

      const base = await detectBaseBranch(run, repo_path)
      let head_on_base: boolean | null = null
      const headRefOid =
        typeof parsed['headRefOid'] === 'string' ? parsed['headRefOid'].trim() : ''
      if (headRefOid.length >= 40) {
        await run(['git', '-C', repo_path, 'fetch', '--no-tags', 'origin', base], repo_path)
        const ancestor = await run(
          [
            'git',
            '-C',
            repo_path,
            'merge-base',
            '--is-ancestor',
            headRefOid,
            `refs/remotes/origin/${base}`,
          ],
          repo_path,
        )
        head_on_base = ancestor.ok ? true : ancestor.exit_code === 1 ? false : null
      }

      return {
        pr,
        merged_at: typeof parsed['mergedAt'] === 'string' ? parsed['mergedAt'] : null,
        head_on_base,
        base,
      }
    } catch {
      return null
    }
  }
}

/**
 * Read a build branch's tip THE WAY THE LAUNCH WILL READ IT, because the seed is
 * a prediction about what `launch()` + `classifyResume` will decide and a proof
 * taken against a different ref proves nothing about that decision.
 *
 *   pr    → `git ls-remote --heads origin refs/heads/<branch>`, mirroring
 *           `resolveResumeLiveHead` (orchestrator.ts), which reads the REMOTE in
 *           pr mode. This is not a detail: Forge is told "do NOT push" in pr mode
 *           (`forgePushStep`, inner-workflow.mjs), so a run that died at
 *           `forge-done` in pr mode has its commit ONLY locally and origin has no
 *           branch at all — `classifyResume` answers `head-branch-absent` and
 *           REBUILDS. Proving the LOCAL ref there would seed a row that pays the
 *           seed's whole cost (leftover-branch guard stripped, no base re-pin) for
 *           none of its saving. An empty ls-remote is exactly that case and seeds
 *           nothing; the pr-mode salvage that DOES pay is `outer-published:*`,
 *           whose commit the outer loop already pushed.
 *   local → the local ref, which is the same one `resolveResumeLiveHead` reads in
 *           local mode. `--verify --quiet` makes an absent ref exit non-zero with
 *           empty output rather than an error.
 *
 * Either way "no such branch" and "git could not answer" collapse into the same
 * `''`, which is correct: both mean no evidence, so no resume seed.
 *
 * THE `pr`-MODE READ IS CREDENTIALED, like every other remote read this file makes
 * (Argus r3). `ls-remote` against a PRIVATE origin over an uncredentialed process
 * env exits non-zero, which collapses to `''` — a silent no-seed, i.e. the card's
 * headline salvage quietly not happening on exactly the repos that most need it.
 * It fails CLOSED so it was never wrong, only inert; the adjacent landed probe
 * already takes `credentialedRunner` for the same class of read, so this takes the
 * same runner. `spawnCapture` (the primitive `build-workspace.ts` uses) stays the
 * default for callers that have no credential source.
 *
 * AND THE CREDENTIAL HAS TO BE WIRED, NOT MERELY ACCEPTED (Argus r16 blocker). An
 * earlier revision of this note claimed "nothing needs new composition-root
 * wiring", which was false: `credentialedRunner` was built ONLY from
 * `secretsStore` + `owner_handle`, and no production caller passes those — all of
 * them inject `resolveMergeMode` instead, because the composition root owns the
 * token. So every real dispatch reached this function on bare `spawnCapture`, and
 * against a private origin the salvage was inert: built, never reviewed, silently
 * rebuilt. `BoardBoundBuildDeps.hostRunner` is the missing seam, and
 * `open/composer.ts` hands the SAME `tridentHostRunner` the landed probe already
 * uses to every production dispatch site.
 */
async function defaultReadBranchTip(
  repo_path: string,
  branch: string,
  merge_mode: MergeMode,
  run: EnvCapableHostRunner = spawnCapture,
): Promise<string> {
  const ref = `refs/heads/${branch}`
  try {
    if (merge_mode === 'pr') {
      const res = await run(
        ['git', '-C', repo_path, 'ls-remote', '--heads', 'origin', ref],
        repo_path,
      )
      if (!res.ok) return ''
      // `<oid>\t<ref>` on the first line; an OK ls-remote with no output is the
      // remote saying the branch is not there.
      const token = res.stdout.trim().split('\n')[0]?.trim().split(/\s+/)[0] ?? ''
      return /^[0-9a-f]{40}$/i.test(token) ? token : ''
    }
    // `run`, not `spawnCapture`: the parameter defaults to `spawnCapture` already,
    // and calling the primitive directly here dropped a caller-supplied
    // instrumented runner on the local-mode path alone — a signature that
    // over-promises on half its branches (Argus r4).
    const res = await run(
      ['git', '-C', repo_path, 'rev-parse', '--verify', '--quiet', ref],
      repo_path,
    )
    return res.ok ? res.stdout.trim() : ''
  } catch {
    return ''
  }
}

/**
 * The minimal board surface the chokepoint needs: read an item (for the
 * existence + readiness checks) and bind a run to it. `WorkBoardStore`
 * satisfies this structurally (`get` / `attachRun`).
 */
export interface TridentBoardBinder {
  get(
    project_slug: string,
    id: string,
  ): (DispatchReadinessTarget & {
    id: string
    repo_name?: string | null
    linked_run_id?: string | null
    execution_strategy?: 'single' | 'task_sequence' | null
    strategy_rationale?: string | null
    strategy_plan?: string | null
    strategy_source?: 'planner' | 'legacy' | null
    task_iteration?: number
    max_task_iterations?: number | null
    task_total?: number | null
    /**
     * The card's lane. OPTIONAL so the existing readiness/bind test seams need not
     * implement it — but the hold sweep reads it, because a card finished BY HAND
     * while its dispatch sat held must drop the hold rather than be retried forever.
     */
    status?: string
    /**
     * 0139 — the card ids this card declares it depends on. OPTIONAL for the same
     * reason as `status`: an absent list declares NO dependency and never holds.
     */
    blockers?: string[]
  }) | null
  attachRun(project_slug: string, id: string, run_id: string): Promise<unknown>
  /**
   * Reconcile a terminal run's bound card (mark it done/failed, preserve its
   * retry binding). Optional so the readiness/bind test seams need not implement
   * it; the production `WorkBoardStore` satisfies it structurally. `/code stop`
   * uses it to reconcile the board on cancel (§F6a, Codex r6) — the SAME reconcile
   * the tick loop + board DELETE run through `buildBoardReconcileObserver`.
   */
  detachRun?(
    project_slug: string,
    run_id: string,
    outcome: 'done' | 'failed' | 'blocked',
    pr_info?: {
      pr: number | null
      pr_url: string | null
      execution_strategy: 'single' | 'task_sequence' | null
      task_iteration: number
      max_task_iterations: number
      task_total?: number | null
    },
  ): Promise<unknown>
}

export interface BoardBoundBuildInput {
  task: string
  /** The Work Board item this build is bound to. REQUIRED (the hard rule). */
  board_item_id: string | undefined
  /**
   * The EXISTING PR this run is bound to; set ⇒ REVIEW-ONLY round against that
   * PR — the run must never create a branch, commit, or open a PR; populated onto
   * `code_trident_runs.bound_pr`.
   *
   * Cross-lane hazard: the fix-round-contract lane
   * (.trident/plans/trident/a-fix-round-that-abandons-the-revie.md, tasks 2/4
   * unbuilt) planned `bound_pr` as a fix-round publish-target pin; THIS card's
   * semantic (set ⇒ never publishes, enforced fail-closed at launch) governs
   * now, and that lane must add its own discriminator before shipping
   * commit-capable bound runs.
   */
  bound_pr?: number | null
}

export interface BoardBoundBuildDeps {
  store: TridentRunStore
  board: TridentBoardBinder
  /**
   * Where a dispatch that cannot run YET is parked, rather than dropped or queued
   * twice. OPTIONAL: a composition wiring no hold store keeps today's behaviour
   * exactly, so this cannot change dispatch on a box that has not opted in.
   */
  holds?: DispatchHoldStore
  /**
   * Reads a card's plan doc so the claimed-path set is DERIVED from what the work
   * declares. Optional for the same reason, and an unreadable doc yields the EMPTY
   * set — which claims nothing and therefore never holds anyone, rather than
   * claiming everything and stalling the board.
   */
  readPlanDoc?: (project_slug: string, design_doc_ref: string) => Promise<string | null>
  project_slug: string
  /**
   * The owner HOME base under which per-project build workspaces are created —
   * NOT the git repo itself. The chokepoint resolves each project's own
   * git-initialized workspace `<owner_home>/Projects/<project_slug>/code` from
   * it (`resolveBuildRepo`) and writes THAT onto the run row's `repo_path`, so a
   * brand-new project (no pre-existing repo) is still buildable and every
   * project's build is isolated. Both callers pass the owner HOME.
   */
  repo_path: string
  /**
   * Resolve (and git-init-with-commit, idempotently) the per-project build
   * workspace, returning its absolute path. Defaults to
   * `ensureProjectBuildWorkspace` over the production fs/git probe. Test seam.
   */
  resolveBuildRepo?: (owner_home: string, project_slug: string, repo_name?: string | null) => Promise<string>
  /**
   * Resolve the repo's merge mode. An injected resolver wins. Direct callers
   * may instead provide the secrets store and owner handle below; that fallback
   * probes with the same per-command credential environment as the publisher.
   */
  resolveMergeMode?: (repo_path: string) => Promise<MergeMode>
  /** Outer-loop evidence that this card branch already has a merged PR. */
  landedProbe?: DispatchLandedProbe
  /**
   * BRANCH LIVENESS probe — finds the linked worktree holding a branch, if
   * any (see `probeBranchHolder`). Default: the production probe over the
   * real repo. Test seam. POSITIVE EVIDENCE ONLY: null (no worktree, failed
   * look) and a non-live holder never refuse.
   */
  branchHolderProbe?: (repo_path: string, branch: string) => Promise<BranchHolderProbe | null>
  /**
   * Read the tip of a build branch THROUGH THE SAME REF THE LAUNCH WILL — the
   * remote in `pr` mode, the local ref in `local` mode — or `''` when it is absent
   * or unreadable. Only ever consulted to confirm that a prior run's
   * built-but-unreviewed commit is still what that branch holds; `''` and any
   * mismatch mean NO seed, so an unreadable ref costs a rebuild, never a wrong
   * resume. Defaults to the production `spawnCapture` reader below, so no
   * composition root has to wire it. Test seam.
   */
  readBranchTip?: (repo_path: string, branch: string, merge_mode: MergeMode) => Promise<string>
  /**
   * THE CREDENTIALED HOST RUNNER THIS DISPATCH'S REMOTE READS GO THROUGH — the
   * composition root's own (`open/composer.ts` `tridentHostRunner`, the same one
   * behind `landedProbe`), handed in because the token lives THERE, not here.
   *
   * The built-never-reviewed seed's branch-tip probe is why it exists: `git
   * ls-remote origin` over a bare process env exits non-zero against a PRIVATE
   * origin, which collapses to `''` — no seed, a silent rebuild of work that was
   * already built (Argus r16 blocker). A caller that omits it keeps the
   * uncredentialed `spawnCapture` default, so this cannot change behaviour on a
   * public origin or in a test seam.
   *
   * IT IS NOT THE ONLY READ IT FEEDS (Argus r20/r21 — the docblock said "only the
   * seed's branch-tip probe consults it today" and that stopped being true when
   * the merged-PR fallback was widened). It also seeds `credentialedRunner`, from
   * which a caller that supplies `hostRunner` and NO `landedProbe` is handed a
   * manufactured merged-PR probe — the coupling adjudicated at that call site
   * below. Every production site passes BOTH, pinned by the dispatch-site scan in
   * `open/__tests__/open-trident-prod-boot-wiring.test.ts`.
   */
  hostRunner?: EnvCapableHostRunner
  /** Credential source for direct callers that do not inject a merge-mode resolver. */
  secretsStore?: Pick<SecretsStore, 'get'>
  owner_handle?: string
  chat_id?: string | null
  thread_id?: string | null
  channel_kind?: Topic['channel_kind']
  max_rounds?: number
  max_task_iterations?: number
  /**
   * EXECUTOR LIVENESS, at the CHOKEPOINT — not at one caller.
   *
   * A build dispatched onto a positively-revoked Codex seat spends ~15 minutes
   * resolving a workspace and assembling a brief for a `codex exec` that cannot
   * start. The refusal has to live HERE because `dispatchBoardBoundBuild` has
   * THREE production callers and wiring it per-caller covered exactly one of
   * them: the agent tools were gated while the app's ▶ button
   * (`open/composer.ts` `boardStartBuild`) and `/code`
   * (`trident/code-command.ts`) — the owner's primary dispatch paths — kept the
   * old behaviour verbatim.
   *
   * Optional, and every unwired or failing case dispatches: an absent preflight
   * (a direct/test caller) is `{ok:true}`, and the implementation itself is
   * required never to throw and to refuse only on a POSITIVE verdict.
   */
  preflight?: () => Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * PROJECT ADMISSION (#1237), pre-scoped to this dispatch's project and producer
   * by the composition root. REQUIRED: an unwired gate is a composition bug, not a
   * permissive default — a build that holds no lease is invisible to a maintenance
   * fence, which could then advance to `quiesced` under a live build.
   *
   * Asked after the cheap refusals (item, blocked, bound_pr, review intent,
   * underspecified, executor) and BEFORE any git/gh/row work, so a fenced project
   * does none. An admitted lease names the run id the row is created with; it is
   * KEPT when a run row exists (the run owns it until its terminal event releases
   * it) and released on every other unwind.
   */
  projectAdmission: DispatchAdmission
}

export type BoardBoundBuildRejectionCode =
  // NOT a rejection in the usual sense: the dispatch is well-formed and WILL run,
  // just not yet. It is parked in `code_trident_dispatch_holds` because a blocker
  // is unfinished or another live run claims an overlapping path. Distinguished
  // from the codes below because those mean "this will never run as asked".
  | 'held'
  | 'missing_board_item'
  | 'unknown_board_item'
  | 'invalid_bound_pr'
  | 'review_needs_bound_pr'
  | 'underspecified'
  // THE CARD IS BLOCKED — a previous build STOPPED ON PURPOSE and reported why
  // (`work_board_items.status = 'blocked'`, migration 0140). NOT queued, unlike
  // 'held': a hold is waiting for a condition the sweep can re-test, and nothing
  // here can re-test a decision. Re-dispatching now reproduces the run that
  // reached the block, which is the waste the escalation exists to stop, one
  // level out from the fix loop it was stopped in. Clearing the block is a
  // status write the orchestrator makes deliberately.
  | 'card_blocked'
  | 'task_budget_exhausted'
  | 'already_landed'
  // Something LIVE already holds this card's branch — a non-terminal run row,
  // or a linked-worktree lock naming a live pid. REFUSED *AND* QUEUED: nothing
  // was dispatched now, and the card is parked in `code_trident_dispatch_holds`
  // so the sweep re-asks. It is its own code rather than `held` because the
  // operator-facing sentence is different (resolve the holder, never delete the
  // branch) — but it carries a `hold` exactly like `held` does, because it is
  // one. Measured origin (2026-09-01): a launcher settle timeout mislabeled a
  // run `failed` while its detached workflow kept building the branch; only the
  // wrong-base guard's SHAPE check stopped the relaunch. This code refuses on
  // LIVENESS.
  | 'branch_live'
  | 'executor_unavailable'
  | 'backend_error'
  // THE PROJECT IS FENCED FOR MAINTENANCE (#1237). Refused AND QUEUED, like
  // `branch_live`: the condition ends when admission reopens, and the hold sweep
  // re-asks on its cadence. Nothing git/gh/row-shaped ran.
  | 'project_fenced'
  // THE SCOPE IS NOT A LIVE PROJECT (#1237). NOT queued and nothing deleted: there
  // is no condition a sweep could re-test for a project that is not live.
  | 'project_unknown'

export type BoardBoundBuildResult =
  | { ok: true; run: TridentRun; merge_mode: MergeMode; execution_strategy: 'single' | 'task_sequence' | null }
  | {
      ok: false
      // THE QUEUED REFUSAL — a `held`/`branch_live` that really did write a hold
      // row. `branch_live` used to return a bare code+message while the same
      // block upserted a hold — a refusal that told the caller "nothing is
      // queued" about a queued card. The `kind` discriminator is the SURFACE's,
      // not the column's: the stored `hold_kind` stays `'path'` (migration 0139
      // pins that CHECK), and nothing reads the stored kind to decide behaviour.
      //
      // A `held`/`branch_live` that queued NOTHING — no hold store wired, or the
      // card's own live run is the reason — is the member BELOW instead, whose
      // `code` is the broad union and which carries no `hold`. So the presence
      // of `hold` means "queued", exactly, and `'hold' in result` is the check
      // (never `code === 'branch_live'`, which both members admit). Argus r6,
      // minor: this comment used to read as "both codes ALWAYS carry a hold",
      // which stopped being true the moment the queue decision moved to the write.
      code: 'held' | 'branch_live' | 'project_fenced'
      message: string
      hold: {
        kind: 'blocker' | 'path' | 'branch' | 'fence'
        blocker_id?: string
        holding_run_id?: string
        path?: string
        branch?: string
      }
    }
  | { ok: false; code: BoardBoundBuildRejectionCode; message: string }

/**
 * Resolve a `neutron-docs:` plan doc off disk. Any other scheme (an https URL,
 * an `/api/app/...` deep link) and any read error resolve to null — an
 * unreadable plan doc must degrade to "derive from the task text alone", never
 * to a thrown dispatch.
 */
async function defaultReadPlanDoc(
  owner_home: string,
  project_slug: string,
  design_doc_ref: string,
): Promise<string | null> {
  const PREFIX = 'neutron-docs:'
  if (!design_doc_ref.startsWith(PREFIX)) return null
  const rel = design_doc_ref.slice(PREFIX.length).replace(/^\/+/, '')
  if (rel.length === 0 || rel.includes('..')) return null
  try {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    return await readFile(join(owner_home, 'Projects', project_slug, 'docs', rel), 'utf8')
  } catch {
    return null
  }
}

/**
 * Detect a request for a review ROUND OF AN EXISTING PR. Over-refusal is CHEAP:
 * the refusal tells the caller exactly how to re-dispatch. Silent conversion
 * into a build is the measured defect: PRs #542/#541/#530 were docs PRs ABOUT
 * reviewing while the target's review-gate stayed red. Therefore this matcher
 * deliberately errs toward refusing.
 */
export function detectReviewIntent(task: string): number | null {
  // CodeQL js/polynomial-redos: `PR\s*#?\s*` is AMBIGUOUS — when `#?` matches
  // empty the engine sees `\s*\s*`, so a task string with a long run of spaces
  // backtracks polynomially. `task` is caller-supplied text, so that input is
  // reachable. `(?:\s*#)?\s*` accepts exactly the same forms — `PR5`, `PR 5`,
  // `PR#5`, `PR # 5` — with only one way to match each, so there is nothing to
  // backtrack over.
  const patterns = [
    /\bre-?review\s+(?:of\s+)?PR(?:\s*#)?\s*(\d{1,7})\b/i,
    /\breview\s+(?:round|pass|sweep)\s+(?:on|of|for|against)\s+PR(?:\s*#)?\s*(\d{1,7})\b/i,
    /\b(?:run|do|perform|start|dispatch)\b[^\n.]{0,40}?\breview\b[^\n.]{0,40}?\bPR(?:\s*#)?\s*(\d{1,7})\b/i,
    /\breview\s+PR(?:\s*#)?\s*(\d{1,7})\b/i,
  ] as const
  for (const pattern of patterns) {
    const match = task.match(pattern)
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10)
  }
  return null
}

/**
 * "May this refusal queue the card?", answered at the instant a hold is about
 * to be written — see `queueDecision` inside {@link dispatchBoardBoundBuild}.
 */
interface QueueDecision {
  /** Write the hold row (true) or DELETE whatever is already queued (false). */
  queued: boolean
  /** The card already has a non-terminal run of its own — that run owns it. */
  linkedLive: boolean
  /** That run's id, for the prose that names who owns the card. */
  linkedRunId: string | null
  /** The sentence that replaces "…it will dispatch automatically…". */
  notQueuedClause: string
}

/**
 * What the hold write ACTUALLY did — see `queueHold` inside
 * {@link dispatchBoardBoundBuild}. `queued` is the {@link QueueDecision}'s
 * intent confirmed by a write that returned; a non-null `error` means the store
 * threw and NOTHING is queued, so no refusal may claim a `hold` shape.
 */
interface QueueOutcome {
  /** A hold row exists for this card because this call wrote one. */
  queued: boolean
  /** The hold store's failure message, or null when the write went through. */
  error: string | null
  /**
   * WHICH write failed — the two failures have OPPOSITE consequences, so the
   * refusal prose may not describe them with one sentence (Argus r10 BLOCKER).
   * A failed `upsert` queued nothing, so the card really will not move on its
   * own; a failed `delete` left a row that an EARLIER dispatch seeded, and the
   * sweep re-fires that survivor once the card's linked run terminalizes.
   */
  attempted: 'upsert' | 'delete'
}

/**
 * The project lease a dispatch holds, owned by {@link dispatchBoardBoundBuild}
 * and filled in by the gate inside {@link dispatchUnderAdmission}. `kept` flips
 * the instant a run row exists: from then on the lease belongs to that run and
 * only its terminal event (or restart reconciliation) releases it.
 */
interface DispatchLeaseSlot {
  lease: DispatchAdmitted | null
  kept: boolean
}

/**
 * Create a board-bound trident run, enforcing the required-item + ask-gate
 * chokepoint rules. Pure of any chat/tool framing — the two callers wrap the
 * typed result in their own response shape.
 *
 * THE PROJECT LEASE IS RELEASED ON EVERY UNWIND THAT CREATED NO RUN (#1237) —
 * every non-ok return and every throw, from the blockers gate to the end. It is
 * kept only once a run row exists, including the rare case where the row was
 * written and a later step (`attachRun`, the hold delete) failed: that run is
 * live, so the lease must stay for the life of the run, and the terminal
 * observer releases it exactly as for an ok dispatch. A failed release is
 * logged, never thrown: a stuck lease blocks maintenance, not builds — the safe
 * direction.
 */
export async function dispatchBoardBoundBuild(
  input: BoardBoundBuildInput,
  deps: BoardBoundBuildDeps,
): Promise<BoardBoundBuildResult> {
  const slot: DispatchLeaseSlot = { lease: null, kept: false }
  try {
    return await dispatchUnderAdmission(input, deps, slot)
  } finally {
    if (slot.lease !== null && !slot.kept) {
      await slot.lease.release().catch((err: unknown) => {
        log.warn('dispatch_project_lease_release_failed', {
          project: deps.project_slug,
          item: typeof input.board_item_id === 'string' ? input.board_item_id : null,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }
}

async function dispatchUnderAdmission(
  input: BoardBoundBuildInput,
  deps: BoardBoundBuildDeps,
  slot: DispatchLeaseSlot,
): Promise<BoardBoundBuildResult> {
  // (1) REQUIRED board_item_id — no untracked dispatches.
  const board_item_id = typeof input.board_item_id === 'string' ? input.board_item_id.trim() : ''
  if (board_item_id.length === 0) {
    return {
      ok: false,
      code: 'missing_board_item',
      message:
        'Every build must be bound to a Plan item — no board_item_id was supplied. Add the ' +
        'work to the Plan first (work_board_add) and dispatch the build against that item id.',
    }
  }

  // (2) The item must exist on THIS project's board.
  const item = deps.board.get(deps.project_slug, board_item_id)
  if (item === null) {
    return {
      ok: false,
      code: 'unknown_board_item',
      message: `No Plan item "${board_item_id}" on this project's board. Use work_board_list to find the item id.`,
    }
  }

  // (2a) THE CARD IS BLOCKED. Checked immediately after the item is found and
  // BEFORE every other gate, because the answer does not depend on any of them:
  // a blocked card is not startable whatever the task text says, whether or not
  // a PR is bound, and however healthy the executor is. Placing it later would
  // let an underspecified-or-executor refusal be reported for a card whose real
  // problem is that somebody has to make a decision.
  //
  // NOT QUEUED. `held` parks a well-formed dispatch whose blocker the sweep can
  // re-test; this one is waiting on a JUDGEMENT, and a sweep that re-fired it
  // would relearn the same block on the orchestrator's behalf — exactly the loop
  // this card closed inside the run, reopened one level out.
  if (item.status === 'blocked') {
    return {
      ok: false,
      code: 'card_blocked',
      message:
        `Plan item "${board_item_id}" is BLOCKED: a previous build stopped and escalated rather than ` +
        'iterating, and nothing has cleared it. Read its reported reason, sequence whatever it says ' +
        'is missing (or decide the plan), then move the card back to upcoming and dispatch again. ' +
        'Re-dispatching while it is blocked just reproduces the run that reached the block.',
    }
  }

  // (2b) A bound review target is a positive integer PR number.
  const bound_pr = input.bound_pr
  if (bound_pr !== undefined && bound_pr !== null && (!Number.isInteger(bound_pr) || bound_pr <= 0)) {
    return {
      ok: false,
      code: 'invalid_bound_pr',
      message: `bound_pr must be a positive integer PR number; got ${JSON.stringify(bound_pr)}. No run was created.`,
    }
  }

  // (2c) Review-shaped free text must never fall through into the build path.
  const wantsReview = detectReviewIntent(input.task)
  if (wantsReview !== null && (bound_pr === undefined || bound_pr === null)) {
    return {
      ok: false,
      code: 'review_needs_bound_pr',
      message: `This task asks for a review round of an existing PR (#${wantsReview}), but no bound_pr was supplied. A review dispatch must set bound_pr to the PR number it reviews — free-text "review PR #N" is refused rather than silently converted into a build (a build would open a NEW PR and never touch #${wantsReview}). Re-dispatch with bound_pr: ${wantsReview}.`,
    }
  }

  // (3) ASK-BEFORE-ACTING — block an underspecified item; the caller must ask.
  // The ask-before-acting gate protects underspecified BUILDS; a bound review
  // round is fully specified by the PR it reviews plus the task text.
  if (bound_pr === undefined || bound_pr === null) {
    const readiness = assessDispatchReadiness(item)
    if (!readiness.ready) {
      return { ok: false, code: 'underspecified', message: readiness.reason ?? 'Plan item is underspecified.' }
    }

    // (3b) EXECUTOR LIVENESS — the last gate before anything is created, and
    // deliberately INSIDE the not-a-review branch. The preflight's refusal is a
    // sentence about the BUILD phase's executor; a `bound_pr` round does not run
    // that phase, so refusing one with "the Build phase runs on Codex and …"
    // would misattribute the cause. (Bound rounds are separately refused by the
    // orchestrator; that is a different refusal, with its own reason.)
    if (deps.preflight !== undefined) {
      const gate = await deps.preflight()
      if (!gate.ok) return { ok: false, code: 'executor_unavailable', message: gate.reason }
    }
  }

  // The chat/limits context to replay when the queue re-fires this card, built
  // HERE (not by the callers) so every dispatch entry queues the same shape.
  const holdPayload: DispatchHoldPayload = {
    ...(deps.chat_id !== undefined ? { chat_id: deps.chat_id } : {}),
    ...(deps.thread_id !== undefined ? { thread_id: deps.thread_id } : {}),
    ...(deps.channel_kind !== undefined ? { channel_kind: deps.channel_kind } : {}),
    ...(deps.max_rounds !== undefined ? { max_rounds: deps.max_rounds } : {}),
    ...(deps.max_task_iterations !== undefined ? { max_task_iterations: deps.max_task_iterations } : {}),
    // AND THE ROUND'S OWN KIND (Argus r3, minor). `bound_pr` is what makes this
    // dispatch a REVIEW of a published head rather than a build; a hold that
    // dropped it came back through the sweep as a full build, opening a second
    // PR for work that is already published.
    ...(bound_pr !== undefined && bound_pr !== null ? { bound_pr } : {}),
  }

  // MAY THIS REFUSAL QUEUE THE CARD AT ALL? — ONE rule, applied by EVERY
  // HOLD-PRODUCING GATE (Argus r4 VETO). It used to be decided inside the
  // branch-liveness gate alone, which left the two gates ABOVE and BELOW it
  // writing hold rows unconditionally — and either survivor outlives the card's
  // linked run. `buildDispatchHoldSweep` drops a hold only while that run is
  // live AT SWEEP TIME and otherwise re-dispatches, so a `blocker` row written
  // while the card had a live run auto-restarted a card that was later STOPPED
  // on purpose, the moment the declared blocker completed. Two facts decide it:
  //  - A HOLD STORE. A caller that wired none persists nothing, so there is no
  //    queue for the card to be in (every production composer passes one).
  //  - THE CARD'S OWN LINKED RUN. If it is live, that run owns the card and the
  //    card's next move is that run's terminal event — never a queue replay.
  // Every gate below therefore queues through `queueHold`, whose two arms are
  // "write the row" and "delete whatever is already queued", and says which one
  // happened in its own prose and in its returned shape.
  //
  // RE-READ, NEVER SNAPSHOTTED (Argus r6 BLOCKER — dispatch TOCTOU). The rule
  // used to be evaluated ONCE here, off the `item` read at the top of this
  // function, and then applied by gates that run AFTER `resolveBuildRepo`, the
  // merge-mode probe, the gh landed probe and the worktree holder probe — a
  // seconds-wide window of awaits. A competing dispatch that BOUND the card
  // inside that window (the very thing the branch-liveness gate below then
  // observes and refuses on) left this dispatch still holding "the card is
  // free", so it wrote the hold anyway; stop that competing run on purpose and
  // the sweep re-fires the survivor onto a deliberately stopped card. So the
  // decision is taken FRESH, from the board and the store, and — this is the
  // load-bearing half — SYNCHRONOUSLY, with no `await` between the read and the
  // `queueHold` that acts on it. `deps.board.get` and `deps.store.get` are both
  // sync, so nothing can interleave in between.
  //
  // A card that has VANISHED off the board mid-dispatch falls back to the
  // opening snapshot rather than inventing a liveness answer: the sweep already
  // drops holds whose card is gone, so this is not the place to decide that.
  //
  // AND ITS TWO READS ARE CONTAINED (Argus r10, minor — the same escape class
  // the r9 fix closed for the hold WRITE). `deps.board.get` and `deps.store.get`
  // are DB reads and can fail for the reasons that fix names (a locked file, a
  // closed handle, a full disk), and two callers run this OUTSIDE every
  // try/catch in this function — the declared-blockers gate, and the
  // branch-liveness gate whose probe `try` has already closed. A throw there
  // turned a typed refusal into a rejected promise at `code-command.ts` /
  // `open/composer.ts`. So a read that fails degrades instead: the board falls
  // back to the opening snapshot (the rule the vanished-card case already uses),
  // and an UNREADABLE linked run counts as LIVE. That direction is the safe one
  // — it takes `queueHold`'s delete arm, so a failed read can never CREATE a
  // hold behind a card that may already have an owner, which is the r4 harm.
  const queueDecision = (): QueueDecision => {
    let card = item
    try {
      card = deps.board.get(deps.project_slug, board_item_id) ?? item
    } catch {
      card = item
    }
    const linkedRunId = card.linked_run_id ?? null
    // SCOPE THE LOOKUP TO THIS PROJECT (Argus r8 BLOCKER), exactly as
    // `runProgressForItem` (`trident/run-progress.ts`) and
    // `work-wakeup-selection.ts` already do: `TridentRunStore.get` is keyed on
    // the run id ALONE, so a stale or mis-copied `linked_run_id` naming ANOTHER
    // project's run would be read as this card's driver. Those two consumers
    // fail safe when that happens; this one would fail DESTRUCTIVE — a foreign
    // live run makes `linkedLive` true, which sends `queueHold` down the
    // `deleteByItem` arm (erasing the card's queued hold) and tells the operator
    // that run "owns" the card. It does not: its terminal event fires on a
    // different project's board and never re-dispatches this card, so the card
    // wedges with nothing left to release it. A run that is not this project's
    // drives nothing here, so it is ignored and the card stays queueable.
    let linkedRun: TridentRun | null = null
    let unreadable = false
    if (linkedRunId !== null) {
      try {
        linkedRun = deps.store.get(linkedRunId) ?? null
      } catch {
        unreadable = true // the card IS bound to something we could not read
      }
    }
    const linkedPhase =
      linkedRun !== null && linkedRun.project_slug === deps.project_slug ? linkedRun.phase : null
    const linkedLive = unreadable || (linkedPhase !== null && !['done', 'failed', 'stopped'].includes(linkedPhase))
    // The clause that replaces "…it will dispatch automatically…" when nothing
    // was queued. Promising an automatic re-fire that cannot come is the thing
    // that made the surviving row dangerous rather than merely wrong.
    const notQueuedClause =
      deps.holds === undefined
        ? 'and NOTHING WAS QUEUED — this caller wired no hold store, so re-dispatch the card yourself once it clears.'
        : `and nothing stays queued — run ${(linkedRunId ?? '').slice(0, 8)} is already bound to this card and ` +
          'owns it; the card moves when that run finishes, not when this clears.'
    return { queued: deps.holds !== undefined && !linkedLive, linkedLive, linkedRunId, notQueuedClause }
  }
  // A FAILED HOLD WRITE IS REPORTED, NEVER THROWN (Argus r9 BLOCKER). Both arms
  // are DB writes and both can fail — a locked SQLite file, a closed handle, a
  // full disk. Two of the three refusal gates that call this run OUTSIDE every
  // try/catch in this function (the blocker gate, and the branch-liveness gate
  // whose probe `try` closes before the write), so a throw there escaped
  // `dispatchBoardBoundBuild` as a REJECTED PROMISE and turned a typed,
  // recoverable refusal into an unhandled failure at the surface — both callers
  // (`trident/code-command.ts`, `open/composer.ts`) await this function with no
  // local try, and only the sweep (`trident/dispatch-holds.ts`) contains its
  // own per-hold throws. So the throw is contained HERE, once, for every gate,
  // and REPORTED instead: the caller still gets its typed refusal — the card
  // really is blocked, the branch really is held, and that fact is what the
  // caller acts on — with the QUEUE CLAIM retracted in both the prose and the
  // shape, which is the one thing a failed write actually invalidates.
  const queueHold = async (entry: DispatchHoldInput, decision: QueueDecision): Promise<QueueOutcome> => {
    const attempted = decision.queued ? 'upsert' : 'delete'
    if (deps.holds === undefined) return { queued: false, error: null, attempted }
    try {
      // NOT WRITING IS NOT ENOUGH — DELETE WHAT IS ALREADY THERE (Argus r3
      // BLOCKER, generalised in r4). Skipping the upsert only keeps THIS refusal
      // from queuing the card; a row seeded by an EARLIER dispatch, before the
      // card had a live run, still survives it and re-fires once that run
      // terminalizes. The delete is idempotent and scoped to this (project, card)
      // pair, which is the hold table's own key.
      if (decision.queued) await deps.holds.upsert(entry)
      else await deps.holds.deleteByItem(deps.project_slug, board_item_id)
    } catch (err) {
      return { queued: false, error: err instanceof Error ? err.message : String(err), attempted }
    }
    return { queued: decision.queued, error: null, attempted }
  }
  // The sentence appended to a refusal whose queue write failed. WHICH write
  // failed decides what it says (Argus r10 BLOCKER) — the two failures are not
  // the same fact and the safe action differs:
  //  - `upsert` threw: nothing was queued, so the card really will NOT move on
  //    its own and the operator must re-dispatch it.
  //  - `delete` threw: the row this arm exists to REMOVE is still there. That
  //    survivor is exactly the one `buildDispatchHoldSweep` re-fires once the
  //    card's linked run terminalizes, so telling the operator to re-dispatch
  //    would invite a SECOND lane onto the card. Say the stale hold is still
  //    queued and may re-fire, and ask for it to be cleared instead.
  const queueFailureClause = (outcome: QueueOutcome): string => {
    if (outcome.error === null) return ''
    if (outcome.attempted === 'delete') {
      return (
        ` NOTE: a STALE hold for this card could not be REMOVED — the hold store failed (${outcome.error}) — so an ` +
        'earlier queue entry may still exist and could re-dispatch this card on its own once the run that owns it ' +
        'finishes; clear that hold before dispatching the card yourself, or two lanes will build it.'
      )
    }
    return (
      ` NOTE: nothing could be QUEUED — the hold store failed (${outcome.error}) — so this card will NOT ` +
      're-dispatch on its own; re-dispatch it yourself once the reason above clears.'
    )
  }

  // (3c) PROJECT ADMISSION (#1237) — the last gate before any git/gh/row work.
  // The run id is minted HERE so the durable lease names the run the row will be
  // created with; `createIfClaimsAvailable` below is handed the same id.
  const runId = crypto.randomUUID()
  const projectLease = await deps.projectAdmission.admit(runId)
  if (projectLease.status === 'fenced') {
    // QUEUED, like `branch_live`: the fence ends when admission reopens, and the
    // hold sweep re-runs this gate on its cadence. The stored kind stays inside
    // migration 0139's CHECK (`'path'`, exactly as `branch_live` records it);
    // the SURFACE kind is `'fence'`. Decided synchronously with the write — see
    // `queueDecision` for why the answer may not be carried across an await.
    const decision = queueDecision()
    const message =
      `Refused: this project is fenced for maintenance (${projectLease.phase ?? 'reopening'}) and admits no ` +
      'new build right now. Nothing was dispatched; ' +
      (decision.queued
        ? 'this card is QUEUED and starts automatically when admission reopens.'
        : decision.notQueuedClause)
    const outcome = await queueHold(
      {
        project_slug: deps.project_slug,
        board_item_id,
        task: input.task,
        payload: holdPayload,
        hold_kind: 'path',
        hold_reason: message,
        held_on_run_id: null,
      },
      decision,
    )
    log.warn('dispatch_project_fenced', {
      project: deps.project_slug,
      item: board_item_id,
      phase: projectLease.phase,
      queued: outcome.queued,
      ...(outcome.error !== null ? { hold_write_failed: outcome.error } : {}),
    })
    return {
      ok: false,
      code: 'project_fenced',
      message: message + queueFailureClause(outcome),
      ...(outcome.queued ? { hold: { kind: 'fence' as const } } : {}),
    }
  }
  if (projectLease.status === 'unknown') {
    // NOT queued, and nothing deleted: a sweep has no condition to re-test for a
    // scope that is not a live project, and an existing hold is left for the
    // sweep's own policy (it retains one whose project may yet be restored).
    log.warn('dispatch_project_unknown', { project: deps.project_slug, item: board_item_id })
    return {
      ok: false,
      code: 'project_unknown',
      message:
        `Refused: the board scope "${deps.project_slug}" is not a live project, so no build can be admitted ` +
        'for it. Nothing was dispatched and nothing was queued.',
    }
  }
  slot.lease = projectLease

  // (4) DECLARED BLOCKERS — do not fan out onto an unmet dependency.
  //
  // A blocker id that resolves to NO card is treated as CLEARED. Judgment call,
  // documented: the board's removal path HARD-DELETES cards, so waiting forever
  // on a ghost would wedge this card (and everything queued behind it) with no
  // event that could ever release it.
  for (const blocker_id of item.blockers ?? []) {
    const blocker = deps.board.get(deps.project_slug, blocker_id)
    if (blocker === null) continue
    const status = blocker.status
    if (status === undefined || status === 'done') continue
    const decision = queueDecision()
    let message =
      `Plan item "${board_item_id}" is blocked by "${blocker_id}" ("${blocker.title}", status ${status}) — ` +
      (decision.queued ? 'it will dispatch automatically when the blocker completes.' : decision.notQueuedClause)
    if (status === 'failed') {
      message += ' That blocker has FAILED; it must be retried before this card can start.'
    }
    const outcome = await queueHold(
      {
        project_slug: deps.project_slug,
        board_item_id,
        task: input.task,
        payload: holdPayload,
        hold_kind: 'blocker',
        hold_reason: message,
        held_on_blocker_id: blocker_id,
      },
      decision,
    )
    return {
      ok: false,
      code: 'held',
      message: message + queueFailureClause(outcome),
      // The `hold` shape is a claim that a queue entry EXISTS; only make it when
      // one was really written — which now includes "the write did not throw".
      ...(outcome.queued ? { hold: { kind: 'blocker' as const, blocker_id } } : {}),
    }
  }

  // Resolve THIS project's own git-initialized build workspace from the owner
  // HOME base. A brand-new project has no code repo; without this the run row's
  // repo_path would be the HOME dir (not a git repo) and the inner workflow's
  // `git worktree add` would fail at forge-init before Forge ever ran. Merge-mode
  // detection then probes the RESOLVED workspace (a fresh local project
  // has no origin, so merge mode correctly degrades to 'local').
  let repo_path: string
  let merge_mode: MergeMode
  let execution_strategy = item.execution_strategy ?? null
  let strategy_rationale = item.strategy_rationale ?? null
  let strategy_plan = item.strategy_plan ?? null
  let strategy_source = item.strategy_source ?? null
  // The composition root's credentialed runner, when it wired one. The
  // `secretsStore` + `owner_handle` branch below still overrides it for a direct
  // caller that hands its own credential source instead.
  let credentialedRunner: EnvCapableHostRunner | undefined = deps.hostRunner
  try {
    repo_path = await (deps.resolveBuildRepo ??
      ((home, slug, repo) => ensureProjectBuildWorkspace(home, slug, undefined, repo).then((r) => r.build_repo_path)))(
      deps.repo_path,
      deps.project_slug,
      item.repo_name,
    )
    let mergeModeFn = deps.resolveMergeMode
    if (deps.secretsStore !== undefined && deps.owner_handle !== undefined) {
      const loadEnv = async (): Promise<Record<string, string>> => {
        try {
          return githubProcessEnv(await readGitHubToken(deps.secretsStore!, asOwnerHandle(deps.owner_handle!)))
        } catch {
          // Degrade to {} because a throwing origin probe becomes silent 'local', removing the PR gate.
          return {}
        }
      }
      const credential: PublisherCredentialSource = {
        owner_handle: deps.owner_handle,
        source: 'the instance secrets store',
        load: loadEnv,
      }
      const lazyRunner = makeLazyCredentialedHostRunner(loadEnv)
      credentialedRunner = (command, cwd, extraEnv) =>
        extraEnv === undefined
          ? lazyRunner(command, cwd)
          : makeCredentialedHostRunner(extraEnv)(command, cwd)
      if (mergeModeFn === undefined) {
        mergeModeFn = (path) => detectMergeMode(path, defaultGitModeProbe(credential, credentialedRunner!))
      }
    }
    if (mergeModeFn === undefined) {
      throw new Error('resolveMergeMode or a credentialed secretsStore + owner_handle is required')
    }
    merge_mode = await mergeModeFn(repo_path)
  } catch (err) {
    return {
      ok: false,
      code: 'backend_error',
      message: `could not prepare the build workspace for "${deps.project_slug}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // A card-owned counter is independent of its movable run link. Refuse at the
  // dispatch chokepoint when it is spent so exhaustion cannot masquerade as a
  // newly completed run or buy another bootstrap before failing. This applies
  // while planning is pending and under either selected strategy.
  //
  // THE CARD'S OWN SNAPSHOT IS THE ONLY THING THIS READS, and the review that
  // found it reading `deps.max_task_iterations` as a fallback is why the sentence is
  // here. A card with no snapshot has spent nothing — its counter is 0 — so the
  // fallback could never refuse a card that had genuinely spent anything. What it
  // COULD do is answer a question it had not been asked: comparing 0 against the
  // DISPATCH CEILING refused every fresh card when that ceiling was a deliberate
  // `0` ("no iterations — let the LOOP refuse the first one", pinned in
  // `retry-resumes-checkpoint.test.ts`), and it answered an INVALID ceiling (`-5`)
  // with "this card is exhausted" — a config fault reported as a budget fact, i.e.
  // "I could not read the cap" wearing "the cap is spent" as a mask. The cap this
  // guard compares against is a value the store has already validated on the way
  // in (`max_task_iterations IS NULL OR >= 0`, migration 0142 — 0141's `>= 1` was the
  // rule that disagreed with the run store, and #728 resolved the disagreement in
  // the store's favour), so it is a cap, not an input.
  //
  // BOTH `??` HERE ARE NULLISH, NOT TRUTHY, AND THAT IS LOAD-BEARING. A cap of `0`
  // is a real cap meaning "no iterations" (`TridentInvalidTaskCapError`'s docblock
  // in `store.ts` says so in as many words), so it must survive the coalesce and
  // reach the comparison as `0`, where `0 >= 0` refuses. Rewriting either of these
  // as `||` would read a zero cap as ABSENT and admit the very card the owner
  // capped at nothing.
  const cardTaskIteration = item.task_iteration ?? 0
  const cardTaskCap = item.max_task_iterations ?? null
  if (!isTaskIteration(cardTaskIteration) || (cardTaskCap !== null && !isTaskCap(cardTaskCap))
    || (cardTaskIteration > 0 && cardTaskCap === null)) {
    return { ok: false, code: 'backend_error', message: 'The card iteration budget is corrupt. Nothing was dispatched.' }
  }
  if (cardTaskCap !== null && cardTaskIteration >= cardTaskCap) {
    return {
      ok: false,
      code: 'task_budget_exhausted',
      message:
        `Refused: Plan item "${board_item_id}" exhausted its Task iteration budget ` +
        `(${cardTaskIteration}/${cardTaskCap}). No run was created; completion was not reported.`,
    }
  }

  const slug = slugifyTask(input.task)
  const branch = `trident/${slug}`

  /**
   * THE ONE `branch_live` REFUSAL, composed in one place — the tail that says
   * what will re-fire the card, the hold row (or the delete), the log line and
   * the returned shape.
   *
   * IT HAS TWO CALL SITES because the condition has two moments. Gate (4b)
   * below is the cheap look BEFORE the workspace is written; the admission
   * refusal further down is the same fact re-taken INSIDE the insert's own
   * transaction, which is the only place a competitor that bound the branch
   * during (4b)'s worktree probe can still be caught (Argus r7 BLOCKER: that
   * race used to escape as `UNIQUE constraint failed` → `backend_error` → HTTP
   * 500, with no hold queued and therefore nothing to re-fire the card). Both
   * moments owe the caller the same sentence and the same queue entry, so
   * neither may compose its own.
   *
   * EVERY DECISION IS TAKEN HERE, after the caller's last await: `queueDecision`
   * must not be carried across one — see its own note.
   */
  const refuseBranchLive = async (
    body: string,
    held_on_run_id: string | null,
  ): Promise<BoardBoundBuildResult> => {
    const decision = queueDecision()
    const tail =
      deps.holds === undefined
        ? ' Nothing was dispatched, and NOTHING WAS QUEUED — this caller wired no hold store, so re-dispatch the ' +
          'card yourself once the holder is gone.'
        : decision.linkedLive
          ? ` Nothing was dispatched now, and nothing stays queued — run ${(decision.linkedRunId ?? '').slice(0, 8)} is already ` +
            'bound to this card and owns it; the card moves when that run finishes.'
          : ' Nothing was dispatched now; this card is QUEUED and re-checked on every sweep, so it dispatches ' +
            'automatically once nothing live holds the branch.'
    const message = body + tail
    // QUEUE IT — a refusal is not a rejection. This condition ENDS the moment
    // the live lane finishes, which is exactly the shape the hold queue was
    // built for: without a row here the card is dropped on the floor and only
    // a human re-dispatching it ever revives it, while the path-claim gate
    // below (the same "a live run owns this") auto-re-fires via
    // `buildDispatchHoldSweep`. The sweep re-runs EVERY gate, so a still-live
    // branch simply refreshes this row's reason and a freed one dispatches.
    //
    // `hold_kind: 'path'` and not a new `'branch'`: migration 0139 pins the
    // column to CHECK (hold_kind IN ('blocker','path')), widening it needs a
    // non-idempotent table rebuild the migrations contract forbids, and a
    // held branch IS the same fact the 'path' kind already records — a live
    // run owns a resource this dispatch needs. The reason string carries the
    // detail; nothing reads the kind to decide behaviour.
    //
    // …UNLESS THE CARD'S OWN LIVE RUN IS THE REASON. `queueHold`'s other arm
    // DELETES instead, because writing a row anyway — or leaving one an
    // earlier dispatch wrote — is what let a stopped/failed card auto-restart
    // once that run terminalized. See the note at `queueDecision`.
    const outcome = await queueHold(
      {
        project_slug: deps.project_slug,
        board_item_id,
        task: input.task,
        payload: holdPayload,
        hold_kind: 'path',
        hold_reason: message,
        held_on_run_id,
      },
      decision,
    )
    // SAY SO. The refusal used to be silent in the logs as well as in the
    // queue, so a card that stopped moving had no trace anywhere.
    log.warn('dispatch_branch_live', {
      project: deps.project_slug,
      item: board_item_id,
      branch,
      held_on_run_id,
      ...(outcome.error !== null ? { hold_write_failed: outcome.error } : {}),
    })
    return {
      ok: false,
      code: 'branch_live',
      message: message + queueFailureClause(outcome),
      // SAY IT IS QUEUED IN THE SHAPE, NOT ONLY IN THE PROSE. `held` and the
      // path-claim refusal both carry this; a `branch_live` without it made a
      // queued card look dropped to every structured consumer. It is present
      // ONLY when a hold row was really written: with no store — or behind the
      // card's own live run, or after a THROWING write (Argus r9) — nothing was
      // persisted, and a `hold` shape then claims a queue entry that does not
      // exist.
      ...(outcome.queued
        ? {
            hold: {
              kind: 'branch' as const,
              branch,
              ...(held_on_run_id !== null ? { holding_run_id: held_on_run_id } : {}),
            },
          }
        : {}),
    }
  }

  // A gh outage or malformed response is no evidence and therefore degrades
  // open, matching detectMergedPr's rule that absence of evidence is not a merge.
  if (merge_mode === 'pr') {
    // A CALLER THAT SUPPLIES `hostRunner` AND NOT `landedProbe` GETS A PROBE IT DID
    // NOT ASK FOR (Argus r18, noted rather than changed). `credentialedRunner` is
    // seeded from `deps.hostRunner`, so this pre-existing fallback now also fires
    // for hostRunner-only callers and manufactures a merged-PR probe out of that
    // runner. That is the intended reading — the two are the same credentialed
    // remote read, and the boot-wiring test pins the pairing so every production
    // site passes both — but it is a behaviour change for anyone who wires only
    // the runner, and it is here rather than at the call site, so it is said here.
    const probe =
      deps.landedProbe ??
      (credentialedRunner !== undefined ? makeDispatchLandedProbe(credentialedRunner) : undefined)
    // The INVOCATION is inside the try, not just the promise: a NON-async probe
    // throws at the call site, before any promise exists for a `.catch` to attach to
    // (Argus r7, applied here too — the seed probe below already had this shape and
    // its docblock claimed parity this call did not yet have).
    let landed: Awaited<ReturnType<NonNullable<typeof probe>>> | null = null
    try {
      landed = probe === undefined ? null : await probe(repo_path, branch)
    } catch {
      landed = null // no evidence — degrade open, exactly as a rejected promise does
    }
    if (landed !== null) {
      // A MERGED PR is enough to refuse even when ancestry is false/unknown:
      // squash merges make the original head un-ancestral while the work is landed.
      const message = `Refused: this card's work already merged as #${landed.pr} — branch ${branch} has a MERGED PR${landed.merged_at ? ` (merged ${landed.merged_at})` : ''}${landed.head_on_base === true ? ` and its head is contained in origin/${landed.base}` : ''}. Please verify the card instead of rebuilding: check what #${landed.pr} shipped; mark the Plan item done if complete, or put the unshipped half on a NEW Plan item with its own title. Nothing was dispatched.`
      return { ok: false, code: 'already_landed', message }
    }
  }

  // (4b) BRANCH LIVENESS — never aim a second lane at a branch something live
  // already holds. Measured 2026-09-01: a fire-turn settle timeout wrote a run
  // off as `failed` while its detached workflow kept building this exact
  // branch; the terminal wake then instructed a relaunch and only the
  // wrong-base guard's SHAPE check stopped two lanes building one branch. So
  // refuse on LIVENESS, two positive checks, cheapest first:
  //   (a) the store — a NON-terminal run on this repo already carries this
  //       branch (also catches the orchestrator's launched-but-unobserved
  //       hold, which keeps the row non-terminal on purpose);
  //   (b) the worktrees — a linked worktree has the branch checked out under
  //       a lock naming a LIVE pid (signal-0 + recycled-pid starttime check —
  //       the same probe the fire-evidence gate uses).
  // POSITIVE EVIDENCE ONLY: no worktree, an unlocked or unparseable lock, a
  // dead or recycled pid, a throwing probe, a terminal same-branch row — all
  // proceed exactly as before. Worktree mtime is NOT consulted here: dispatch
  // has no fire clock to compare against, and recency without a reference is
  // just another arbitrary threshold. A refusal creates no RUN and must never
  // advise deleting the branch — it is the live lane's workspace.
  //
  // NO `bound_pr` EXEMPTION, deliberately (Argus r6, minor). A review-only round
  // does not build, so exempting it looks free — but a `bound_pr` dispatch
  // creates a RUN, and that run's fix rounds do build, on this exact branch,
  // under whatever is still holding it. The cost of refusing is bounded and
  // self-clearing: the refusal QUEUES the card WITH its `bound_pr` (see
  // `holdPayload`), and the sweep replays the same review round the moment the
  // holder is gone. The cost of exempting is the two-lanes-on-one-branch
  // outcome this whole gate exists to prevent.
  //
  // IT RUNS *AFTER* `already_landed`, and the order is load-bearing. Both
  // refuse and both dispatch nothing, so the only thing at stake is which
  // sentence the operator reads — and "already merged as #N, verify the card"
  // is strictly more actionable than "something is building this branch" for a
  // card whose work has SHIPPED (the 2026-08-17 incidents this file's header
  // names). Running the liveness probe second costs one `gh` call on the rarer
  // path; running it first cost the clearer diagnosis on the common one.
  {
    const holdingRun = deps.store.listNonTerminalByRepo(repo_path).find((r) => r.branch === branch)
    // THE REFUSAL BODY IS BUILT WITHOUT ITS TAIL, and the tail is appended below
    // — because the tail states what will re-fire the card, and that is only
    // knowable AFTER the last await in this gate (the holder probe). Deciding it
    // here, ahead of the probe, is how the snapshot bug got in: a competing
    // dispatch binding the card DURING the probe left this refusal promising an
    // automatic re-fire and writing the row to make it happen.
    let body: string | null = null
    let held_on_run_id: string | null = null
    if (holdingRun !== undefined) {
      held_on_run_id = holdingRun.id
      body =
        `Refused: branch ${branch} is already being built by live run ${holdingRun.id.slice(0, 8)} ` +
        `(${holdingRun.slug}, phase ${holdingRun.phase}). Resolve that run first — watch it finish, or stop it ` +
        `explicitly if it is truly dead — and never delete the branch under it.`
    } else {
      let holder: BranchHolderProbe | null = null
      try {
        holder = await (deps.branchHolderProbe ?? defaultBranchHolderProbe)(repo_path, branch)
      } catch {
        holder = null // a failed look is not a holder — positive evidence only
      }
      if (holder !== null && holder.pid_live) {
        body =
          `Refused: branch ${branch} is held by live worktree ${holder.worktree_basename}` +
          (holder.pid !== null ? ` (lock pid ${holder.pid}, alive)` : '') +
          ` — a lane appears to be building this branch right now even though no live run row says so ` +
          `(a launcher timeout may have mislabeled its run as failed). Resolve the holder first: check ` +
          '`git worktree list --porcelain` and that pid; never delete the branch under a live lock.'
      }
    }
    // WHAT WILL ACTUALLY RE-FIRE THIS CARD is decided inside `refuseBranchLive`
    // — after every await in this gate, synchronously with the write that
    // follows. See `queueDecision` for why the answer may not be carried across
    // an await.
    if (body !== null) return await refuseBranchLive(body, held_on_run_id)
  }

  // (4c) SALVAGE-RESUME SEED — a build that EXISTS is routed to review, never
  // rebuilt.
  //
  // The measured waste this closes: 33 runs in 30 days reached `forge-done` (the
  // build succeeded and committed) and then died without a review. Today the
  // re-dispatch of that card creates a row with null checkpoints, so `launch()`
  // treats it as a FRESH launch — which either rebuilds the identical work from
  // scratch or, worse, gets refused outright by the leftover-branch guard because
  // the previous run's own commits are sitting on the branch.
  //
  // So: when the card's latest TERMINAL run is built-but-never-reviewed and the
  // live branch tip is still EXACTLY the commit that run recorded, carry its
  // checkpoint evidence onto the new row. Nothing else changes — `launch()` reads
  // `inner_checkpoint` and the existing `classifyResume` machinery routes
  // `forge-done` / `fix-round-N` / `outer-published:*` to review mode — except a
  // bare `forge-done` in TASK mode, which that machinery rebuilds
  // ('execution_strategy-progress-unknown'), so the persisted execution strategy is an input to the
  // seed decision rather than something read after the row exists.
  //
  // THE CHECKPOINT IS NOT THE WHOLE OF CONTINUITY (#519). The card's Task SPEND is
  // the other durable half: `refireNextTask` bounds the run's remaining loop on
  // `task_iteration + 1 > max_task_iterations` and `buildWorkflowArgs` threads the counter
  // to the inner workflow's plan-refresh cadence, so a re-dispatch that writes 0 hands
  // a mid-budget run a fresh count and lands its periodic full re-plan on the wrong
  // iteration of the same work. `carriedTaskBudget` (run-disposition.ts) owns that
  // decision — BOTH halves or neither, and the cap is min(prior, this dispatch) so a
  // re-dispatch may tighten the budget and never loosen it. It is deliberately NOT
  // gated on the commit proof; see the ladder below and the file header for why the
  // link is the identity and the task text is not.
  //
  // THE HEAD EQUALITY IS LOAD-BEARING, not a nicety. It is what makes ADOPTING the
  // prior run's commit — its checkpoint, head, findings and base pin — safe: the
  // branch provably still holds this lane's own recorded commit. Seeding does NOT
  // remove the ownership check; since Argus r3 that check runs for every row that
  // has not fired (`freshLaunch || seeded_resume`, orchestrator.ts), and a
  // legitimate seed PASSES it because the tip provably descends from the carried
  // base pin (`ownCrashLeftover`). A moved tip, an absent ref, an unreadable one,
  // or any non-qualifying prior (approved, reviewed-and-rejected,
  // died-before-build) all fall through to a byte-identical fresh dispatch with
  // the guard intact. A thrown probe is treated as no evidence for the same reason
  // the landed probe is.
  //
  // AND THE PROOF IS TAKEN AGAINST THE REF THE LAUNCH WILL CONSULT (see
  // `defaultReadBranchTip`), not merely against a local ref — otherwise the seed
  // predicts a resume the workflow was never going to perform. It is still a proof
  // taken one tick BEFORE it is consumed, so `launch()` RE-VERIFIES it against the
  // live head it reads anyway. That re-verification is deliberately NARROW: only a
  // MOVED tip — a real 40-hex that is not the recorded one — drops the seed. An
  // absent branch and an unreadable read are not evidence of another lane's work,
  // so they leave the seed alone and are answered downstream by `classifyResume`'s
  // own rebuild (orchestrator.ts, "SEEDED RESUME — REVALIDATED AT LAUNCH"). This
  // check is the cheap filter; that one is the authority.
  //
  // IT RUNS AFTER THE LIVENESS REFUSAL ABOVE, and the order is load-bearing in one
  // direction only: a dispatch that gate refuses creates no row, so there is nothing
  // for a seed to be carried onto and its branch-tip read would be a remote call made
  // for an answer nobody consumes. The two gates are otherwise independent — liveness
  // asks about NON-terminal rows and live worktree locks, this one about the card's
  // latest TERMINAL row — so neither can mask the other.
  let seed: ReturnType<typeof builtButNeverReviewedSeed> = null
  let typedSource: ReturnType<typeof retryModeSource> = null
  // WHY THE SEED DECISION IS NAMED OUT LOUD (#519). Every arm below that declines
  // falls back to a byte-identical FRESH dispatch, and a fresh dispatch looks
  // exactly like a first attempt: a row with a null checkpoint and `task_iteration`
  // 0. So the one place the refusal existed at all was the absence of two column
  // values, which no operator reads and no journal records — a card that silently
  // rebuilt finished work was indistinguishable from a card that had never been
  // built. The reason is decided on the same lines that decide the seed and
  // emitted once, after the last await, so the line reports the decision that was
  // actually made rather than one it was heading for.
  let seedReason: ResumeSeedReason = 'no_prior_terminal_run'
  // DIAGNOSTIC ONLY — never the decision. `latestTerminalBySlug` answers "is there ANY
  // prior for this work", which is the right question for a log line and the WRONG one
  // for "is there a prior THIS CARD is bound to": it orders by `started_at DESC LIMIT 1`
  // over a slug that `slugifyTask` TRUNCATES at 35 characters, so a colliding card's
  // newer run wins. See `namedPrior` below for why that mattered.
  const anyPriorForThisWork = deps.store.latestTerminalBySlug(deps.project_slug, slug)
  // THE CARD'S TASK BUDGET, carried separately from the commit and gated on the
  // STRONG identity alone — see `carriedTaskBudget` (run-disposition.ts). Null for
  // every dispatch with neither a card snapshot nor a prior to inherit from.
  let budget: { task_iteration: number; max_task_iterations: number } | null =
    item.max_task_iterations !== undefined && item.max_task_iterations !== null
      ? {
          task_iteration: item.task_iteration ?? 0,
          max_task_iterations: Math.min(item.max_task_iterations, deps.max_task_iterations ?? item.max_task_iterations),
        }
      : null
  // THE SLUG IS NOT AN IDENTITY. `slugifyTask` truncates at 35 characters, so two
  // DIFFERENT cards whose titles agree on their first 35 slugged characters share
  // a slug — and therefore share `trident/<slug>` as a branch. Without a seed the
  // collision is caught downstream: the second card's dispatch is a fresh launch,
  // and the leftover-branch guard refuses a branch carrying commits the lane does
  // not own. A SEEDED row still RUNS that guard — but cannot be caught by it: the
  // seed carries the prior run's base pin, the colliding tip genuinely descends
  // from it, and `ownCrashLeftover` reads exactly that shape as "this lane's own
  // leftover". So the collision has to be caught HERE, by the task text — the only
  // column that distinguishes the two cards — or the second card silently adopts
  // the first card's unreviewed commit and sends it to review under the wrong
  // title. The head-equality probe cannot see it: on a collision the branch really
  // does hold the prior run's commit, which is
  // exactly the wrong-card case. The run row carries the FULL task text, so compare
  // that — an exact match is the same card; anything else falls through to the
  // byte-identical fresh dispatch with the guard intact. An edited title is a
  // false negative and costs only the rebuild that happened before this existed.
  //
  // AND THE CARD MUST NAME THAT RUN — THIS FAILS CLOSED (Argus r1 blocker, codex
  // veto). Task text is a PROXY for identity, and two distinct cards CAN carry
  // byte-identical text — at which point the second one adopts the first one's
  // unreviewed commit and sends it to review under the wrong title.
  // `linked_run_id` is the real link: since #340 the terminal reconcile KEEPS it on
  // failure, which is precisely the built-never-reviewed shape being seeded here,
  // so a genuine re-dispatch of the same card still names the run it is about.
  //
  // An earlier revision let an ABSENT link fall back to the task text alone,
  // tolerating that false positive to save a rebuild. That was the wrong side of the
  // trade: a link-less card could still inherit another card's checkpoint, head,
  // findings and base pin. So an absent link — null, undefined, or a whitespace-only
  // string — is now a REFUSAL to seed, exactly like a link naming a different run.
  // The cost is bounded and one-directional: that card takes the byte-identical
  // fresh dispatch it took before this seed existed, with the leftover-branch guard
  // intact. The saving is claimed only when the board itself says whose commit is
  // being adopted.
  const cardsPriorRun = typeof item.linked_run_id === 'string' ? item.linked_run_id.trim() : ''

  // THE PRIOR IS THE RUN THE CARD NAMES, LOADED BY ITS ID (final gate, blocker 1).
  //
  // It used to be `latestTerminalBySlug(project, slug)` — and then the ladder compared
  // that row's id against `linked_run_id`. So the decision was resolved through a LOSSY
  // DERIVED key and then checked against the EXACT key it had never used. Measured
  // consequence: card A links run A; a colliding card B (same first 35 slugged
  // characters, hence the same slug) produces a NEWER terminal run; retrying card A
  // compares its link against run B, takes `card_names_a_different_run`, and resets A to
  // a fresh budget. The exact defect this change exists to prevent, reached through the
  // lookup instead of through the comparison.
  //
  // THE TASK-TEXT COMPARISON DOES NOT SAVE IT, and that is the part worth remembering:
  // it defeats the 35-character collision for SEEDING, because it runs after the row is
  // chosen. Here the collision happens BEFORE any comparison, in the row selection — and
  // a guard downstream of a lossy lookup cannot recover what the lookup discarded.
  //
  // `linked_run_id` is an exact key that `attachRun` alone writes, so it is loaded
  // directly. What it may point at that is still unusable is enumerated in the ladder
  // below, each with its own reason rather than one catch-all.
  //
  // ONE COPY OF THE USABILITY RULE. An earlier draft computed `prior` here with the same
  // three predicates the ladder below applies, so mutating either copy was INERT — the
  // two-copies pattern this change has been removing everywhere else, reintroduced in the
  // fix for it. `prior` is now assigned ONLY in the ladder's final arm, so the ladder is
  // the single author of "usable" and every arm is observable.
  const namedPrior = cardsPriorRun === '' ? null : deps.store.get(cardsPriorRun)
  let prior: TridentRun | null = null
  //
  // THE LADDER ASKS THE STRONG QUESTION FIRST, and the order is the fix for a
  // MEASURED defect (adversarial review, P2). It used to compare the task text
  // BEFORE the link and refuse with `prior_run_is_a_different_card`. But the ▶ task
  // text is the card's design-doc BODY (`work-board-surface.ts`) and `slugifyTask`
  // truncates at 35 characters — so an owner clarifying that doc between two presses
  // keeps the same slug, the same branch and the same card while the full text
  // differs. Measured: a prior at `task_iteration 12` on `fix-round-3`, tip unmoved,
  // `linked_run_id` naming it, came back `prior_run_is_a_different_card` with a fresh
  // budget. Same lane, same card, and a diagnosis that was simply false. Clarifying a
  // spec doc between two presses is the most likely thing an owner does.
  //
  // So the LINK decides identity and the TEXT decides only whether the COMMIT may be
  // adopted. The asymmetry is the hazard model, not a compromise: adopting the wrong
  // card's unreviewed commit sends code to review under another card's title, while
  // the budget carry is MONOTONE (`min`) and can only TIGHTEN a bound. A wrong budget
  // carry under-authorises; a wrong commit carry authorises. This repo takes the
  // under-authorising side, so the weak proxy does not get to veto the strong
  // identity for a value that cannot authorise anything.
  //
  // EACH UNUSABLE SHAPE GETS ITS OWN REASON rather than one catch-all, because the
  // operator action differs: a cleared link is a status-dot advance, an unknown id is a
  // deleted row, a live run is something to wait for, and another project's run is a
  // wiring fault.
  if (cardsPriorRun === '') {
    seedReason = 'card_names_no_run'
  } else if (namedPrior === null) {
    seedReason = 'card_names_an_unknown_run'
  } else if (namedPrior.project_slug !== deps.project_slug) {
    seedReason = 'card_names_a_different_run'
  } else if (!isTerminalPhase(namedPrior.phase)) {
    seedReason = 'card_names_a_live_run'
  } else {
    // THE ONLY PLACE `prior` IS SET. Past all four arms the named run exists, belongs to
    // this project and is terminal, so it is the prior — and nothing below has to re-check
    // any of that.
    prior = namedPrior
    try {
      prior = await deps.store.reconcileTaskSpend(prior.id) ?? prior
    } catch {
      return { ok: false, code: 'backend_error', message: 'The previous run has an invalid iteration checkpoint. Nothing was dispatched.' }
    }
    if (execution_strategy !== null && prior.execution_strategy !== null && execution_strategy !== prior.execution_strategy) {
      return { ok: false, code: 'backend_error', message: 'The card and prior run disagree about the immutable execution strategy. Nothing was dispatched.' }
    }
    if (execution_strategy === null) {
      execution_strategy = prior.execution_strategy
      strategy_rationale = prior.strategy_rationale
      strategy_plan = prior.strategy_plan
      strategy_source = prior.strategy_source
    }
    // PAST THE LINK CHECK THIS CARD *IS* THIS RUN'S CARD, so the budget travels and
    // nothing below can veto it. `deps.max_task_iterations` is passed as the CEILING for
    // the carried cap — never as a gate on the carried ROUND, which is the mistake an
    // earlier revision of this branch made: a refused carry is a fresh row at 0, i.e.
    // a budget RESET wearing a guard's clothes.
    const read = carriedTaskBudget(prior, {
      execution_strategy,
      ...(deps.max_task_iterations !== undefined ? { max_task_iterations: deps.max_task_iterations } : {}),
    })
    // AN UNREADABLE PRIOR BUDGET REFUSES THE DISPATCH (final review round, defect four).
    // It cannot degrade to "carry nothing": for a COUNTER that is the reset, and the
    // reset is the whole defect this change exists to close. Both columns are
    // `INTEGER NOT NULL DEFAULT`, so an unreadable value is CORRUPT state rather than a
    // legacy shape — and while the card's spend is unknown, nothing can say whether its
    // budget is exhausted, so nothing may authorise another iteration. `unknown`
    // authorises nothing.
    //
    // `backend_error` rather than a new code, deliberately: corrupt persisted state IS a
    // backend fault, it is the code this chokepoint already uses for "the substrate is
    // wrong, not the request", and it needs no change in the HTTP surface that maps
    // these codes. It creates no row and queues no hold — a hold would replay against
    // the same corrupt row forever. The message names the run and the column so the
    // repair is a one-line UPDATE.
    if (!read.ok) {
      log.warn('dispatch_budget_unreadable', {
        project: deps.project_slug,
        item: board_item_id,
        prior_run_id: prior.id,
        column: read.column,
        value: typeof read.value === 'number' ? String(read.value) : JSON.stringify(read.value),
      })
      return {
        ok: false,
        code: 'backend_error',
        message:
          `Refused: this card's previous run ${prior.id.slice(0, 8)} carries an unreadable ` +
          `${read.column} (${typeof read.value === 'number' ? String(read.value) : JSON.stringify(read.value)}), ` +
          'so how much of its Task budget the card has spent cannot be established — and an unknown spend ' +
          'authorises no further iteration. Both columns are INTEGER NOT NULL, so this row is corrupt rather ' +
          `than legacy: repair code_trident_runs.${read.column} for run ${prior.id} and dispatch again. ` +
          'Nothing was dispatched.',
      }
    }
    // Neither a stale card snapshot nor a stale predecessor may refund spend.
    if (read.budget !== null) {
      budget = budget === null ? read.budget : {
        task_iteration: Math.max(budget.task_iteration, read.budget.task_iteration),
        max_task_iterations: Math.min(budget.max_task_iterations, read.budget.max_task_iterations),
      }
    }
    if (prior.task !== input.task) {
      // Only the COMMIT is refused, and the reason names which of the two facts
      // disagreed rather than claiming this is a different card.
      seedReason = 'prior_run_task_text_differs'
    } else {
      // Typed driver state, including a source-only retry that failed during
      // preparation, is validated under every predecessor's original identity.
      let source: ReturnType<typeof retryModeSource>
      try {
        source = prior.repo_path === repo_path && prior.branch === branch
          && prior.merge_mode === merge_mode && prior.execution_strategy === execution_strategy
          ? retryModeSource(deps.store, prior) : null
      } catch {
        return { ok: false, code: 'backend_error', message: 'The previous run has an invalid retry checkpoint. Nothing was dispatched.' }
      }
      // Typed state or a source link supersedes an inherited legacy projection.
      // An ineligible successor cannot revive its old fix-round seed.
      // A GOVERNED ITERATION THAT HANDED BACK (`task-built`) is carried as a
      // CONTINUATION seed rather than a review seed (spec item
      // a-retry-must-resume-from-the-checkpoint, gap 2): the retry still builds the next
      // task, but opens it with the committed plan instead of the full planning survey.
      const continuation = source !== null && isTaskContinuationSource(source)
      const candidate = source !== null ? {
        checkpoint: continuation ? TASK_CONTINUATION_CHECKPOINT : `fix-round-${source.state.checkpoint.round}`,
        head: source.state.checkpoint.head!, findings: null, base_sha: prior.base_sha!,
      } : deps.store.stageEvents(prior.id).some(event => event.stage === 'build-mode-state' || event.stage === 'build-retry-source')
        ? null : builtButNeverReviewedSeed(prior, { execution_strategy })
      if (candidate === null) {
        seedReason = 'prior_run_has_no_resumable_build'
      } else {
        // THE CONTINUATION'S TIP IS THE LOCAL REF, WHATEVER THE MERGE MODE. A Task
        // iteration commits locally and hands back without publishing (deferred waves
        // leave origin stale by design), so in `pr` mode origin legitimately lags the
        // recorded head and a remote read would refuse every such retry. It is the
        // same ref `prepareLaunch` re-verifies this seed against (launch-preparation.ts,
        // the `task-built` arm of `resolveResumeLiveHead`), so the dispatch proof
        // and the launch proof ask one question — and neither is the fire-time PR probe.
        const tipMode: MergeMode = continuation ? 'local' : merge_mode
        // The call itself sits inside the try: a NON-async probe throws at the
        // call, before any promise exists for a .catch to attach to (Argus r7).
        let tip = ''
        try {
          tip = await (
            deps.readBranchTip ??
            ((p: string, b: string, m: MergeMode) =>
              defaultReadBranchTip(p, b, m, credentialedRunner ?? spawnCapture))
          )(repo_path, branch, tipMode)
        } catch {
          tip = '' // a thrown probe is NO evidence — fall through to a fresh dispatch
        }
        const observed = tip.trim().toLowerCase()
        if (observed === candidate.head) {
          seed = candidate
          typedSource = source
          seedReason = continuation ? 'resumed_continuation' : 'resumed'
        } else {
          // THE TWO FAILURES ARE DIFFERENT FACTS AND ARE REPORTED AS SUCH. A 40-hex
          // tip that is not the recorded one means the branch moved — someone else's
          // commit, or a force-push — and resuming onto it would build against state
          // that is gone. An empty read means the branch is absent, or the ref could
          // not be read at all (an uncredentialed remote, a thrown probe); that is
          // not evidence of another lane's work, it is the absence of evidence. Both
          // refuse, because `unknown` authorises nothing; only the sentence differs,
          // and it is the sentence that tells an operator whether to look at the
          // branch or at the credential.
          seedReason = observed === '' ? 'branch_tip_unreadable_or_absent' : 'branch_tip_moved'
        }
      }
    }
  }
  // ONE value for the row's Task cap, decided HERE so nothing below can overwrite
  // it — the deps spread used to sit inside the create call BELOW the seed and
  // silently won, which is how a prior run's 5 became the ambient 20. `budget` has
  // already folded the deps cap in as a ceiling, so this is not "config ignored": it
  // is min(prior, config). Undefined for every dispatch with nothing to inherit,
  // which is byte-identical to before.
  const effectiveMaxTaskIterations = budget?.max_task_iterations ?? deps.max_task_iterations
  if (budget !== null && budget.task_iteration >= budget.max_task_iterations) {
    return { ok: false, code: 'task_budget_exhausted',
      message: `Refused: Plan item "${board_item_id}" exhausted its task iteration budget (${budget.task_iteration}/${budget.max_task_iterations}). No run was created.` }
  }

  // (5) FILE CONTENTION — do not start a build on a file a LIVE run already owns.
  //
  // The claim is derived from what actually exists at dispatch time: the task
  // text (always) plus the card's plan doc when `design_doc_ref` is a resolvable
  // `neutron-docs:` ref. An EMPTY derived set claims nothing and NEVER holds —
  // the gate cannot hold on paths it could not measure.
  //
  // Scoped to this repo: `listNonTerminalByRepo` is also the CLAIM RELEASE (a
  // terminal run is simply not returned), so no explicit clear exists to be
  // missed and a crashed run cannot strand a claim.
  let paths: string[]
  try {
    const planDoc =
      item.design_doc_ref !== null && item.design_doc_ref !== undefined
        ? await (deps.readPlanDoc ??
            ((slug, ref) => defaultReadPlanDoc(deps.repo_path, slug, ref)))(
            deps.project_slug,
            item.design_doc_ref,
          )
        : null
    paths = deriveClaimedPaths({ task: input.task, planDoc })
  } catch {
    // An unreadable plan doc degrades to the task text alone — never a throw.
    paths = deriveClaimedPaths({ task: input.task })
  }

  // SET THE INSTANT THE INSERT WINS, and read in the catch below. A failure that
  // happens AFTER the row exists (`board.attachRun`, `holds.deleteByItem`) must
  // never be re-diagnosed as "something else holds this branch" — the live row
  // the re-read would find is OUR OWN, and refusing on it would queue a hold
  // behind a run this very call created.
  let createdRunId: string | null = null
  // WHETHER THERE WAS A PRIOR TO ASK ABOUT — the condition that gates the
  // `dispatch_resume_seed` line below. The ladder above always names a reason
  // (`card_names_no_run` for a link-less card), so without this a card's very FIRST
  // dispatch would be told it "was not resumed" from a run that never existed.
  const hadPriorToAsk = prior !== null || cardsPriorRun !== '' || anyPriorForThisWork !== null
  // THE CARD SENTENCE HAS A NARROWER GATE: a prior THIS CARD can be said to have — a
  // resolved prior, a run the card links, or a slug match for the SAME task text. The
  // slug lookup (`anyPriorForThisWork`) is truncated at 35 characters (`slugifyTask`),
  // so it also finds ANOTHER card's run when two titles share a prefix, and a brand-new
  // card would be told on its first dispatch that it "was not resumed". A slug match
  // whose task text differs stays in the log line (`other_prior_for_slug`) and off the
  // card. One with the same text is this card's own work with its link lost, and a
  // retry of that must still SAY it did not resume (acceptance 1: silence fails).
  const cardHadPrior = prior !== null || cardsPriorRun !== ''
    || (anyPriorForThisWork !== null && anyPriorForThisWork.task === input.task)
  // THE CARD SENTENCE, built from the values this row is about to be written with —
  // the same seed, budget and cap the spreads below pass — so the note and the row
  // cannot disagree. Written once, at create; nothing later restates it.
  const resume_note = resumeNote(cardHadPrior ? seedReason : 'no_prior_terminal_run', {
    inner_checkpoint: seed?.checkpoint ?? null,
    inner_checkpoint_head: seed?.head ?? null,
    execution_strategy,
    task_iteration: budget?.task_iteration ?? 0,
    max_task_iterations: budget?.max_task_iterations ?? effectiveMaxTaskIterations ?? DEFAULT_MAX_TASK_ITERATIONS,
    budget_carried: budget !== null,
  })
  try {
    const admission = await deps.store.createIfClaimsAvailable({
      // THE ID THE PROJECT LEASE ALREADY NAMES (#1237) — minted at the admission
      // gate, so the lease's work reference is this run from before it exists.
      id: runId,
      slug,
      project_slug: deps.project_slug,
      repo_path,
      task: input.task,
      merge_mode,
      execution_strategy,
      strategy_rationale,
      strategy_plan,
      strategy_source,
      branch,
      // RECORD THE CLAIM on the run row, so the next dispatch's gate is a real
      // query against live state rather than an inference.
      claimed_paths: paths,
      resume_note,
      ...(input.bound_pr !== undefined && input.bound_pr !== null ? { bound_pr: input.bound_pr } : {}),
      // Only publication provenance travels through the exact card link. The
      // observational `pr` field may have been filled by discovery and cannot
      // establish ownership of a branch's existing PR.
      //
      // NOT gated on the task text, for the reason the ladder above states: the
      // LINK decides identity and the TEXT decides only whether the COMMIT may be
      // adopted. `prior` is past that link, so this card IS this run's card. An
      // owner clarifying the design doc between two presses used to drop the
      // carry, which then left the retry with no `owned_pr` and refused it against
      // its OWN published PR at `build-run.ts` fresh admission. Like the budget,
      // this value cannot authorise anything foreign: it is receipt-minted
      // publication provenance belonging to this very card's prior run.
      ...(prior !== null && prior.published_pr !== null ? { published_pr: prior.published_pr } : {}),
      // The salvage-resume seed, or nothing at all. `bound_pr` is deliberately NOT
      // seeded (it means review-only-never-publish) and no verdict is seeded — the
      // resumed run is going to review, it has not been to one. `base_sha` IS
      // seeded: a seeded checkpoint makes `launch()`'s `freshLaunch` false, so the
      // row would otherwise never pin a base and the publish-time "not cut from
      // origin/<base>" refusal could never fire on a salvaged run.
      ...(seed !== null
        ? {
            inner_checkpoint: seed.checkpoint,
            inner_checkpoint_head: seed.head,
            inner_checkpoint_findings: seed.findings,
            base_sha: seed.base_sha,
          }
        : {}),
      // THE CARD'S TASK BUDGET (#519) — BOTH HALVES OR NEITHER, and carried
      // independently of the commit seed above: the link is what proves this card owns
      // the prior run, and the task text has no bearing on a value that can only
      // tighten a bound. `create` refuses a round whose cap was not named, so the pair
      // is written as a pair here.
      ...(budget !== null
        ? {
            task_iteration: budget.task_iteration,
            max_task_iterations: budget.max_task_iterations,
            task_total: item.task_total ?? (prior?.execution_strategy ? prior.task_total : null),
          }
        : {}),
      // …and for every dispatch with nothing to inherit, the configured cap exactly as
      // before. `effectiveMaxTaskIterations` already prefers the carried one, so this
      // never overwrites it (the old deps spread sat BELOW the seed and did).
      ...(budget === null && effectiveMaxTaskIterations !== undefined
        ? { max_task_iterations: effectiveMaxTaskIterations }
        : {}),
      ...(deps.max_rounds !== undefined ? { max_rounds: deps.max_rounds } : {}),
      ...(deps.chat_id !== undefined ? { chat_id: deps.chat_id } : {}),
      ...(deps.thread_id !== undefined ? { thread_id: deps.thread_id } : {}),
      ...(deps.channel_kind !== undefined ? { channel_kind: deps.channel_kind } : {}),
    }, typedSource === null ? undefined : {
      priorRunId: typedSource.prior.id, eventId: typedSource.eventId,
      head: typedSource.state.checkpoint.head!,
    })
    if (!admission.ok) {
      if (admission.conflict === 'branch') {
        // THE RACE THE GATE ABOVE CANNOT WIN (Argus r7 BLOCKER). Gate (4b) read
        // the live rows, then awaited the worktree probe; a competing dispatch
        // that bound this branch inside that window was invisible to it and used
        // to surface HERE as `UNIQUE constraint failed: code_trident_runs.
        // project_slug, code_trident_runs.slug` — caught by the bare handler at
        // the bottom of this block, returned as `backend_error`, mapped to HTTP
        // 500 by `work-board-surface.ts`, and queueing NOTHING, so the card was
        // dropped rather than parked behind the lane that beat it. The store
        // re-takes the same liveness fact inside the INSERT's transaction and
        // reports it as a conflict; the refusal is the gate's, word for word.
        // SAY WHICH ARM COLLIDED (Argus r8 nit). `liveBranchOrSlugHolder` ORs two
        // facts — this repo's branch, and this project's slug — and the second
        // ignores `repo_path`, so a card dispatched against a DIFFERENT repo
        // collides on the slug while its branch is free. Reporting that as
        // "branch X is already being built" sends the operator to look at a
        // branch nothing holds. The refusal and the queue behaviour are identical
        // either way; only the diagnosis sentence changes.
        const holder = admission.holding_run
        const sameBranch = holder.repo_path === repo_path && holder.branch === branch
        return await refuseBranchLive(
          `Refused: ${
            sameBranch
              ? `branch ${branch} is already being built`
              : `this card's slug ${slug} is already being built (on another repo path, branch ${holder.branch ?? 'none'})`
          } by live run ${holder.id.slice(0, 8)} ` +
            `(${holder.slug}, phase ${holder.phase}) — it won the race for this card ` +
            'while this dispatch was still checking. Resolve that run first — watch it finish, or stop it explicitly ' +
            'if it is truly dead — and never delete the branch under it.',
          holder.id,
        )
      }
      // Decided AFTER the admission attempt — the last await before the write.
      const decision = queueDecision()
      const message =
        `"${admission.path}" is claimed by live run ${admission.holding_run.id.slice(0, 8)} ` +
        `(${admission.holding_run.slug}) — ` +
        (decision.queued
          ? 'this build will start automatically when that run goes terminal.'
          : decision.notQueuedClause)
      const outcome = await queueHold(
        {
          project_slug: deps.project_slug,
          board_item_id,
          task: input.task,
          payload: holdPayload,
          claimed_paths: paths,
          hold_kind: 'path',
          hold_reason: message,
          held_on_run_id: admission.holding_run.id,
        },
        decision,
      )
      return {
        ok: false,
        code: 'held',
        message: message + queueFailureClause(outcome),
        ...(outcome.queued
          ? {
              hold: {
                kind: 'path' as const,
                holding_run_id: admission.holding_run.id,
                path: admission.path,
              },
            }
          : {}),
      }
    }
    const run = admission.run
    createdRunId = run.id
    // The run exists: from here the project lease is the RUN's, released by its
    // terminal event (or restart reconciliation), never by this call's unwind.
    slot.kept = true
    // ONE LINE PER DISPATCH THAT HAD A PRIOR TERMINAL RUN TO ASK ABOUT, EMITTED ONLY
    // NOW — after the row exists (adversarial review, P3). It used to be emitted
    // before the plan-doc await and before three refusal returns, so a dispatch that
    // created NO row still logged `reason=resumed`: the one line an operator would
    // grep to find out what a retry inherited, reporting a retry that never happened.
    // Reading the values off the ROW rather than off `seed`/`budget` closes the other
    // half of that: the line now states what was WRITTEN, not what was intended.
    if (hadPriorToAsk) {
      log.info('dispatch_resume_seed', {
        project: deps.project_slug,
        item: board_item_id,
        branch,
        // WHAT THE CARD NAMES, WHAT WAS USED, AND WHAT ELSE EXISTS — three different
        // facts, three fields. Collapsing them into one `prior_run_id` is part of why the
        // slug-collision defect read as an ordinary "different run" refusal in the logs:
        // the line could not show that the row it refused on was not the row the card
        // named.
        card_names: cardsPriorRun === '' ? null : cardsPriorRun,
        prior_run_id: prior?.id ?? null,
        other_prior_for_slug:
          anyPriorForThisWork !== null && anyPriorForThisWork.id !== (prior?.id ?? '')
            ? anyPriorForThisWork.id
            : null,
        run: run.id,
        reason: seedReason,
        checkpoint: run.inner_checkpoint,
        // THE BOUND IS A PAIR, so both halves are reported: a round without the cap it
        // is measured against says nothing about whether the card is exhausted.
        task_iteration: run.task_iteration,
        max_task_iterations: run.max_task_iterations,
        // AND WHETHER THE CARD'S SPEND WAS INHERITED AT ALL, as its own field. A
        // `reason` of `resumed` describes the COMMIT; the budget is carried on a
        // different gate, so one word cannot honestly cover both.
        budget_carried: budget !== null,
        // The sentence the card shows, read OFF THE ROW like the fields above.
        note: run.resume_note,
      })
    }
    // BIND: light the item up (fork ⑂ + in_progress) the instant the build starts.
    // The durable loop fires + harvests by runId; terminal-reconcile clears it.
    await deps.board.attachRun(deps.project_slug, item.id, run.id)
    // A card that was previously HELD and has now finally dispatched clears its
    // queue entry (idempotent — a never-held card has no row to delete).
    await deps.holds?.deleteByItem(deps.project_slug, board_item_id)
    return { ok: true, run, merge_mode, execution_strategy }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // THE SAME RACE, ONE PROCESS FURTHER OUT. The store closes the in-process
    // window inside its own transaction, but two gateway processes on one DB
    // file can still both pass their reads, and the loser then meets the
    // live-only unique index (`(project_slug, slug)` WHERE phase NOT IN
    // terminal, migration 0138) as a raw SQLite error. That is the SAME fact —
    // something live already owns this card's branch — so it gets the same
    // refusal and the same hold rather than a 500 that queues nothing. Any
    // other failure is still a genuine `backend_error`.
    //
    // …AND THE SAME FACT ALSO ARRIVES AS `SQLITE_BUSY` (Argus r10 BLOCKER). Two
    // connections on one DB file collide in TWO ways, not one: the loser may
    // meet the unique index, or it may simply fail to take the write lock while
    // the winner's transaction is open and surface as
    // `BusyRetryExhaustedError: SQLITE_BUSY: exhausted 15 retries` — a message
    // the regex above does not and should not match. Mapping only the first
    // left the second returning `backend_error` (HTTP 500) with NOTHING queued,
    // which is the exact card-on-the-floor outcome the constraint arm exists to
    // prevent. So the error text is not the classifier: ASK THE STORE WHO HOLDS
    // THIS CARD NOW. A live row on this repo carrying the branch — or this
    // project's slug, the index's other arm — is the same fact and earns the
    // same refusal and the same hold. POSITIVE EVIDENCE ONLY, unchanged: no
    // visible holder (including the common BUSY case where the winner has not
    // committed yet) is still a genuine `backend_error`.
    const holder =
      createdRunId !== null
        ? null
        : ((): TridentRun | null => {
            try {
              return (
                deps.store
                  .listNonTerminalByRepo(repo_path)
                  .find(
                    (candidate) =>
                      candidate.branch === branch ||
                      (candidate.project_slug === deps.project_slug && candidate.slug === slug),
                  ) ?? null
              )
            } catch {
              return null // a failed look is not a holder
            }
          })()
    if (
      createdRunId === null &&
      (holder !== null || /UNIQUE constraint failed:\s*code_trident_runs\.(project_slug|slug)/i.test(detail))
    ) {
      // BELT AND BRACES, kept from Argus r8. The hold write itself no longer
      // throws — `queueHold` contains it for EVERY gate now (Argus r9 BLOCKER,
      // which is what made the two unwrapped gates above safe) and reports the
      // failure in the refusal instead. This catch remains only for the rest of
      // `refuseBranchLive`: its `queueDecision` re-read of the board and the
      // store, and the log line. Both run in a catch block already handling a
      // failed write, so a second failure here degrades to `backend_error`
      // rather than escaping as a rejected promise.
      try {
        return await refuseBranchLive(
          holder !== null
            ? `Refused: ${
                holder.branch === branch
                  ? `branch ${branch} is already being built`
                  : `this card's slug ${slug} is already being built (on another repo path, branch ${holder.branch ?? 'none'})`
              } by live run ${holder.id.slice(0, 8)} (${holder.slug}, phase ${holder.phase}) — it won the race for ` +
              `this card while this dispatch was still checking, and this dispatch's own write then failed ` +
              `(${detail}). Resolve that run first — watch it finish, or stop it explicitly if it is truly dead — ` +
              'and never delete the branch under it.'
            : `Refused: branch ${branch} is already being built by a live run that won the race for this card while ` +
              'this dispatch was still checking. Resolve that run first — watch it finish, or stop it explicitly if ' +
              'it is truly dead — and never delete the branch under it.',
          holder?.id ?? null,
        )
      } catch (holdErr) {
        return {
          ok: false,
          code: 'backend_error',
          message: `failed to start a build: ${detail}; and the branch-live hold could not be recorded: ${
            holdErr instanceof Error ? holdErr.message : String(holdErr)
          }`,
        }
      }
    }
    return {
      ok: false,
      code: 'backend_error',
      message: `failed to start a build: ${detail}`,
    }
  }
}
