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
 * Before creating the run it resolves THIS project's own git-initialized build
 * workspace (`<owner_home>/Projects/<project_slug>/code`, `ensureProjectBuildWorkspace`)
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
 * ralph detection helpers, and a STRUCTURAL board binder interface (satisfied
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
  detectRalphMode,
  defaultGitModeProbe,
  defaultRalphModeProbe,
  makeCredentialedHostRunner,
  makeLazyCredentialedHostRunner,
  type EnvCapableHostRunner,
  type PublisherCredentialSource,
} from './git-mode.ts'
import { ensureProjectBuildWorkspace } from './build-workspace.ts'
import { detectBaseBranch } from './merge.ts'
import { slugifyTask } from './slugify-task.ts'
import type { DispatchHoldInput, DispatchHoldPayload, DispatchHoldStore } from './dispatch-holds.ts'
import { deriveClaimedPaths } from './claimed-paths.ts'
import { defaultBranchHolderProbe, type BranchHolderProbe } from './fire-evidence-probes.ts'
import type { MergeMode, TridentRun, TridentRunStore } from './store.ts'

const log = createLogger('trident')

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
    linked_run_id?: string | null
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
  detachRun?(project_slug: string, run_id: string, outcome: 'done' | 'failed'): Promise<unknown>
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
  resolveBuildRepo?: (owner_home: string, project_slug: string) => Promise<string>
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
  /** Credential source for direct callers that do not inject a merge-mode resolver. */
  secretsStore?: Pick<SecretsStore, 'get'>
  owner_handle?: string
  /**
   * Resolve whether this build is governed (Ralph mode). Defaults to
   * `detectRalphMode` over the production probe — a `SPEC.md` at the git
   * root governs. An explicit resolver still wins. Test seam.
   */
  resolveRalph?: () => Promise<boolean>
  chat_id?: string | null
  thread_id?: string | null
  channel_kind?: Topic['channel_kind']
  max_rounds?: number
  max_ralph_rounds?: number
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

export type BoardBoundBuildResult =
  | { ok: true; run: TridentRun; merge_mode: MergeMode; ralph: boolean }
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
      code: 'held' | 'branch_live'
      message: string
      hold: {
        kind: 'blocker' | 'path' | 'branch'
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
 * Create a board-bound trident run, enforcing the required-item + ask-gate
 * chokepoint rules. Pure of any chat/tool framing — the two callers wrap the
 * typed result in their own response shape.
 */
export async function dispatchBoardBoundBuild(
  input: BoardBoundBuildInput,
  deps: BoardBoundBuildDeps,
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
    ...(deps.max_ralph_rounds !== undefined ? { max_ralph_rounds: deps.max_ralph_rounds } : {}),
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
  // + ralph detection then probe the RESOLVED workspace (a fresh local project
  // has no origin, so merge mode correctly degrades to 'local').
  let repo_path: string
  let merge_mode: MergeMode
  let ralph: boolean
  let credentialedRunner: EnvCapableHostRunner | undefined
  try {
    repo_path = await (deps.resolveBuildRepo ??
      ((home, slug) => ensureProjectBuildWorkspace(home, slug).then((r) => r.build_repo_path)))(
      deps.repo_path,
      deps.project_slug,
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
    // K10 restored the governed default (the refactor-window `resolveRalph =
    // false` override is gone): a root `SPEC.md` on the resolved workspace's
    // git root flips the build into Ralph mode via `detectRalphMode`. Neither
    // production caller (the `/code` chat command nor the agent-native
    // `work_board_dispatch_build` tool) supplies `resolveRalph`, so this is
    // the live behavior for every real build; an explicit caller-supplied
    // `deps.resolveRalph` (tests, or a future composition-root override)
    // still wins.
    ralph = await (deps.resolveRalph ?? (() => detectRalphMode(repo_path, defaultRalphModeProbe())))()
  } catch (err) {
    return {
      ok: false,
      code: 'backend_error',
      message: `could not prepare the build workspace for "${deps.project_slug}": ${err instanceof Error ? err.message : String(err)}`,
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
    const probe =
      deps.landedProbe ??
      (credentialedRunner !== undefined ? makeDispatchLandedProbe(credentialedRunner) : undefined)
    const landed = probe === undefined ? null : await probe(repo_path, branch).catch(() => null)
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
  try {
    const admission = await deps.store.createIfClaimsAvailable({
      slug,
      project_slug: deps.project_slug,
      repo_path,
      task: input.task,
      merge_mode,
      ralph,
      branch,
      // RECORD THE CLAIM on the run row, so the next dispatch's gate is a real
      // query against live state rather than an inference.
      claimed_paths: paths,
      ...(input.bound_pr !== undefined && input.bound_pr !== null ? { bound_pr: input.bound_pr } : {}),
      ...(deps.max_rounds !== undefined ? { max_rounds: deps.max_rounds } : {}),
      ...(deps.max_ralph_rounds !== undefined ? { max_ralph_rounds: deps.max_ralph_rounds } : {}),
      ...(deps.chat_id !== undefined ? { chat_id: deps.chat_id } : {}),
      ...(deps.thread_id !== undefined ? { thread_id: deps.thread_id } : {}),
      ...(deps.channel_kind !== undefined ? { channel_kind: deps.channel_kind } : {}),
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
    // BIND: light the item up (fork ⑂ + in_progress) the instant the build starts.
    // The durable loop fires + harvests by runId; terminal-reconcile clears it.
    await deps.board.attachRun(deps.project_slug, item.id, run.id)
    // A card that was previously HELD and has now finally dispatched clears its
    // queue entry (idempotent — a never-held card has no row to delete).
    await deps.holds?.deleteByItem(deps.project_slug, board_item_id)
    return { ok: true, run, merge_mode, ralph }
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
