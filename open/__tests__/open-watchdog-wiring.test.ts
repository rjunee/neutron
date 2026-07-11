/**
 * Open supervision-watchdog prod-boot wiring (F4) — the anti-"built-but-not-
 * wired" gate for items (1) real heartbeat source and (4) real notifier.
 *
 * Boots the REAL Open composer and proves the composition it returns carries:
 *   1. a REAL heartbeat tracker (a `HeartbeatPulse` that advances ONLY when the
 *      gateway tick pulses it), NOT the never-stale `{ () => Date.now() }` stub —
 *      and an `on_gateway_tick` hook that pulses it.
 *   4. a REAL `watchdog_notifier` that emits a `watchdog_alert` `system_events`
 *      row (O4) and does not throw — NOT the `{ notify: async () => undefined }`
 *      no-op.
 *
 * Reverting either wiring in composer.ts turns this RED.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  SystemEventsStore,
  registerSystemEventSink,
  type SystemEventInput,
} from '@neutronai/persistence/system-events.ts'
import type { WatchdogAlert } from '@neutronai/watchdog/types.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

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
let tmpDir: string | undefined
let db: ProjectDb | undefined

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-wd-wiring-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-wd-wiring-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
})

afterEach(() => {
  registerSystemEventSink(null)
  // Guard teardown on successful setup — if setup threw (e.g. a sandbox that
  // rejects mkdtemp), `db`/`tmpDir` are undefined and an unguarded `db.close()`
  // would throw and MASK the real setup error.
  db?.close()
  db = undefined
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

describe('Open supervision-watchdog prod-boot wiring (F4)', () => {
  test('composition wires a REAL heartbeat pulse + on_gateway_tick (not the never-stale stub)', async () => {
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db: db!, project_slug: 'owner' })
    try {
      const tracker = composition.heartbeat_tracker
      // Pre-pulsed at construction → a concrete number, not null.
      const first = tracker.lastHeartbeatAt()
      expect(typeof first).toBe('number')

      // THE KEY DISTINCTION from the `() => Date.now()` stub: without a tick the
      // value is STABLE across reads (the stub would advance on every read).
      await Bun.sleep(5)
      expect(tracker.lastHeartbeatAt()).toBe(first)

      // The gateway-tick hook exists AND advances the pulse when called.
      expect(typeof composition.on_gateway_tick).toBe('function')
      await Bun.sleep(2)
      composition.on_gateway_tick!()
      const after = tracker.lastHeartbeatAt()
      expect(typeof after).toBe('number')
      expect(after!).toBeGreaterThan(first!)

      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          await cleanup()
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          await cleanup()
        } catch {
          /* ignore */
        }
      }
      throw err
    }
  }, 20_000)

  test('the real watchdog_notifier emits a watchdog_alert system_events row and never throws', async () => {
    // Register an ambient O4 sink (as the gateway boot does) so the notifier's
    // `emitSystemEvent` resolves it.
    registerSystemEventSink(new SystemEventsStore({ db: db! }))

    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db: db!, project_slug: 'owner' })
    try {
      // It is NOT the no-op stub — invoking it lands a durable journal row.
      const alert: WatchdogAlert = {
        id: 'test-alert-1',
        kind: 'gateway_heartbeat',
        project_slug: 'owner',
        detected_at: Date.now() / 1000,
        resolved_at: null,
        payload: { age_ms: 99_000 },
      }
      // Must never throw, and `notify()` AWAITS the durable O4 write (round-15):
      // the row is present the instant `notify()` resolves — NO `Bun.sleep` needed.
      await composition.watchdog_notifier.notify(alert)

      const rows = db!.all<{ event_name: string; module: string }, []>(
        `SELECT event_name, module FROM system_events WHERE event_name = 'watchdog_alert'`,
        [],
      )
      expect(rows.length).toBe(1)
      expect(rows[0]!.module).toBe('watchdog')

      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          await cleanup()
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          await cleanup()
        } catch {
          /* ignore */
        }
      }
      throw err
    }
  }, 20_000)

  test('round-15: notify() does NOT resolve until the deferred O4 write completes (no fire-and-forget race)', async () => {
    // A durable sink whose record() is HELD pending until released — stands in for
    // an O4 write still in flight when the tick would otherwise be considered drained.
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    const realStore = new SystemEventsStore({ db: db! })
    let recordStarted = false
    let recorded = false
    registerSystemEventSink({
      record: async (input: SystemEventInput) => {
        recordStarted = true
        await gate
        const out = await realStore.record(input) // land the durable row only after release
        recorded = true
        return out
      },
    } as unknown as SystemEventsStore)

    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db: db!, project_slug: 'owner' })
    try {
      const alert: WatchdogAlert = {
        id: 'deferred-alert-1',
        kind: 'gateway_heartbeat',
        project_slug: 'owner',
        detected_at: Date.now() / 1000,
        resolved_at: null,
        payload: { age_ms: 99_000 },
      }

      // Start notify() WITHOUT awaiting; it must BLOCK on the durable write.
      let notifyResolved = false
      const notifyP = composition.watchdog_notifier.notify(alert).then(() => {
        notifyResolved = true
      })
      for (let i = 0; i < 8; i++) await Promise.resolve() // let notify reach the gated write
      expect(recordStarted).toBe(true) // it DID begin the durable write…
      expect(notifyResolved).toBe(false) // …and notify() has NOT resolved while it's pending
      expect(recorded).toBe(false)

      // Release the write → ONLY THEN does notify() resolve, with the row durable.
      release()
      await notifyP
      expect(notifyResolved).toBe(true)
      expect(recorded).toBe(true)
      const rows = db!.all<{ event_name: string }, []>(
        `SELECT event_name FROM system_events WHERE event_name = 'watchdog_alert'`,
        [],
      )
      expect(rows.length).toBe(1)

      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          await cleanup()
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      release()
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          await cleanup()
        } catch {
          /* ignore */
        }
      }
      throw err
    }
  }, 20_000)
})
