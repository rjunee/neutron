/**
 * Self-test for the held-sweeper teardown harness: against a REAL Open
 * composer + production graph, the harness must DISTINGUISH a teardown that
 * awaits the production drain before closing the DB from the two broken shapes
 * the integration fixtures are being moved off:
 *   (a) `await drainRealmodeCleanups` → graph shutdown → db close  — clean;
 *   (b) the old unawaited `try { c() }` loop → graph shutdown → db close — the
 *       harness observes the graph shut down while the tick is held;
 *   (c) db close moved BEFORE an awaited drain — the harness observes the DB
 *       closed while the tick is held, and the real write failing.
 * Case (d) exercises the `graphShutdownOrder: 'before-drain'` opt-in: production's
 * own order (graph shutdown first, then the awaited drain) is clean under it.
 * Cases (b) and (c) EXPECT the violation: they prove the harness can see it, so a
 * clean report from a consumer fixture means something.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from './test-isolation.ts'
import { seedMigratedDb } from './migrated-db.ts'
import {
  bootCapturingSweeperLoop,
  finalOrderViolations,
  runHeldSweeperTeardown,
  type HeldTeardownReport,
} from './held-sweeper-teardown.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { drainRealmodeCleanups } from '@neutronai/gateway/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

let home: IsolatedHome
/** Safety net: a stack whose harness run never started its teardown. */
let leftover: (() => Promise<void>) | null = null

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-held-sweeper',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
    },
  })
})

afterEach(async () => {
  const pending = leftover
  leftover = null
  if (pending !== null) await pending().catch(() => {})
  home.restore()
})

function cannedSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'ok' }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
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

async function bootStack() {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const { value, loop } = await bootCapturingSweeperLoop(async () => {
    const composer = buildOpenGraphComposer({
      env: process.env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      substrateFactory: (() => cannedSubstrate()) as any,
    })
    const composition = await composer({ db, project_slug: 'owner' })
    const graph = await composeProductionGraph(composition)
    leftover = async () => {
      await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
      await graph.shutdown()
      db.close()
    }
    return { composition, graph }
  })
  return { db, loop, ...value }
}

function expectCleanTick(report: HeldTeardownReport): void {
  expect(report.write.changed).toBe(true)
  expect(report.write.statusAfterWrite).toBe('expired')
  expect(report.write.error).toBeNull()
}

describe('held-sweeper teardown harness — discriminates awaited drain from early DB close', () => {
  test('(a) awaited production drain, then graph shutdown, then db close → clean report', async () => {
    const { db, loop, composition, graph } = await bootStack()
    const report = await runHeldSweeperTeardown({
      composition,
      graph,
      db,
      loop,
      teardown: async () => {
        await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
        await graph.shutdown()
        db.close()
      },
    })
    leftover = null
    expect(report.whileHeldViolations).toEqual([])
    expect(report.loopActiveBefore).toBe(true)
    expect(report.loopRunningWhileHeld).toBe(true)
    expect(report.teardownSettledWhileHeld).toBe(false)
    expect(report.dbStatusWhileHeld).toBe('uploading')
    expectCleanTick(report)
    expect(report.tickResult).toEqual({ ran: true, skipped: false })
    expect(finalOrderViolations(report)).toEqual([])
    expect(report.loopActiveAfter).toBe(false)
    expect(report.dbClosedAfter).toBe(true)
    expect(report.counts.length).toBeGreaterThan(0)
    expect(report.counts.every((n) => n === 1)).toBe(true)
    expect(report.unhandledRejections).toEqual([])
  }, 45_000)

  test('(b) the old unawaited synchronous cleanup loop → harness OBSERVES graph shutdown while held', async () => {
    const { db, loop, composition, graph } = await bootStack()
    const report = await runHeldSweeperTeardown({
      composition,
      graph,
      db,
      loop,
      teardown: async () => {
        for (const c of composition.realmode_cleanups ?? []) {
          try {
            void c()
          } catch {
            /* the pre-change fixture shape */
          }
        }
        await graph.shutdown()
        db.close()
      },
    })
    leftover = null
    expect(report.whileHeldViolations).toContain('graph:shutdown while the tick was held')
    expect(report.whileHeldViolations.some((v) => /^cleanup:\d+:enter while the tick was held$/.test(v))).toBe(true)
    expect(finalOrderViolations(report)).not.toEqual([])
  }, 45_000)

  test('(c) db close moved before an awaited drain → harness OBSERVES the close and the failed write', async () => {
    const { db, loop, composition, graph } = await bootStack()
    const report = await runHeldSweeperTeardown({
      composition,
      graph,
      db,
      loop,
      teardown: async () => {
        db.close()
        await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
        await graph.shutdown()
      },
    })
    leftover = null
    expect(report.whileHeldViolations).toContain('db:close while the tick was held')
    expect(report.dbReadErrorWhileHeld).not.toBeNull()
    // The sweeper swallows the DB error, so the tick still "completes" — only
    // the recorded write outcome exposes the lost write.
    expect(report.tickResult).toEqual({ ran: true, skipped: false })
    expect(report.write.changed).not.toBe(true)
    expect(report.write.error).not.toBeNull()
  }, 45_000)

  test("(d) production's order (graph shutdown, THEN awaited drain, then db close) is clean only when opted into", async () => {
    const { db, loop, composition, graph } = await bootStack()
    const report = await runHeldSweeperTeardown({
      composition,
      graph,
      db,
      loop,
      graphShutdownOrder: 'before-drain',
      teardown: async () => {
        await graph.shutdown()
        await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
        db.close()
      },
    })
    leftover = null
    expect(report.graphShutdownOrder).toBe('before-drain')
    expect(report.whileHeldViolations).toEqual([])
    expect(report.teardownSettledWhileHeld).toBe(false)
    expect(report.dbStatusWhileHeld).toBe('uploading')
    expectCleanTick(report)
    expect(finalOrderViolations(report)).toEqual([])
    expect(report.dbClosedAfter).toBe(true)
    // The same trace judged by the fixtures' default order IS flagged.
    expect(finalOrderViolations({ ...report, graphShutdownOrder: 'after-drain' })).toContain(
      'loop:stop-settled after graph:shutdown',
    )
  }, 45_000)
})
