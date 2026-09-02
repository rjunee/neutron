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
import type { DispatchHoldPayload, DispatchHoldStore } from './dispatch-holds.ts'
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
      // BOTH QUEUEING CODES CARRY THE HOLD. `branch_live` used to return a bare
      // code+message while the same block upserted a hold row — a refusal that
      // told the caller "nothing is queued" about a queued card. The `kind`
      // discriminator is the SURFACE's, not the column's: the stored `hold_kind`
      // stays `'path'` (migration 0139 pins that CHECK), and nothing reads the
      // stored kind to decide behaviour.
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
    let message =
      `Plan item "${board_item_id}" is blocked by "${blocker_id}" ("${blocker.title}", status ${status}) — ` +
      'it will dispatch automatically when the blocker completes.'
    if (status === 'failed') {
      message += ' That blocker has FAILED; it must be retried before this card can start.'
    }
    await deps.holds?.upsert({
      project_slug: deps.project_slug,
      board_item_id,
      task: input.task,
      payload: holdPayload,
      hold_kind: 'blocker',
      hold_reason: message,
      held_on_blocker_id: blocker_id,
    })
    return { ok: false, code: 'held', message, hold: { kind: 'blocker', blocker_id } }
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
  // IT RUNS *AFTER* `already_landed`, and the order is load-bearing. Both
  // refuse and both dispatch nothing, so the only thing at stake is which
  // sentence the operator reads — and "already merged as #N, verify the card"
  // is strictly more actionable than "something is building this branch" for a
  // card whose work has SHIPPED (the 2026-08-17 incidents this file's header
  // names). Running the liveness probe second costs one `gh` call on the rarer
  // path; running it first cost the clearer diagnosis on the common one.
  {
    const holdingRun = deps.store.listNonTerminalByRepo(repo_path).find((r) => r.branch === branch)
    // WHAT WILL ACTUALLY RE-FIRE THIS CARD — say that, and nothing more. Two
    // facts decide it, and the prose used to promise an automatic dispatch in
    // cases where neither holds:
    //  - A HOLD STORE. A caller that wired none persists nothing, so there is
    //    no queue for the card to be in (every production composer passes one,
    //    so this is the hypothetical arm — but a refusal must not claim a row
    //    it did not write).
    //  - THE SWEEP'S OWN DROP RULE. `buildDispatchHoldSweep` deletes a hold
    //    whose card already has a LIVE linked run, because that run owns the
    //    card. A refusal behind the card's own live run therefore queues
    //    nothing that survives the next sweep, and telling the operator to
    //    wait for a dispatch that will never come is worse than saying so.
    //
    // AND WHEN IT SAYS "NOTHING STAYS QUEUED", WRITE NOTHING (Argus r5 BLOCKER).
    // Saying it while still upserting the row was not merely inconsistent, it
    // was DANGEROUS: the sweep drops the hold only while the linked run is STILL
    // live AT SWEEP TIME. The moment that run terminalizes — or `board-reconcile`
    // detaches it — the surviving row falls through to `dispatchBoardBoundBuild`
    // and re-fires a card whose own run was stopped or failed on purpose. So the
    // prose and the write are now decided by ONE value.
    const linkedRunId = item.linked_run_id ?? null
    const linkedPhase = linkedRunId === null ? null : (deps.store.get(linkedRunId)?.phase ?? null)
    const linkedLive = linkedPhase !== null && !['done', 'failed', 'stopped'].includes(linkedPhase)
    const queued = deps.holds !== undefined && !linkedLive
    let tail: string
    if (deps.holds === undefined) {
      tail =
        ' Nothing was dispatched, and NOTHING WAS QUEUED — this caller wired no hold store, so re-dispatch the ' +
        'card yourself once the holder is gone.'
    } else if (linkedLive) {
      tail =
        ` Nothing was dispatched now, and nothing stays queued — run ${(linkedRunId ?? '').slice(0, 8)} is already ` +
        'bound to this card and owns it; the card moves when that run finishes.'
    } else {
      tail =
        ' Nothing was dispatched now; this card is QUEUED and re-checked on every sweep, so it dispatches ' +
        'automatically once nothing live holds the branch.'
    }
    let message: string | null = null
    let held_on_run_id: string | null = null
    if (holdingRun !== undefined) {
      held_on_run_id = holdingRun.id
      message =
        `Refused: branch ${branch} is already being built by live run ${holdingRun.id.slice(0, 8)} ` +
        `(${holdingRun.slug}, phase ${holdingRun.phase}). Resolve that run first — watch it finish, or stop it ` +
        `explicitly if it is truly dead — and never delete the branch under it.` + tail
    } else {
      let holder: BranchHolderProbe | null = null
      try {
        holder = await (deps.branchHolderProbe ?? defaultBranchHolderProbe)(repo_path, branch)
      } catch {
        holder = null // a failed look is not a holder — positive evidence only
      }
      if (holder !== null && holder.pid_live) {
        message =
          `Refused: branch ${branch} is held by live worktree ${holder.worktree_basename}` +
          (holder.pid !== null ? ` (lock pid ${holder.pid}, alive)` : '') +
          ` — a lane appears to be building this branch right now even though no live run row says so ` +
          `(a launcher timeout may have mislabeled its run as failed). Resolve the holder first: check ` +
          '`git worktree list --porcelain` and that pid; never delete the branch under a live lock.' +
          tail
      }
    }
    if (message !== null) {
      // QUEUE IT — a refusal is not a rejection. This condition ENDS the moment
      // the live lane finishes, which is exactly the shape the hold queue was
      // built for: without a row here the card is dropped on the floor and only
      // a human re-dispatching it ever revives it, while the path-claim gate
      // twenty lines below (the same "a live run owns this") auto-re-fires via
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
      // …UNLESS THE CARD'S OWN LIVE RUN IS THE REASON. `queued` is false there,
      // and writing a row anyway is what let a stopped/failed card auto-restart
      // once that run terminalized — see the note at `queued`.
      if (queued) {
        await deps.holds?.upsert({
          project_slug: deps.project_slug,
          board_item_id,
          task: input.task,
          payload: holdPayload,
          hold_kind: 'path',
          hold_reason: message,
          held_on_run_id,
        })
      } else if (deps.holds !== undefined) {
        // AND NOT WRITING IS NOT ENOUGH — DELETE WHAT IS ALREADY THERE (Argus
        // r3 BLOCKER). Skipping the upsert only kept THIS refusal from queuing
        // the card; a hold row seeded EARLIER still survives it. The blocker
        // gate twenty lines up upserts unconditionally, and a `path`/`branch`
        // row written while the card had no live linked run stays behind once
        // one appears. Either survivor outlives the linked run: the sweep drops
        // a hold only while that run is live AT SWEEP TIME, so the moment it
        // goes `stopped`/`failed` the row falls through to a fresh dispatch and
        // restarts a card that was stopped on purpose — the exact hazard the
        // `queued` rule exists to close, arriving one row early.
        //
        // The delete is idempotent (no row is not an error) and scoped to this
        // (project, card) pair, which is the hold table's own key. The card is
        // not dropped by it: its live linked run owns it, and that run's own
        // terminal event is what moves the card next.
        await deps.holds.deleteByItem(deps.project_slug, board_item_id)
      }
      // SAY SO. The refusal used to be silent in the logs as well as in the
      // queue, so a card that stopped moving had no trace anywhere.
      log.warn('dispatch_branch_live', {
        project: deps.project_slug,
        item: board_item_id,
        branch,
        held_on_run_id,
      })
      return {
        ok: false,
        code: 'branch_live',
        message,
        // SAY IT IS QUEUED IN THE SHAPE, NOT ONLY IN THE PROSE. `held` and the
        // path-claim refusal both carry this; a `branch_live` without it made a
        // queued card look dropped to every structured consumer. It is present
        // ONLY when a hold row was really written: with no store — or behind the
        // card's own live run — nothing was persisted, and a `hold` shape then
        // claims a queue entry that does not exist.
        ...(queued
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
      const message =
        `"${admission.path}" is claimed by live run ${admission.holding_run.id.slice(0, 8)} ` +
        `(${admission.holding_run.slug}) — this build will start automatically when that run goes terminal.`
      await deps.holds?.upsert({
        project_slug: deps.project_slug,
        board_item_id,
        task: input.task,
        payload: holdPayload,
        claimed_paths: paths,
        hold_kind: 'path',
        hold_reason: message,
        held_on_run_id: admission.holding_run.id,
      })
      return {
        ok: false,
        code: 'held',
        message,
        hold: { kind: 'path', holding_run_id: admission.holding_run.id, path: admission.path },
      }
    }
    const run = admission.run
    // BIND: light the item up (fork ⑂ + in_progress) the instant the build starts.
    // The durable loop fires + harvests by runId; terminal-reconcile clears it.
    await deps.board.attachRun(deps.project_slug, item.id, run.id)
    // A card that was previously HELD and has now finally dispatched clears its
    // queue entry (idempotent — a never-held card has no row to delete).
    await deps.holds?.deleteByItem(deps.project_slug, board_item_id)
    return { ok: true, run, merge_mode, ralph }
  } catch (err) {
    return {
      ok: false,
      code: 'backend_error',
      message: `failed to start a build: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
