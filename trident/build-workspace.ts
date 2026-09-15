/** Resolve the card-selected project repo before preparing a build workspace.
 * project-repos.json declares names, paths, remotes, and the default. Projects
 * without a declaration retain their existing code/ workspace. */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { readProjectRepos, resolveProjectRepo } from './project-repos.ts'

import { spawnCapture, type HostCommandResult } from './git-mode.ts'

/** Subdir under a project root that holds its git-tracked code (convention:
 *  `<owner_home>/Projects/<project_slug>/code`). */
export const PROJECT_CODE_DIRNAME = 'code'

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
  /** Absolute path of the selected declared workspace. */
  build_repo_path: string
  /** True iff this call initialized the repo (fresh init + initial commit). */
  created: boolean
}

/** Repository-local identity maintained for every agent-authored build commit. */
const COMMIT_IDENTITY = {
  name: 'Neutron',
  email: 'neutron@localhost',
} as const

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
  requestedRepo?: string | null,
): Promise<EnsureBuildWorkspaceResult> {
  const projectDir = join(owner_home, 'Projects', project_slug)
  const repo = resolveProjectRepo(readProjectRepos(projectDir, project_slug), requestedRepo)
  const build_repo_path = join(projectDir, repo.path)

  if (repo.remote !== null && !probe.exists(join(build_repo_path, '.git'))) {
    throw new Error(`Repo "${repo.name}" requires an existing checkout; remote cloning is not automatic`)
  }
  if (!probe.exists(build_repo_path)) probe.mkdirp(build_repo_path)

  let hasHead = false
  if (probe.exists(join(build_repo_path, '.git'))) {
    const head = await probe.git(['rev-parse', '--verify', 'HEAD'], build_repo_path)
    hasHead = head.ok
  } else {
    const init = await probe.git(['init', '-q', '--initial-branch=main'], build_repo_path)
    if (!init.ok) {
      throw new Error(
        `git init failed at ${build_repo_path}: ${init.stderr || init.stdout || `exit ${init.exit_code}`}`,
      )
    }
  }

  // Agent commits must never inherit the machine owner's global identity. Keep
  // this repository-local config current on every dispatch, including repos that
  // predate this guard. A failed write is fatal: continuing would restore the
  // exact inheritance this configuration prevents.
  for (const [key, value] of [
    ['user.name', COMMIT_IDENTITY.name],
    ['user.email', COMMIT_IDENTITY.email],
  ] as const) {
    const configured = await probe.git(['config', '--local', key, value], build_repo_path)
    if (!configured.ok) {
      throw new Error(
        `git identity configuration failed at ${build_repo_path}: ${configured.stderr || configured.stdout || `exit ${configured.exit_code}`}`,
      )
    }
  }

  // A healthy workspace is never re-initialized or surprise-committed.
  if (hasHead) return { build_repo_path, created: false }

  // Initial commit — `--allow-empty` so a brand-new project (no files yet) still
  // gets a valid HEAD. `git worktree add` needs a commit to base the build
  // branch on; the empty tree is fine, Forge writes the first files.
  const commit = await probe.git(
    ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `chore: initialize ${project_slug} build workspace`],
    build_repo_path,
  )
  if (!commit.ok) {
    throw new Error(
      `git initial commit failed at ${build_repo_path}: ${commit.stderr || commit.stdout || `exit ${commit.exit_code}`}`,
    )
  }

  return { build_repo_path, created: true }
}
