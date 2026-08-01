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
    ).toEqual({ kind: 'measurable', token: TOKEN })
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
  }) {
    const queue = [...(opts.outcomes ?? [])]
    let probes = 0
    const m = new CredentialUsageMonitor({
      env: opts.env ?? { ...bareEnv(), CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      credentialDeps: noCredentialsOnDisk(),
      probe: async () => {
        probes += 1
        opts.onProbe?.()
        return queue.shift() ?? { kind: 'error', message: 'no outcome staged' }
      },
      // Never let the real timer arm inside a unit test.
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    return { m, probeCount: () => probes }
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
    expect(m.snapshot()).toEqual({ available: false, reason: 'probe_failed' })
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
