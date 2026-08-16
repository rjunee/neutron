import { describe, expect, test } from 'bun:test'
import {
  cleanupAfterMerge,
  defaultGitModeProbe,
  detectMergeMode,
  isGithubRemoteUrl,
  unwiredPublisherCredential,
  type GitModeProbe,
  type HostCommandResult,
  type PublisherCredentialSource,
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
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    harvested_at: null,
    crash_recoveries: 0,
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

// A placeholder handle. The owner's real one never enters a test.
const PUBLISHER = { owner_handle: 'owner-a', source: 'a fake store' } as const

describe('detectMergeMode', () => {
  const probe = (hasOrigin: boolean, canPublish: boolean): GitModeProbe => ({
    publisher: PUBLISHER,
    hasGithubOrigin: async () => hasOrigin,
    publisherAvailable: async () =>
      canPublish
        ? { authenticated: true }
        : { authenticated: false, cause: 'no_credential_available' },
  })

  test("returns 'pr' when a github origin AND gh are both present", async () => {
    expect(await detectMergeMode('/repo', probe(true, true))).toBe('pr')
  })

  test('a GitHub origin without a capable publisher fails loudly', async () => {
    await expect(detectMergeMode('/repo', probe(true, false))).rejects.toThrow('refusing to silently weaken')
  })

  test("returns 'local' when there is no github origin", async () => {
    expect(await detectMergeMode('/repo', probe(false, true))).toBe('local')
  })

  test("returns 'local' when neither is present", async () => {
    expect(await detectMergeMode('/repo', probe(false, false))).toBe('local')
  })

  test('a throwing probe degrades to local, never errors the run', async () => {
    const boom: GitModeProbe = {
      publisher: PUBLISHER,
      hasGithubOrigin: async () => {
        throw new Error('git missing')
      },
      publisherAvailable: async () => ({ authenticated: true }),
    }
    expect(await detectMergeMode('/repo', boom)).toBe('local')
  })

  test('a throwing publisher probe on a GitHub repo fails loudly', async () => {
    await expect(detectMergeMode('/repo', {
      publisher: PUBLISHER,
      hasGithubOrigin: async () => true,
      publisherAvailable: async () => { throw new Error('secret store unavailable') },
    })).rejects.toThrow('refusing to silently weaken')
  })
})

// THE REFUSAL NAMES ITS CAUSE. "cannot authenticate" is equally true of a
// missing token, an expired one, and a probe that was never handed one — and a
// refusal that does not distinguish them has cost a day, repeatedly. Each case
// asserts BOTH the cause and the owner handle the lookup was made under, and
// asserts the OTHER causes are absent so the three can never be confused.
describe('detectMergeMode names WHY the publisher could not authenticate', () => {
  const identity = { owner_handle: 'owner-a', source: 'the instance secrets store' }

  const refusal = async (
    result: Awaited<ReturnType<GitModeProbe['publisherAvailable']>>,
  ): Promise<string> => {
    try {
      await detectMergeMode('/repo', {
        publisher: identity,
        hasGithubOrigin: async () => true,
        publisherAvailable: async () => result,
      })
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    throw new Error('expected a refusal')
  }

  test('nothing stored reads as "not connected", explicitly NOT an expired token', async () => {
    const msg = await refusal({ authenticated: false, cause: 'no_credential_available' })
    expect(msg).toContain('no GitHub credential is stored')
    expect(msg).toContain('not an expired token')
    expect(msg).toContain('owner-a')
    expect(msg).toContain('the instance secrets store')
    expect(msg).not.toContain('REJECTED')
  })

  test('a stored-but-rejected credential reads as expired/revoked, not as missing', async () => {
    const msg = await refusal({
      authenticated: false,
      cause: 'credential_rejected',
      detail: 'HTTP 401: Bad credentials',
    })
    expect(msg).toContain('REJECTED')
    expect(msg).toContain('expired, revoked, or missing a scope')
    expect(msg).toContain('HTTP 401: Bad credentials')
    expect(msg).toContain('owner-a')
    expect(msg).not.toContain('no GitHub credential is stored')
  })

  test('an unrunnable publisher CLI is unverifiable — it blames neither token nor owner', async () => {
    const msg = await refusal({
      authenticated: false,
      cause: 'publisher_cli_unavailable',
      detail: 'ENOENT',
    })
    expect(msg).toContain('could not be executed on this host')
    expect(msg).toContain('owner-a')
    expect(msg).not.toContain('REJECTED')
    expect(msg).not.toContain('no GitHub credential is stored')
  })

  test('a probe that THREW says so, and still names the handle it was asked about', async () => {
    let msg = ''
    try {
      await detectMergeMode('/repo', {
        publisher: identity,
        hasGithubOrigin: async () => true,
        publisherAvailable: async () => {
          throw new Error('secrets keyfile unreadable')
        },
      })
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    expect(msg).toContain('the publisher capability probe itself failed')
    expect(msg).toContain('secrets keyfile unreadable')
    expect(msg).toContain('owner-a')
  })

  test('every refusal keeps the original guard sentence — the gate itself is unchanged', async () => {
    const msg = await refusal({ authenticated: false, cause: 'no_credential_available' })
    expect(msg).toContain('refusing to silently weaken the PR merge gate')
  })
})

describe('defaultGitModeProbe (injected runner)', () => {
  const ok = (stdout: string): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
  const fail = (): HostCommandResult => ({ ok: false, stdout: '', stderr: 'no', exit_code: 1 })

  /**
   * A credential source backed by a FAKE TOKEN STORE — the seam every assertion
   * below goes through. No environment variable is ever set: mutating the test
   * process's env would exercise the ambient-`gh` reading that this change
   * removes, and would pass for the broken implementation too.
   */
  const storedCredential = (token: string | null): PublisherCredentialSource => ({
    owner_handle: 'owner-a',
    source: 'a fake token store',
    load: async () => (token === null ? {} : { GH_TOKEN: token }),
  })

  test('detects a github origin via the git runner', async () => {
    const probe = defaultGitModeProbe(storedCredential('t0k'), async (cmd) => {
      if (cmd[0] === 'git') return ok('https://github.com/rjunee/neutron.git')
      return ok('logged in')
    })
    expect(await probe.hasGithubOrigin('/repo')).toBe(true)
    expect(await probe.publisherAvailable()).toEqual({ authenticated: true })
    expect(await detectMergeMode('/repo', probe)).toBe('pr')
  })

  test('no origin remote → not a github origin → local', async () => {
    const probe = defaultGitModeProbe(storedCredential('t0k'), async (cmd) => {
      if (cmd[0] === 'git') return fail() // `git remote get-url origin` exits non-zero
      return ok('logged in')
    })
    expect(await probe.hasGithubOrigin('/repo')).toBe(false)
    expect(await detectMergeMode('/repo', probe)).toBe('local')
  })

  test('publisher authentication missing on a GitHub repo fails loudly', async () => {
    const probe = defaultGitModeProbe(storedCredential(null), async (cmd) => {
      if (cmd[0] === 'git') return ok('git@github.com:rjunee/neutron.git')
      return fail()
    })
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'no_credential_available',
    })
    await expect(detectMergeMode('/repo', probe)).rejects.toThrow('outer publisher cannot authenticate')
  })
})

/**
 * THE GUARD — the reported bug, reduced.
 *
 * A host whose AMBIENT publisher CLI has never been logged in (which is every
 * gateway process: the token is injected per spawn and never lives in the
 * gateway's own environment) but whose token store holds a valid credential.
 * The probe MUST answer yes, because the publisher it speaks for is handed that
 * same credential.
 *
 * Asserted entirely through the token-store seam — `process.env` is never
 * touched.
 */
describe('a stored credential beats an un-logged-in ambient CLI', () => {
  /** A host where `auth status` succeeds IFF the call carried an injected token. */
  const hostWithNoAmbientLogin =
    (seen: { envs: (Record<string, string> | undefined)[] }) =>
    async (
      cmd: string[],
      _cwd?: string,
      extraEnv?: Record<string, string>,
    ): Promise<HostCommandResult> => {
      if (cmd[0] === 'git') {
        return { ok: true, stdout: 'https://github.com/rjunee/neutron.git', stderr: '', exit_code: 0 }
      }
      seen.envs.push(extraEnv)
      const token = extraEnv?.['GH_TOKEN'] ?? ''
      return token.length > 0
        ? { ok: true, stdout: 'Logged in to github.com account owner-a', stderr: '', exit_code: 0 }
        : { ok: false, stdout: '', stderr: 'You are not logged into any GitHub hosts.', exit_code: 1 }
    }

  test('stored token + no ambient login → available, and the mode is pr', async () => {
    const seen = { envs: [] as (Record<string, string> | undefined)[] }
    const probe = defaultGitModeProbe(
      {
        owner_handle: 'owner-a',
        source: 'a fake token store',
        load: async () => ({ GH_TOKEN: 't0k' }),
      },
      hostWithNoAmbientLogin(seen),
    )
    expect(await probe.publisherAvailable()).toEqual({ authenticated: true })
    expect(await detectMergeMode('/repo', probe)).toBe('pr')
    // CONTROL proving the mutation landed: the credential really did reach the
    // capability call. Without it the assertion above would also pass for a
    // probe that ignored the store and ran on a logged-in host.
    expect(seen.envs.length).toBeGreaterThan(0)
    expect(seen.envs.every((e) => e?.['GH_TOKEN'] === 't0k')).toBe(true)
  })

  test('CONTROL — the SAME host with an empty store refuses, so the probe is not always-true', async () => {
    const seen = { envs: [] as (Record<string, string> | undefined)[] }
    const probe = defaultGitModeProbe(
      { owner_handle: 'owner-a', source: 'a fake token store', load: async () => ({}) },
      hostWithNoAmbientLogin(seen),
    )
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'no_credential_available',
    })
    // …and it never asked the host at all: "nothing stored" is answered from the
    // store, never laundered through a question about ambient state.
    expect(seen.envs.length).toBe(0)
  })

  test('a token the host rejects is `credential_rejected`, never `no_credential_available`', async () => {
    const probe = defaultGitModeProbe(
      {
        owner_handle: 'owner-a',
        source: 'a fake token store',
        load: async () => ({ GH_TOKEN: 'expired' }),
      },
      async (cmd): Promise<HostCommandResult> => {
        if (cmd[0] === 'git') {
          return { ok: true, stdout: 'https://github.com/rjunee/neutron.git', stderr: '', exit_code: 0 }
        }
        return { ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials', exit_code: 1 }
      },
    )
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'credential_rejected',
      detail: 'HTTP 401: Bad credentials',
    })
  })

  test('an unspawnable publisher CLI (exit -1) is unavailable, not a bad token', async () => {
    const probe = defaultGitModeProbe(
      {
        owner_handle: 'owner-a',
        source: 'a fake token store',
        load: async () => ({ GH_TOKEN: 't0k' }),
      },
      async (): Promise<HostCommandResult> => ({
        ok: false,
        stdout: '',
        stderr: 'ENOENT',
        exit_code: -1,
      }),
    )
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'publisher_cli_unavailable',
      detail: 'ENOENT',
    })
  })
})

describe('unwiredPublisherCredential', () => {
  test('reports emptiness AS emptiness and never consults the host', async () => {
    let hostCalls = 0
    const probe = defaultGitModeProbe(unwiredPublisherCredential('owner-a'), async (cmd) => {
      hostCalls += 1
      if (cmd[0] === 'git') {
        return { ok: true, stdout: 'https://github.com/rjunee/neutron.git', stderr: '', exit_code: 0 }
      }
      // Reaching here means the "unwired" source asked about ambient state — the bug.
      return { ok: true, stdout: 'authenticated', stderr: '', exit_code: 0 }
    })
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'no_credential_available',
    })
    expect(hostCalls).toBe(0)
    await expect(detectMergeMode('/repo', probe)).rejects.toThrow(
      'no credential source was wired into this composition',
    )
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
