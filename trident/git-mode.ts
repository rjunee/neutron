/**
 * @neutronai/trident — git integration mode detection + merge/cleanup
 * seam.
 *
 * Ryan-locked decision: Trident supports BOTH a local branch-merge mode
 * and a GitHub PR mode, auto-detected per run with NO user config. A run
 * is `'pr'` mode iff the project repo has a GitHub `origin` remote AND the
 * `gh` CLI is available on the host; otherwise `'local'` (the safe
 * default — branch + merge with no remote).
 *
 * SCOPE — PR-2 lands the detection helper + the merge/cleanup STUBS. The
 * real branch/merge/PR mechanics (worktree create, `gh pr create`,
 * `gh pr merge`, branch teardown) are PR-3; this PR provides the typed
 * seam + persists the mode so PR-3 only fills in the bodies.
 */

import type { MergeMode, TridentRun } from './store.ts'

export interface HostCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  exit_code: number
}

/**
 * Host-process probe used by `detectMergeMode`. Tests inject a stub; the
 * default (`defaultGitModeProbe`) shells out via `Bun.spawn`. Kept narrow
 * — only the two facts detection needs — so the merge-mode decision is
 * statically reasoning-friendly.
 */
export interface GitModeProbe {
  /** Whether `repoPath` has an `origin` remote pointing at GitHub. */
  hasGithubOrigin(repoPath: string): Promise<boolean>
  /** Whether the `gh` CLI is installed + on PATH. */
  ghAvailable(): Promise<boolean>
}

/**
 * Auto-detect the merge mode for a repo. `'pr'` requires BOTH a GitHub
 * origin remote AND `gh`; anything else (no remote, a non-GitHub remote,
 * or `gh` missing) is `'local'`. A probe that throws is treated as the
 * capability being absent, so detection degrades to `'local'` rather than
 * erroring a run at creation time.
 */
export async function detectMergeMode(
  repoPath: string,
  probe: GitModeProbe,
): Promise<MergeMode> {
  try {
    const [hasOrigin, hasGh] = await Promise.all([
      probe.hasGithubOrigin(repoPath),
      probe.ghAvailable(),
    ])
    return hasOrigin && hasGh ? 'pr' : 'local'
  } catch {
    return 'local'
  }
}

/** True when the URL is a GitHub remote (https or ssh form). */
export function isGithubRemoteUrl(url: string): boolean {
  const u = url.trim()
  if (u.length === 0) return false
  return /(^|@|\/\/)github\.com[:/]/i.test(u) || /(^|\b)git@github\.com:/i.test(u)
}

/**
 * Default production probe: shells `git -C <repo> remote get-url origin`
 * and `gh --version` via `Bun.spawn`. Any spawn/exec failure resolves to
 * `false` (capability absent) — never throws — so `detectMergeMode`
 * always yields a concrete mode.
 */
export function defaultGitModeProbe(
  run: (cmd: string[], cwd?: string) => Promise<HostCommandResult> = spawnCapture,
): GitModeProbe {
  return {
    hasGithubOrigin: async (repoPath) => {
      const res = await run(['git', '-C', repoPath, 'remote', 'get-url', 'origin'], repoPath)
      return res.ok && isGithubRemoteUrl(res.stdout)
    },
    ghAvailable: async () => {
      const res = await run(['gh', '--version'])
      return res.ok
    },
  }
}

// ---------------------------------------------------------------------------
// Ralph mode detection
// ---------------------------------------------------------------------------

/**
 * Probe for `detectRalphMode`. Narrow on purpose — the only fact Ralph
 * detection needs is whether the repo is "governed" (its git root has a
 * `SPEC.md`, per the Spec-Drift Guardrails convention). Tests inject a
 * stub; production uses `defaultRalphModeProbe`.
 */
export interface RalphModeProbe {
  /** Whether the git root containing `repoPath` has a `SPEC.md`. */
  hasSpecFile(repoPath: string): Promise<boolean>
}

/**
 * Decide whether a run uses Ralph build mode (the one-task-per-fresh-
 * context loop). Mirrors Vajra SKILL.md "Ralph mode detection":
 *
 *   1. EXPLICIT — the caller asked for it (`opts.explicit`) → Ralph.
 *   2. GOVERNED — else the repo's git root contains a `SPEC.md` → Ralph.
 *   3. Else → legacy single-context build.
 *
 * A probe that throws is treated as "not governed" so detection degrades
 * to the legacy path rather than erroring a run at creation time.
 */
export async function detectRalphMode(
  repoPath: string,
  probe: RalphModeProbe,
  opts: { explicit?: boolean } = {},
): Promise<boolean> {
  if (opts.explicit === true) return true
  try {
    return await probe.hasSpecFile(repoPath)
  } catch {
    return false
  }
}

/**
 * Default production probe: resolves the git root via
 * `git rev-parse --show-toplevel` (falling back to `repoPath`), then checks
 * for `<root>/SPEC.md`. The file-existence check is injectable so unit
 * tests need no real filesystem.
 */
export function defaultRalphModeProbe(
  run: (cmd: string[], cwd?: string) => Promise<HostCommandResult> = spawnCapture,
  fileExists: (path: string) => Promise<boolean> = (p) => Bun.file(p).exists(),
): RalphModeProbe {
  return {
    hasSpecFile: async (repoPath) => {
      const res = await run(['git', '-C', repoPath, 'rev-parse', '--show-toplevel'], repoPath)
      const root = res.ok && res.stdout.trim().length > 0 ? res.stdout.trim() : repoPath
      return await fileExists(`${root}/SPEC.md`)
    },
  }
}

/**
 * Default production host-command runner: shells `cmd` via `Bun.spawn`
 * and captures stdout/stderr/exit. Shared by the git-mode/ralph probes
 * AND the trident orchestrator's `run_host` (git/gh/numstat/merge) when a
 * composer doesn't inject its own. Never throws — a spawn failure resolves
 * to `{ ok:false, exit_code:-1 }`.
 */
export async function spawnCapture(cmd: string[], cwd?: string): Promise<HostCommandResult> {
  try {
    const proc = Bun.spawn(cmd, {
      // Only set `cwd` when provided — under exactOptionalPropertyTypes an
      // explicit `cwd: undefined` is not assignable to SpawnOptions.
      ...(cwd !== undefined ? { cwd } : {}),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exit_code = await proc.exited
    return { ok: exit_code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exit_code }
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err), exit_code: -1 }
  }
}

/**
 * PR-3 seam — post-merge cleanup, branching on the run's `merge_mode`.
 * Both modes get a stub now so the state machine's `done` transition has a
 * concrete call site; PR-3 fills in the bodies:
 *
 *   • `'pr'`   → `gh pr merge <pr> --squash`, then remove the worktree +
 *               delete the local branch.
 *   • `'local'`→ merge the branch into the base locally, then remove the
 *               worktree + delete the branch.
 *
 * The interface (and the merge_mode switch) is locked here so PR-3 only
 * implements the two host-command sequences.
 */
export interface MergeCleanupDeps {
  /** PR-3: `gh pr merge` + teardown. */
  mergePr?(run: TridentRun): Promise<void>
  /** PR-3: local branch merge + teardown. */
  mergeLocal?(run: TridentRun): Promise<void>
}

export interface MergeCleanupResult {
  mode: MergeMode
  /** False while PR-3's bodies are unimplemented (the stub path). */
  performed: boolean
  note: string
}

export async function cleanupAfterMerge(
  run: TridentRun,
  deps: MergeCleanupDeps = {},
): Promise<MergeCleanupResult> {
  if (run.merge_mode === 'pr') {
    if (deps.mergePr) {
      await deps.mergePr(run)
      return { mode: 'pr', performed: true, note: `merged PR #${run.pr ?? '?'} + cleaned up` }
    }
    return { mode: 'pr', performed: false, note: 'pr-mode merge/cleanup not yet implemented (PR-3)' }
  }
  if (deps.mergeLocal) {
    await deps.mergeLocal(run)
    return { mode: 'local', performed: true, note: `merged branch ${run.branch ?? '?'} locally + cleaned up` }
  }
  return { mode: 'local', performed: false, note: 'local-mode merge/cleanup not yet implemented (PR-3)' }
}
