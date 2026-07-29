/**
 * @neutronai/codegen-core — per-project worktree resolver.
 *
 * Resolves the per-project git worktree at
 * `<OWNER_HOME>/Projects/<project_id>/code/`. Runs `git init` if the
 * dir isn't a repo; runs `gh repo create` if there's no origin
 * remote. Idempotent — second + subsequent invocations short-circuit
 * after detecting an already-resolved worktree.
 *
 * Per docs/plans/code-gen-core-tier1-brief.md § 3.4.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  assertWithinProjectsBoundary,
  safeResolveProjectRoot,
  type SafeResolveProjectRootOptions,
} from '@neutronai/cores-runtime'

import {
  CodegenWorktreeNotResolvedError,
} from './backend.ts'
import { PROJECT_WORKTREE_DIRNAME } from './manifest.ts'
import type {
  HostGhRunner,
  HostGitRunner,
} from './host-runners.ts'
import type { CodegenSidecar } from './sidecar/store.ts'

export interface ResolvedWorktree {
  /** Absolute path: `<owner_home>/Projects/<project_id>/code/`. */
  worktree_path: string
  /** Resolved by inspecting `code_settings.default_branch`. */
  default_branch: string
  /** Repo slug — defaults to project_id; overridable via code_settings. */
  repo_slug: string
  /** GitHub org/user the repo lives under (null = `gh repo create` default). */
  gh_owner: string | null
  /** True iff this resolution created the worktree (fresh init). */
  newly_initialised: boolean
}

export interface ResolveWorktreeInput {
  owner_home: string
  project_id: string
  gh_runner: HostGhRunner
  git_runner: HostGitRunner
  sidecar: CodegenSidecar
  /** Override the project-root resolution (testing seam). */
  resolveProjectRoot?: (project_id: string) => string
}

/**
 * Resolve (and lazily create) the per-project worktree. Throws
 * `CodegenWorktreeNotResolvedError` on any unrecoverable failure
 * with a structured `reason` string so the chat client can render
 * the issue.
 */
export async function resolveWorktree(
  input: ResolveWorktreeInput,
): Promise<ResolvedWorktree> {
  // Refactor X4 (security): route the tool-supplied `project_id` through the
  // universal traversal guard BEFORE any FS op. This Core PREVIOUSLY did a
  // bare `join()` — a crafted `..`/NUL/absolute `project_id` could create a
  // git worktree outside `<owner_home>/Projects/`. Throws
  // `CorePathTraversalError` (before the mkdir try-block below).
  const safeOpts: SafeResolveProjectRootOptions = {
    owner_home: input.owner_home,
    project_id: input.project_id,
  }
  if (input.resolveProjectRoot !== undefined) {
    safeOpts.resolveProjectRoot = input.resolveProjectRoot
  }
  const projectRoot = safeResolveProjectRoot(safeOpts)
  const worktree_path = join(projectRoot, PROJECT_WORKTREE_DIRNAME)

  // 1. Ensure the dir exists. (mode 0700 mirrors the per-project
  // sidecar / Notes pattern.)
  try {
    if (!existsSync(worktree_path)) {
      mkdirSync(worktree_path, { recursive: true, mode: 0o700 })
    }
  } catch (err) {
    throw new CodegenWorktreeNotResolvedError(
      input.project_id,
      `mkdir failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 1b. Re-check the FINAL worktree dir: a symlink at `<root>/code` pointing
  // outside the boundary passes the root-level guard, and `mkdir -p` over a
  // pre-existing symlink silently follows it. Reject BEFORE using it as a
  // git `cwd`. Throws `CorePathTraversalError`.
  assertWithinProjectsBoundary({
    owner_home: input.owner_home,
    target: worktree_path,
    project_id: input.project_id,
  })

  // 2. Resolve settings — pull `default_branch`, `repo_slug`,
  // `gh_owner` from the per-project sidecar's `code_settings`. The
  // sidecar bootstraps a default row if the project is fresh.
  const settings = input.sidecar.settings.get()
  const default_branch = settings.default_branch
  const repo_slug = settings.repo_slug ?? input.project_id
  const gh_owner = settings.gh_owner

  // 3. Init the repo if missing.
  const isRepo = await input.git_runner.isRepo({ cwd: worktree_path })
  let newly_initialised = false
  if (!isRepo) {
    newly_initialised = true
    const initRes = await input.git_runner.exec({
      cwd: worktree_path,
      args: ['init', '--initial-branch', default_branch],
    })
    if (!initRes.ok) {
      throw new CodegenWorktreeNotResolvedError(
        input.project_id,
        `git init failed: ${initRes.stderr || initRes.stdout || `exit ${initRes.exit_code}`}`,
      )
    }
  }

  // 4. Ensure an origin remote — if missing, run `gh repo create`.
  const remoteRes = await input.git_runner.exec({
    cwd: worktree_path,
    args: ['remote', 'get-url', 'origin'],
  })
  if (!remoteRes.ok) {
    const ghRes = await input.gh_runner.repoCreate({
      cwd: worktree_path,
      owner: gh_owner,
      slug: repo_slug,
      private: true,
    })
    if (!ghRes.ok) {
      throw new CodegenWorktreeNotResolvedError(
        input.project_id,
        `gh repo create failed: ${ghRes.stderr || ghRes.stdout || `exit ${ghRes.exit_code}`}`,
      )
    }
  }

  return {
    worktree_path,
    default_branch,
    repo_slug,
    gh_owner,
    newly_initialised,
  }
}

/**
 * Slugify a free-form task description into a git-safe branch name.
 * Trims to ≤ 64 chars; keeps lowercase alnum + dashes; collapses
 * whitespace + non-alnum runs to single dashes; prefixes with
 * `feat/code-gen-` so branches sort together in `git branch -a`.
 */
export function sluggifyBranch(task: string, suffix?: string): string {
  const base = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40)
  const slug = base.length > 0 ? base : 'task'
  if (suffix !== undefined && suffix.length > 0) {
    return `feat/code-gen-${slug}-${suffix.slice(0, 8)}`
  }
  return `feat/code-gen-${slug}`
}
