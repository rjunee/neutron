/**
 * The route-slot coverage fixture must not close SQLite under a running loop tick.
 *
 * `route-slot-coverage.test.ts` boots the real Open composition and tears it down
 * through `teardownComposedFixture`. The composition registers async
 * `realmode_cleanups`; the chunked-upload sweeper's cleanup is a quiescing
 * `stop()` that waits for an in-flight tick. Calling those cleanups without
 * awaiting them, then shutting the graph down and closing the database, lets the
 * database close while that tick is still writing.
 *
 * WHY THE UPLOAD SWEEPER. A standalone synthetic loop, or a deferred callback
 * appended to the cleanup list, would only prove the helper awaits something.
 * This file holds a tick of a loop the composer actually registers, on the
 * composer's own cleanup path: the sweeper is built by the Open upload wiring,
 * listed in the loop registry as `chunked-upload-sweeper`, and its `stop()` is
 * the cleanup the wiring pushes. Its tick does a real SQL transaction
 * (`markExpired`) on a seeded expired row. The sweeper catches `markExpired`
 * errors, so a finished tick proves nothing on its own; the write's outcome is
 * recorded and asserted.
 *
 * Progress is observed through ordered events and explicit barriers. The only
 * waits are on deferreds and microtask yields; nothing here measures time.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { SqliteUploadSessionStore } from '@neutronai/gateway/upload/upload-session-store.ts'
import { ChunkedUploadSweeper } from '@neutronai/gateway/upload/chunked-upload-sweeper.ts'
import { SupervisedLoop } from '@neutronai/loop'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import { teardownComposedFixture } from './route-slot-fixture-teardown.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const SWEEPER_LOOP = 'chunked-upload-sweeper'
const SEEDED_ID = 'route-quiesce-expired'

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

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

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

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
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

interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * Boot the real Open composer and production graph, capturing the
 * `SupervisedLoop` instance behind the composed upload sweeper.
 */
async function bootComposed(): Promise<{
  db: ProjectDb
  composition: Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  sweeperLoop: SupervisedLoop
}> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH'] as string)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH'] as string)
  const captured: SupervisedLoop[] = []
  const realStart = SupervisedLoop.prototype.start
  SupervisedLoop.prototype.start = function patchedStart(this: SupervisedLoop): void {
    if ((this as unknown as { name: string }).name === SWEEPER_LOOP) captured.push(this)
    return realStart.call(this)
  }
  let composition
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
  } finally {
    SupervisedLoop.prototype.start = realStart
  }
  expect(captured).toHaveLength(1)
  const graph = await composeProductionGraph(composition)
  return { db, composition, graph, sweeperLoop: captured[0] as SupervisedLoop }
}

/**
 * Wrap every registered cleanup in place, in order, with a call counter that
 * returns the original's result unchanged.
 */
function countCleanups(cleanups: Array<() => void | Promise<void>>): number[] {
  const counts: number[] = cleanups.map(() => 0)
  for (let i = 0; i < cleanups.length; i++) {
    const original = cleanups[i] as () => void | Promise<void>
    cleanups[i] = () => {
      counts[i] = (counts[i] ?? 0) + 1
      return original()
    }
  }
  return counts
}

/**
 * A cleanup that REJECTS, with its rejection pre-handled. The drain still
 * observes the rejection when it awaits; a synchronous loop that drops the
 * promise produces no unhandled rejection.
 */
function rejectingCleanup(calls: { n: number }): () => Promise<void> {
  return () => {
    calls.n++
    const p = Promise.reject(new Error('cleanup-boom'))
    p.catch(() => {})
    return p
  }
}

const OLD_LOOP = /for\s*\(\s*const\s+\w+\s+of\s+composition\.realmode_cleanups/

describe('route-slot fixture teardown quiesces composed loops before closing SQLite', () => {
  test('a held upload-sweeper tick keeps graph shutdown and DB close waiting until it settles', async () => {
    const { db, composition, graph, sweeperLoop } = await bootComposed()
    const events: string[] = []
    const entered = deferred()
    const release = deferred()
    const stopCalled = deferred()
    const realMarkExpired = SqliteUploadSessionStore.prototype.markExpired
    const realStop = ChunkedUploadSweeper.prototype.stop
    SqliteUploadSessionStore.prototype.markExpired = async function heldMarkExpired(
      this: SqliteUploadSessionStore,
      upload_id: string,
    ): Promise<boolean> {
      if (upload_id !== SEEDED_ID) return realMarkExpired.call(this, upload_id)
      events.push('markExpired:entered')
      entered.resolve()
      await release.promise
      try {
        const result = await realMarkExpired.call(this, upload_id)
        events.push(`markExpired:${String(result)}`)
        return result
      } catch (err) {
        events.push('markExpired:failed')
        throw err
      }
    }
    ChunkedUploadSweeper.prototype.stop = function recordedStop(this: ChunkedUploadSweeper): Promise<void> {
      events.push('sweeper.stop')
      stopCalled.resolve()
      return realStop.call(this)
    }
    let tick: Promise<unknown> | null = null
    let tornDown = false
    try {
      // Premise: the composed sweeper loop is live, and the seeded row is one
      // its scan picks up (with no expired row the tick returns before writing).
      expect(composition.loop_registry?.get(SWEEPER_LOOP)?.isActive?.()).toBe(true)
      await new SqliteUploadSessionStore(db).create({
        upload_id: SEEDED_ID,
        project_slug: 'owner',
        source: 'chatgpt',
        filename: 'synthetic.zip',
        total_bytes: 10,
        mime_type: 'application/zip',
        created_at: 0,
        expires_at: 1,
      })
      const expired = await new SqliteUploadSessionStore(db).listExpiredUploading(Date.now(), 10)
      expect(expired.map((r) => r.upload_id)).toContain(SEEDED_ID)

      const cleanups = composition.realmode_cleanups ?? []
      expect(cleanups.length).toBeGreaterThan(0)
      const counts = countCleanups(cleanups)
      const rejected = { n: 0 }
      cleanups.unshift(rejectingCleanup(rejected))

      // Drive one real loop tick and hold it inside the DB write.
      tick = sweeperLoop.runOnce()
      await entered.promise

      let settled = false
      const tearing = teardownComposedFixture({
        cleanups: composition.realmode_cleanups,
        graph: {
          shutdown: async () => {
            events.push('graph.shutdown')
            return graph.shutdown()
          },
        },
        db: {
          close: () => {
            events.push('db.close')
            db.close()
          },
        },
      }).then(() => {
        settled = true
      })
      tornDown = true

      // Wait for the sweeper's cleanup to be reached, then yield once.
      await stopCalled.promise
      await Promise.resolve()

      // THE DISCRIMINANT: the tick is held, so teardown must not have moved on.
      expect(events).not.toContain('graph.shutdown')
      expect(events).not.toContain('db.close')
      expect(settled).toBe(false)
      // The database is still open and the row is untouched while the tick waits.
      const held = db.get<{ status: string }, [string]>(
        'SELECT status FROM upload_sessions WHERE upload_id = ?',
        [SEEDED_ID],
      )
      expect(held?.status).toBe('uploading')

      release.resolve()
      await tearing

      expect(settled).toBe(true)
      expect(events).not.toContain('markExpired:failed')
      const wrote = events.indexOf('markExpired:true')
      const shut = events.indexOf('graph.shutdown')
      const closed = events.indexOf('db.close')
      expect(wrote).toBeGreaterThanOrEqual(0)
      expect(shut).toBeGreaterThan(wrote)
      expect(closed).toBeGreaterThan(shut)
      expect(composition.loop_registry?.get(SWEEPER_LOOP)?.isActive?.()).toBe(false)
      expect(rejected.n).toBe(1)
      expect(counts.every((c) => c === 1)).toBe(true)
    } finally {
      release.resolve()
      if (tick !== null) await tick
      SqliteUploadSessionStore.prototype.markExpired = realMarkExpired
      ChunkedUploadSweeper.prototype.stop = realStop
      if (!tornDown) {
        try {
          await graph.shutdown()
        } catch {
          /* best-effort */
        }
        try {
          db.close()
        } catch {
          /* best-effort */
        }
      }
    }
  }, 120_000)

  test('settled control: idle loops, a rejecting and a throwing cleanup still tear down in order, once each', async () => {
    const { db, composition, graph } = await bootComposed()
    const events: string[] = []
    const cleanups = composition.realmode_cleanups ?? []
    expect(cleanups.length).toBeGreaterThan(0)
    const counts = countCleanups(cleanups)
    const rejected = { n: 0 }
    let thrown = 0
    let after = 0
    cleanups.unshift(() => {
      thrown++
      throw new Error('cleanup-sync-boom')
    })
    cleanups.unshift(rejectingCleanup(rejected))
    cleanups.push(() => {
      after++
      events.push('after-rejection')
    })

    await teardownComposedFixture({
      cleanups: composition.realmode_cleanups,
      graph: {
        shutdown: async () => {
          events.push('graph.shutdown')
          return graph.shutdown()
        },
      },
      db: {
        close: () => {
          events.push('db.close')
          db.close()
        },
      },
    })

    expect(events).toEqual(['after-rejection', 'graph.shutdown', 'db.close'])
    expect(rejected.n).toBe(1)
    expect(thrown).toBe(1)
    expect(after).toBe(1)
    expect(counts.every((c) => c === 1)).toBe(true)
    expect(composition.loop_registry?.get(SWEEPER_LOOP)?.isActive?.()).toBe(false)
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
    const source = readFileSync(new URL('./route-slot-coverage.test.ts', import.meta.url), 'utf8')
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
