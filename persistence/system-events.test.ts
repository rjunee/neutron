import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from './db.ts'
import {
  SystemEventsStore,
  emitSystemEvent,
  emitSystemEventSafe,
  registerSystemEventSink,
  resolveSystemEventSink,
  type SystemEventSink,
} from './system-events.ts'

let tmp: string
let db: ProjectDb
let store: SystemEventsStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'system-events-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new SystemEventsStore({ db })
})

afterEach(() => {
  registerSystemEventSink(null)
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function countRows(): number {
  const r = db.get<{ n: number }, []>('SELECT COUNT(*) AS n FROM system_events', [])
  return r?.n ?? 0
}

describe('SystemEventsStore — persist + defaults', () => {
  it('inserts a row with the primitive columns + defaults (level=warn, module=system)', async () => {
    const { id } = await store.record({ event: 'gbrain_unavailable', ts: 100, payload: { reason: 'not_init' } })
    expect(id).toBeTruthy()
    const rows = store.listRecent(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      ts: 100,
      level: 'warn',
      module: 'system',
      event: 'gbrain_unavailable',
      payload: { reason: 'not_init' },
      project_slug: null,
    })
  })

  it('honors explicit level/module/project_slug/duration', async () => {
    await store.record({
      event: 'core_install_failed',
      module: 'cores',
      level: 'error',
      project_slug: 'casey',
      duration_ms: 42,
      ts: 200,
      payload: { core: 'weather' },
    })
    const rows = store.listRecent(10)
    expect(rows[0]).toMatchObject({
      level: 'error',
      module: 'cores',
      project_slug: 'casey',
      duration_ms: 42,
      event: 'core_install_failed',
    })
  })

  it('listRecent returns newest-first and respects the limit; <=0 => []', async () => {
    await store.record({ event: 'cron_job_error', ts: 1 })
    await store.record({ event: 'cron_job_error', ts: 2 })
    await store.record({ event: 'prewarm_failed', ts: 3 })
    const recent = store.listRecent(2)
    expect(recent.map((r) => r.ts)).toEqual([3, 2])
    expect(store.listRecent(0)).toEqual([])
    // event-name filter (serves the cron rising-edge dedup + O5 surface)
    const crons = store.listRecent(10, 'cron_job_error')
    expect(crons.map((r) => r.ts)).toEqual([2, 1])
  })
})

describe('SystemEventsStore.listRecentForScope — scope + limit boundaries (O5)', () => {
  const insert = (id: string, ts: number, project_slug: string | null): void => {
    db.runSync(
      `INSERT INTO system_events (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
       VALUES (?, ?, 'warn', 'm', 'cron_job_error', '{}', ?, NULL)`,
      [id, ts, project_slug],
    )
  }

  it('scopes to project_slug OR NULL; a foreign slug is never returned', () => {
    insert('a', 10, 'demo')
    insert('b', 20, null) // process-wide → included
    insert('c', 30, 'other') // foreign → excluded (even though newest)
    expect(store.listRecentForScope('demo', 50).map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('non-positive / non-finite limits return []', () => {
    insert('a', 10, 'demo')
    expect(store.listRecentForScope('demo', 0)).toEqual([])
    expect(store.listRecentForScope('demo', -5)).toEqual([])
    expect(store.listRecentForScope('demo', Number.NaN)).toEqual([])
    expect(store.listRecentForScope('demo', Number.POSITIVE_INFINITY)).toEqual([])
  })

  it('floors a fractional limit', () => {
    insert('a', 10, 'demo')
    insert('b', 20, 'demo')
    insert('c', 30, 'demo')
    expect(store.listRecentForScope('demo', 2.9)).toHaveLength(2) // floor(2.9) = 2
  })

  it('breaks equal-ts ties deterministically by id DESC', () => {
    insert('id-1', 100, 'demo')
    insert('id-2', 100, 'demo') // same ts
    expect(store.listRecentForScope('demo', 10).map((r) => r.id)).toEqual(['id-2', 'id-1'])
  })
})

describe('emitSystemEventSafe — NEVER throws / rejects', () => {
  it('no-op (resolves) when sink is null/undefined', async () => {
    await expect(emitSystemEventSafe(null, { event: 'gbrain_unavailable' })).resolves.toBeUndefined()
    await expect(emitSystemEventSafe(undefined, { event: 'gbrain_unavailable' })).resolves.toBeUndefined()
  })

  it('persists exactly one row through a real store on the degrade edge', async () => {
    expect(countRows()).toBe(0)
    await emitSystemEventSafe(store, { event: 'import_orphaned', ts: 5, payload: { job: 'j1' } })
    expect(countRows()).toBe(1)
  })

  it('swallows a SYNCHRONOUS throw from the sink (routes to onError)', async () => {
    let seen: unknown
    const throwing: SystemEventSink = {
      record() {
        throw new Error('sync boom')
      },
    }
    await expect(
      emitSystemEventSafe(throwing, { event: 'prewarm_failed' }, (e) => {
        seen = e
      }),
    ).resolves.toBeUndefined()
    expect((seen as Error).message).toBe('sync boom')
  })

  it('swallows an ASYNC rejection from the sink (routes to onError)', async () => {
    let seen: unknown
    const rejecting: SystemEventSink = {
      record() {
        return Promise.reject(new Error('async boom'))
      },
    }
    await expect(
      emitSystemEventSafe(rejecting, { event: 'prewarm_failed' }, (e) => {
        seen = e
      }),
    ).resolves.toBeUndefined()
    expect((seen as Error).message).toBe('async boom')
  })

  it('swallows even when onError ITSELF throws', async () => {
    const rejecting: SystemEventSink = {
      record() {
        return Promise.reject(new Error('boom'))
      },
    }
    await expect(
      emitSystemEventSafe(rejecting, { event: 'prewarm_failed' }, () => {
        throw new Error('handler boom')
      }),
    ).resolves.toBeUndefined()
  })

  it('the degrade path continues even if the write fails — emit is fire-and-forget', () => {
    // A degrade site does NOT await; it fires and continues. Assert the call
    // returns synchronously without throwing even against a throwing sink.
    const throwing: SystemEventSink = {
      record() {
        throw new Error('boom')
      },
    }
    let reached = false
    void emitSystemEventSafe(throwing, { event: 'credential_all_cooldown' })
    reached = true
    expect(reached).toBe(true)
  })
})

describe('SystemEventsStore — drain flushes fire-and-forget writes', () => {
  it('a fire-and-forget emit is durably written after drain() (no lost row at shutdown)', async () => {
    // Mirror the production path: fire WITHOUT awaiting (as degrade sites do),
    // then drain() — the row must be present before a subsequent db.close().
    void emitSystemEventSafe(store, { event: 'gbrain_unavailable', ts: 1 })
    expect(await store.drain()).toBeUndefined()
    expect(countRows()).toBe(1)
  })

  it('drain() resolves immediately when there are no in-flight writes', async () => {
    await expect(store.drain()).resolves.toBeUndefined()
    expect(countRows()).toBe(0)
  })

  it('drain() awaits MULTIPLE concurrent fire-and-forget writes', async () => {
    for (let i = 0; i < 5; i += 1) {
      void emitSystemEventSafe(store, { event: 'cron_job_error', ts: i })
    }
    await store.drain()
    expect(countRows()).toBe(5)
  })

  it('a REAL store write failure never produces an unhandled rejection', async () => {
    // Throwaway DB/store local to this test so closing it doesn't collide with
    // the shared afterEach teardown of `db`.
    const failDb = ProjectDb.open(join(tmp, 'fail.db'))
    applyMigrations(failDb.raw())
    const failStore = new SystemEventsStore({ db: failDb })

    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      // Close the DB so the next record()'s db.run rejects — the production
      // "degrade emitted just as the DB is torn down" boundary.
      failDb.close()
      // Fire-and-forget against the failing store (as degrade sites do).
      await expect(
        emitSystemEventSafe(failStore, { event: 'gbrain_unavailable' }),
      ).resolves.toBeUndefined()
      // drain() must also settle cleanly against the failed write.
      await expect(failStore.drain()).resolves.toBeUndefined()
      // Let any stray microtask-scheduled rejection surface.
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })
})

describe('ambient sink registry', () => {
  it('emitSystemEvent is a no-op when no sink is registered', async () => {
    registerSystemEventSink(null)
    expect(resolveSystemEventSink()).toBeNull()
    await expect(emitSystemEvent({ event: 'repl_session_capped' })).resolves.toBeUndefined()
    expect(countRows()).toBe(0)
  })

  it('emitSystemEvent routes through the registered sink', async () => {
    registerSystemEventSink(store)
    expect(resolveSystemEventSink()).toBe(store)
    await emitSystemEvent({ event: 'repl_session_capped', ts: 9 })
    expect(countRows()).toBe(1)
  })

  it('last registration wins; null clears', () => {
    const a: SystemEventSink = { record: () => ({ id: 'a' }) }
    const b: SystemEventSink = { record: () => ({ id: 'b' }) }
    registerSystemEventSink(a)
    expect(resolveSystemEventSink()).toBe(a)
    registerSystemEventSink(b)
    expect(resolveSystemEventSink()).toBe(b)
    registerSystemEventSink(null)
    expect(resolveSystemEventSink()).toBeNull()
  })
})

describe('existing gateway_events readers are undisturbed', () => {
  it('gateway_events + onboarding_metrics still exist alongside system_events', () => {
    const names = db
      .all<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('gateway_events','onboarding_metrics','system_events') ORDER BY name",
        [],
      )
      .map((r) => r.name)
    expect(names).toEqual(['gateway_events', 'onboarding_metrics', 'system_events'])
  })
})
