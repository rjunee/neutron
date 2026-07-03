/**
 * @neutronai/trident — merge + cleanup, per git-mode.
 *
 * Fills in the `MergeCleanupDeps` bodies the PR-2 `cleanupAfterMerge`
 * seam (git-mode.ts) calls on the `argus APPROVE → done` transition.
 * Both modes are host-command sequences over an injected runner (the
 * same `(cmd, cwd) => HostCommandResult` shape `defaultGitModeProbe`
 * uses), so tests assert the exact git/gh calls without shelling out.
 *
 *   • `'pr'`    → `gh pr merge <pr> --squash`, then delete the REMOTE
 *                 branch (`git push origin --delete`) + the local branch.
 *   • `'local'` → merge the feature branch into the base locally, then
 *                 delete the local branch.
 *
 * WORKTREE CLEANUP — ENFORCED (Trident v2, D-1/C3). The prior "Ryan-locked: NO
 * `git worktree remove`" rule held while Open ran plain branches. Trident v2's
 * inner workflow builds in `isolation:'worktree'` worktrees, and the harness
 * removes a worktree ONLY IF UNCHANGED — a Forge build always commits, so the
 * worktree is orphaned unless trident removes it (the June fseventsd CPU-peg
 * wedge driver). The inner workflow's `finally{}` cleans up on every inner path;
 * this is the OUTER backstop: after the merge + branch teardown, if `run.worktree`
 * is set, best-effort `git worktree remove --force` + `git worktree prune` so
 * `git worktree list` is clean after EVERY merge. Best-effort + non-fatal: the
 * merge has already landed, so a failed worktree removal is logged, never thrown
 * (it must not undo a completed merge).
 */

import { join } from 'node:path'

import type { HostCommandResult } from './git-mode.ts'
import type { MergeCleanupDeps } from './git-mode.ts'
import type { TridentRun } from './store.ts'

export type RunHostCommand = (cmd: string[], cwd?: string) => Promise<HostCommandResult>

/** Thrown when a merge/cleanup host command exits non-zero. */
export class TridentMergeError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly result: HostCommandResult,
  ) {
    super(message)
    this.name = 'TridentMergeError'
  }
}

/**
 * Thrown when a rebase conflict is genuinely un-resolvable/ambiguous and the
 * bounded Forge resolver ESCALATED (or automatic resolution was unavailable).
 * The OUTER loop (`orchestrator.applyResult`) maps this to a `failed` run whose
 * `failure_reason` is the SPECIFIC question — the terminal delivery posts that
 * question to chat, never a raw "merge failed" (#342 step 3).
 */
export class TridentMergeConflictEscalation extends Error {
  constructor(readonly question: string) {
    super(question)
    this.name = 'TridentMergeConflictEscalation'
  }
}

/**
 * A bounded Forge that resolves a git REBASE conflict IN the repo's working
 * tree (mid-rebase, conflict markers present). Production is
 * `buildForgeConflictResolver` (`conflict-resolver.ts`) over the composer's
 * ephemeral substrate factory; tests inject a stub. It resolves + `git add`s the
 * conflicts (the OUTER `mergeLocal` runs `git rebase --continue`), returning:
 *   - `{ resolved: true }`               → conflicts staged, safe to continue.
 *   - `{ resolved: false; question }`    → ambiguous → escalate to chat.
 */
export interface MergeConflictResolver {
  (input: {
    /** The repo working tree (cwd, mid-rebase). */
    repo_path: string
    /** The build's branch being rebased. */
    branch: string
    /** The base branch it is rebasing onto. */
    base_branch: string
    run: TridentRun
    /** Files with unresolved conflict markers (`--diff-filter=U`). */
    conflicted_files: string[]
  }): Promise<{ resolved: true } | { resolved: false; question: string }>
}

/** Bound the rebase-continue loop so a pathological history can't spin forever. */
const MAX_CONFLICT_ROUNDS = 12

/**
 * Resolve the base branch to merge into. Tries `origin/HEAD`'s symbolic
 * target, then a local `main`/`master`, defaulting to `main`. Never
 * throws — a probe failure degrades to `main`.
 */
export async function detectBaseBranch(
  run_host: RunHostCommand,
  repo_path: string,
): Promise<string> {
  try {
    const sym = await run_host(
      ['git', '-C', repo_path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      repo_path,
    )
    if (sym.ok && sym.stdout.trim().length > 0) {
      // e.g. "origin/main" → "main"
      const ref = sym.stdout.trim()
      const slash = ref.indexOf('/')
      return slash >= 0 ? ref.slice(slash + 1) : ref
    }
  } catch {
    // fall through to the default
  }
  return 'main'
}

/**
 * Per-working-tree serialization for LOCAL-mode merges. Two parallel builds in
 * the SAME project share ONE build workspace (`ensureProjectBuildWorkspace` keys
 * the `code` dir on the project slug), so both runs carry the IDENTICAL
 * `repo_path`. A local merge is `git checkout <base>` + `git merge --no-ff` in
 * that single working tree; running two concurrently collides — build A's
 * committed-but-not-yet-merged files show up as UNTRACKED when build B checks
 * out `base`, and git aborts B with "untracked working tree files would be
 * overwritten". A per-`repo_path` promise chain forces the second merge to WAIT
 * for the first: by the time B checks out `base`, A's files are TRACKED on
 * `base` and B merges cleanly on top. Keyed on `repo_path` so merges in
 * DIFFERENT workspaces (different projects) still run fully in parallel. The
 * PR-mode path merges the remote and never touches the shared tree, so it is
 * NOT gated here.
 */
const localMergeChains = new Map<string, Promise<void>>()

function withLocalMergeLock(repo_path: string, body: () => Promise<void>): Promise<void> {
  const prev = localMergeChains.get(repo_path) ?? Promise.resolve()
  // Chain off the prior merge REGARDLESS of whether it settled ok — a failed
  // predecessor must not wedge the workspace's queue (swallow its result here;
  // that call already surfaced its own rejection to its own caller).
  const next = prev.then(
    () => body(),
    () => body(),
  )
  localMergeChains.set(repo_path, next)
  // GC the tail once it settles so the map can't grow unbounded across builds.
  // `then(cleanup, cleanup)` (not `.finally`) so this bookkeeping never produces
  // an unhandled rejection — `next` itself (returned below) still carries the
  // real merge result/rejection to the caller.
  const cleanup = (): void => {
    if (localMergeChains.get(repo_path) === next) localMergeChains.delete(repo_path)
  }
  next.then(cleanup, cleanup)
  return next
}

function must(step: string, res: HostCommandResult): HostCommandResult {
  if (!res.ok) {
    throw new TridentMergeError(
      `${step} failed: ${res.stderr || res.stdout || `exit ${res.exit_code}`}`,
      step,
      res,
    )
  }
  return res
}

/** Where a run's dedicated MERGE worktree lives: `<repo>/.trident-worktrees/<slug>-<id8>`.
 *  Pure + deterministic (keyed on the run so N same-project builds get DISTINCT
 *  paths), so the store's `worktree` column, the provisioning, and the teardown all
 *  agree without threading a path around. `.trident-worktrees/` is inside the
 *  project's own storage (the leak-gate + fseventsd-CPU lesson: never scatter
 *  worktrees outside the repo). */
export function runWorktreePath(repo_path: string, run: Pick<TridentRun, 'id' | 'slug'>): string {
  const id8 = run.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'run'
  const slug = run.slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'build'
  return join(repo_path, '.trident-worktrees', `${slug}-${id8}`)
}

/**
 * FIX 2 (#351/#352) — DEFENSIVE stale-state auto-recovery. Before ANY merge/rebase
 * touches the shared base repo, abort a lingering merge/rebase left by a PRIOR
 * build (a crash, or a pre-#342 hard-fail) and hard-reset to a clean base. Without
 * this, ONE poisoned checkout (`.git/MERGE_HEAD` / `.git/rebase-merge` /
 * `.git/rebase-apply` present) makes EVERY later build in that repo trip
 * "you need to resolve your current index first" (the verified 2026-07-03 kvwal
 * failure). Self-healing: `git merge --abort` / `git rebase --abort` each succeed
 * ONLY when that operation was actually in progress, so their exit code is an
 * accurate "was-dirty" probe; a `reset --hard` then restores a clean HEAD. All
 * best-effort — a clean repo makes every command a harmless no-op.
 */
export async function recoverStaleGitState(run_host: RunHostCommand, repo: string): Promise<boolean> {
  const mergeAbort = await run_host(['git', '-C', repo, 'merge', '--abort'], repo)
  const rebaseAbort = await run_host(['git', '-C', repo, 'rebase', '--abort'], repo)
  const wasDirty = mergeAbort.ok || rebaseAbort.ok
  if (wasDirty) {
    // A merge/rebase WAS in progress and is now aborted; hard-reset restores the
    // index+working tree to HEAD so the next checkout/merge starts from clean.
    // Deliberately NOT `git clean` — the shared checkout may hold a real project's
    // untracked files, and a build never depends on wiping them.
    await run_host(['git', '-C', repo, 'reset', '--hard'], repo)
  }
  return wasDirty
}

/** Remove a specific worktree path (best-effort) + prune stale admin entries. */
async function removeWorktreePath(run_host: RunHostCommand, repo: string, wt: string): Promise<void> {
  try {
    await run_host(['git', '-C', repo, 'worktree', 'remove', '--force', wt], repo)
    await run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
  } catch {
    // Swallow — a cleanup miss is cosmetic; the merge/refs are already durable.
  }
}

/**
 * FIX 1 (#351) — provision the run's DEDICATED merge worktree, detached at `base`.
 * Detached (`--detach`) so it never collides with `base` being checked out in the
 * shared repo ("`<base>` is already checked out"). Idempotent: any stale worktree
 * at the path (a crash-resumed run reusing the deterministic path) is removed +
 * pruned first. The whole rebase (the conflict-prone step) then runs HERE, so a
 * failed rebase can only dirty THIS throwaway worktree — never the shared checkout.
 */
async function provisionRunWorktree(
  run_host: RunHostCommand,
  repo: string,
  wt: string,
  base: string,
): Promise<void> {
  await removeWorktreePath(run_host, repo, wt)
  must(
    'git worktree add',
    await run_host(['git', '-C', repo, 'worktree', 'add', '--detach', '--force', wt, base], repo),
  )
}

/**
 * Free `branch` from ANY lingering worktree (other than `keepPath`) that still has
 * it checked out — the inner-workflow build worktree the harness/inner-cleanup may
 * have missed. Without this, checking `branch` out in the merge worktree would fail
 * "already checked out at <path>". Parses `git worktree list --porcelain`. Best-effort.
 */
async function freeBranchFromWorktrees(
  run_host: RunHostCommand,
  repo: string,
  branch: string,
  keepPath: string,
): Promise<void> {
  const list = await run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain'], repo)
  if (!list.ok) return
  const wantRef = `refs/heads/${branch}`
  let curPath: string | null = null
  for (const raw of list.stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('worktree ')) {
      curPath = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      if (ref === wantRef && curPath !== null && curPath !== keepPath) {
        await run_host(['git', '-C', repo, 'worktree', 'remove', '--force', curPath], repo)
      }
    }
  }
  await run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
}

/**
 * Build the `MergeCleanupDeps` (mergePr / mergeLocal) over a host
 * command runner. The `cleanupAfterMerge` switch picks the right one
 * from `run.merge_mode`.
 */
export function buildMergeCleanupDeps(
  run_host: RunHostCommand,
  opts: { base_branch?: string; resolve_conflict?: MergeConflictResolver } = {},
): MergeCleanupDeps {
  return {
    async mergePr(run: TridentRun): Promise<void> {
      const repo = run.repo_path
      const branch = run.branch
      if (run.pr === null) {
        throw new TridentMergeError('pr-mode merge requires a PR number', 'precondition', {
          ok: false,
          stdout: '',
          stderr: 'run.pr is null',
          exit_code: -1,
        })
      }
      must('gh pr merge', await run_host(['gh', 'pr', 'merge', String(run.pr), '--squash'], repo))
      if (branch !== null) {
        // Best-effort branch teardown — the merge already landed, so a
        // failed delete is logged but not fatal to the merge itself.
        await run_host(['git', '-C', repo, 'push', 'origin', '--delete', branch], repo)
        await run_host(['git', '-C', repo, 'branch', '-D', branch], repo)
      }
      await removeWorktree(run_host, run)
    },

    async mergeLocal(run: TridentRun): Promise<void> {
      const repo = run.repo_path
      const branch = run.branch
      if (branch === null) {
        throw new TridentMergeError('local-mode merge requires a branch', 'precondition', {
          ok: false,
          stdout: '',
          stderr: 'run.branch is null',
          exit_code: -1,
        })
      }
      // Serialize per BASE repo — parallel same-project builds share this
      // `repo_path`; the final land onto `base` (the one op that touches the shared
      // checkout) must not interleave. The lock makes N same-project builds land in
      // order (#342): each waits for the prior merge, THEN rebases onto the
      // now-updated base + merges. Keyed on `repo_path` so DIFFERENT projects still
      // merge fully in parallel.
      await withLocalMergeLock(repo, async () => {
        const base = opts.base_branch ?? (await detectBaseBranch(run_host, repo))
        // (0) DEFENSIVE stale-state recovery (FIX 2): heal any merge/rebase a PRIOR
        //     build left in the shared checkout BEFORE we touch it — else one old
        //     poisoned index makes every later merge fail "resolve your current
        //     index first" (the verified kvwal failure).
        await recoverStaleGitState(run_host, repo)
        // (1) ISOLATION (FIX 1): provision this run's OWN detached worktree and run
        //     the whole rebase there. A rebase conflict that hard-fails can only
        //     dirty THIS throwaway worktree — never the shared checkout — so one
        //     build's failed merge can never poison another's.
        const wt = run.worktree ?? runWorktreePath(repo, run)
        // Free the branch from any lingering build worktree first (else the merge
        //     worktree's `git checkout <branch>` fails "already checked out").
        await freeBranchFromWorktrees(run_host, repo, branch, wt)
        await provisionRunWorktree(run_host, repo, wt, base)
        try {
          // (2) REBASE the build's branch onto the LATEST base IN THE WORKTREE so it
          //     replays on top of any sibling build that merged before it. On a real
          //     content conflict, dispatch the bounded Forge resolver; on a genuinely
          //     ambiguous one, escalate to chat (TridentMergeConflictEscalation).
          await rebaseBranchOntoBase(run_host, wt, base, branch, run, opts.resolve_conflict)
          // (3) LAND onto base in the shared checkout — the branch now CONTAINS base
          //     (rebased on top), so this no-ff merge is fast-forwardable and CANNOT
          //     conflict. Heal-then-land defensively (the repo is still clean here).
          await recoverStaleGitState(run_host, repo)
          must('git checkout base', await run_host(['git', '-C', repo, 'checkout', base], repo))
          must(
            'git merge',
            await run_host(['git', '-C', repo, 'merge', '--no-ff', branch, '-m', `Merge ${branch}`], repo),
          )
        } finally {
          // (4) Tear down the per-run worktree on EVERY terminal path (success OR a
          //     thrown escalation) — never orphan a changed worktree (the fseventsd
          //     CPU-peg lesson). Frees the branch so the delete below succeeds.
          await removeWorktreePath(run_host, repo, wt)
        }
        // Branch teardown after a successful merge (best-effort).
        await run_host(['git', '-C', repo, 'branch', '-D', branch], repo)
      })
    },
  }
}

/** True when a git result's output names a merge/rebase conflict. */
function isRebaseConflict(res: HostCommandResult): boolean {
  const s = `${res.stdout}\n${res.stderr}`.toLowerCase()
  return (
    s.includes('conflict') ||
    s.includes('could not apply') ||
    s.includes('needs merge') ||
    s.includes('resolve all conflicts')
  )
}

/** The files with unresolved conflict markers (`git diff --diff-filter=U`). */
async function listConflictedFiles(run_host: RunHostCommand, repo: string): Promise<string[]> {
  const res = await run_host(['git', '-C', repo, 'diff', '--name-only', '--diff-filter=U'], repo)
  if (!res.ok) return []
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Abort an in-progress rebase and return the working tree to `base`. Best-effort. */
async function abortRebase(run_host: RunHostCommand, repo: string, base: string): Promise<void> {
  await run_host(['git', '-C', repo, 'rebase', '--abort'], repo)
  await run_host(['git', '-C', repo, 'checkout', base], repo)
}

/**
 * Rebase `branch` onto `base` in the shared working tree, resolving any content
 * conflict with the bounded Forge `resolver`. Assumes the caller holds the
 * per-repo merge lock (so the tree is exclusively ours). On success the branch
 * has been replayed on top of `base` and the working tree is left on `branch`;
 * the caller then checks out `base` + merges (a clean no-ff). Throws:
 *   - `TridentMergeConflictEscalation` when the resolver escalates (ambiguous)
 *     OR no resolver is configured on a conflict — the OUTER loop turns this into
 *     a chat-delivered specific question.
 *   - `TridentMergeError` for any other (non-conflict) rebase failure.
 */
async function rebaseBranchOntoBase(
  run_host: RunHostCommand,
  repo: string,
  base: string,
  branch: string,
  run: TridentRun,
  resolver: MergeConflictResolver | undefined,
): Promise<void> {
  must('git checkout branch', await run_host(['git', '-C', repo, 'checkout', branch], repo))
  let res = await run_host(['git', '-C', repo, 'rebase', base], repo)
  let rounds = 0
  while (!res.ok && isRebaseConflict(res)) {
    if (rounds >= MAX_CONFLICT_ROUNDS) {
      await abortRebase(run_host, repo, base)
      throw new TridentMergeConflictEscalation(
        `merging \`${branch}\` into \`${base}\` hit conflicts across more than ${MAX_CONFLICT_ROUNDS} commits — it needs a manual rebase before I can land it.`,
      )
    }
    rounds++
    const conflicted = await listConflictedFiles(run_host, repo)
    if (resolver === undefined) {
      await abortRebase(run_host, repo, base)
      throw new TridentMergeConflictEscalation(
        `\`${branch}\` conflicts with \`${base}\` in ${conflicted.join(', ') || 'the branch'} and I have no way to auto-resolve it here — it needs a manual merge.`,
      )
    }
    const outcome = await resolver({
      repo_path: repo,
      branch,
      base_branch: base,
      run,
      conflicted_files: conflicted,
    })
    if (!outcome.resolved) {
      await abortRebase(run_host, repo, base)
      throw new TridentMergeConflictEscalation(outcome.question)
    }
    // The resolver staged its resolutions; advance the rebase (which may surface
    // the NEXT conflicting commit → loop). `core.editor=true` so the replayed
    // commit never blocks on an interactive editor in this headless path.
    res = await run_host(
      ['git', '-C', repo, '-c', 'core.editor=true', 'rebase', '--continue'],
      repo,
    )
  }
  if (!res.ok) {
    // A non-conflict rebase failure (or the resolver staged nothing so
    // `--continue` had no changes) — abort + fail loudly.
    await abortRebase(run_host, repo, base)
    throw new TridentMergeError(
      `git rebase of ${branch} onto ${base} failed: ${res.stderr || res.stdout || `exit ${res.exit_code}`}`,
      'rebase',
      res,
    )
  }
}

/**
 * D-1/C3 — best-effort worktree cleanup after a merge has LANDED. The inner
 * workflow's `finally{}` already removes its build worktree on every inner path;
 * this is the OUTER backstop for a `run.worktree` the run row still carries.
 * Non-fatal: the merge is irreversible by this point, so any failure is
 * swallowed (a thrown removal must never undo a completed merge). Goal: `git
 * worktree list` is clean after every merge.
 */
async function removeWorktree(run_host: RunHostCommand, run: TridentRun): Promise<void> {
  if (run.worktree === null) return
  const repo = run.repo_path
  try {
    await run_host(['git', '-C', repo, 'worktree', 'remove', '--force', run.worktree], repo)
    await run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
  } catch {
    // Swallow — the merge already landed; a cleanup miss is cosmetic, not fatal.
  }
}
