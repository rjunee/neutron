/**
 * @neutronai/codegen-core — host-process runner interfaces.
 *
 * Thin abstractions over the gateway host's `gh` / `git` / `bun test`
 * CLIs. Tests pass stubs; production wires real `child_process.spawn`
 * adapters at composer time. Each runner is gated by its corresponding
 * capability at the manifest layer (`host:gh`, `host:gh` for git via
 * the same shell, and `host:gh`-adjacent for bun-test — there is no
 * separate `host:bun` capability in the closed enum, so bun test
 * shares `host:gh`'s "host CLI invocation" semantics for v1).
 *
 * The interfaces here are deliberately narrow — only the operations
 * the RuntimeCodegenRunner + worktree-resolver actually need. A
 * future "shell escape hatch" Core would expose a broader surface;
 * this Core stays minimal so the auto-merge gate + worktree
 * isolation can be statically reasoned about.
 *
 * Per docs/plans/code-gen-core-tier1-brief.md § 2.3 (`host-runners.ts`).
 */

export interface HostRunnerResult {
  /** Whether the underlying child exited 0. */
  ok: boolean
  /** stdout text — trimmed; capped at 32 KB by the caller if needed. */
  stdout: string
  /** stderr text — trimmed. */
  stderr: string
  /** Exit code (or -1 on signal). */
  exit_code: number
}

export interface HostGhRunner {
  /**
   * Open a PR via `gh pr create`. Returns the assigned PR number
   * (parsed from stdout). The actual command is composed by the
   * caller; this runner just executes it.
   */
  prCreate(input: {
    cwd: string
    title: string
    body: string
    head: string
    base: string
    draft?: boolean
  }): Promise<{ pr_number: number; pr_url: string; raw: HostRunnerResult }>

  /**
   * Run `gh pr merge <n> --squash`. The CALLER is responsible for
   * enforcing the auto-merge confirmation gate BEFORE invoking this
   * method — the runner does NOT itself short-circuit on `confirm`.
   */
  prMerge(input: {
    cwd: string
    pr_number: number
    strategy?: 'squash' | 'merge' | 'rebase'
  }): Promise<HostRunnerResult>

  /** Run `gh pr diff <n>`. Used by the judgment composers. */
  prDiff(input: { cwd: string; pr_number: number }): Promise<HostRunnerResult>

  /**
   * Run `gh repo create <owner>/<slug> --private --source=<cwd>
   *   --remote=origin --push`.
   */
  repoCreate(input: {
    cwd: string
    owner: string | null
    slug: string
    private: boolean
  }): Promise<HostRunnerResult>

  /** Run `gh issue list --state open --limit 10`. */
  issueList(input: { cwd: string; limit?: number }): Promise<HostRunnerResult>
}

export interface HostGitRunner {
  /** Run `git -C <cwd> <...args>`. */
  exec(input: { cwd: string; args: string[] }): Promise<HostRunnerResult>
  /**
   * Check whether `cwd` is already a git repo. Returns false on any
   * exit-non-zero (no `.git/`, dir doesn't exist, no read perms).
   */
  isRepo(input: { cwd: string }): Promise<boolean>
}

export interface HostBunTestRunner {
  /** Run `bun test --max-concurrency=2` in `cwd`. */
  run(input: { cwd: string; max_concurrency?: number }): Promise<HostRunnerResult>
}

/**
 * Tiny in-memory stub bundle used by every test file. Captures each
 * call so assertions can verify the expected commands fired (or, in
 * the auto-merge-gate-rejects case, that NO gh prMerge call fired).
 */
export interface StubHostRunnerCalls {
  pr_create: Array<Parameters<HostGhRunner['prCreate']>[0]>
  pr_merge: Array<Parameters<HostGhRunner['prMerge']>[0]>
  pr_diff: Array<Parameters<HostGhRunner['prDiff']>[0]>
  repo_create: Array<Parameters<HostGhRunner['repoCreate']>[0]>
  issue_list: Array<Parameters<HostGhRunner['issueList']>[0]>
  git_exec: Array<Parameters<HostGitRunner['exec']>[0]>
  bun_test: Array<Parameters<HostBunTestRunner['run']>[0]>
}

export interface StubHostRunnersOverrides {
  prCreate?: (input: Parameters<HostGhRunner['prCreate']>[0]) =>
    Promise<{ pr_number: number; pr_url: string; raw: HostRunnerResult }>
  prMerge?: (input: Parameters<HostGhRunner['prMerge']>[0]) => Promise<HostRunnerResult>
  prDiff?: (input: Parameters<HostGhRunner['prDiff']>[0]) => Promise<HostRunnerResult>
  repoCreate?: (input: Parameters<HostGhRunner['repoCreate']>[0]) => Promise<HostRunnerResult>
  issueList?: (input: Parameters<HostGhRunner['issueList']>[0]) => Promise<HostRunnerResult>
  gitExec?: (input: Parameters<HostGitRunner['exec']>[0]) => Promise<HostRunnerResult>
  gitIsRepo?: (input: Parameters<HostGitRunner['isRepo']>[0]) => Promise<boolean>
  bunRun?: (input: Parameters<HostBunTestRunner['run']>[0]) => Promise<HostRunnerResult>
}

export interface StubHostRunners {
  gh: HostGhRunner
  git: HostGitRunner
  bun_test: HostBunTestRunner
  calls: StubHostRunnerCalls
}

function okResult(stdout = ''): HostRunnerResult {
  return { ok: true, stdout, stderr: '', exit_code: 0 }
}

/**
 * Build a stub bundle of host runners with sensible defaults +
 * caller-supplied overrides. Tests typically construct one of these
 * and either inspect `calls.*` or replace individual methods via
 * `overrides`.
 */
export function buildStubHostRunners(
  overrides: StubHostRunnersOverrides = {},
): StubHostRunners {
  const calls: StubHostRunnerCalls = {
    pr_create: [],
    pr_merge: [],
    pr_diff: [],
    repo_create: [],
    issue_list: [],
    git_exec: [],
    bun_test: [],
  }
  const gh: HostGhRunner = {
    async prCreate(input) {
      calls.pr_create.push(input)
      if (overrides.prCreate) return overrides.prCreate(input)
      return {
        pr_number: 1,
        pr_url: `https://github.com/stub/stub/pull/1`,
        raw: okResult('#1 stub-pr-url'),
      }
    },
    async prMerge(input) {
      calls.pr_merge.push(input)
      if (overrides.prMerge) return overrides.prMerge(input)
      return okResult(`merged PR #${input.pr_number}`)
    },
    async prDiff(input) {
      calls.pr_diff.push(input)
      if (overrides.prDiff) return overrides.prDiff(input)
      return okResult(`--- a/stub\n+++ b/stub\n@@ -1 +1 @@\n-old\n+new`)
    },
    async repoCreate(input) {
      calls.repo_create.push(input)
      if (overrides.repoCreate) return overrides.repoCreate(input)
      return okResult(`https://github.com/${input.owner ?? 'me'}/${input.slug}`)
    },
    async issueList(input) {
      calls.issue_list.push(input)
      if (overrides.issueList) return overrides.issueList(input)
      return okResult('[]')
    },
  }
  const git: HostGitRunner = {
    async exec(input) {
      calls.git_exec.push(input)
      if (overrides.gitExec) return overrides.gitExec(input)
      return okResult('')
    },
    async isRepo(input) {
      if (overrides.gitIsRepo) return overrides.gitIsRepo(input)
      // Default: not a repo (so resolver runs init).
      return false
    },
  }
  const bun_test: HostBunTestRunner = {
    async run(input) {
      calls.bun_test.push(input)
      if (overrides.bunRun) return overrides.bunRun(input)
      return okResult('0 fail')
    },
  }
  return { gh, git, bun_test, calls }
}
