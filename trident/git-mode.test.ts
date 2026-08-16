import { describe, expect, test } from 'bun:test'
import {
  cleanupAfterMerge,
  defaultGitModeProbe,
  detectMergeMode,
  isGithubRemoteUrl,
  looksLikeAmbiguousLoginFailure,
  looksLikeCredentialRejected,
  looksLikeGithubRateLimited,
  looksLikeGithubUnreachable,
  looksLikeNoGithubAuth,
  renderAuthFailureDetail,
  spawnCapture,
  MAX_AUTH_FAILURE_DETAIL_CHARS,
  PUBLISHER_AUTH_COMMAND,
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
const PUBLISHER: PublisherCredentialSource = {
  owner_handle: 'owner-a',
  source: 'a fake store',
  load: async () => ({}),
}

describe('detectMergeMode', () => {
  const probe = (hasOrigin: boolean, canPublish: boolean): GitModeProbe => ({
    credential: PUBLISHER,
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
      credential: PUBLISHER,
      hasGithubOrigin: async () => {
        throw new Error('git missing')
      },
      publisherAvailable: async () => ({ authenticated: true }),
    }
    expect(await detectMergeMode('/repo', boom)).toBe('local')
  })

  test('a throwing publisher probe on a GitHub repo fails loudly', async () => {
    await expect(detectMergeMode('/repo', {
      credential: PUBLISHER,
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
  const identity: PublisherCredentialSource = {
    owner_handle: 'owner-a',
    source: 'the instance secrets store',
    load: async () => ({}),
  }

  const refusal = async (
    result: Awaited<ReturnType<GitModeProbe['publisherAvailable']>>,
  ): Promise<string> => {
    try {
      await detectMergeMode('/repo', {
        credential: identity,
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
        credential: identity,
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
  // `gh`'s real wording when it holds no credential at all — the classifier now
  // reads the OUTPUT, not merely the exit code, so a stub must speak `gh`.
  const NO_AUTH = 'You are not logged into any GitHub hosts. To log in, run: gh auth login'
  const fail = (): HostCommandResult => ({ ok: false, stdout: '', stderr: NO_AUTH, exit_code: 1 })

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
      detail: NO_AUTH,
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
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
    expect(res.authenticated === false && res.detail).toContain('HTTP 401: Bad credentials')
    expect(res.authenticated === false && res.detail).toContain(
      'the credential resolved from the configured source',
    )
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

  // THE INVERSION. Round 2 whitelisted transport failures and let EVERYTHING
  // else fall through to `credential_rejected`, whose text tells the owner the
  // token is expired or revoked. So any failure mode not enumerated in
  // `looksLikeGithubUnreachable` — a TLS/x509 error being the concrete one Argus
  // found — arrived as a confident, specific claim about a token that had been
  // learned nothing about. `credential_rejected` now requires POSITIVE evidence.
  test('an x509/TLS failure is NOT reported as a rejected credential', async () => {
    const probe = defaultGitModeProbe(
      withToken,
      ghFails({
        stdout: '',
        stderr:
          'Get "https://api.github.com/": x509: certificate signed by unknown authority',
        exit_code: 1,
      }),
    )
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).not.toBe('credential_rejected')
    expect(res.authenticated === false && res.cause).toBe('probe_failed')
    // …and the owner is told, in as many words, not to act on it.
    const msg = await detectMergeMode('/repo', probe).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(msg).toContain('Do NOT rotate the token')
    expect(msg).not.toContain('REJECTED')
  })

  test('an unrecognised failure says so instead of guessing the costly cause', async () => {
    const probe = defaultGitModeProbe(withToken, ghFails({ stdout: '', stderr: 'weird', exit_code: 1 }))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('probe_failed')
    // The detail names the command and the exit code, so an unclassified failure
    // is still actionable by a reader without being misattributed to the token.
    expect(res.authenticated === false && res.detail).toContain('no recognisable verdict')
    expect(res.authenticated === false && res.detail).toContain('gh auth status')
  })

  // CONTROL that the inversion NARROWED rather than swallowed: every wording
  // that PROVES GitHub answered and refused still reaches the owner as one.
  //
  // Each string below requires a live GitHub response body to exist at all — a
  // transport failure cannot fabricate `Bad credentials` or a scope list — which
  // is exactly what separates them from the ambiguous wordings covered by the
  // `credential_verdict_unavailable` suite below. Two entries that used to live
  // in this list (`The token in GH_TOKEN is invalid.` and `X Failed to log in
  // …`) moved there, because measurement showed `gh` prints them for a dead
  // network too.
  test('CONTROL — wordings that PROVE GitHub answered are still `credential_rejected`', async () => {
    for (const stderr of [
      'HTTP 401: Bad credentials',
      'HTTP 403: Resource not accessible by personal access token',
      'error: missing required scopes: repo',
      'HTTP 403: Your token has not been granted the required scopes',
      'This endpoint requires authentication',
    ]) {
      const probe = defaultGitModeProbe(withToken, ghFails({ stdout: '', stderr, exit_code: 1 }))
      const res = await probe.publisherAvailable()
      expect(res.authenticated === false && res.cause).toBe('credential_rejected')
    }
  })

  test('the refusal text tells the owner NOT to rotate the token', async () => {
    const msg = await detectMergeMode('/repo', {
      credential: {
        owner_handle: 'owner-a',
        source: 'the instance secrets store',
        load: async () => ({}),
      },
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

/**
 * THE REPORTED BUG, REDUCED — and the reason it was a REFUSAL rather than a
 * misleading message.
 *
 * Measured on the host with gh 2.97.0: `gh auth status` with no flags checks
 * every account on every known host, and per its own `--help` exits 1 "if an
 * account on any host … has authentication issues". With a VALID publisher token
 * injected it printed `✓ Logged in to github.com account <handle> (GH_TOKEN)`
 * AND `X Failed to log in to github.com account <handle> (default)` — and exited
 * 1. `res.ok` was false, so `detectMergeMode` refused, and every board build was
 * blocked by a stale account the publisher never uses. The same token with
 * `--hostname github.com --active` exits 0.
 */
describe('a stale unrelated account cannot veto a valid publisher credential', () => {
  const withToken: PublisherCredentialSource = {
    owner_handle: 'owner-a',
    source: 'a fake token store',
    load: async () => ({ GH_TOKEN: 't0k' }),
  }

  /**
   * A host carrying a second, broken account — the shape measured above. It
   * answers as the real CLI does: the UNSCOPED question fails (because of the
   * other account), the SCOPED one succeeds (because our credential is fine).
   */
  const hostWithStaleSecondAccount =
    (seen: { cmds: string[][] }) =>
    async (cmd: string[], _cwd?: string, extraEnv?: Record<string, string>): Promise<HostCommandResult> => {
      if (cmd[0] === 'git') {
        return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
      }
      seen.cmds.push(cmd)
      const scoped = cmd.includes('--active') && cmd.includes('--hostname')
      const token = extraEnv?.['GH_TOKEN'] ?? ''
      if (scoped && token.length > 0) {
        return { ok: true, stdout: 'Logged in to github.com account owner-a (GH_TOKEN)', stderr: '', exit_code: 0 }
      }
      return {
        ok: false,
        stdout: '',
        stderr:
          'X Failed to log in to github.com account owner-a (default)\n' +
          '  - The token in default is invalid.',
        exit_code: 1,
      }
    }

  test('the probe asks the SCOPED question, so the good token resolves to pr mode', async () => {
    const seen = { cmds: [] as string[][] }
    const probe = defaultGitModeProbe(withToken, hostWithStaleSecondAccount(seen))
    expect(await probe.publisherAvailable()).toEqual({ authenticated: true })
    expect(await detectMergeMode('/repo', probe)).toBe('pr')
    // CONTROL that the pass came from the scoping and not from a lenient stub:
    // the exact flags reached the CLI.
    expect(seen.cmds.length).toBeGreaterThan(0)
    expect(seen.cmds[0]).toEqual(['gh', 'auth', 'status', '--hostname', 'github.com', '--active'])
  })

  test('CONTROL — the SAME host answering the UNSCOPED question refuses, which is the bug', async () => {
    // Proves the test above measures the scoping. This probe is the pre-fix one:
    // same host, same valid token, unscoped question → the refusal the owner saw.
    const unscoped = defaultGitModeProbe(withToken, async (cmd, cwd, extraEnv) =>
      hostWithStaleSecondAccount({ cmds: [] })(
        cmd[0] === 'git' ? cmd : ['gh', 'auth', 'status'],
        cwd,
        extraEnv,
      ),
    )
    expect((await unscoped.publisherAvailable()).authenticated).toBe(false)
    await expect(detectMergeMode('/repo', unscoped)).rejects.toThrow('refusing to silently weaken')
  })

  test('the exported command is the scoped one — the flags are not incidental', () => {
    expect([...PUBLISHER_AUTH_COMMAND]).toEqual([
      'gh',
      'auth',
      'status',
      '--hostname',
      'github.com',
      '--active',
    ])
  })

  test('a `gh` too old for the flags is a CLI problem, never a token verdict', async () => {
    const probe = defaultGitModeProbe(withToken, async (cmd): Promise<HostCommandResult> => {
      if (cmd[0] === 'git') {
        return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
      }
      return { ok: false, stdout: '', stderr: 'unknown flag: --active', exit_code: 1 }
    })
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('publisher_cli_unavailable')
    expect(res.authenticated === false && res.detail).toContain('gh >= 2.41')
  })
})

/**
 * A CREDENTIAL THAT NEVER REACHED `gh` IS NOT A REJECTED CREDENTIAL.
 *
 * `EnvCapableHostRunner`'s third parameter is optional, so a two-parameter
 * runner — which is exactly the shape `makeLazyCredentialedHostRunner` returns —
 * satisfies the type and silently discards the environment the probe resolved.
 * Round 2 then read the resulting bare `gh` failure as `credential_rejected` and
 * told the owner to rotate a token that had never left the process.
 */
describe('a dropped credential is reported as a wiring fault, not a bad token', () => {
  const withToken: PublisherCredentialSource = {
    owner_handle: 'owner-a',
    source: 'a fake token store',
    load: async () => ({ GH_TOKEN: 't0k' }),
  }

  test('a runner that ignores extraEnv is named as the fault', async () => {
    // Two parameters — the credential the probe resolved cannot arrive.
    const probe = defaultGitModeProbe(withToken, async (cmd: string[], _cwd?: string) => {
      if (cmd[0] === 'git') {
        return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
      }
      return {
        ok: false,
        stdout: '',
        stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
        exit_code: 1,
      }
    })
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('probe_failed')
    expect(res.authenticated === false && res.detail).toContain('did not carry it into')
    // Never the two readings that send the owner somewhere useless.
    expect(res.authenticated === false && res.cause).not.toBe('credential_rejected')
    expect(res.authenticated === false && res.cause).not.toBe('no_credential_available')
  })

  test('CONTROL — the SAME host with an EMPTY store is `no_credential_available`', async () => {
    // Same output, no token resolved: now "connect GitHub" is the honest read,
    // which proves the branch above keys on the credential and not on the text.
    const probe = defaultGitModeProbe(
      { owner_handle: 'owner-a', source: 'a fake token store', load: async () => ({}) },
      async (cmd: string[], _cwd?: string) => {
        if (cmd[0] === 'git') {
          return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
        }
        return {
          ok: false,
          stdout: '',
          stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
          exit_code: 1,
        }
      },
    )
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('no_credential_available')
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

  // THE POSITIVE PATH, THROUGH THE REAL CODE. Every other assertion about
  // `timed_out` injects the flag via a stubbed `HostCommandResult`, so deleting
  // the watchdog — or setting the flag in the wrong closure — left the whole
  // suite green while the publisher probe went back to calling a hung network
  // call a rejected token. This kills an actual child process.
  test('a command that outruns the budget IS flagged, and is not ok', async () => {
    const res = await spawnCapture(['sleep', '5'], undefined, undefined, 50)
    expect(res.timed_out).toBe(true)
    expect(res.ok).toBe(false)
  })

  test('CONTROL — the SAME budget on a fast command is not flagged', async () => {
    // Proves the assertion above measured the watchdog rather than the short
    // budget: same 50ms, a command that finishes inside it.
    const res = await spawnCapture(['true'], undefined, undefined, 50)
    expect(res.ok).toBe(true)
    expect(res.timed_out).toBeUndefined()
  })

  test('a real timeout reaches the owner as unreachable, never as a bad token', async () => {
    // End to end over the real watchdog: the probe classifies what `spawnCapture`
    // actually produced, closing the gap between the flag and its consumer.
    const probe = defaultGitModeProbe(
      { owner_handle: 'owner-a', source: 'a fake token store', load: async () => ({ GH_TOKEN: 't0k' }) },
      async (cmd) =>
        cmd[0] === 'git'
          ? { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
          : spawnCapture(['sleep', '5'], undefined, undefined, 50),
    )
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('could_not_reach_github')
    expect(res.authenticated === false && res.cause).not.toBe('credential_rejected')
  })
})

// ---------------------------------------------------------------------------
// The classifier suite, driven by REAL multi-line `gh` output.
//
// WHY THESE FIXTURES ARE MULTI-LINE AND THE OLD ONES WERE NOT. Every stub in
// this file used to be a single crafted line, which is not what `gh` prints and
// is precisely why a first-line-only truncation bug survived a green suite: with
// a one-line stub, `split('\n')[0]` IS the whole string, so the defect was
// invisible by construction. The blocks below are copied from `gh version 2.97.0
// (2026-07-31)` run as `gh auth status --hostname github.com --active`.
// ---------------------------------------------------------------------------

/**
 * MEASURED, and the single most important fixture in this file: gh 2.97.0 prints
 * EXACTLY THIS for BOTH
 *
 *   • a genuinely invalid token on a working network, and
 *   • a perfectly good token behind a dead proxy (GitHub never reached).
 *
 * The two stderr captures were byte-for-byte identical. So this text is not
 * evidence of a bad token — it is evidence that `gh` could not log in, and the
 * cause is undetermined. Note the first line is the bare hostname, which is what
 * the old `split('\n')[0]` rendering kept while discarding all three lines that
 * carry meaning.
 */
const GH_LOGIN_FAILURE_AMBIGUOUS = [
  'github.com',
  '  X Failed to log in to github.com using token (GH_TOKEN)',
  '  - Active account: true',
  '  - The token in GH_TOKEN is invalid.',
].join('\n')

/**
 * A verdict only a live GitHub response can produce: the scope list came back in
 * a response body, so the transport demonstrably worked and the credential was
 * genuinely refused. This is the shape that MUST still read as a rejection.
 */
const GH_REJECTED_MISSING_SCOPE = [
  'github.com',
  '  X Failed to log in to github.com account owner-a (keyring)',
  '  - Active account: true',
  "  - Token scopes: 'gist', 'read:org'",
  "  ! Missing required token scopes: 'repo'",
].join('\n')

/** GitHub's primary rate limit, which it returns as 403 WITH a valid token. */
const GH_RATE_LIMIT_PRIMARY = [
  'github.com',
  '  X Failed to log in to github.com using token (GH_TOKEN)',
  '  - Active account: true',
  '  - HTTP 403: API rate limit exceeded for user ID 12345.',
  '    (https://api.github.com/user)',
].join('\n')

/** GitHub's secondary rate limit — also a 403, also with a valid token. */
const GH_RATE_LIMIT_SECONDARY = [
  'github.com',
  '  X Failed to log in to github.com using token (GH_TOKEN)',
  '  - HTTP 403: You have exceeded a secondary rate limit.',
  '    Please wait a few minutes before you try again.',
].join('\n')

/** MEASURED: what gh 2.97.0 prints with an empty config dir. */
const GH_NO_ACCOUNTS = 'You are not logged into any GitHub hosts. To log in, run: gh auth login'

const storeWithToken: PublisherCredentialSource = {
  owner_handle: 'owner-a',
  source: 'a fake token store',
  load: async () => ({ GH_TOKEN: 't0k' }),
}
const emptyStore: PublisherCredentialSource = {
  owner_handle: 'owner-a',
  source: 'a fake token store',
  load: async () => ({}),
}

/** A host whose `gh` always fails with the given stderr; `git` reports a GitHub origin. */
const ghFailsWith =
  (stderr: string, exit_code = 1) =>
  async (cmd: string[]): Promise<HostCommandResult> => {
    if (cmd[0] === 'git') {
      return {
        ok: true,
        stdout: 'https://github.com/example-org/example-repo.git',
        stderr: '',
        exit_code: 0,
      }
    }
    return { ok: false, stdout: '', stderr, exit_code }
  }

const refusalMessage = async (probe: GitModeProbe): Promise<string> =>
  detectMergeMode('/repo', probe).then(
    () => '',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )

describe('a transport failure is never sold to the owner as a bad token', () => {
  test('the MEASURED dead-network output is NOT classified as a rejection', async () => {
    const probe = defaultGitModeProbe(storeWithToken, ghFailsWith(GH_LOGIN_FAILURE_AMBIGUOUS))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).not.toBe('credential_rejected')
    expect(res.authenticated === false && res.cause).toBe('credential_verdict_unavailable')
  })

  test('the refusal NAMES the ambiguity and sends the owner to the network first', async () => {
    const msg = await refusalMessage(
      defaultGitModeProbe(storeWithToken, ghFailsWith(GH_LOGIN_FAILURE_AMBIGUOUS)),
    )
    expect(msg).toContain('does not say')
    expect(msg).toContain('Check network/DNS/proxy FIRST')
    // The costly instruction is the one that must NOT appear, because it is the
    // one that has him rotating a credential nothing was learned about.
    expect(msg).not.toContain('REJECTED')
    expect(msg).not.toContain('expired, revoked, or missing a scope')
  })

  test('the classifiers agree: the measured output is ambiguous, not a verdict', () => {
    expect(looksLikeAmbiguousLoginFailure(GH_LOGIN_FAILURE_AMBIGUOUS)).toBe(true)
    expect(looksLikeCredentialRejected(GH_LOGIN_FAILURE_AMBIGUOUS)).toBe(false)
    // …and the transport classifier CANNOT rescue it, which is the trap: the
    // `dial tcp` / `no such host` strings it looks for are emitted only under
    // `GH_DEBUG`, never in the normal output above.
    expect(looksLikeGithubUnreachable(GH_LOGIN_FAILURE_AMBIGUOUS)).toBe(false)
  })

  test('CONTROL — a verdict only a live response can produce IS still a rejection', async () => {
    const probe = defaultGitModeProbe(storeWithToken, ghFailsWith(GH_REJECTED_MISSING_SCOPE))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
    const msg = await refusalMessage(probe)
    expect(msg).toContain('REJECTED')
  })
})

describe('a rate limit is not a rejection — GitHub returns 403 with a WORKING token', () => {
  for (const [label, stderr] of [
    ['primary', GH_RATE_LIMIT_PRIMARY],
    ['secondary', GH_RATE_LIMIT_SECONDARY],
  ] as const) {
    test(`the ${label} rate limit is \`github_rate_limited\`, not a bad token`, async () => {
      const probe = defaultGitModeProbe(storeWithToken, ghFailsWith(stderr))
      const res = await probe.publisherAvailable()
      expect(res.authenticated === false && res.cause).toBe('github_rate_limited')
    })

    test(`the ${label} refusal says WAIT, and never says rotate`, async () => {
      const msg = await refusalMessage(defaultGitModeProbe(storeWithToken, ghFailsWith(stderr)))
      expect(msg).toContain('rate-limited')
      expect(msg).toContain('Wait for the limit to reset')
      expect(msg).toContain('Do NOT rotate the token')
      expect(msg).not.toContain('REJECTED')
      expect(msg).not.toContain('expired, revoked, or missing a scope')
    })
  }

  test('the 403 in a rate limit is subtracted from the rejection classifier itself', () => {
    // The defect was a blanket `/\bhttp 40[13]\b/`. Asserted at the classifier so
    // it cannot be reintroduced by a caller that skips the probe's ordering.
    expect(looksLikeCredentialRejected('HTTP 403: API rate limit exceeded')).toBe(false)
    expect(looksLikeGithubRateLimited('HTTP 403: API rate limit exceeded')).toBe(true)
  })

  test('CONTROL — a 403 that is NOT a rate limit is still a rejection', () => {
    expect(
      looksLikeCredentialRejected('HTTP 403: Resource not accessible by personal access token'),
    ).toBe(true)
  })
})

describe('the reported cause is what HAPPENED, not what was configured', () => {
  test('an empty store whose AMBIENT credential is refused reads as a rejection', async () => {
    // The real gh 2.97.0 case: a stale ambient account whose token in `hosts.yml`
    // is invalid. Control reaches the rejection branch on positive evidence a
    // credential was presented and refused, so "no credential available" would
    // deny the very observation that selected the branch.
    const probe = defaultGitModeProbe(emptyStore, ghFailsWith(GH_REJECTED_MISSING_SCOPE))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
    expect(res.authenticated === false && res.cause).not.toBe('no_credential_available')
  })

  test('…and the refusal names WHICH credential, so he fixes the ambient one', async () => {
    const msg = await refusalMessage(
      defaultGitModeProbe(emptyStore, ghFailsWith(GH_REJECTED_MISSING_SCOPE)),
    )
    expect(msg).toContain("used this host's ambient login")
    // The self-contradicting sentence must be gone: `gh` just told us a
    // credential WAS presented.
    expect(msg).not.toContain('no GitHub credential is stored')
    expect(msg).toContain('REJECTED')
  })

  test('CONTROL — an empty store with NO credential anywhere is still `no_credential_available`', async () => {
    const probe = defaultGitModeProbe(emptyStore, ghFailsWith(GH_NO_ACCOUNTS))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('no_credential_available')
    const msg = await refusalMessage(probe)
    expect(msg).toContain('no GitHub credential is stored')
    expect(msg).not.toContain('REJECTED')
  })

  test('CONTROL — narrowing the rejection classifier did not break the no-auth guard', () => {
    // `looksLikeNoGithubAuth` trusts the `gh auth login` hint only when nothing
    // else in the output is a verdict. Narrowing `looksLikeCredentialRejected`
    // would have silently reopened that hole for the ambiguous wordings.
    expect(looksLikeNoGithubAuth(GH_NO_ACCOUNTS)).toBe(true)
    expect(
      looksLikeNoGithubAuth('The token in GH_TOKEN is invalid. To log in, run: gh auth login'),
    ).toBe(false)
    expect(looksLikeNoGithubAuth('HTTP 401: Bad credentials. To log in, run: gh auth login')).toBe(
      false,
    )
  })
})

describe('multi-line `gh` output survives into the refusal', () => {
  test('EVERY diagnostic line reaches the owner, not just the bare hostname', async () => {
    const msg = await refusalMessage(
      defaultGitModeProbe(storeWithToken, ghFailsWith(GH_LOGIN_FAILURE_AMBIGUOUS)),
    )
    // The three lines the old `split('\n')[0]` threw away…
    expect(msg).toContain('Failed to log in to github.com using token (GH_TOKEN)')
    expect(msg).toContain('Active account: true')
    expect(msg).toContain('The token in GH_TOKEN is invalid.')
    // …and the one it kept, which on its own diagnoses nothing.
    expect(msg).toContain('github.com')
    // The refusal must not TERMINATE at the hostname, which is what the bug
    // produced: `…missing a scope: github.com`.
    expect(msg.trimEnd().endsWith('github.com')).toBe(false)
  })

  test('lines are flattened and trimmed, never dropped', () => {
    expect(renderAuthFailureDetail(GH_LOGIN_FAILURE_AMBIGUOUS)).toBe(
      ': github.com; X Failed to log in to github.com using token (GH_TOKEN); ' +
        '- Active account: true; - The token in GH_TOKEN is invalid.',
    )
  })

  test('empty, absent and blank-only details render as nothing', () => {
    expect(renderAuthFailureDetail(undefined)).toBe('')
    expect(renderAuthFailureDetail('')).toBe('')
    expect(renderAuthFailureDetail('\n  \n')).toBe('')
  })

  test('a runaway detail is bounded rather than allowed to flood the refusal', () => {
    const rendered = renderAuthFailureDetail('x'.repeat(MAX_AUTH_FAILURE_DETAIL_CHARS + 500))
    expect(rendered).toContain('(truncated)')
    expect(rendered.length).toBeLessThan(MAX_AUTH_FAILURE_DETAIL_CHARS + 40)
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
