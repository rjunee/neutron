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
 * existing resume path and the commit goes to REVIEW instead of being rebuilt
 * from scratch. Every other shape dispatches exactly as it did before.
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
  spawnCapture,
  type EnvCapableHostRunner,
  type PublisherCredentialSource,
} from './git-mode.ts'
import { ensureProjectBuildWorkspace } from './build-workspace.ts'
import { builtButNeverReviewedSeed } from './run-disposition.ts'
import { detectBaseBranch } from './merge.ts'
import { slugifyTask } from './slugify-task.ts'
import type { DispatchHoldPayload, DispatchHoldStore } from './dispatch-holds.ts'
import { deriveClaimedPaths } from './claimed-paths.ts'
import type { MergeMode, TridentRun, TridentRunStore } from './store.ts'

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
  | 'executor_unavailable'
  | 'backend_error'

export type BoardBoundBuildResult =
  | { ok: true; run: TridentRun; merge_mode: MergeMode; ralph: boolean }
  | {
      ok: false
      code: 'held'
      message: string
      hold: {
        kind: 'blocker' | 'path'
        blocker_id?: string
        holding_run_id?: string
        path?: string
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
  // The composition root's credentialed runner, when it wired one. The
  // `secretsStore` + `owner_handle` branch below still overrides it for a direct
  // caller that hands its own credential source instead.
  let credentialedRunner: EnvCapableHostRunner | undefined = deps.hostRunner
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

  // (4b) SALVAGE-RESUME SEED — a build that EXISTS is routed to review, never
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
  // bare `forge-done` in RALPH mode, which that machinery rebuilds
  // ('ralph-progress-unknown'), so the resolved `ralph` flag is an input to the
  // seed decision rather than something read after the row exists.
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
  let seed: ReturnType<typeof builtButNeverReviewedSeed> = null
  const prior = deps.store.latestTerminalBySlug(deps.project_slug, slug)
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
  if (prior !== null && prior.task === input.task && cardsPriorRun !== '' && cardsPriorRun === prior.id) {
    const candidate = builtButNeverReviewedSeed(prior, { ralph })
    if (candidate !== null) {
      // The call itself sits inside the try: a NON-async probe throws at the
      // call, before any promise exists for a .catch to attach to (Argus r7).
      let tip = ''
      try {
        tip = await (
          deps.readBranchTip ??
          ((p: string, b: string, m: MergeMode) =>
            defaultReadBranchTip(p, b, m, credentialedRunner ?? spawnCapture))
        )(repo_path, branch, merge_mode)
      } catch {
        tip = '' // a thrown probe is NO evidence — fall through to a fresh dispatch
      }
      if (tip.trim().toLowerCase() === candidate.head) seed = candidate
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
