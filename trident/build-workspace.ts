/**
 * @neutronai/trident — per-project build workspace resolver.
 *
 * A brand-new project has NO code repo. The build dispatch chokepoint
 * (`dispatchBoardBoundBuild`) used to hand the run row a single
 * composition-time constant (the owner HOME dir) as its `repo_path`, so the
 * inner workflow's `isolation:'worktree'` (`git worktree add`) fired against a
 * path that was not a git repo — the build died at forge-init before Forge ran.
 *
 * This resolver gives every project its OWN git-initialized code workspace at
 * `<owner_home>/Projects/<project_slug>/code`, WITH an initial commit (a repo
 * with no HEAD still fails `git worktree add`). It is idempotent: a workspace
 * that already exists as a repo with a commit is returned untouched, so a
 * re-dispatch (or a project a wow-moment already materialized) is a no-op.
 *
 * A fresh local project has no GitHub origin, so `detectMergeMode` correctly
 * degrades to `'local'` (branch + local merge, no PR) — the right shape for a
 * self-hoster's brand-new project.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { spawnCapture, type HostCommandResult } from './git-mode.ts'

/** Subdir under a project root that holds its git-tracked code (convention:
 *  `<owner_home>/Projects/<project_slug>/code`). */
export const PROJECT_WORKSPACE_DIRNAME = 'code'

/**
 * Filesystem + git seam the resolver needs. Tests inject a stub; production
 * uses `defaultBuildWorkspaceProbe` (real `node:fs` + `git` via `Bun.spawn`).
 * Narrow on purpose — only the four operations the resolver performs.
 */
export interface BuildWorkspaceProbe {
  /** Whether `path` exists on disk. */
  exists(path: string): boolean
  /** Recursively create `path`. */
  mkdirp(path: string): void
  /** Run a `git` subcommand in `cwd`. Never throws (resolves a failure result). */
  git(args: string[], cwd: string): Promise<HostCommandResult>
}

/** Production probe: real `node:fs` + `git` shelled via the shared `spawnCapture`. */
export function defaultBuildWorkspaceProbe(): BuildWorkspaceProbe {
  return {
    exists: (path) => existsSync(path),
    mkdirp: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    },
    git: (args, cwd) => spawnCapture(['git', '-C', cwd, ...args], cwd),
  }
}

export interface EnsureBuildWorkspaceResult {
  /** Absolute path: `<owner_home>/Projects/<project_slug>/code`. */
  workspace_path: string
  /** True iff this call initialized the repo (fresh init + initial commit). */
  created: boolean
}

/** The git identity + no-gpg flags the initial commit is pinned to (mirrors the
 *  wow-moment materializer so a box with no user git config still commits). */
const COMMIT_IDENTITY = [
  '-c',
  'user.name=Neutron',
  '-c',
  'user.email=neutron@localhost',
  '-c',
  'commit.gpgsign=false',
]

/**
 * Resolve (and lazily create) the per-project build workspace, guaranteeing a
 * git repo WITH an initial commit so `git worktree add` succeeds.
 *
 * Idempotent:
 *   - repo already exists WITH a commit → returned as-is (`created:false`);
 *   - repo exists but has NO commit (a prior partial init) → the initial commit
 *     is made now;
 *   - no repo → `git init` (default branch `main`) + initial commit.
 *
 * Throws on an unrecoverable git failure (the dispatch chokepoint maps this to a
 * `backend_error` so a run is never created against a non-buildable path).
 */
export async function ensureProjectBuildWorkspace(
  owner_home: string,
  project_slug: string,
  probe: BuildWorkspaceProbe = defaultBuildWorkspaceProbe(),
): Promise<EnsureBuildWorkspaceResult> {
  const workspace_path = join(owner_home, 'Projects', project_slug, PROJECT_WORKSPACE_DIRNAME)

  if (!probe.exists(workspace_path)) probe.mkdirp(workspace_path)

  // Already a repo WITH a commit? Nothing to do — never re-init or re-commit a
  // healthy workspace (that would surprise-commit the user's working tree).
  if (probe.exists(join(workspace_path, '.git'))) {
    const head = await probe.git(['rev-parse', '--verify', 'HEAD'], workspace_path)
    if (head.ok) return { workspace_path, created: false }
  } else {
    const init = await probe.git(['init', '-q', '--initial-branch=main'], workspace_path)
    if (!init.ok) {
      throw new Error(
        `git init failed at ${workspace_path}: ${init.stderr || init.stdout || `exit ${init.exit_code}`}`,
      )
    }
  }

  // Initial commit — `--allow-empty` so a brand-new project (no files yet) still
  // gets a valid HEAD. `git worktree add` needs a commit to base the build
  // branch on; the empty tree is fine, Forge writes the first files.
  const commit = await probe.git(
    [...COMMIT_IDENTITY, 'commit', '-q', '--allow-empty', '-m', `chore: initialize ${project_slug} build workspace`],
    workspace_path,
  )
  if (!commit.ok) {
    throw new Error(
      `git initial commit failed at ${workspace_path}: ${commit.stderr || commit.stdout || `exit ${commit.exit_code}`}`,
    )
  }

  return { workspace_path, created: true }
}
