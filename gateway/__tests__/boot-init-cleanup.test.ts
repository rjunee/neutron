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
import { ProjectDb } from '@neutronai/persistence/index.ts'
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
})
