import { describe, expect, test } from 'bun:test'
import {
  classifyGithubReachability,
  cleanupAfterMerge,
  defaultGitModeProbe,
  describeReachabilityAnswer,
  detectMergeMode,
  isGithubRemoteUrl,
  looksLikeAmbiguousLoginFailure,
  looksLikeCredentialRejected,
  looksLikeGithubRateLimited,
  looksLikeGithubUnreachable,
  looksLikeNoGithubAuth,
  looksLikeSamlSsoUnauthorized,
  renderAuthFailureDetail,
  spawnCapture,
  DEFAULT_HOST_COMMAND_TIMEOUT_MS,
  MAX_AUTH_FAILURE_DETAIL_CHARS,
  PUBLISHER_AUTH_COMMAND,
  PUBLISHER_REACHABILITY_COMMAND,
  PUBLISHER_REACHABILITY_TIMEOUT_MS,
  unwiredPublisherCredential,
  type GitModeProbe,
  type PublisherAuthFailureCause,
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
    infra_retries: 0,
    reviewed_head: null,
    bound_pr: null,
    fenced_paths: null,
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

  // EVERY member of the union, enumerated rather than sampled. The predecessor of
  // this list was one call with `no_credential_available` under the name "every
  // refusal", so six of the seven causes were unasserted — and a cause added
  // later (as two were) would have joined them silently.
  //
  // WHY THIS IS A KEYED RECORD AND NOT AN ARRAY — the round-5 fix, and the reason
  // "every member" was still a claim rather than a guarantee. A
  // `readonly PublisherAuthFailureCause[]` is satisfied by ANY subset: the two
  // causes added in this very PR (`credential_needs_sso_authorization`,
  // `github_reachable_but_login_failed`) would have compiled fine while going
  // completely unasserted, which is the exact failure the comment above says the
  // list exists to prevent. `Record<PublisherAuthFailureCause, ...>` is
  // exhaustive BY TYPE: omit a member and `tsc` fails on this line, in this file,
  // naming the missing cause.
  //
  // The value is not a placeholder. It is what the owner is being asked to do
  // about his credential, which is the property the assertions below actually
  // care about:
  //   'act_now'      — go touch the credential, now: this cause says so outright.
  //   'conditional'  — touch it only after something else is ruled out first.
  //   'do_not_touch' — a host condition or a non-verdict; touching it is waste.
  const CREDENTIAL_ACTION = {
    no_credential_available: 'act_now',
    credential_rejected: 'act_now',
    credential_needs_sso_authorization: 'act_now',
    credential_verdict_unavailable: 'conditional',
    github_rate_limited: 'do_not_touch',
    github_reachable_but_login_failed: 'do_not_touch',
    could_not_reach_github: 'do_not_touch',
    publisher_cli_unavailable: 'do_not_touch',
    probe_failed: 'do_not_touch',
  } as const satisfies Record<PublisherAuthFailureCause, 'act_now' | 'conditional' | 'do_not_touch'>

  const ALL_CAUSES = Object.keys(CREDENTIAL_ACTION) as PublisherAuthFailureCause[]

  test('every refusal keeps the original guard sentence — the gate itself is unchanged', async () => {
    for (const cause of ALL_CAUSES) {
      const msg = await refusal({ authenticated: false, cause })
      expect(msg).toContain('refusing to silently weaken the PR merge gate')
    }
  })

  test('every refusal names the handle, the source, and a cause-specific sentence', async () => {
    // A refusal that does not name the handle sends the reader hunting through
    // the store by hand; one whose text is the same for every cause is the vague
    // message this whole change replaced. Both are asserted for ALL seven.
    const rendered = new Set<string>()
    for (const cause of ALL_CAUSES) {
      const msg = await refusal({ authenticated: false, cause, detail: 'the captured detail' })
      expect(msg).toContain('owner-a')
      expect(msg).toContain('the instance secrets store')
      expect(msg).toContain('the captured detail')
      rendered.add(msg)
    }
    expect(rendered.size).toBe(ALL_CAUSES.length)
  })

  // THE COSTLY INSTRUCTION, ENUMERATED THE OTHER WAY ROUND, and rewritten in
  // round 5 because the previous version was a two-way test over a three-way
  // reality. It asked whether a message "asks him to touch the credential" and
  // expected `true` for exactly `credential_rejected` and
  // `no_credential_available` — which quietly asserted `false` for
  // `credential_verdict_unavailable`, whose message says "rotate the token only
  // once the network is known good" (`trident/git-mode.ts`
  // `describePublisherAuthFailure`, the `credential_verdict_unavailable` arm).
  // That IS asking him to touch the credential; the honest distinction is that it
  // asks CONDITIONALLY. Collapsing conditional into "no" meant the guard could
  // not have noticed a future edit that dropped the condition and left the bare
  // instruction standing — which is the whole misdirection this PR exists to
  // remove.
  const DO_NOT_ROTATE = 'Do NOT rotate the token on this signal'
  const CONDITIONAL_ROTATE = 'rotate the token only once the network is known good'
  const REPAIR_NOW = ['connect GitHub', 'was REJECTED by GitHub', 'AUTHORIZE the existing token']

  test('each refusal asks for a credential repair NOW, LATER, or NEVER — and says which', async () => {
    for (const cause of ALL_CAUSES) {
      const msg = await refusal({ authenticated: false, cause })
      const asksNow = REPAIR_NOW.some((phrase) => msg.includes(phrase))
      const asksLater = msg.includes(CONDITIONAL_ROTATE)
      const asksNever = msg.includes(DO_NOT_ROTATE)
      // Exactly one of the three, for every cause. `[cause, …]` so a failure
      // names which cause broke rather than just printing three booleans.
      expect([cause, asksNow, asksLater, asksNever]).toEqual([
        cause,
        CREDENTIAL_ACTION[cause] === 'act_now',
        CREDENTIAL_ACTION[cause] === 'conditional',
        CREDENTIAL_ACTION[cause] === 'do_not_touch',
      ])
    }
  })

  test('a `do_not_touch` cause never smuggles in a repair instruction', async () => {
    for (const cause of ALL_CAUSES) {
      if (CREDENTIAL_ACTION[cause] !== 'do_not_touch') continue
      const msg = await refusal({ authenticated: false, cause })
      for (const phrase of [...REPAIR_NOW, CONDITIONAL_ROTATE]) {
        expect([cause, phrase, msg.includes(phrase)]).toEqual([cause, phrase, false])
      }
    }
  })

  test('an `act_now` cause never also tells him to stand down', async () => {
    for (const cause of ALL_CAUSES) {
      if (CREDENTIAL_ACTION[cause] !== 'act_now') continue
      const msg = await refusal({ authenticated: false, cause })
      expect([cause, msg.includes(DO_NOT_ROTATE)]).toEqual([cause, false])
    }
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
  // ROUND 5 SHARPENS THIS. The docblock above cites x509 as its motivating
  // example, and the assertion below settled for `probe_failed` — "nothing was
  // learned" — which was still wrong about a case where something specific WAS
  // learned: the TLS handshake never completed, so no credential reached GitHub.
  // That is a transport fact, and the owner-facing difference is real: one
  // message points at the connection, the other shrugs.
  for (const [label, stderr] of [
    ['an untrusted root (corporate MITM proxy)', 'x509: certificate signed by unknown authority'],
    ['a self-signed certificate', 'x509: self-signed certificate in certificate chain'],
    ['an expired server certificate', 'x509: certificate has expired or is not yet valid'],
    ['a failed TLS handshake', 'remote error: tls: handshake failure'],
  ] as const) {
    test(`${label} is a TRANSPORT failure, not a rejected credential`, async () => {
      const probe = defaultGitModeProbe(
        withToken,
        ghFails({
          stdout: '',
          stderr: `Get "https://api.github.com/": ${stderr}`,
          exit_code: 1,
        }),
      )
      const res = await probe.publisherAvailable()
      expect(res.authenticated === false && res.cause).not.toBe('credential_rejected')
      expect(res.authenticated === false && res.cause).toBe('could_not_reach_github')
      // …and the owner is told, in as many words, not to act on it — and told
      // WHICH thing to look at, which `probe_failed` could not say.
      const msg = await detectMergeMode('/repo', probe).then(
        () => '',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      )
      expect(msg).toContain('Do NOT rotate the token')
      expect(msg).toContain('check network/DNS/proxy')
      expect(msg).not.toContain('REJECTED')
      expect(msg).not.toContain('the publisher capability probe itself failed')
    })
  }

  test('CONTROL — the bare word "certificate" does not hijack a real rejection', async () => {
    // The transport patterns are the Go TLS vocabulary, not `certificate`, so a
    // verdict that happens to mention one is still a verdict.
    const probe = defaultGitModeProbe(
      withToken,
      ghFails({
        stdout: '',
        stderr: 'HTTP 401: Bad credentials (certificate-based auth is not enabled)',
        exit_code: 1,
      }),
    )
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
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
// invisible by construction.
//
// PROVENANCE IS NOW STATED PER BLOCK, AND THAT IS A FIX, NOT BOOKKEEPING. This
// header used to assert that all of the blocks below were "copied from gh
// version 2.97.0" — and three of them could not have been, because `gh auth
// status` renders a FIXED failure entry that never contains an HTTP status or a
// response body (`pkg/cmd/auth/status/status.go` L90-108, v2.97.0), and
// `Missing required token scopes` is printed only by the SUCCESS entry (L86).
// A fixture that cannot occur cannot certify a classifier, and the worst of
// them was the CONTROL asserting that `credential_rejected` still worked. Each
// block below therefore says MEASURED (with the command that produced it) or
// CONSTRUCTED (with what it was built from and why it could not be measured).
//
// The MEASURED captures were taken on `gh version 2.97.0 (2026-07-31)`, each run
// with an isolated `GH_CONFIG_DIR` so the host's own login was neither read nor
// disturbed, as:
//
//     env GH_TOKEN=<invalid> GH_CONFIG_DIR=$(mktemp -d) \
//       gh auth status --hostname github.com --active
//     env GH_TOKEN=<invalid> GH_CONFIG_DIR=$(mktemp -d) \
//       gh api --hostname github.com /zen
//
// with the transport faults injected via HTTPS_PROXY (a refused port, a
// non-resolving host, and a blackholed address).
// ---------------------------------------------------------------------------

/**
 * MEASURED, and the single most important fixture in this file: gh 2.97.0 prints
 * EXACTLY THIS, byte for byte, for ALL FOUR of
 *
 *   • a genuinely invalid token on a working network;
 *   • a dead proxy (connection refused), so GitHub was never reached;
 *   • a proxy host that does not resolve (DNS failure);
 *   • a blackholed proxy, so the call hung until it timed out.
 *
 * So this text is not evidence of a bad token — it is evidence that `gh` could
 * not log in, and it carries NOTHING about which of the four happened. Note the
 * first line is the bare hostname, which is what the old `split('\n')[0]`
 * rendering kept while discarding all three lines that carry meaning.
 */
const GH_LOGIN_FAILURE_AMBIGUOUS = [
  'github.com',
  '  X Failed to log in to github.com using token (GH_TOKEN)',
  '  - Active account: true',
  '  - The token in GH_TOKEN is invalid.',
].join('\n')

/**
 * CONSTRUCTED from `gh`'s SUCCESS entry template (`status.go` L73-89, v2.97.0),
 * because it needs a token that authenticates but lacks a scope and no such
 * token was available to measure with. The shape is `gh`'s, not invented: the
 * `- Token scopes:` and `! Missing required token scopes:` format strings are
 * present verbatim in the 2.97.0 binary; only the handle and the scope names are
 * illustrative.
 *
 * Its PREDECESSOR was impossible — it opened with the failure entry's
 * `X Failed to log in …` line and then printed the success entry's scope lines,
 * a combination `gh`'s renderer cannot produce, since the two are exclusive
 * branches of one switch. This is the shape that MUST still read as a rejection:
 * a scope list can only come back in a live response body, so the transport
 * demonstrably worked and the credential was genuinely refused.
 */
const GH_REJECTED_MISSING_SCOPE = [
  'github.com',
  '  ✓ Logged in to github.com account owner-a (keyring)',
  '  - Active account: true',
  '  - Git operations protocol: https',
  '  - Token: gho_************',
  "  - Token scopes: 'gist', 'read:org'",
  "  ! Missing required token scopes: 'repo'",
].join('\n')

/**
 * CONSTRUCTED from `gh`'s TIMEOUT entry template (`status.go` L110-117,
 * v2.97.0), whose format string `"  %s Timeout trying to log in to %s using
 * token (%s)"` is present verbatim in the 2.97.0 binary. Reproducing a real one
 * needs a network that hangs for gh's full budget rather than failing; the
 * blackholed-proxy capture ({@link GH_API_BLACKHOLE_TIMEOUT}) timed out at the
 * `gh api` layer first, so the entry itself was not observed.
 */
const GH_TIMEOUT_ENTRY = [
  'github.com',
  '  X Timeout trying to log in to github.com using token (GH_TOKEN)',
  '  - Active account: true',
].join('\n')

/**
 * THE `gh api` FIXTURES CARRY BOTH STREAMS — the round-5 fix, and the reason the
 * suite could stay green through a real regression.
 *
 * Every one of these used to be a bare stderr string, and every double that
 * served them hardcoded `stdout: ''`. That is not what `gh` does, and the
 * difference is not cosmetic: {@link classifyGithubReachability} reads
 * `stderr + stdout`, so a fixture with an empty stdout can never exercise the
 * half of the input the classifier depends on, and a change that dropped stdout
 * from the classifier would not have moved a single test. It also hid the
 * owner-facing bug this PR fixes — the evidence sentence read `stderr` alone,
 * which is invisible when every fixture puts everything in stderr.
 *
 * MEASURED on gh 2.97.0 (byte counts from the capture), and the split is not
 * uniform, which is exactly why it has to be modelled:
 *
 *   success           → stdout only  (body), stderr EMPTY, exit 0
 *   bad credentials   → stdout JSON body (112 B) AND stderr summary (31 B), exit 1
 *   transport failure → stderr only (102/106 B), stdout EMPTY, exit 1
 */
interface GhApiCapture {
  stdout: string
  stderr: string
  exit_code: number
  ok: boolean
  timed_out?: boolean
}

const ghApi = (over: Partial<GhApiCapture>): GhApiCapture => ({
  stdout: '',
  stderr: '',
  exit_code: 1,
  ok: false,
  ...over,
})

/**
 * The text a STRING-level classifier sees, flattened the same way
 * `defaultGitModeProbe` and `classifyGithubReachability` flatten it. Asserting
 * `looksLike*` against a capture's stderr alone would re-create, inside the
 * tests, exactly the stderr-only reading this PR removes from the code.
 */
const bothStreams = (c: GhApiCapture): string => `${c.stderr}\n${c.stdout}`

/**
 * MEASURED (`gh api /zen`, valid ambient credential): the body goes to STDOUT
 * and stderr is EMPTY. The shape that proved the owner-facing bug — a call that
 * plainly answered was reported as "exited 0 without printing anything".
 */
const GH_API_ZEN_SUCCESS = ghApi({ stdout: 'Encourage flow.', exit_code: 0, ok: true })

/**
 * MEASURED (`gh api`, invalid token, network fine): GitHub ANSWERED, and refused.
 * Note WHERE the two halves land — the fuller diagnostic is the one on STDOUT,
 * i.e. the one a stderr-only reading throws away.
 */
const GH_API_BAD_CREDENTIALS = ghApi({
  stdout: [
    '{',
    '  "message": "Bad credentials",',
    '  "documentation_url": "https://docs.github.com/rest",',
    '  "status": "401"',
    '}',
  ].join('\n'),
  stderr: 'gh: Bad credentials (HTTP 401)',
})

/** MEASURED (`gh api` through a proxy port that refuses the connection): stderr only. */
const GH_API_DEAD_PROXY = ghApi({
  stderr:
    'Get "https://api.github.com/zen": proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused',
})

/**
 * MEASURED (`gh api` through a proxy host that does not resolve). Two lines, and
 * neither is in Go's `net` vocabulary — this is `gh`'s own wording, which is why
 * the Go-shaped transport patterns missed a plain DNS failure entirely.
 */
const GH_API_DNS_FAILURE = ghApi({
  stderr: [
    'error connecting to no-such-host-xyzzy.invalid',
    'check your internet connection or https://githubstatus.com',
  ].join('\n'),
})

/** MEASURED (`gh api` through a blackholed proxy address — the call hung, then timed out). */
const GH_API_BLACKHOLE_TIMEOUT = ghApi({
  stderr:
    'Get "https://api.github.com/zen": proxyconnect tcp: dial tcp 192.0.2.1:8080: i/o timeout',
})

/**
 * CONSTRUCTED (`x509` through a TLS-intercepting proxy with an untrusted root):
 * Go's own wording, wrapped in `gh api`'s `Get "…":` prefix exactly as the two
 * MEASURED transport captures above are. The handshake never completed, so no
 * credential reached GitHub.
 */
const GH_API_TLS_INTERCEPTED = ghApi({
  stderr: 'Get "https://api.github.com/zen": x509: certificate signed by unknown authority',
})

/**
 * CONSTRUCTED: GitHub's documented primary rate-limit body, split across the two
 * streams the same way the MEASURED 401 above splits — body to stdout, `gh`'s
 * one-line summary to stderr. Exhausting a real rate limit to capture it was not
 * a reasonable thing to do to the account. Note WHERE it lives: `gh auth status`
 * cannot print an HTTP status at all, so a rate limit reaches us as the ambiguous
 * block plus THIS, on the reachability call.
 */
const GH_API_RATE_LIMIT_PRIMARY = ghApi({
  stdout: [
    '{',
    '  "message": "API rate limit exceeded for user ID 12345.",',
    '  "documentation_url": "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",',
    '  "status": "403"',
    '}',
  ].join('\n'),
  stderr: 'gh: API rate limit exceeded for user ID 12345. (HTTP 403)',
})

/** CONSTRUCTED the same way: GitHub's secondary rate limit — also a 403. */
const GH_API_RATE_LIMIT_SECONDARY = ghApi({
  stderr:
    'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
})

/**
 * CONSTRUCTED: GitHub's SAML/SSO authorization refusal. A 403 in which GitHub
 * knows exactly whose credential this is — which is how it can name the org — and
 * refuses the RESOURCE. The wording lives in the RESPONSE BODY, i.e. on STDOUT,
 * so this case is invisible to any reading that only looks at stderr.
 */
const GH_API_SAML_SSO = ghApi({
  stdout: [
    '{',
    '  "message": "Resource protected by organization SAML enforcement. ' +
      'You must grant your OAuth token access to this organization.",',
    '  "documentation_url": "https://docs.github.com/articles/authenticating-with-saml-single-sign-on",',
    '  "status": "403"',
    '}',
  ].join('\n'),
  stderr: 'gh: Resource protected by organization SAML enforcement. (HTTP 403)',
})

/** MEASURED: what gh 2.97.0 prints with an empty config dir and no token. */
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

/**
 * A host whose two `gh` surfaces answer DIFFERENTLY — which is the whole point:
 * `gh auth status` flattens a refusal and a transport failure into one string,
 * and `gh api` is the second measurement that separates them. `ghFailsWith`
 * above keeps its meaning (every `gh` call fails identically) and is still the
 * right double wherever the reachability answer is not what is under test.
 */
const ghHost =
  (surfaces: { status: string; api: GhApiCapture }) =>
  async (cmd: string[]): Promise<HostCommandResult> => {
    if (cmd[0] === 'git') {
      return {
        ok: true,
        stdout: 'https://github.com/example-org/example-repo.git',
        stderr: '',
        exit_code: 0,
      }
    }
    // The `gh api` surface answers with BOTH streams, because that is what `gh`
    // does and because the classifier reads both. Spreading the capture is the
    // point: a fixture can no longer silently assert `stdout: ''`.
    if (cmd[1] === 'api') return { ...surfaces.api }
    return { ok: false, stdout: '', stderr: surfaces.status, exit_code: 1 }
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
    // failure entry `gh` renders is fixed text that never carries the underlying
    // transport or API error, so `dial tcp` / `no such host` cannot appear in it
    // at all. Breaking the tie needs a second measurement, not a better regex.
    expect(looksLikeGithubUnreachable(GH_LOGIN_FAILURE_AMBIGUOUS)).toBe(false)
  })

  test("gh's OWN timeout entry is a transport fact, not an unclassified failure", async () => {
    // `gh auth status` has a third rendering state, distinct from success and
    // failure, and it says plainly that GitHub never answered. It used to match
    // no classifier at all and land in `probe_failed` — the advice was already
    // "do not rotate", so this was never owner-misdirecting, but the named cause
    // was wrong and `probe_failed` blames our own probe for the network.
    const probe = defaultGitModeProbe(storeWithToken, ghFailsWith(GH_TIMEOUT_ENTRY))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('could_not_reach_github')
    expect(looksLikeGithubUnreachable(GH_TIMEOUT_ENTRY)).toBe(true)
  })

  test('CONTROL — a verdict only a live response can produce IS still a rejection', async () => {
    const probe = defaultGitModeProbe(storeWithToken, ghFailsWith(GH_REJECTED_MISSING_SCOPE))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
    const msg = await refusalMessage(probe)
    expect(msg).toContain('REJECTED')
  })
})

describe('a rate limit is a 403 that is not a verdict on the credential either way', () => {
  for (const [label, api] of [
    ['primary', GH_API_RATE_LIMIT_PRIMARY],
    ['secondary', GH_API_RATE_LIMIT_SECONDARY],
  ] as const) {
    // Driven through BOTH surfaces, because that is the only way a rate limit can
    // actually arrive: `gh auth status` renders its fixed failure entry (no HTTP
    // status anywhere), and the 403 shows up on the reachability call.
    const host = ghHost({ status: GH_LOGIN_FAILURE_AMBIGUOUS, api })

    test(`the ${label} rate limit is \`github_rate_limited\`, not a bad token`, async () => {
      const probe = defaultGitModeProbe(storeWithToken, host)
      const res = await probe.publisherAvailable()
      expect(res.authenticated === false && res.cause).toBe('github_rate_limited')
    })

    test(`the ${label} refusal says WAIT, and never says rotate`, async () => {
      const msg = await refusalMessage(defaultGitModeProbe(storeWithToken, host))
      expect(msg).toContain('rate-limited')
      expect(msg).toContain('Wait for the limit to reset')
      expect(msg).toContain('Do NOT rotate the token')
      expect(msg).not.toContain('REJECTED')
      expect(msg).not.toContain('expired, revoked, or missing a scope')
    })

    test(`the ${label} refusal does NOT claim the credential is good`, async () => {
      // THE ROUND-5 CORRECTION, and it cuts the other way from every other fix
      // in this PR. Round 4's text read "GitHub returns a rate limit WITH a
      // working credential, so this is evidence the token is fine" — a POSITIVE
      // claim about a credential nothing had verified. GitHub 403-rate-limits
      // UNAUTHENTICATED requests too, against the source IP, and `gh` has
      // documented modes (cli/cli#13317) in which a keychain error silently
      // drops the credential and the request goes out unauthenticated. So the
      // same 403 is equally consistent with "the token is fine" and "no token
      // was sent at all". The honest reading is one-directional: not evidence of
      // rejection, and not evidence of acceptance.
      const msg = await refusalMessage(defaultGitModeProbe(storeWithToken, host))
      expect(msg).toContain('neither accepted nor rejected')
      expect(msg).toContain('NOT evidence of rejection')
      expect(msg).toContain('unauthenticated requests too')
      expect(msg).not.toContain('evidence the token is fine')
      expect(msg).not.toContain('WITH a working credential')
    })
  }

  test('the 403 in a rate limit is subtracted from the rejection classifier itself', () => {
    // The first defect here was a blanket `/\bhttp 40[13]\b/`. Asserted at the
    // classifier so it cannot be reintroduced by a caller that skips the probe's
    // ordering.
    expect(looksLikeCredentialRejected('HTTP 403: API rate limit exceeded')).toBe(false)
    expect(looksLikeGithubRateLimited('HTTP 403: API rate limit exceeded')).toBe(true)
    expect(looksLikeCredentialRejected(bothStreams(GH_API_RATE_LIMIT_PRIMARY))).toBe(false)
    expect(looksLikeCredentialRejected(bothStreams(GH_API_RATE_LIMIT_SECONDARY))).toBe(false)
  })

  test('a 403 with NO rejection wording is not a verdict about the credential either', () => {
    // The round-4 blocker. The rate-limit subtraction only rescued the 403s that
    // said "rate limit"; every OTHER 403 GitHub returns to a request whose token
    // it accepted and counted — SAML/SSO authorization, repository resource
    // restrictions, a bare `Forbidden` — still read as "expired, revoked, or
    // missing a scope". 401 is the code that means the credential was refused.
    expect(looksLikeCredentialRejected('HTTP 403: Forbidden')).toBe(false)
    expect(looksLikeCredentialRejected('gh: Forbidden (HTTP 403)')).toBe(false)
    expect(looksLikeCredentialRejected('HTTP 401: Bad credentials')).toBe(true)
    expect(looksLikeCredentialRejected(bothStreams(GH_API_BAD_CREDENTIALS))).toBe(true)
  })

  test('a SAML/SSO 403 is an AUTHORIZATION refusal, not a rejected credential', () => {
    // GitHub answered, and its answer names the org — so it knows whose token
    // this is. "Expired, revoked, or missing a scope" is the wrong repair and
    // `probe_failed`'s "nothing was learned" is the wrong report; round 4 gave
    // the second of those. The wording lives in the response BODY, which is why
    // this is asserted over both streams.
    expect(looksLikeSamlSsoUnauthorized(bothStreams(GH_API_SAML_SSO))).toBe(true)
    expect(looksLikeCredentialRejected(bothStreams(GH_API_SAML_SSO))).toBe(false)
    // …and it is not mistaken for a transport failure either.
    expect(looksLikeGithubUnreachable(bothStreams(GH_API_SAML_SSO))).toBe(false)
  })

  test('CONTROL — a 403 whose WORDING is a refusal is still a rejection', () => {
    // The verdict comes from the phrase, not from the number, so narrowing the
    // status-code test did not blind the classifier to real 403 refusals.
    expect(
      looksLikeCredentialRejected('HTTP 403: Resource not accessible by personal access token'),
    ).toBe(true)
    expect(looksLikeCredentialRejected(GH_REJECTED_MISSING_SCOPE)).toBe(true)
  })
})

describe('the tie `gh auth status` cannot break is broken by asking GitHub directly', () => {
  // THE POINT OF THIS SUITE. `gh auth status` prints one fixed block for a
  // refused token AND for three different transport failures, so on its own it
  // can only ever produce a non-verdict — which meant a genuinely expired token
  // was reported as "check your network first", and `credential_rejected` was
  // unreachable from real `gh` output. `gh api` prints what actually happened.
  const withReachability = (api: GhApiCapture) =>
    defaultGitModeProbe(storeWithToken, ghHost({ status: GH_LOGIN_FAILURE_AMBIGUOUS, api }))

  test('GitHub ANSWERED with a refusal → `credential_rejected`, and the owner is told to rotate', async () => {
    const probe = withReachability(GH_API_BAD_CREDENTIALS)
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
    const msg = await refusalMessage(probe)
    expect(msg).toContain('REJECTED')
    expect(msg).toContain('expired, revoked, or missing a scope')
    // The wrong advice for this case, and what round 3 actually said:
    expect(msg).not.toContain('Check network/DNS/proxy FIRST')
  })

  for (const [label, api] of [
    ['a dead proxy', GH_API_DEAD_PROXY],
    ['a DNS failure', GH_API_DNS_FAILURE],
    ['a blackholed proxy', GH_API_BLACKHOLE_TIMEOUT],
  ] as const) {
    test(`${label} → \`could_not_reach_github\`, never a bad token`, async () => {
      const probe = withReachability(api)
      const res = await probe.publisherAvailable()
      expect(res.authenticated === false && res.cause).toBe('could_not_reach_github')
    })

    test(`${label} tells the owner NOT to rotate`, async () => {
      const msg = await refusalMessage(withReachability(api))
      expect(msg).toContain('could not reach GitHub')
      expect(msg).toContain('Do NOT rotate the token')
      expect(msg).not.toContain('REJECTED')
      expect(msg).not.toContain('expired, revoked, or missing a scope')
    })
  }

  test('a SAML/SSO refusal names the ORG problem, and never says "rotate"', async () => {
    // Round 4 sent this to `probe_failed` — "nothing was learned about the
    // credential" — when in fact the single most actionable thing had been
    // learned. Note the evidence for it is on STDOUT, so this test also fails if
    // the classifier goes back to reading stderr alone.
    const probe = withReachability(GH_API_SAML_SSO)
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_needs_sso_authorization')
    const msg = await refusalMessage(probe)
    expect(msg).toContain('AUTHORIZE the existing token')
    expect(msg).toContain('not expired or revoked')
    expect(msg).not.toContain('REJECTED')
    expect(msg).not.toContain('the publisher capability probe itself failed')
  })

  test('a reachability call that SUCCEEDS rules out both the token and the network', async () => {
    // THE ROUND-5 REPRO. `gh api /zen` exiting 0 proves GitHub answered and
    // accepted this credential — and round 4 called that `inconclusive` and told
    // the owner to "Check network/DNS/proxy FIRST", i.e. to go debug the one
    // thing the probe had just measured as working.
    const probe = withReachability(GH_API_ZEN_SUCCESS)
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('github_reachable_but_login_failed')
    const msg = await refusalMessage(probe)
    expect(msg).toContain("this host's local `gh` login state")
    expect(msg).toContain('Do NOT rotate the token')
    expect(msg).not.toContain('Check network/DNS/proxy FIRST')
    expect(msg).not.toContain('REJECTED')
  })

  test('a successful reachability call is QUOTED, not reported as having printed nothing', async () => {
    // The measured shape that exposed the classifier/message split: success
    // writes to STDOUT and leaves stderr EMPTY, so the stderr-only rendering
    // reported an answer it had in hand as "exited 0 without printing anything".
    const msg = await refusalMessage(withReachability(GH_API_ZEN_SUCCESS))
    expect(msg).toContain('SUCCEEDED, answering: Encourage flow.')
    expect(msg).not.toContain('without printing anything')
  })

  test('our own watchdog killing the reachability call is unreachable, not a verdict', async () => {
    const probe = withReachability(ghApi({ timed_out: true }))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('could_not_reach_github')
    // A silent `gh` must not render as `answered: ` with nothing after it, which
    // reads as evidence LOST rather than evidence absent.
    const msg = await refusalMessage(probe)
    expect(msg).toContain('killed by our own')
    expect(msg).not.toContain('and answered:')
    // …and it names the SHORTER budget this call actually gets, not the 60s one.
    expect(msg).toContain(`${PUBLISHER_REACHABILITY_TIMEOUT_MS / 1000}s watchdog`)
  })

  test('an unspawnable `gh api` leaves the honest non-verdict standing', async () => {
    const probe = withReachability(ghApi({ exit_code: -1 }))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_verdict_unavailable')
    expect(await refusalMessage(probe)).toContain('without printing anything')
  })

  test('BOTH measurements mute → the honest non-verdict, still pointing at the network first', async () => {
    const probe = withReachability(ghApi({ stderr: 'gh: something nobody has classified' }))
    const res = await probe.publisherAvailable()
    expect(res.authenticated === false && res.cause).toBe('credential_verdict_unavailable')
    const msg = await refusalMessage(probe)
    expect(msg).toContain('Check network/DNS/proxy FIRST')
    expect(msg).not.toContain('REJECTED')
  })

  test('the refusal shows BOTH measurements AND BOTH STREAMS of the second one', async () => {
    const msg = await refusalMessage(withReachability(GH_API_BAD_CREDENTIALS))
    expect(msg).toContain('The token in GH_TOKEN is invalid.')
    expect(msg).toContain('gh api --hostname github.com /zen')
    // stderr's one-line summary…
    expect(msg).toContain('Bad credentials (HTTP 401)')
    // …AND the fuller response body, which `gh` writes to STDOUT and which the
    // stderr-only rendering discarded even though the classifier had read it.
    expect(msg).toContain('"documentation_url": "https://docs.github.com/rest"')
  })

  test('the reachability call gets the REDUCED watchdog budget, not the 60s one', async () => {
    // The worst case is 60s + this, inside a call no caller imposes a deadline on
    // (`open/composer.ts`, `trident/work-board-build-tool.ts`,
    // `onboarding/overnight/register.ts` all just await it). Asserted at the seam
    // rather than in prose, because the previous docblock's "one extra `gh`
    // invocation" was true as a COUNT and silent about the 120s it cost.
    const budgets: (number | undefined)[] = []
    const probe = defaultGitModeProbe(
      storeWithToken,
      async (cmd, _cwd, _env, timeoutMs): Promise<HostCommandResult> => {
        if (cmd[0] === 'git') {
          return {
            ok: true,
            stdout: 'https://github.com/example-org/example-repo.git',
            stderr: '',
            exit_code: 0,
          }
        }
        budgets.push(timeoutMs)
        if (cmd[1] === 'api') return { ...GH_API_DEAD_PROXY }
        return { ok: false, stdout: '', stderr: GH_LOGIN_FAILURE_AMBIGUOUS, exit_code: 1 }
      },
    )
    await probe.publisherAvailable()
    // The first (`gh auth status`) call passes no budget, so it keeps the
    // production 60s default; the follow-up asks for less.
    expect(budgets).toEqual([undefined, PUBLISHER_REACHABILITY_TIMEOUT_MS])
    expect(PUBLISHER_REACHABILITY_TIMEOUT_MS).toBeLessThan(DEFAULT_HOST_COMMAND_TIMEOUT_MS)
  })

  test('the reachability call carries the PUBLISHER credential, not a bare `gh`', async () => {
    // Same seam as the rest of the probe: if this call ran without the env, it
    // would answer about a different credential than the one being judged.
    const seen: { cmd: string[]; env: Record<string, string> | undefined }[] = []
    const probe = defaultGitModeProbe(storeWithToken, async (cmd, _cwd, extraEnv) => {
      seen.push({ cmd, env: extraEnv })
      if (cmd[0] === 'git') {
        return {
          ok: true,
          stdout: 'https://github.com/example-org/example-repo.git',
          stderr: '',
          exit_code: 0,
        }
      }
      if (cmd[1] === 'api') return { ...GH_API_BAD_CREDENTIALS }
      return { ok: false, stdout: '', stderr: GH_LOGIN_FAILURE_AMBIGUOUS, exit_code: 1 }
    })
    await probe.publisherAvailable()
    const reachability = seen.filter((c) => c.cmd[1] === 'api')
    expect(reachability.length).toBe(1)
    expect(reachability[0]?.cmd).toEqual([...PUBLISHER_REACHABILITY_COMMAND])
    expect(reachability[0]?.env?.['GH_TOKEN']).toBe('t0k')
  })

  test('the reachability call is NOT made when `gh auth status` already gave a verdict', async () => {
    // It costs a round-trip; it is only worth making when the first measurement
    // was genuinely ambiguous.
    const cmds: string[][] = []
    const probe = defaultGitModeProbe(storeWithToken, async (cmd) => {
      cmds.push(cmd)
      if (cmd[0] === 'git') {
        return {
          ok: true,
          stdout: 'https://github.com/example-org/example-repo.git',
          stderr: '',
          exit_code: 0,
        }
      }
      return { ok: false, stdout: '', stderr: GH_REJECTED_MISSING_SCOPE, exit_code: 1 }
    })
    expect((await probe.publisherAvailable()).authenticated).toBe(false)
    expect(cmds.some((c) => c[1] === 'api')).toBe(false)
  })

  test('classifyGithubReachability reads the MEASURED shapes, and defaults to inconclusive', () => {
    expect(classifyGithubReachability(GH_API_BAD_CREDENTIALS)).toBe('refused')
    expect(classifyGithubReachability(GH_API_DEAD_PROXY)).toBe('unreachable')
    expect(classifyGithubReachability(GH_API_DNS_FAILURE)).toBe('unreachable')
    expect(classifyGithubReachability(GH_API_BLACKHOLE_TIMEOUT)).toBe('unreachable')
    expect(classifyGithubReachability(GH_API_TLS_INTERCEPTED)).toBe('unreachable')
    expect(classifyGithubReachability(GH_API_RATE_LIMIT_PRIMARY)).toBe('rate_limited')
    expect(classifyGithubReachability(GH_API_SAML_SSO)).toBe('sso_unauthorized')
    expect(classifyGithubReachability(GH_API_ZEN_SUCCESS)).toBe('reachable')
    expect(classifyGithubReachability(ghApi({ timed_out: true }))).toBe('unreachable')
    expect(classifyGithubReachability(ghApi({ stderr: 'ENOENT', exit_code: -1 }))).toBe(
      'inconclusive',
    )
    expect(classifyGithubReachability(ghApi({ stderr: 'who knows' }))).toBe('inconclusive')
    // A 403 with no rejection wording must not sneak a verdict in through here.
    expect(classifyGithubReachability(ghApi({ stderr: 'gh: Forbidden (HTTP 403)' }))).toBe(
      'inconclusive',
    )
  })

  test('the classifier reads STDOUT too — a verdict that lands only there is still read', () => {
    // The direct guard on the defect the fixtures were hiding. `gh` puts the
    // fuller diagnostic in the response body, i.e. on stdout; every fixture used
    // to hardcode `stdout: ''`, so a classifier that stopped reading stdout would
    // not have moved one test. Here the verdict exists ONLY on stdout.
    expect(classifyGithubReachability(ghApi({ stdout: '{"message": "Bad credentials"}' }))).toBe(
      'refused',
    )
    expect(
      classifyGithubReachability(
        ghApi({ stdout: '{"message": "Resource protected by organization SAML enforcement."}' }),
      ),
    ).toBe('sso_unauthorized')
    expect(
      classifyGithubReachability(ghApi({ stdout: '{"message": "API rate limit exceeded"}' })),
    ).toBe('rate_limited')
  })

  test('describeReachabilityAnswer quotes both streams, and says "nothing" only when both are empty', () => {
    expect(describeReachabilityAnswer(GH_API_ZEN_SUCCESS, 'reachable')).toContain(
      'SUCCEEDED, answering: Encourage flow.',
    )
    const refused = describeReachabilityAnswer(GH_API_BAD_CREDENTIALS, 'refused')
    expect(refused).toContain('gh: Bad credentials (HTTP 401)')
    expect(refused).toContain('"status": "401"')
    // Only-stdout is still an answer…
    expect(describeReachabilityAnswer(ghApi({ stdout: 'body only' }), 'inconclusive')).toBe(
      'answered: body only',
    )
    // …and only-stderr is too.
    expect(describeReachabilityAnswer(ghApi({ stderr: 'err only' }), 'inconclusive')).toBe(
      'answered: err only',
    )
    // Genuinely mute is the ONLY case that says nothing was printed.
    expect(describeReachabilityAnswer(ghApi({ exit_code: 7 }), 'inconclusive')).toBe(
      'exited 7 without printing anything',
    )
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
    // The refusal must RUN THROUGH to `gh`'s last line. The truncation bug
    // terminated it at the first one — `…missing a scope: github.com` — so
    // asserting the tail is the direct contradiction of that failure. (Stated
    // as "ends with the real last line" rather than "does not end with the
    // hostname": a suffix test against a bare host name is the shape CodeQL
    // flags as incomplete URL sanitization, and this form is stronger anyway.)
    expect(msg.trimEnd().endsWith('The token in GH_TOKEN is invalid.')).toBe(true)
  })

  // NAMED FOR WHAT IT ACTUALLY GUARANTEES. This was called "never dropped",
  // which the very next test contradicts: the length cap DOES drop characters.
  // The two are not in tension once the guarantee is stated precisely — no LINE
  // is ever SELECTED BETWEEN (which is what `split('\n')[0]` did), and the only
  // thing that can remove characters is the total-length cap, which removes them
  // from the END of an already-complete rendering. A test name that overstates
  // its own guarantee is how a later reader concludes the cap is a bug and
  // removes it.
  test('no line is selected between — every line is flattened and trimmed in order', () => {
    expect(renderAuthFailureDetail(GH_LOGIN_FAILURE_AMBIGUOUS)).toBe(
      ': github.com; X Failed to log in to github.com using token (GH_TOKEN); ' +
        '- Active account: true; - The token in GH_TOKEN is invalid.',
    )
  })

  test('the length cap is the ONLY thing that drops characters, and it cuts the tail', () => {
    // The boundary the pair of names has to be honest about. Four lines, the
    // last of which is pushed past the cap: the earlier lines survive intact, the
    // last is cut mid-way, and the reader is told it was cut.
    const long = ['first line', 'second line', 'x'.repeat(MAX_AUTH_FAILURE_DETAIL_CHARS)].join('\n')
    const rendered = renderAuthFailureDetail(long)
    expect(rendered.startsWith(': first line; second line; ')).toBe(true)
    expect(rendered).toContain('(truncated)')
    // Nothing was re-ordered or selected away — the loss is a suffix, and only a
    // suffix.
    const body = rendered.slice(2).replace('… (truncated)', '')
    expect('first line; second line; ' + 'x'.repeat(MAX_AUTH_FAILURE_DETAIL_CHARS)).toContain(body)
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
