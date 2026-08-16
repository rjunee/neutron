import { describe, expect, test } from 'bun:test'
import {
  cleanupAfterMerge,
  defaultGitModeProbe,
  detectMergeMode,
  isGithubRemoteUrl,
  looksLikeGithubUnreachable,
  spawnCapture,
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
    expect(isGithubRemoteUrl('https://github.com/example-org/example-repo.git')).toBe(true)
    expect(isGithubRemoteUrl('git@github.com:example-org/example-repo.git')).toBe(true)
    expect(isGithubRemoteUrl('ssh://git@github.com/example-org/example-repo.git')).toBe(true)
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
      if (cmd[0] === 'git') return ok('https://github.com/example-org/example-repo.git')
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
      if (cmd[0] === 'git') return ok('git@github.com:example-org/example-repo.git')
      return fail()
    })
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'no_credential_available',
      detail: 'no',
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
        return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
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
      detail: 'You are not logged into any GitHub hosts.',
    })
    // It DID ask the host, carrying the empty environment the publisher would
    // carry — see the ambient-parity suite below for why asking is mandatory.
    // What makes the answer `no_credential_available` rather than
    // `credential_rejected` is that there was no token to reject.
    expect(seen.envs).toEqual([{}])
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
          return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
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
  test('names no handle, because no lookup ran — it never renders a project slug as an owner', async () => {
    const src = unwiredPublisherCredential()
    expect(src.owner_handle).toBe('unknown')
    expect(await src.load()).toEqual({})
    // The regression this closes: the only caller had no handle to give and
    // passed the PROJECT SLUG, so the refusal read `owner handle "<slug>"` and
    // sent the reader to check a row that was never consulted. The function now
    // takes no argument at all, so that misuse does not typecheck.
    expect(unwiredPublisherCredential.length).toBe(0)
  })

  test('an unwired composition on a host with no ambient login refuses BY NAME', async () => {
    const probe = defaultGitModeProbe(unwiredPublisherCredential(), async (cmd) => {
      if (cmd[0] === 'git') {
        return {
          ok: true,
          stdout: 'https://github.com/example-org/example-repo.git',
          stderr: '',
          exit_code: 0,
        }
      }
      return { ok: false, stdout: '', stderr: 'You are not logged into any GitHub hosts.', exit_code: 1 }
    })
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'no_credential_available',
      detail: 'You are not logged into any GitHub hosts.',
    })
    const msg = await detectMergeMode('/repo', probe).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(msg).toContain('no credential source was wired into this composition')
    expect(msg).toContain('unknown')
  })
})

/**
 * AMBIENT PARITY — the probe must not be STRICTER than the publisher it speaks for.
 *
 * The publisher spawns `{ ...process.env, ...env }` and omits `env` entirely
 * when it is empty (`spawnCapture`), so on a host where the owner ran
 * `gh auth login` and never connected GitHub in-app, publishing WORKS today.
 * Round 1 of this fix short-circuited an empty store straight to
 * `no_credential_available` without asking anything, which would have started
 * refusing exactly that host — trading the original false negative for a new
 * one. The probe therefore always runs the same command in the same environment
 * the publisher will use.
 *
 * Asserted through the credential seam; `process.env` is never touched.
 */
describe('the probe is never stricter than the publisher it speaks for', () => {
  /** A host whose AMBIENT publisher CLI is logged in, and which knows no store. */
  const hostWithAmbientLogin =
    (seen: { envs: (Record<string, string> | undefined)[] }) =>
    async (
      cmd: string[],
      _cwd?: string,
      extraEnv?: Record<string, string>,
    ): Promise<HostCommandResult> => {
      if (cmd[0] === 'git') {
        return {
          ok: true,
          stdout: 'https://github.com/example-org/example-repo.git',
          stderr: '',
          exit_code: 0,
        }
      }
      seen.envs.push(extraEnv)
      return {
        ok: true,
        stdout: 'Logged in to github.com account example-owner',
        stderr: '',
        exit_code: 0,
      }
    }

  test('empty store + ambient login → available, and the mode is pr', async () => {
    const seen = { envs: [] as (Record<string, string> | undefined)[] }
    const probe = defaultGitModeProbe(
      { owner_handle: 'owner-a', source: 'a fake token store', load: async () => ({}) },
      hostWithAmbientLogin(seen),
    )
    expect(await probe.publisherAvailable()).toEqual({ authenticated: true })
    expect(await detectMergeMode('/repo', probe)).toBe('pr')
    // CONTROL proving the mutation landed: the probe really did reach the host,
    // and really did carry the empty environment the publisher would carry — so
    // this passes for the same reason the publisher would succeed, not by luck.
    expect(seen.envs.length).toBeGreaterThan(0)
    expect(seen.envs.every((e) => e !== undefined && Object.keys(e).length === 0)).toBe(true)
  })

  test('CONTROL — the SAME empty store on a host with NO ambient login still refuses', async () => {
    const probe = defaultGitModeProbe(
      { owner_handle: 'owner-a', source: 'a fake token store', load: async () => ({}) },
      async (cmd): Promise<HostCommandResult> => {
        if (cmd[0] === 'git') {
          return {
            ok: true,
            stdout: 'https://github.com/example-org/example-repo.git',
            stderr: '',
            exit_code: 0,
          }
        }
        return { ok: false, stdout: '', stderr: 'You are not logged into any GitHub hosts.', exit_code: 1 }
      },
    )
    expect((await probe.publisherAvailable()).authenticated).toBe(false)
    await expect(detectMergeMode('/repo', probe)).rejects.toThrow('refusing to silently weaken')
  })
})

/**
 * A HOST FAILURE IS NOT A VERDICT ON THE TOKEN.
 *
 * `gh auth status` makes a live API round-trip, so DNS failure, an offline host,
 * a proxy, a GitHub 5xx and our own 60s watchdog kill all exit non-zero with a
 * perfectly good credential. Round 1 mapped every non-(-1) non-zero exit to
 * `credential_rejected`, whose refusal text tells the owner the token is expired
 * or revoked — sending him to rotate a working credential during an outage.
 */
describe('unreachable GitHub is reported as unreachable, not as a bad token', () => {
  const withToken: PublisherCredentialSource = {
    owner_handle: 'owner-a',
    source: 'a fake token store',
    load: async () => ({ GH_TOKEN: 't0k' }),
  }
  const ghFails =
    (res: Omit<HostCommandResult, 'ok'>) =>
    async (cmd: string[]): Promise<HostCommandResult> => {
      if (cmd[0] === 'git') {
        return {
          ok: true,
          stdout: 'https://github.com/example-org/example-repo.git',
          stderr: '',
          exit_code: 0,
        }
      }
      return { ok: false, ...res }
    }

  test('a DNS failure is `could_not_reach_github`', async () => {
    const probe = defaultGitModeProbe(
      withToken,
      ghFails({ stdout: '', stderr: 'dial tcp: lookup api.github.com: no such host', exit_code: 1 }),
    )
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'could_not_reach_github',
      detail: 'dial tcp: lookup api.github.com: no such host',
    })
  })

  test('a GitHub 5xx is `could_not_reach_github`', async () => {
    const probe = defaultGitModeProbe(
      withToken,
      ghFails({ stdout: '', stderr: 'HTTP 503: Service Unavailable', exit_code: 1 }),
    )
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('could_not_reach_github')
  })

  test('OUR OWN watchdog kill is `could_not_reach_github`, though the exit code looks ordinary', async () => {
    const probe = defaultGitModeProbe(
      withToken,
      ghFails({ stdout: '', stderr: '', exit_code: 143, timed_out: true }),
    )
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'could_not_reach_github',
      detail: 'timed out after 60s',
    })
  })

  test('CONTROL — a genuine 401 on the SAME shape is still `credential_rejected`', async () => {
    const probe = defaultGitModeProbe(
      withToken,
      ghFails({ stdout: '', stderr: 'HTTP 401: Bad credentials', exit_code: 1 }),
    )
    // Proves the branches above NARROW rather than swallow: an exit code of 1
    // carrying a credential verdict still reaches the owner as one.
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
  })

  test('CONTROL — an unrecognised failure falls through to the credential reading', async () => {
    const probe = defaultGitModeProbe(withToken, ghFails({ stdout: '', stderr: 'weird', exit_code: 1 }))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
  })

  test('the refusal text tells the owner NOT to rotate the token', async () => {
    const msg = await detectMergeMode('/repo', {
      publisher: { owner_handle: 'owner-a', source: 'the instance secrets store' },
      hasGithubOrigin: async () => true,
      publisherAvailable: async () => ({
        authenticated: false,
        cause: 'could_not_reach_github',
        detail: 'i/o timeout',
      }),
    }).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(msg).toContain('could not reach GitHub')
    expect(msg).toContain('Do NOT rotate the token')
    expect(msg).toContain('owner-a')
    expect(msg).not.toContain('REJECTED')
    expect(msg).not.toContain('no GitHub credential is stored')
  })
})

describe('looksLikeGithubUnreachable', () => {
  test('recognises the transport failures the publisher CLI actually prints', () => {
    for (const line of [
      'dial tcp 140.82.113.5:443: connect: connection refused',
      'Get "https://api.github.com/": context deadline exceeded',
      'net/http: TLS handshake timeout',
      'lookup api.github.com: no such host',
      'HTTP 502: Bad Gateway',
      'proxyconnect tcp: dial tcp: i/o timeout',
    ]) {
      expect(looksLikeGithubUnreachable(line)).toBe(true)
    }
  })

  test('CONTROL — credential verdicts and empty output are NOT transport failures', () => {
    for (const line of [
      '',
      'HTTP 401: Bad credentials',
      'HTTP 403: Resource not accessible by personal access token',
      'You are not logged into any GitHub hosts.',
    ]) {
      expect(looksLikeGithubUnreachable(line)).toBe(false)
    }
  })
})

describe('spawnCapture flags a timeout only when it caused one', () => {
  test('a fast command carries no `timed_out`', async () => {
    const res = await spawnCapture(['true'])
    expect(res.ok).toBe(true)
    // The flag is the ONLY thing distinguishing our kill from an ordinary
    // non-zero exit, so a spuriously-set one would relabel every real
    // credential rejection as a network problem.
    expect(res.timed_out).toBeUndefined()
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
