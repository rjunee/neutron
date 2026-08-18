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
 * terminal-reconcile path (`build-core-modules` on_terminal) clears the binding
 * and sets the lane (done / back-to-upcoming) when the run lands terminal.
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
  type EnvCapableHostRunner,
  type PublisherCredentialSource,
} from './git-mode.ts'
import { ensureProjectBuildWorkspace } from './build-workspace.ts'
import { detectBaseBranch } from './merge.ts'
import { slugifyTask } from './slugify-task.ts'
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
 * The minimal board surface the chokepoint needs: read an item (for the
 * existence + readiness checks) and bind a run to it. `WorkBoardStore`
 * satisfies this structurally (`get` / `attachRun`).
 */
export interface TridentBoardBinder {
  get(
    project_slug: string,
    id: string,
  ): (DispatchReadinessTarget & { id: string; linked_run_id?: string | null }) | null
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
}

export interface BoardBoundBuildDeps {
  store: TridentRunStore
  board: TridentBoardBinder
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
}

export type BoardBoundBuildRejectionCode =
  | 'missing_board_item'
  | 'unknown_board_item'
  | 'underspecified'
  | 'already_landed'
  | 'backend_error'

export type BoardBoundBuildResult =
  | { ok: true; run: TridentRun; merge_mode: MergeMode; ralph: boolean }
  | { ok: false; code: BoardBoundBuildRejectionCode; message: string }

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

  // (3) ASK-BEFORE-ACTING — block an underspecified item; the caller must ask.
  const readiness = assessDispatchReadiness(item)
  if (!readiness.ready) {
    return { ok: false, code: 'underspecified', message: readiness.reason ?? 'Plan item is underspecified.' }
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

  try {
    const run = await deps.store.create({
      slug,
      project_slug: deps.project_slug,
      repo_path,
      task: input.task,
      merge_mode,
      ralph,
      branch,
      ...(deps.max_rounds !== undefined ? { max_rounds: deps.max_rounds } : {}),
      ...(deps.max_ralph_rounds !== undefined ? { max_ralph_rounds: deps.max_ralph_rounds } : {}),
      ...(deps.chat_id !== undefined ? { chat_id: deps.chat_id } : {}),
      ...(deps.thread_id !== undefined ? { thread_id: deps.thread_id } : {}),
      ...(deps.channel_kind !== undefined ? { channel_kind: deps.channel_kind } : {}),
    })
    // BIND: light the item up (fork ⑂ + in_progress) the instant the build starts.
    // The durable loop fires + harvests by runId; terminal-reconcile clears it.
    await deps.board.attachRun(deps.project_slug, item.id, run.id)
    return { ok: true, run, merge_mode, ralph }
  } catch (err) {
    return {
      ok: false,
      code: 'backend_error',
      message: `failed to start a build: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
