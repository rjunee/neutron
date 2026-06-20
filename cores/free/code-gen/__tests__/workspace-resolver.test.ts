import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodegenWorktreeNotResolvedError } from '../src/backend.ts'
import { buildStubHostRunners } from '../src/host-runners.ts'
import { CodegenSidecarResolver } from '../src/sidecar/store.ts'
import { resolveWorktree, sluggifyBranch } from '../src/worktree-resolver.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codegen-worktree-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('resolveWorktree', () => {
  test('fresh dir → creates worktree + runs git init + gh repo create', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => false,
      gitExec: async (input) => {
        // git remote get-url origin → fail to trigger gh repo create.
        if (input.args[0] === 'remote') {
          return { ok: false, stdout: '', stderr: 'no remote', exit_code: 128 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const sidecarResolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await sidecarResolver.resolve('proj-a')
    const ws = await resolveWorktree({
      owner_home: tmp,
      project_id: 'proj-a',
      gh_runner: runners.gh,
      git_runner: runners.git,
      sidecar,
    })
    expect(ws.newly_initialised).toBe(true)
    expect(ws.worktree_path).toBe(join(tmp, 'Projects', 'proj-a', 'code'))
    expect(ws.default_branch).toBe('main')
    expect(ws.repo_slug).toBe('proj-a')
    expect(existsSync(ws.worktree_path)).toBe(true)
    // Verify the init + remote check + gh repo create all fired.
    const gitArgsFlat = runners.calls.git_exec.map((c) => c.args.join(' '))
    expect(gitArgsFlat).toContain('init --initial-branch main')
    expect(gitArgsFlat).toContain('remote get-url origin')
    expect(runners.calls.repo_create).toHaveLength(1)
    expect(runners.calls.repo_create[0]?.slug).toBe('proj-a')
    sidecarResolver.closeAll()
  })

  test('already-a-repo with origin → skips init AND skips gh repo create', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        // Origin remote exists.
        if (input.args[0] === 'remote') {
          return { ok: true, stdout: 'git@github.com:me/proj.git', stderr: '', exit_code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const sidecarResolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await sidecarResolver.resolve('proj-a')
    const ws = await resolveWorktree({
      owner_home: tmp,
      project_id: 'proj-a',
      gh_runner: runners.gh,
      git_runner: runners.git,
      sidecar,
    })
    expect(ws.newly_initialised).toBe(false)
    const gitArgsFlat = runners.calls.git_exec.map((c) => c.args.join(' '))
    expect(gitArgsFlat).not.toContain('init --initial-branch main')
    expect(runners.calls.repo_create).toHaveLength(0)
    sidecarResolver.closeAll()
  })

  test('repo-with-no-remote → runs `gh repo create` only (no second init)', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: false, stdout: '', stderr: 'no remote', exit_code: 128 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const sidecarResolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await sidecarResolver.resolve('proj-a')
    await resolveWorktree({
      owner_home: tmp,
      project_id: 'proj-a',
      gh_runner: runners.gh,
      git_runner: runners.git,
      sidecar,
    })
    const gitArgsFlat = runners.calls.git_exec.map((c) => c.args.join(' '))
    expect(gitArgsFlat).not.toContain('init --initial-branch main')
    expect(runners.calls.repo_create).toHaveLength(1)
    sidecarResolver.closeAll()
  })

  test('gh fails → throws CodegenWorktreeNotResolvedError', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => false,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: false, stdout: '', stderr: 'no remote', exit_code: 128 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
      repoCreate: async () => ({ ok: false, stdout: '', stderr: 'gh: auth required', exit_code: 1 }),
    })
    const sidecarResolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await sidecarResolver.resolve('proj-a')
    await expect(
      resolveWorktree({
        owner_home: tmp,
        project_id: 'proj-a',
        gh_runner: runners.gh,
        git_runner: runners.git,
        sidecar,
      }),
    ).rejects.toBeInstanceOf(CodegenWorktreeNotResolvedError)
    sidecarResolver.closeAll()
  })
})

describe('sluggifyBranch', () => {
  test('lowercase + dashes + ≤40 char base', () => {
    expect(sluggifyBranch('Add a /healthz endpoint')).toBe('feat/code-gen-add-a-healthz-endpoint')
  })
  test('with suffix → `-<8-char-suffix>` appended', () => {
    expect(sluggifyBranch('Add a /healthz endpoint', 'abcdef12')).toBe(
      'feat/code-gen-add-a-healthz-endpoint-abcdef12',
    )
  })
  test('empty / non-alnum → falls back to "task"', () => {
    expect(sluggifyBranch('!!!')).toBe('feat/code-gen-task')
  })
})
