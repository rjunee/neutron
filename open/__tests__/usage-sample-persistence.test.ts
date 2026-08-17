/**
 * THE MONITOR ACTUALLY WRITES THE SERIES — the wiring, not the store.
 *
 * `persistence/usage-samples-store.test.ts` covers the store and the pace maths. It
 * cannot cover this: `open` depends on `persistence` and never the reverse, so a test
 * over there cannot import the monitor. The lint rule said so and the rule was right —
 * the dependency direction is the architecture.
 *
 * WHAT IS AT STAKE HERE is the failure this repo keeps having: the store could be
 * perfect and never called. So this asserts the monitor invokes the sink, that it does
 * so ONLY for a successful probe, that a throwing sink cannot break the tick, and that
 * the real composer supplies a sink at all.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { UsageSamplesStore } from '@neutronai/persistence/usage-samples-store.ts'

import { CredentialUsageMonitor } from '../credential-usage-monitor.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

let tmp: string
let db: ProjectDb
let store: UsageSamplesStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'usage-wiring-'))
  db = openMigratedDbAt(join(tmp, 'owner.db'))
  store = new UsageSamplesStore({ db, now: () => NOW })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('the monitor actually writes to it — the wiring, not the store', () => {
  /**
   * The store could be perfect and never called. That is the failure this repo keeps
   * having, so it gets its own assertions: one behavioural (the monitor invokes the
   * sink, and only on a successful probe) and one on the composer's source (it supplies
   * a sink at all).
   */
  test('THE ACCOUNT LABEL RIDES WITH THE READING, and lands on the row', async () => {
    // The column existed and was null on every row for a release. A label that
    // resolves correctly and is then dropped on the way to the sink is the exact
    // "built but never carried" shape — so this asserts the value ARRIVES, not that
    // the resolver works (which has its own tests).
    const samples: Array<Record<string, unknown>> = []
    const monitor = new CredentialUsageMonitor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as never,
      now: () => NOW,
      credentialDeps: { readLabel: () => 'acct-2' },
      probe: async () => ({ kind: 'ok', reading: { session: 0.4, weekly: 0.2 } }) as never,
      onSample: async (reading) => {
        samples.push(reading as unknown as Record<string, unknown>)
        await store.record({ pool: 'anthropic', ...reading })
      },
    })
    await monitor.measureOnce()
    expect(samples[0]?.['account_label']).toBe('acct-2')
    // And on the row, because the sink writing it somewhere else would be the same
    // defect one layer down.
    expect(store.latest('anthropic')?.account_label).toBe('acct-2')
  })

  test('an UNLABELLED credential still records, with a null label', async () => {
    // The ordinary case. It must not become a row that fails to write, or a label
    // invented to fill the column.
    const monitor = new CredentialUsageMonitor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as never,
      now: () => NOW,
      credentialDeps: { readLabel: () => null },
      probe: async () => ({ kind: 'ok', reading: { session: 0.4, weekly: 0.2 } }) as never,
      onSample: async (reading) => {
        await store.record({ pool: 'anthropic', ...reading })
      },
    })
    await monitor.measureOnce()
    expect(store.latest('anthropic')?.account_label).toBeNull()
  })

  test('a SUCCESSFUL probe reaches the sink, and lands in the series', async () => {
    const samples: unknown[] = []
    const monitor = new CredentialUsageMonitor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as never,
      now: () => NOW,
      probe: async () => ({
        kind: 'ok',
        reading: { session: 0.6, weekly: 0.3, session_reset_at: NOW + HOUR },
      }) as never,
      onSample: async (reading) => {
        samples.push(reading)
        await store.record({ pool: 'anthropic', ts: NOW, ...reading })
      },
    })
    await monitor.measureOnce()
    expect(samples).toHaveLength(1)
    expect(store.latest('anthropic')!.session).toBe(0.6)
  })

  test('a FAILED probe writes NOTHING — a gap is not a zero', async () => {
    // An unauthorized or errored probe learned nothing about utilisation. Recording a
    // row for it would put a value in the series that no measurement supports, and
    // every derived number downstream would inherit it.
    for (const kind of ['unauthorized', 'error'] as const) {
      const samples: unknown[] = []
      const monitor = new CredentialUsageMonitor({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as never,
        now: () => NOW,
        probe: async () => ({ kind, reason: 'x' }) as never,
        onSample: async (r) => {
          samples.push(r)
        },
      })
      await monitor.measureOnce()
      expect(samples).toHaveLength(0)
    }
  })

  test('a THROWING sink never fails the tick — the meter outranks the history', async () => {
    // Repeated tick failures escalate the loop, and the meter is the monitor's actual
    // contract. Losing one row from a 60-second series costs nothing; losing the meter
    // costs the feature.
    const monitor = new CredentialUsageMonitor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as never,
      now: () => NOW,
      probe: async () => ({ kind: 'ok', reading: { session: 0.5, weekly: 0.2 } }) as never,
      onSample: async () => {
        throw new Error('db locked')
      },
    })
    await monitor.measureOnce()
    // The meter still has the reading despite the sink blowing up.
    expect(monitor.snapshot()).toMatchObject({ available: true, session: 0.5 })
  })

  test('the COMPOSER supplies a sink and prunes on the same call', async () => {
    // Source-scoped: booting the real composer needs a substrate and a socket registry.
    // Without this the three tests above pass while production writes nothing.
    const src = await Bun.file(new URL('../composer.ts', import.meta.url)).text()
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    const at = code.indexOf('new CredentialUsageMonitor({')
    expect(at).toBeGreaterThan(-1)
    const end = code.indexOf('\n    })', at)
    expect(end).toBeGreaterThan(at)
    const block = code.slice(at, end)
    expect(block.includes('onSample:')).toBe(true)
    expect(block.includes('usageSamplesStore.record(')).toBe(true)
    expect(block.includes('usageSamplesStore.prune()')).toBe(true)
    // AND that the real sink hands the WHOLE reading to the store instead of naming
    // columns one at a time. `account_label` rides ON the reading, so a sink that
    // cherry-picks `ts`/`session`/`weekly` drops it — and the label tests above use
    // their OWN `onSample`, which means they prove the MONITOR carries the label and
    // say nothing about the sink that runs in production. Stripping the spread out of
    // the composer passed all 36 tests in this feature's three files before this line
    // existed: "resolved but never carried", one layer further along than the mutant
    // the monitor test was written to kill.
    const recordAt = block.indexOf('usageSamplesStore.record(')
    const recordEnd = block.indexOf('\n', recordAt)
    expect(recordEnd).toBeGreaterThan(recordAt)
    expect(block.slice(recordAt, recordEnd)).toContain('...reading')
  })

  test('the COMPOSER also gives the usage surface a way to READ the series', async () => {
    // The other half, and the one that fails silently: a series written by nobody
    // reading it is just disk. The write assertion above passed for a whole PR
    // during which no endpoint existed, so both halves need their own check —
    // links in a chain are independently absent.
    const src = await Bun.file(new URL('../composer.ts', import.meta.url)).text()
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    const at = code.indexOf('createAppUsageSurface({')
    expect(at).toBeGreaterThan(-1)
    // The terminator has to be FOUND, not just searched for — see the note on the
    // same pattern in `credential-label.test.ts`: an unfound `indexOf` returns -1 and
    // `slice(at, -1)` widens the block to the rest of the file, where these two
    // strings are trivially present and the check stops checking anything.
    const end = code.indexOf('\n    })', at)
    expect(end).toBeGreaterThan(at)
    const block = code.slice(at, end)
    // Scoped to the CONSTRUCT, not to an argument list or a variable name: this
    // has to survive the surface gaining another dependency.
    expect(block.includes('dashboard:')).toBe(true)
    expect(block.includes('.summarise(')).toBe(true)
  })
})
