/**
 * Sprint 19 Phase 1 — boot init-failure cleanup tests.
 *
 * Per `docs/plans/2026-05-05-002-feat-sprint-19-wiring-wiring-plan.md`
 * § Boot init cleanup (P2 race fix). When the composer or
 * `composeProductionGraph` throws, `boot()` MUST release the open SQLite
 * handle (`db.close()`) and shutdown any partially-composed graph
 * (`graph?.shutdown()`) before re-throwing — without this a systemd
 * Restart=always loop races a still-open SQLite handle + dangling timers.
 *
 * Strategy:
 *   - Spy on `ProjectDb.prototype.close` so we can assert it ran in the
 *     init-failure path even though `boot()` never returns a handle.
 *   - For the "graph throws" branch we drive `composeProductionGraph` to
 *     reject by supplying a composer that returns garbage (a plain object
 *     missing required fields, observed through a thrown error inside
 *     module init). Easiest reproducer: a `topic_handler` that itself
 *     throws is NOT enough (the handler is only called on inbound events,
 *     which compose doesn't do). The simplest reliable shape is to have
 *     the composer itself throw AFTER opening the DB (covered by
 *     "composer throws" — same cleanup path runs). For graph-side throws
 *     we lean on a rejection from the second async hop: pass a
 *     `topic_handler` that's syntactically a function but supply a broken
 *     `connect_api.handlers` shape that causes the cross-instance
 *     server import + handler build to throw at the boot-side
 *     post-compose step. That throw lands inside the same try block and
 *     hits the same cleanup.
 *
 *   - Success path: confirm the cleanup spy was NOT called during the
 *     normal boot path (it IS called once on shutdown, but only after
 *     `boot()` returns).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../index.ts'
import {
  ProjectDb,
  emitSystemEvent,
  registerSystemEventSink,
  resolveSystemEventSink,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop()!, { recursive: true, force: true })
  }
  delete process.env['OWNER_HOME']
  delete process.env['NEUTRON_DB_PATH']
  delete process.env['NEUTRON_INSTANCE_SLUG']
  delete process.env['NOTIFY_SOCKET']
})

interface CloseSpy {
  calls: number
  restore: () => void
}

/** Patch `ProjectDb.prototype.close` so callers can assert close was invoked. */
function spyProjectDbClose(): CloseSpy {
  const original = ProjectDb.prototype.close
  const spy: CloseSpy = {
    calls: 0,
    restore: () => {
      ProjectDb.prototype.close = original
    },
  }
  ProjectDb.prototype.close = function patched(this: ProjectDb): void {
    spy.calls++
    return original.call(this)
  }
  return spy
}

let activeSpy: CloseSpy | null = null
beforeEach(() => {
  activeSpy = null
})
afterEach(() => {
  if (activeSpy !== null) activeSpy.restore()
  activeSpy = null
})

describe('boot init-failure cleanup', () => {
  test('composer throws → db.close() is called before re-throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-boot-cleanup-composer-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    activeSpy = spyProjectDbClose()
    const closeSpy = activeSpy

    await expect(
      boot({
        port: 0,
        composer: async () => {
          throw new Error('composer-boom')
        },
      }),
    ).rejects.toThrow('composer-boom')

    // db.close ran exactly once during init-failure cleanup. Graph was
    // never composed (composer threw first), so graph.shutdown isn't
    // observable here — the next test covers the graph-throw branch.
    expect(closeSpy.calls).toBe(1)
  })

  test('composeProductionGraph throws → db.close() is called before re-throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-boot-cleanup-graph-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    activeSpy = spyProjectDbClose()
    const closeSpy = activeSpy

    // Drive a throw from inside `composeProductionGraph` by attaching a
    // throwing GETTER to `topic_handler`. The `channels` module's `init`
    // dereferences `input.topic_handler` during compose — the getter
    // fires there and the module-graph compose loop propagates the
    // throw, satisfying the "graph throws mid-compose" branch without
    // smuggling in an obviously-invalid runtime type.
    //
    // Note: `graph` is still null at the catch block because the
    // `graph = await composeProductionGraph(...)` assignment only runs
    // after the Promise resolves — so `graph?.shutdown()` is a no-op in
    // this branch (the user's instruction confirms this). The
    // load-bearing assertion is just `db.close()` ran.
    const composer = ({
      db,
      project_slug,
    }: {
      db: import('@neutronai/persistence/index.ts').ProjectDb
      project_slug: string
    }): import('../composition.ts').CompositionInput => {
      const input: import('../composition.ts').CompositionInput = {
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      }
      Object.defineProperty(input, 'topic_handler', {
        get(): never {
          throw new Error('graph-compose-boom')
        },
      })
      return input
    }

    await expect(boot({ port: 0, composer })).rejects.toThrow('graph-compose-boom')

    // db.close ran in the catch block. graph?.shutdown is a no-op here
    // (graph is still null because `graph = await composeProductionGraph
    // (...)` never finished assigning).
    expect(closeSpy.calls).toBe(1)
  })

  test('successful boot → db.close() is NOT called during boot itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-boot-cleanup-success-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    activeSpy = spyProjectDbClose()
    const closeSpy = activeSpy

    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      }),
    })
    try {
      // Boot returned without throwing → cleanup path was NOT taken.
      expect(closeSpy.calls).toBe(0)

      // Sanity: the listener is reachable + /healthz works.
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
      expect(res.status).toBe(200)
    } finally {
      // Normal shutdown DOES close the db — this is the post-boot path,
      // not the init-failure cleanup path. After this call closeSpy
      // should be 1; we don't assert that to keep the test focused on
      // the init-failure invariant.
      await handle.shutdown()
    }
  })

  test('§F1 shutdown awaits an async realmode_cleanup before db.close(), and tolerates a rejecting one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-boot-f1-cleanup-'))
    cleanups.push(root)
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']

    // Record the ORDER of cleanup markers vs db.close() by spying close.
    const order: string[] = []
    const original = ProjectDb.prototype.close
    activeSpy = {
      calls: 0,
      restore: () => {
        ProjectDb.prototype.close = original
      },
    }
    const spy = activeSpy
    ProjectDb.prototype.close = function patched(this: ProjectDb): void {
      spy.calls++
      order.push('db.close')
      return original.call(this)
    }

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const handle = await boot({
      port: 0,
      composer: ({ db, project_slug }) => ({
        db,
        project_slug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
        platform: STUB_PLATFORM,
        realmode_cleanups: [
          async () => {
            await gate
            order.push('async-cleanup')
          },
          () => {
            // A rejecting cleanup must NOT stop later cleanups or db.close().
            throw new Error('mid-cleanup-boom')
          },
          () => {
            order.push('after-throw')
          },
        ],
      }),
    })

    let done = false
    const shutdownP = handle.shutdown().then(() => {
      done = true
    })
    // While the async cleanup is gated, shutdown cannot finish → db.close() not reached.
    await new Promise((r) => setTimeout(r, 25))
    expect(done).toBe(false)
    expect(order).not.toContain('db.close')

    release()
    // Bound so a regression (db.close before cleanups, or a rejecting cleanup
    // aborting the drain) surfaces as a failure, not a hang.
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000))
    const raced = await Promise.race([shutdownP.then(() => 'done' as const), timeout])
    expect(raced).toBe('done')
    expect(done).toBe(true)
    // db.close() ran strictly AFTER the async cleanup finished and after the
    // later cleanup ran despite the middle one throwing.
    expect(order).toEqual(['async-cleanup', 'after-throw', 'db.close'])
  })
})

describe('O4 — boot manages the ambient system_events sink lifecycle', () => {
  afterEach(() => registerSystemEventSink(null))

  function bootEnv(root: string): void {
    process.env['NEUTRON_DB_PATH'] = join(root, 'owner.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']
  }

  const goodComposer = ({
    db,
    project_slug,
  }: {
    db: import('@neutronai/persistence/index.ts').ProjectDb
    project_slug: string
  }): import('../composition.ts').CompositionInput => ({
    db,
    project_slug,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  })

  test('registers a sink on boot and CLEARS it on shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-'))
    cleanups.push(root)
    bootEnv(root)
    registerSystemEventSink(null)

    const handle = await boot({ port: 0, composer: goodComposer })
    // Boot registered the journal sink.
    expect(resolveSystemEventSink()).not.toBeNull()
    await handle.shutdown()
    // Shutdown cleared the owned sink before closing the DB.
    expect(resolveSystemEventSink()).toBeNull()
  })

  test('CLEARS the sink on init failure (composer throws)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-fail-'))
    cleanups.push(root)
    bootEnv(root)
    registerSystemEventSink(null)

    await expect(
      boot({
        port: 0,
        composer: async () => {
          throw new Error('composer-boom')
        },
      }),
    ).rejects.toThrow('composer-boom')
    expect(resolveSystemEventSink()).toBeNull()
  })

  test('CLEARS the sink + closes the DB + stops the listener on a POST-bind init failure', async () => {
    // Exercises the guard around all initialization AFTER sink registration:
    // the listener binds, then `sdNotify('READY=1')` throws (a bogus
    // NOTIFY_SOCKET makes sendto() fail) BEFORE a BootHandle is returned. This
    // is the same guarded region a bindHttpListener rejection lands in, and it
    // additionally proves the already-bound listener is stopped.
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-postbind-'))
    cleanups.push(root)
    bootEnv(root)
    process.env['NOTIFY_SOCKET'] = join(root, 'nonexistent', 'bogus.sock')
    registerSystemEventSink(null)

    activeSpy = spyProjectDbClose()
    const closeSpy = activeSpy
    await expect(boot({ port: 0, composer: goodComposer })).rejects.toThrow(/sd_notify/)
    // Guard ran: sink cleared, DB closed (listener stop is best-effort + logged).
    expect(resolveSystemEventSink()).toBeNull()
    expect(closeSpy.calls).toBe(1)
  })

  test('POST-bind failure STOPS the already-bound listener (port becomes rebindable)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-portstop-'))
    cleanups.push(root)
    bootEnv(root)
    // Grab a free port, release it, then pin boot to it so we can prove the
    // listener was stopped (the port is rebindable afterwards).
    const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') })
    const port = probe.port
    await probe.stop(true)
    if (port === undefined) throw new Error('probe did not bind a port')

    process.env['NOTIFY_SOCKET'] = join(root, 'nonexistent', 'bogus.sock')
    registerSystemEventSink(null)
    // boot binds `port`, then sdNotify('READY=1') throws → boundServerRef.stop()
    // releases the socket before the error propagates.
    await expect(boot({ port, composer: goodComposer })).rejects.toThrow(/sd_notify/)

    // Proof the listener was stopped: the port rebinds cleanly.
    const rebind = Bun.serve({ port, fetch: () => new Response('rebound') })
    expect(rebind.port).toBe(port)
    await rebind.stop(true)
  })

  test('the PORT-ASSERTION failure STOPS the raw bound listener (the leak coordinator-Codex found)', async () => {
    // The `server.port === undefined` assertion throws BEFORE the graceful
    // `boundServer` wrapper is built. Before the fix, the catch's stop guard
    // referenced a ref that wasn't set yet → the open socket leaked. Force
    // Bun.serve to return a port-undefined server (a stoppable stub) and assert
    // boot throws AND the raw server's stop() was called.
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-portassert-'))
    cleanups.push(root)
    bootEnv(root)
    delete process.env['NOTIFY_SOCKET']
    registerSystemEventSink(null)

    const bunMut = Bun as unknown as { serve: (...args: unknown[]) => unknown }
    const origServe = bunMut.serve
    let stopCalls = 0
    bunMut.serve = () => ({
      port: undefined, // trips the `server.port === undefined` assertion
      stop: (_force?: boolean): void => {
        stopCalls += 1
      },
    })
    activeSpy = spyProjectDbClose()
    const closeSpy = activeSpy
    try {
      await expect(boot({ port: 0, composer: goodComposer })).rejects.toThrow(/did not bind a port/)
      // The raw listener was stopped (NOT leaked), and the shared cleanup ran.
      expect(stopCalls).toBe(1)
      expect(closeSpy.calls).toBe(1)
      expect(resolveSystemEventSink()).toBeNull()
    } finally {
      bunMut.serve = origServe
    }
  })

  test('ownership-guarded: shutdown does NOT clobber a sibling sink registered after boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-own-'))
    cleanups.push(root)
    bootEnv(root)
    registerSystemEventSink(null)

    const handle = await boot({ port: 0, composer: goodComposer })
    // A sibling (later boot / test) overwrites the ambient sink.
    const sibling: SystemEventSink = { record: () => ({ id: 'sibling' }) }
    registerSystemEventSink(sibling)
    await handle.shutdown()
    // The owned-clear only fires when the ambient sink is still ours → the
    // sibling survives.
    expect(resolveSystemEventSink()).toBe(sibling)
  })

  function countSystemEvents(db: ProjectDb): number {
    const r = db.get<{ n: number }, []>('SELECT COUNT(*) AS n FROM system_events', [])
    return r?.n ?? 0
  }

  test('PRODUCTION invariant (single boot): a degrade emit lands in THAT boot\'s DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-route-'))
    cleanups.push(root)
    bootEnv(root)
    registerSystemEventSink(null)

    const handle = await boot({ port: 0, composer: goodComposer })
    try {
      // Simulate a degrade site firing through the ambient registry. `await`
      // resolves after the write, so no drain race in the assertion.
      await emitSystemEvent({ event: 'gbrain_unavailable', project_slug: 'alice' })
      expect(countSystemEvents(handle.db)).toBe(1)
      const row = handle.db.get<{ event_name: string; project_slug: string | null }, []>(
        'SELECT event_name, project_slug FROM system_events LIMIT 1',
        [],
      )
      expect(row).toMatchObject({ event_name: 'gbrain_unavailable', project_slug: 'alice' })
    } finally {
      await handle.shutdown()
    }
  })

  test('overlapping boots (TEST-ONLY): emits route to the NEWEST live boot (documented process-global semantics)', async () => {
    // Not a production path (single-owner = one boot/process). This pins the
    // DOCUMENTED behavior so it is intentional + covered, not a hidden surprise:
    // while two boots are live, the ambient registry routes to the top of stack.
    const rootA = mkdtempSync(join(tmpdir(), 'neutron-o4-rA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'neutron-o4-rB-'))
    cleanups.push(rootA, rootB)
    registerSystemEventSink(null)

    bootEnv(rootA)
    const handleA = await boot({ port: 0, composer: goodComposer })
    bootEnv(rootB)
    const handleB = await boot({ port: 0, composer: goodComposer })
    try {
      await emitSystemEvent({ event: 'gbrain_unavailable', project_slug: 'alice' })
      // Newest boot (B) owns the ambient journal while both are live.
      expect(countSystemEvents(handleB.db)).toBe(1)
      expect(countSystemEvents(handleA.db)).toBe(0)
    } finally {
      await handleB.shutdown()
      await handleA.shutdown()
    }
  })

  test('overlapping boots, newest-first shutdown: B restores A instead of orphaning it', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-A-'))
    const rootB = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-B-'))
    cleanups.push(rootA, rootB)
    registerSystemEventSink(null)

    bootEnv(rootA)
    const handleA = await boot({ port: 0, composer: goodComposer })
    const sinkA = resolveSystemEventSink()
    expect(sinkA).not.toBeNull()

    bootEnv(rootB)
    const handleB = await boot({ port: 0, composer: goodComposer })
    const sinkB = resolveSystemEventSink()
    expect(sinkB).not.toBe(sinkA)

    // Newest-first: B shuts down → RESTORES A (does not null the registry), so
    // A's still-live degrade journal keeps working.
    await handleB.shutdown()
    expect(resolveSystemEventSink()).toBe(sinkA)

    // Then A shuts down → restores the pre-A sink (null here).
    await handleA.shutdown()
    expect(resolveSystemEventSink()).toBeNull()
  })

  test('overlapping boots, OLDEST-first shutdown: A removes itself, B stays live (no stale-DB sink)', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-oa-'))
    const rootB = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-ob-'))
    cleanups.push(rootA, rootB)
    registerSystemEventSink(null)

    bootEnv(rootA)
    const handleA = await boot({ port: 0, composer: goodComposer })
    const sinkA = resolveSystemEventSink()

    bootEnv(rootB)
    const handleB = await boot({ port: 0, composer: goodComposer })
    const sinkB = resolveSystemEventSink()

    // Oldest-first: A shuts down + closes ITS db → the stack drops A but keeps
    // B on top (B's DB is still open). The resolver must NOT surface A's now-
    // stale sink.
    await handleA.shutdown()
    expect(resolveSystemEventSink()).toBe(sinkB)
    expect(resolveSystemEventSink()).not.toBe(sinkA)

    // Then B shuts down → the stack empties.
    await handleB.shutdown()
    expect(resolveSystemEventSink()).toBeNull()
  })

  test('init-failure DRAINS realmode_cleanups (post-composition failure)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-sink-drain-'))
    cleanups.push(root)
    bootEnv(root)
    process.env['NOTIFY_SOCKET'] = join(root, 'nonexistent', 'bogus.sock')
    registerSystemEventSink(null)

    let cleanupRan = false
    await expect(
      boot({
        port: 0,
        composer: ({ db, project_slug }) => ({
          ...goodComposer({ db, project_slug }),
          realmode_cleanups: [
            () => {
              cleanupRan = true
            },
          ],
        }),
      }),
    ).rejects.toThrow(/sd_notify/)
    // The sd_notify('READY=1') failure is post-composition, so the wired cleanup
    // must have been drained by bootFailureCleanup.
    expect(cleanupRan).toBe(true)
    expect(resolveSystemEventSink()).toBeNull()
  })

  test('owner-slug resolution failure closes the DB and registers NO sink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-slug-'))
    cleanups.push(root)
    bootEnv(root)
    // `.url_slug` present but a DIRECTORY → readFileSync throws EISDIR inside
    // resolveOwnerSlugFromConfig, which runs BEFORE the sink is registered.
    process.env['OWNER_HOME'] = root
    mkdirSync(join(root, '.url_slug'))
    registerSystemEventSink(null)

    activeSpy = spyProjectDbClose()
    const closeSpy = activeSpy
    await expect(boot({ port: 0, composer: goodComposer })).rejects.toThrow()
    // DB opened then closed by the slug guard; sink never registered.
    expect(closeSpy.calls).toBe(1)
    expect(resolveSystemEventSink()).toBeNull()
  })

  test('migration failure closes the DB and registers NO sink (earliest post-open boundary)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-o4-migfail-'))
    cleanups.push(root)
    const dbPath = join(root, 'owner.db')
    // Pre-seed a `_migrations` table with a bogus schema (only `version`), so
    // the runner's `INSERT INTO _migrations (version, name, applied_at)` throws
    // ("no column named name") on the first unapplied migration.
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY)')
    seed.close()

    process.env['NEUTRON_DB_PATH'] = dbPath
    process.env['NEUTRON_INSTANCE_SLUG'] = 'alice'
    delete process.env['NOTIFY_SOCKET']
    registerSystemEventSink(null)

    activeSpy = spyProjectDbClose()
    const closeSpy = activeSpy
    await expect(boot({ port: 0, composer: goodComposer })).rejects.toThrow()
    // The migration guard closed the opened handle; the sink was never reached.
    expect(closeSpy.calls).toBe(1)
    expect(resolveSystemEventSink()).toBeNull()
  })

  test('repeated boot/shutdown does NOT accumulate SIGTERM/SIGINT listeners', async () => {
    const beforeTerm = process.listenerCount('SIGTERM')
    const beforeInt = process.listenerCount('SIGINT')

    for (let i = 0; i < 3; i += 1) {
      const root = mkdtempSync(join(tmpdir(), `neutron-o4-sig-${i}-`))
      cleanups.push(root)
      bootEnv(root)
      const handle = await boot({ port: 0, composer: goodComposer })
      await handle.shutdown()
    }
    // Manual shutdown removed each boot's listeners → back to baseline.
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm)
    expect(process.listenerCount('SIGINT')).toBe(beforeInt)
  })
})
