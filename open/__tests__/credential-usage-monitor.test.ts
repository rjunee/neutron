/**
 * The monitor's whole job is knowing when it does NOT know.
 *
 * Every case here is a way the meter could lie: an unconfigured box drawing an
 * empty bar, a dead credential's last reading lingering, a network blip blanking
 * a perfectly good number, or an hour-old figure being served as current. The
 * happy path is one test; the rest are the interesting ones.
 */

import { describe, expect, it } from 'bun:test'

import type { CredentialUsageProbeOutcome } from '@neutronai/auth/credential-usage-probe.ts'
import { createLogger } from '@neutronai/logger'

import { resolveActiveCredential, claudeCredentialsPath } from '../active-credential.ts'
import { CredentialUsageMonitor, USAGE_MAX_AGE_MS } from '../credential-usage-monitor.ts'

const TOKEN = 'sk-ant-oat01-test-token-value-not-a-real-credential'

/** An env with nothing in it — a fresh install. `HOME` points somewhere with no
 *  credentials file so the disk tier resolves to "nothing". */
function bareEnv(): NodeJS.ProcessEnv {
  return { HOME: '/nonexistent-home-for-tests' }
}

function noCredentialsOnDisk(): { readFile: (p: string) => string } {
  return {
    readFile: (): string => {
      throw new Error('ENOENT')
    },
  }
}

describe('resolveActiveCredential', () => {
  it('prefers the env subscription token', () => {
    expect(
      resolveActiveCredential({ ...bareEnv(), CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, noCredentialsOnDisk()),
      // `account_label` is null because no sidecar names the account — the ordinary
      // case, and the reason the series column stayed empty until something wrote one.
    ).toEqual({ kind: 'measurable', token: TOKEN, account_label: null })
  })

  it('calls an API key unmeasurable — it is billed per token, not per window', () => {
    expect(
      resolveActiveCredential({ ...bareEnv(), ANTHROPIC_API_KEY: 'sk-ant-api-x' }, noCredentialsOnDisk()),
    ).toEqual({ kind: 'unmeasurable', reason: 'unsupported_credential' })
  })

  it('falls through to the token the CLI keeps on disk — the credential a host swaps', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })
    expect(resolveActiveCredential(bareEnv(), { readFile: () => blob })).toEqual({
      kind: 'measurable',
      token: TOKEN,
      account_label: null,
    })
  })

  it('reports no credential at all when nothing is configured', () => {
    expect(resolveActiveCredential(bareEnv(), noCredentialsOnDisk())).toEqual({
      kind: 'unmeasurable',
      reason: 'no_credential',
    })
  })

  it('degrades a malformed credentials file to "no credential" rather than throwing', () => {
    expect(resolveActiveCredential(bareEnv(), { readFile: () => 'not json at all' })).toEqual({
      kind: 'unmeasurable',
      reason: 'no_credential',
    })
    expect(
      resolveActiveCredential(bareEnv(), { readFile: () => JSON.stringify({ claudeAiOauth: {} }) }),
    ).toEqual({ kind: 'unmeasurable', reason: 'no_credential' })
  })

  it('measures through an isolated CLAUDE_CONFIG_DIR when one is set', () => {
    expect(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/srv/instance/.claude' })).toBe(
      '/srv/instance/.claude/.credentials.json',
    )
  })
})

describe('CredentialUsageMonitor', () => {
  function monitor(opts: {
    env?: NodeJS.ProcessEnv
    outcomes?: CredentialUsageProbeOutcome[]
    now?: () => number
    onProbe?: () => void
    token?: string
  }) {
    const queue = [...(opts.outcomes ?? [])]
    let probes = 0
    const logLines: string[] = []
    const m = new CredentialUsageMonitor({
      env: opts.env ?? { ...bareEnv(), CLAUDE_CODE_OAUTH_TOKEN: opts.token ?? TOKEN },
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      credentialDeps: noCredentialsOnDisk(),
      probe: async () => {
        probes += 1
        opts.onProbe?.()
        return queue.shift() ?? { kind: 'error', message: 'no outcome staged' }
      },
      log: createLogger('credential-usage-test', {
        sink: (_level, line) => logLines.push(line),
      }),
      // Never let the real timer arm inside a unit test.
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    return { m, probeCount: () => probes, logLines }
  }

  it('reports "not measured yet" before the first tick — not zero', () => {
    const { m } = monitor({})
    expect(m.snapshot()).toEqual({ available: false, reason: 'not_measured_yet' })
  })

  it('serves the measured reading with the time it was taken', async () => {
    const { m } = monitor({
      now: () => 1_000_000,
      outcomes: [{ kind: 'ok', reading: { session: 0.17, weekly: 0.34 } }],
    })
    await m.measureOnce()
    expect(m.snapshot()).toEqual({
      available: true,
      measured_at: 1_000_000,
      session: 0.17,
      weekly: 0.34,
    })
  })

  it('never touches the network when there is no credential to ask about', async () => {
    const { m, probeCount } = monitor({ env: bareEnv() })
    await m.measureOnce()
    expect(probeCount()).toBe(0)
    expect(m.snapshot()).toEqual({ available: false, reason: 'no_credential' })
  })

  it('keeps the last good reading through a transient probe failure', async () => {
    const { m } = monitor({
      now: () => 5_000,
      outcomes: [
        { kind: 'ok', reading: { session: 0.5, weekly: 0.2 } },
        { kind: 'error', message: 'ECONNRESET' },
      ],
    })
    await m.measureOnce()
    await m.measureOnce()
    const snap = m.snapshot()
    expect(snap.available).toBe(true)
    expect(snap.available === true ? snap.session : null).toBe(0.5)
  })

  it('stops quoting a reading once it is older than the staleness ceiling', async () => {
    let clock = 5_000
    const { m } = monitor({
      now: () => clock,
      outcomes: [{ kind: 'ok', reading: { session: 0.5, weekly: 0.2 } }],
    })
    await m.measureOnce()
    expect(m.snapshot().available).toBe(true)
    clock += USAGE_MAX_AGE_MS + 1
    expect(m.snapshot()).toEqual({ available: false, reason: 'reading_aged_out' })
  })

  it('keeps never-read, probe-failed, and aged-out unavailable reasons distinct', async () => {
    const neverRead = monitor({}).m
    expect(neverRead.snapshot()).toEqual({ available: false, reason: 'not_measured_yet' })

    const failed = monitor({ outcomes: [{ kind: 'error', message: 'timeout' }] }).m
    await failed.measureOnce()
    expect(failed.snapshot()).toEqual({ available: false, reason: 'probe_failed' })

    let clock = 10
    const agedOut = monitor({
      now: () => clock,
      outcomes: [{ kind: 'ok', reading: { session: 0.1, weekly: 0.2 } }],
    }).m
    await agedOut.measureOnce()
    clock += USAGE_MAX_AGE_MS + 1
    expect(agedOut.snapshot()).toEqual({ available: false, reason: 'reading_aged_out' })
  })

  it('logs a successful probe with its measurement time', async () => {
    const { m, logLines } = monitor({
      now: () => 42,
      outcomes: [{ kind: 'ok', reading: { session: 0.1, weekly: 0.2 } }],
    })
    await m.measureOnce()
    expect(logLines.filter((line) => line.includes('event=usage_probe_ok'))).toEqual([
      expect.stringContaining('measured_at=42'),
    ])
  })

  it('logs a windowless response as its own probe outcome', async () => {
    const { m, logLines } = monitor({ outcomes: [{ kind: 'no-windows' }] })
    await m.measureOnce()
    expect(logLines.filter((line) => line.includes('event=usage_probe_no_windows'))).toHaveLength(1)
  })

  it('logs upstream credential rejection with status as its own probe outcome', async () => {
    const { m, logLines } = monitor({ outcomes: [{ kind: 'unauthorized', httpStatus: 401 }] })
    await m.measureOnce()
    expect(logLines.filter((line) => line.includes('event=usage_probe_unauthorized'))).toEqual([
      expect.stringContaining('status=401'),
    ])
  })

  it('logs a transient probe failure without unsafe exception text', async () => {
    const { m, logLines } = monitor({
      outcomes: [{ kind: 'error', message: `socket included ${TOKEN}` }],
    })
    await m.measureOnce()
    expect(logLines.filter((line) => line.includes('event=usage_probe_failed'))).toEqual([
      expect.stringContaining('cause=probe_error'),
    ])
    expect(logLines.join('\n')).not.toContain(TOKEN)
  })

  it('logs standing transitions but not identical outcomes on every tick', async () => {
    const { m, logLines } = monitor({
      outcomes: [
        { kind: 'ok', reading: { session: 0.1, weekly: 0.2 } },
        { kind: 'ok', reading: { session: 0.2, weekly: 0.3 } },
        { kind: 'unauthorized', httpStatus: 401 },
        { kind: 'unauthorized', httpStatus: 401 },
      ],
    })
    await m.measureOnce()
    const afterInitial = logLines.length
    await m.measureOnce()
    expect(logLines).toHaveLength(afterInitial)
    await m.measureOnce()
    expect(logLines.filter((line) => line.includes('event=credential_standing_changed'))).toEqual([
      expect.stringContaining('to=healthy'),
      expect.stringContaining('to=lapsed'),
    ])
    const afterTransition = logLines.length
    await m.measureOnce()
    expect(logLines).toHaveLength(afterTransition)
  })

  // ── WHAT THE LAST LIVE READ LEARNED ABOUT THE CREDENTIAL ──────────────────
  // ARGUS ROUND 4: the usage card asked the credential FILE whether the Anthropic
  // pool was connected, and `resolveActiveCredential` performs no validity check —
  // so a revoked token read as connected forever, wrote no sample, and rendered
  // "No readings yet.": a promise of a first reading that can never arrive. The
  // card needs the answer to the OTHER question, and this is where it comes from.

  it('says nothing about the credential before the first tick — null, not healthy', () => {
    const { m } = monitor({})
    expect(m.readStanding()).toBeNull()
  })

  it('reports the credential LAPSED once upstream rejects it', async () => {
    const { m } = monitor({
      now: () => 5_000,
      outcomes: [
        { kind: 'ok', reading: { session: 0.5, weekly: 0.2 } },
        { kind: 'unauthorized', httpStatus: 401 },
      ],
    })
    await m.measureOnce()
    // The control: a working credential is not a refusal, so a reader that called
    // everything lapsed would fail here before it could pass below.
    expect(m.readStanding()).toBe('healthy')
    await m.measureOnce()
    expect(m.readStanding()).toBe('lapsed')
  })

  it('a TRANSIENT failure is not a refusal — a dropped packet must not repaint the card', async () => {
    const { m } = monitor({
      now: () => 5_000,
      outcomes: [
        { kind: 'ok', reading: { session: 0.5, weekly: 0.2 } },
        { kind: 'error', message: 'socket hang up' },
      ],
    })
    await m.measureOnce()
    await m.measureOnce()
    expect(m.readStanding()).toBe('indeterminate')
    expect(m.readStanding()).not.toBe('lapsed')
  })

  it('records the standing even when the observer throws', async () => {
    // The observer posts to chat, which touches a DB and a socket and can throw.
    // A throw there must not cost the card the fact that the credential was
    // rejected — which is why the standing is recorded before the observer runs.
    const m = new CredentialUsageMonitor({
      env: { ...bareEnv(), CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      now: () => 5_000,
      credentialDeps: noCredentialsOnDisk(),
      probe: async () => ({ kind: 'unauthorized', httpStatus: 401 }),
      onStanding: () => {
        throw new Error('chat is down')
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    await m.measureOnce()
    expect(m.readStanding()).toBe('lapsed')
  })

  it('drops the reading outright when the credential turns out to be dead', async () => {
    const { m } = monitor({
      now: () => 5_000,
      outcomes: [
        { kind: 'ok', reading: { session: 0.5, weekly: 0.2 } },
        { kind: 'unauthorized', httpStatus: 401 },
      ],
    })
    await m.measureOnce()
    await m.measureOnce()
    expect(m.snapshot()).toEqual({ available: false, reason: 'no_credential' })
  })

  it('drops the reading when the credential stops reporting windows', async () => {
    const { m } = monitor({
      now: () => 5_000,
      outcomes: [
        { kind: 'ok', reading: { session: 0.5, weekly: 0.2 } },
        { kind: 'no-windows' },
      ],
    })
    await m.measureOnce()
    await m.measureOnce()
    expect(m.snapshot()).toEqual({ available: false, reason: 'unsupported_credential' })
  })

  it('re-resolves the credential every tick, so a swapped token is measured next tick', async () => {
    const env: NodeJS.ProcessEnv = { ...bareEnv(), CLAUDE_CODE_OAUTH_TOKEN: TOKEN }
    const seen: string[] = []
    const m = new CredentialUsageMonitor({
      env,
      now: () => 1,
      credentialDeps: noCredentialsOnDisk(),
      probe: async (token: string) => {
        seen.push(token)
        return { kind: 'ok', reading: { session: 0, weekly: 0 } }
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    await m.measureOnce()
    env['CLAUDE_CODE_OAUTH_TOKEN'] = `${TOKEN}-rotated`
    await m.measureOnce()
    expect(seen).toEqual([TOKEN, `${TOKEN}-rotated`])
  })
})
