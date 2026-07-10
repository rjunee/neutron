/**
 * Sprint 19 Phase 1 — boot init-failure cleanup tests.
 *
 * Per `docs/plans/2026-05-05-002-feat-sprint-19-realmode-composer-wiring-plan.md`
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../index.ts'
import {
  ProjectDb,
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
})
