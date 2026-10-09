/**
 * The route-slot coverage fixture must not close SQLite under a running loop tick.
 *
 * `open/__tests__/route-slot-coverage.test.ts` boots the real Open composition
 * and tears it down through `teardownComposedFixture`. The composition
 * registers async `realmode_cleanups`; the chunked-upload sweeper's cleanup is a
 * quiescing `stop()` that waits for an in-flight tick. Calling those cleanups without
 * awaiting them, then shutting the graph down and closing the database, lets the
 * database close while that tick is still writing.
 *
 * The held-tick cases run on the shared harness
 * `tests/support/held-sweeper-teardown.ts` (its own self-test lives beside it).
 * It captures the sweeper loop the Open composer actually starts, seeds an
 * expired `uploading` row, drives one real tick and parks it inside the real
 * `markExpired` write, then runs THIS fixture's teardown and reports what that
 * teardown did while the tick was held: graph shutdown, DB close, or a later
 * cleanup entered early. `expectQuiescedTeardown` asserts none of that happened,
 * that the real write landed, and that the DB closed exactly once afterwards.
 *
 * Progress is observed through ordered events and explicit barriers; nothing
 * here measures time.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../support/migrated-db.ts'
import {
  SWEEPER_LOOP_NAME,
  bootCapturingSweeperLoop,
  expectQuiescedTeardown,
  runHeldSweeperTeardown,
  runTracedTeardown,
} from '../support/held-sweeper-teardown.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { drainRealmodeCleanups } from '@neutronai/gateway/index.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { teardownComposedFixture } from '@neutronai/open/__tests__/route-slot-fixture-teardown.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const COVERAGE_FIXTURE = join(HERE, '..', '..', 'open', '__tests__', 'route-slot-coverage.test.ts')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

type Composition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>

interface Fixture {
  db: ProjectDb
  composition: Composition
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  /** The fixture's teardown under test. Memoized: a repeat call returns the first. */
  close(): Promise<void>
}

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
/** The live booted fixture; afterEach closes it, so a failing test never leaks it. */
let fixture: Fixture | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-route-fixture-quiesce-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'route-fixture-quiesce-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-route-fixture-quiesce'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  // Close a fixture a failing test left behind BEFORE its home is removed.
  // `close()` is memoized, so a fixture the test already tore down is not
  // drained or closed a second time.
  const live = fixture
  fixture = null
  try {
    if (live !== null) await live.close()
  } finally {
    for (const k of SAVED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

/** A substrate that answers immediately and starts no `claude` process. */
function mockSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

/**
 * Boot the real Open composer and production graph the way the coverage
 * fixture does. `close()` is the coverage fixture's own teardown call.
 */
async function bootComposed(): Promise<Fixture> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH'] as string)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH'] as string)
  let composition: Composition
  try {
    const composer = buildOpenGraphComposer({
      env: process.env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      substrateFactory: (() => mockSubstrate()) as any,
    })
    composition = await composer({ db, project_slug: 'owner' })
  } catch (err) {
    db.close()
    throw err
  }
  let graph: Fixture['graph']
  try {
    graph = await composeProductionGraph(composition)
  } catch (err) {
    await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
    db.close()
    throw err
  }
  let closing: Promise<void> | null = null
  return {
    db,
    composition,
    graph,
    close: () =>
      (closing ??= teardownComposedFixture({ cleanups: composition.realmode_cleanups, graph, db })),
  }
}

/** Boot with the sweeper capture installed; `fixture` is set inside the boot so afterEach closes it. */
function bootHeld(): ReturnType<typeof bootCapturingSweeperLoop<Fixture>> {
  return bootCapturingSweeperLoop(async () => (fixture = await bootComposed()))
}

const OLD_LOOP = /for\s*\(\s*const\s+\w+\s+of\s+composition\.realmode_cleanups/

describe('route-slot fixture teardown quiesces composed loops before closing SQLite', () => {
  test('a held upload-sweeper tick keeps teardown pending, the DB open, and later cleanups unentered until it lands', async () => {
    const { value, loop } = await bootHeld()
    // A trailing cleanup guarantees there IS a later cleanup the harness can
    // catch being entered while the sweeper's stop() is still held.
    let trailing = 0
    value.composition.realmode_cleanups!.push(() => {
      trailing++
    })
    const report = await runHeldSweeperTeardown({
      composition: value.composition,
      graph: value.graph,
      db: value.db,
      loop,
      teardown: () => value.close(),
    })
    expectQuiescedTeardown(report)
    expect(report.sweeperIndex!).toBeLessThan(report.counts.length - 1)
    expect(trailing).toBe(1)
  }, 120_000)

  test('a held upload-sweeper tick behind an earlier rejecting and throwing cleanup still quiesces before DB close', async () => {
    const { value, loop } = await bootHeld()
    value.composition.realmode_cleanups!.unshift(
      async () => {
        throw new Error('injected-reject')
      },
      () => {
        throw new Error('injected-throw')
      },
    )
    const report = await runHeldSweeperTeardown({
      composition: value.composition,
      graph: value.graph,
      db: value.db,
      loop,
      teardown: () => value.close(),
    })
    expectQuiescedTeardown(report)
    expect(report.trace.indexOf('cleanup:0:reject')).toBeGreaterThanOrEqual(0)
    expect(report.trace.indexOf('cleanup:1:reject')).toBeGreaterThan(report.trace.indexOf('cleanup:0:reject'))
    expect(report.trace.indexOf('loop:stop-entered')).toBeGreaterThan(report.trace.indexOf('cleanup:1:reject'))
    expect(report.sweeperIndex!).toBeGreaterThan(1)
  }, 120_000)

  test('settled control: idle loops, a rejecting and a throwing cleanup still tear down in order, once each', async () => {
    const f = (fixture = await bootComposed())
    const cleanups = f.composition.realmode_cleanups!
    expect(cleanups.length).toBeGreaterThan(0)
    const counts = cleanups.map(() => 0)
    for (let i = 0; i < cleanups.length; i++) {
      const original = cleanups[i]!
      cleanups[i] = () => {
        counts[i] = (counts[i] ?? 0) + 1
        return original()
      }
    }
    let rejected = 0
    let thrown = 0
    let trailing = 0
    let trailingSawOpenDb = false
    cleanups.unshift(
      () => {
        rejected++
        // Pre-handled, so no teardown shape produces an unhandled rejection.
        const p = Promise.reject(new Error('cleanup-boom'))
        p.catch(() => {})
        return p
      },
      () => {
        thrown++
        throw new Error('cleanup-sync-boom')
      },
    )
    cleanups.push(() => {
      trailing++
      f.db.raw().query('SELECT 1').get()
      trailingSawOpenDb = true
    })

    const result = await runTracedTeardown({ graph: f.graph, db: f.db, teardown: () => f.close() })

    expect(result.teardownError).toBeNull()
    expect(result.trace).toEqual(['graph:shutdown', 'db:close', 'teardown:settled'])
    expect(result.dbClosedAfter).toBe(true)
    expect(rejected).toBe(1)
    expect(thrown).toBe(1)
    expect(trailing).toBe(1)
    expect(trailingSawOpenDb).toBe(true)
    expect(counts).toEqual(counts.map(() => 1))
    expect(f.composition.loop_registry?.get(SWEEPER_LOOP_NAME)?.isActive?.()).toBe(false)
  }, 120_000)

  test('empty cleanups still shut the graph down and close the DB', async () => {
    const events: string[] = []
    await teardownComposedFixture({
      cleanups: [],
      graph: { shutdown: async () => events.push('graph.shutdown') },
      db: { close: () => events.push('db.close') },
    })
    expect(events).toEqual(['graph.shutdown', 'db.close'])
  })

  test('source guard: the coverage fixture tears down through the helper, not a cleanup loop', () => {
    const source = readFileSync(COVERAGE_FIXTURE, 'utf8')
    expect(source.includes('await teardownComposedFixture(')).toBe(true)
    expect(OLD_LOOP.test(source)).toBe(false)
  })

  test('source guard positive control: the old loop shape IS matched', () => {
    const oldLoop = [
      'for (const cleanup of composition.realmode_cleanups ?? []) {',
      '  try {',
      '    cleanup()',
      '  } catch {',
      '    /* best-effort */',
      '  }',
      '}',
    ].join('\n')
    expect(OLD_LOOP.test(oldLoop)).toBe(true)
  })
})
