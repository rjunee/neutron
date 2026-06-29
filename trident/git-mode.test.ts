import { describe, expect, test } from 'bun:test'
import {
  cleanupAfterMerge,
  defaultGitModeProbe,
  detectMergeMode,
  isGithubRemoteUrl,
  type GitModeProbe,
  type HostCommandResult,
} from './git-mode.ts'
import type { TridentRun } from './store.ts'

function makeRun(overrides: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'id',
    slug: 's',
    project_slug: 't1',
    phase: 'done',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'feat',
    pr: 7,
    merge_mode: 'local',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/r',
    worktree: null,
    task: 't',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('isGithubRemoteUrl', () => {
  test('matches https + ssh GitHub remotes', () => {
    expect(isGithubRemoteUrl('https://github.com/rjunee/neutron.git')).toBe(true)
    expect(isGithubRemoteUrl('git@github.com:rjunee/neutron.git')).toBe(true)
    expect(isGithubRemoteUrl('ssh://git@github.com/rjunee/neutron.git')).toBe(true)
  })

  test('rejects non-GitHub + empty remotes', () => {
    expect(isGithubRemoteUrl('https://gitlab.com/x/y.git')).toBe(false)
    expect(isGithubRemoteUrl('https://example.com/github.com-impersonator')).toBe(false)
    expect(isGithubRemoteUrl('')).toBe(false)
    expect(isGithubRemoteUrl('   ')).toBe(false)
  })
})

describe('detectMergeMode', () => {
  const probe = (hasOrigin: boolean, hasGh: boolean): GitModeProbe => ({
    hasGithubOrigin: async () => hasOrigin,
    ghAvailable: async () => hasGh,
  })

  test("returns 'pr' when a github origin AND gh are both present", async () => {
    expect(await detectMergeMode('/repo', probe(true, true))).toBe('pr')
  })

  test("returns 'local' when gh is missing", async () => {
    expect(await detectMergeMode('/repo', probe(true, false))).toBe('local')
  })

  test("returns 'local' when there is no github origin", async () => {
    expect(await detectMergeMode('/repo', probe(false, true))).toBe('local')
  })

  test("returns 'local' when neither is present", async () => {
    expect(await detectMergeMode('/repo', probe(false, false))).toBe('local')
  })

  test('a throwing probe degrades to local, never errors the run', async () => {
    const boom: GitModeProbe = {
      hasGithubOrigin: async () => {
        throw new Error('git missing')
      },
      ghAvailable: async () => true,
    }
    expect(await detectMergeMode('/repo', boom)).toBe('local')
  })
})

describe('defaultGitModeProbe (injected runner)', () => {
  const ok = (stdout: string): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
  const fail = (): HostCommandResult => ({ ok: false, stdout: '', stderr: 'no', exit_code: 1 })

  test('detects a github origin via the git runner', async () => {
    const probe = defaultGitModeProbe(async (cmd) => {
      if (cmd[0] === 'git') return ok('https://github.com/rjunee/neutron.git')
      return ok('gh version 2.0')
    })
    expect(await probe.hasGithubOrigin('/repo')).toBe(true)
    expect(await probe.ghAvailable()).toBe(true)
    expect(await detectMergeMode('/repo', probe)).toBe('pr')
  })

  test('no origin remote → not a github origin → local', async () => {
    const probe = defaultGitModeProbe(async (cmd) => {
      if (cmd[0] === 'git') return fail() // `git remote get-url origin` exits non-zero
      return ok('gh version 2.0')
    })
    expect(await probe.hasGithubOrigin('/repo')).toBe(false)
    expect(await detectMergeMode('/repo', probe)).toBe('local')
  })

  test('gh missing → ghAvailable false → local', async () => {
    const probe = defaultGitModeProbe(async (cmd) => {
      if (cmd[0] === 'git') return ok('git@github.com:rjunee/neutron.git')
      return fail()
    })
    expect(await probe.ghAvailable()).toBe(false)
    expect(await detectMergeMode('/repo', probe)).toBe('local')
  })
})

describe('cleanupAfterMerge (PR-3 seam stubs)', () => {
  test('pr mode without an impl reports not-performed', async () => {
    const res = await cleanupAfterMerge(makeRun({ merge_mode: 'pr' }))
    expect(res.mode).toBe('pr')
    expect(res.performed).toBe(false)
  })

  test('local mode without an impl reports not-performed', async () => {
    const res = await cleanupAfterMerge(makeRun({ merge_mode: 'local' }))
    expect(res.mode).toBe('local')
    expect(res.performed).toBe(false)
  })

  test('pr mode invokes the injected mergePr impl', async () => {
    let called = false
    const res = await cleanupAfterMerge(makeRun({ merge_mode: 'pr' }), {
      mergePr: async () => {
        called = true
      },
    })
    expect(called).toBe(true)
    expect(res.performed).toBe(true)
  })

  test('local mode invokes the injected mergeLocal impl', async () => {
    let called = false
    const res = await cleanupAfterMerge(makeRun({ merge_mode: 'local' }), {
      mergeLocal: async () => {
        called = true
      },
    })
    expect(called).toBe(true)
    expect(res.performed).toBe(true)
  })
})
