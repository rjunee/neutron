/**
 * THE KIMI POLLER ACTUALLY WRITES THE SERIES — the wiring, not the parser.
 *
 * `trident/__tests__/kimi-usage-probe.test.ts` covers the endpoint read and every
 * refusal in it. It cannot cover this: `open` depends on `trident` and never the
 * reverse, so the monitor's sink behaviour has to be asserted here.
 *
 * THE HEADLINE PROPERTY IS "gauge-failure-is-loud": every failure mode writes NO
 * ROW. Asserted by COUNT, with a control write proving the counter can move —
 * otherwise "zero rows" would be indistinguishable from a test that never
 * exercised the writer at all. A gap in the series renders as an ageing card; a
 * fabricated zero renders as a free subscription, and that is the render that
 * would send the owner to raise concurrency into a wall.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { UsageSamplesStore } from '@neutronai/persistence/usage-samples-store.ts'
import type { KimiUsageProbeOutcome } from '@neutronai/trident/kimi-usage-probe.ts'

import { KimiUsageMonitor } from '../kimi-usage-monitor.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = 1_800_000_000_000

let tmp: string
let db: ProjectDb
let store: UsageSamplesStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kimi-usage-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new UsageSamplesStore({ db, now: () => NOW })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function monitorFor(
  outcome: KimiUsageProbeOutcome | (() => Promise<KimiUsageProbeOutcome>),
  opts: { key?: string | null; probed?: string[] } = {},
): KimiUsageMonitor {
  return new KimiUsageMonitor({
    key: () => (opts.key === undefined ? 'stored-key' : opts.key),
    probe: async (key) => {
      opts.probed?.push(key)
      return typeof outcome === 'function' ? await outcome() : outcome
    },
    onSample: async (sample) => {
      await store.record({ pool: 'kimi', ts: NOW, ...sample })
    },
  })
}

const OK_OUTCOME: KimiUsageProbeOutcome = {
  kind: 'ok',
  sample: {
    account_label: 'acct-example',
    session: { fraction: 0.42, reset_at: NOW + 40 * MINUTE, window_ms: 5 * HOUR },
    weekly: { fraction: 0.64, reset_at: NOW + 3 * 24 * HOUR, window_ms: 7 * 24 * HOUR },
  },
}

describe('the Kimi poller writes what it read, and nothing it did not', () => {
  test('a successful read lands ONE row carrying both windows and their lengths', async () => {
    await monitorFor(OK_OUTCOME).measureOnce()
    const row = store.latest('kimi')!
    expect(row.session).toBe(0.42)
    expect(row.weekly).toBe(0.64)
    expect(row.session_reset_at).toBe(NOW + 40 * MINUTE)
    expect(row.weekly_reset_at).toBe(NOW + 3 * 24 * HOUR)
    // The lengths ride WITH the sample — the reader must never have to assume a
    // regime for a provider that told it one.
    expect(row.session_window_ms).toBe(5 * HOUR)
    expect(row.weekly_window_ms).toBe(7 * 24 * HOUR)
    expect(row.account_label).toBe('acct-example')
  })

  test('gauge-failure-is-loud: NO failure mode writes a row', async () => {
    // The control first, so "count stayed 0" cannot be a test that never wired the
    // sink. Without it, deleting the `record` call from the monitor would leave every
    // assertion below green.
    await monitorFor(OK_OUTCOME).measureOnce()
    expect(store.count()).toBe(1)
    const before = store.count()

    const failures: KimiUsageProbeOutcome[] = [
      { kind: 'error', message: 'socket hang up' },
      { kind: 'unauthorized', httpStatus: 401 },
      { kind: 'unrecognised', observed: ['quota', 'five_hour'] },
    ]
    for (const outcome of failures) {
      await monitorFor(outcome).measureOnce()
      expect(store.count()).toBe(before)
    }
    // And the card ages rather than zeroing: the last real reading is still what a
    // summary reports, with its age, after every one of those failures.
    expect(store.summarise('kimi').accounts[0]!.session!.fraction).toBe(0.42)
  })

  test('no key configured is a quiet no-op — no probe, no row, no error', async () => {
    // An install without Kimi is an ordinary install, not a broken one.
    const probed: string[] = []
    await monitorFor(OK_OUTCOME, { key: null, probed }).measureOnce()
    expect(probed).toEqual([])
    expect(store.count()).toBe(0)
    // A whitespace-only stored value counts as absent, the same rule the reviewer's
    // key resolver already applies.
    await monitorFor(OK_OUTCOME, { key: '   ', probed }).measureOnce()
    expect(probed).toEqual([])
  })

  test('a THROWING key lookup never fails the tick', async () => {
    const monitor = new KimiUsageMonitor({
      key: () => {
        throw new Error('credential store locked')
      },
      onSample: async () => {
        throw new Error('should not be reached')
      },
    })
    await monitor.measureOnce()
    expect(store.count()).toBe(0)
  })

  test('a THROWING sink never fails the tick — repeated tick failures escalate the loop', async () => {
    const monitor = new KimiUsageMonitor({
      key: () => 'stored-key',
      probe: async () => OK_OUTCOME,
      onSample: async () => {
        throw new Error('db locked')
      },
    })
    await monitor.measureOnce()
    expect(store.count()).toBe(0)
  })

  test('the stored key is what gets probed', async () => {
    const probed: string[] = []
    await monitorFor(OK_OUTCOME, { key: 'the-stored-one', probed }).measureOnce()
    expect(probed).toEqual(['the-stored-one'])
  })

  test('a sample carries BOTH windows — a half read never reaches the series', async () => {
    // There is no "partial sample" shape to write any more, and that is enforced by
    // the type rather than by care: `KimiUsageSample.weekly` is non-nullable, so
    // `parseKimiUsages` refusing a one-window response is the ONLY way a reading
    // gets here. A half sample and a provider with one window are the same wire
    // shape downstream, so the refusal happens before the store, not after.
    await monitorFor(OK_OUTCOME).measureOnce()
    const account = store.summarise('kimi').accounts[0]!
    expect(account.session!.fraction).toBe(0.42)
    expect(account.weekly!.fraction).toBe(0.64)
    expect(account.weekly!.window_ms).toBe(7 * 24 * HOUR)
  })
})

describe('the card can say WHY it is empty, not just that it is', () => {
  test('an unreadable payload marks the read REFUSED, and a good tick clears it', async () => {
    // THE MUTANT THIS KILLS: leaving the standing at `ok`/null on a refusal, which
    // renders the card as "No readings yet." — a sentence that promises a first
    // reading is coming. Kimi's usages schema is unpublished, so a refused payload
    // is the realistic first-install failure and the owner would wait on it forever
    // while the key names went to a log nobody is watching.
    const refused = monitorFor({ kind: 'unrecognised', observed: ['limits', 'quota'] })
    // Nothing read yet is NOT a refusal: the honest answer before the first tick is
    // "wait", and a card that opened on an error would be its own false alarm.
    expect(refused.readStanding()).toBeNull()
    await refused.measureOnce()
    expect(refused.readStanding()).toBe('refused')
    // And no row: loud and EMPTY, never a zero.
    expect(store.count()).toBe(0)

    // A rejected key is the same standing — the card's sentence covers both, and
    // both need a human rather than a wait.
    const dead = monitorFor({ kind: 'unauthorized', httpStatus: 401 })
    await dead.measureOnce()
    expect(dead.readStanding()).toBe('refused')

    // A TRANSPORT failure is NOT: the next tick retries, so a dropped packet must
    // not repaint the card as broken. This is the control that stops the assertions
    // above from passing on a monitor that calls everything refused.
    const flaky = monitorFor({ kind: 'error', message: 'socket hang up' })
    await flaky.measureOnce()
    expect(flaky.readStanding()).not.toBe('refused')

    // And a successful read clears it — the standing is live, not latched.
    const recovering = new KimiUsageMonitor({
      key: () => 'stored-key',
      probe: async () => OK_OUTCOME,
      onSample: async (sample) => {
        await store.record({ pool: 'kimi', ts: NOW, ...sample })
      },
    })
    await recovering.measureOnce()
    expect(recovering.readStanding()).toBe('ok')
    expect(store.count()).toBe(1)
  })
})
