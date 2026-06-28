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

/**
 * Build the `MergeCleanupDeps` (mergePr / mergeLocal) over a host
 * command runner. The `cleanupAfterMerge` switch picks the right one
 * from `run.merge_mode`.
 */
export function buildMergeCleanupDeps(
  run_host: RunHostCommand,
  opts: { base_branch?: string } = {},
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
      const base = opts.base_branch ?? (await detectBaseBranch(run_host, repo))
      must('git checkout base', await run_host(['git', '-C', repo, 'checkout', base], repo))
      must(
        'git merge',
        await run_host(['git', '-C', repo, 'merge', '--no-ff', branch, '-m', `Merge ${branch}`], repo),
      )
      // Branch teardown after a successful merge (best-effort).
      await run_host(['git', '-C', repo, 'branch', '-D', branch], repo)
      await removeWorktree(run_host, run)
    },
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
