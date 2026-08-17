/**
 * Production-wiring guard: the COMPOSED reminder tick loop resolves a cron
 * cadence in the owner's stored zone.
 *
 * `reminders/owner-timezone-tick.test.ts` proves the loop honours whatever
 * `resolve_time_zone` reports. That is necessary and not sufficient — the
 * original defect was not a broken loop, it was a loop that was never handed a
 * zone at all, so a correct-in-isolation module sat behind a composition that
 * passed nothing and silently took the host's clock. This test therefore boots
 * the REAL `composeProductionGraph`, seeds `instance_metadata.timezone` the way
 * a connecting client does, and asserts the fire time the composed loop actually
 * writes.
 *
 * Closing condition: delete the `resolve_time_zone` field from the reminders
 * module in `gateway/composition/build-core-modules.ts` and this test reds — the
 * loop falls back to `REMINDER_FALLBACK_TIME_ZONE` and the advanced fire lands
 * at 21:00 UTC, which is not 21:00 on the seeded zone's clock.
 *
 * Host-independence: the assertion is "what does the OWNER's clock read", and
 * the only fallback in play is the fixed `UTC` constant, so neither the pass nor
 * the mutation's failure depends on the zone of the machine running the test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import {
  REMINDER_FALLBACK_TIME_ZONE,
  type ReminderTickLoop,
} from '@neutronai/reminders/tick.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { composeProductionGraph } from '../composition.ts'
import { writeOwnerTimezone } from '../storage/owner-metadata.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const OWNER = 'reminders-owner-tz-project'

/** A zone with a large, non-zero offset that is never equal to the UTC
 *  fallback — so "the owner's zone was used" and "the fallback was used" can
 *  never be confused for one another. */
const OWNER_ZONE = 'Asia/Tokyo'

interface Harness {
  db: ProjectDb
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-reminders-owner-tz-wiring-'))
  const db = openMigratedDbAt(join(tmp, 'owner.db'))

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  })

  return {
    db,
    graph,
    close: async () => {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** Render an instant on a given zone's wall clock — the same owner-clock oracle
 *  the unit tests use, so both layers assert the same kind of fact. */
const wallClockIn = (epoch_ms: number, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epoch_ms))

describe('composed reminders module resolves cron cadences in the owner zone', () => {
  let h: Harness

  beforeEach(async () => {
    h = await startHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  test('a stored instance_metadata.timezone reaches the composed tick loop', async () => {
    // The client-reported zone, persisted exactly as the app-ws connect path
    // does via `persistOwnerTimezoneIfChanged`.
    await writeOwnerTimezone(h.db, OWNER, OWNER_ZONE)

    const reminders = h.graph.get<{ store: ReminderStore; loop: ReminderTickLoop }>('reminders')
    // Real `Date.now` here — the composed loop owns its clock. Nothing below
    // measures elapsed time; the assertion is what the owner's clock READS at
    // the computed instant, which is the same answer whenever the test runs.
    const now_sec = Date.now() / 1000
    const row = await reminders.store.createRecurring({
      owner_slug: OWNER,
      topic_id: null,
      fire_at: now_sec - 10, // already due
      message: 'evening wrap',
      recurrence_spec: '0 21 * * *',
    })

    await reminders.loop.runOnce()

    const advanced = reminders.store.get(row.id)
    expect(advanced?.status).toBe('pending')
    const fire_ms = (advanced?.fire_at as number) * 1000

    // The owner's clock reads 21:00…
    expect(wallClockIn(fire_ms, OWNER_ZONE)).toBe('21:00')
    // …and it is NOT 21:00 in the fallback zone, which is what an unwired
    // composition would have produced.
    expect(wallClockIn(fire_ms, REMINDER_FALLBACK_TIME_ZONE)).not.toBe('21:00')
  })

  test('with no stored zone the composed loop uses the explicit fallback, not the host', async () => {
    // A fresh install before any client has connected. The honest behaviour is
    // the documented constant — deterministic on every box — rather than
    // whatever `TZ` the server happens to carry.
    const reminders = h.graph.get<{ store: ReminderStore; loop: ReminderTickLoop }>('reminders')
    const row = await reminders.store.createRecurring({
      owner_slug: OWNER,
      topic_id: null,
      fire_at: Date.now() / 1000 - 10,
      message: 'evening wrap',
      recurrence_spec: '0 21 * * *',
    })

    await reminders.loop.runOnce()

    const fire_ms = (reminders.store.get(row.id)?.fire_at as number) * 1000
    expect(wallClockIn(fire_ms, REMINDER_FALLBACK_TIME_ZONE)).toBe('21:00')
  })

  test('a corrupt stored zone degrades to the fallback and does NOT retire the reminder', async () => {
    // `persistOwnerTimezoneIfChanged` validates on write, so this models a
    // hand-edited or migrated row. Without the `isValidIanaTimezone` guard in
    // the composition, `nextCronFire` throws, the tick reads that as an
    // uncomputable cadence, and the owner's recurring reminder is RETIRED —
    // turning a timezone typo into permanent silent data loss.
    await h.db.run(
      `INSERT INTO instance_metadata (instance_slug, timezone) VALUES (?, ?)
         ON CONFLICT(instance_slug) DO UPDATE SET timezone = excluded.timezone`,
      [OWNER, 'Not/AZone'],
    )

    const reminders = h.graph.get<{ store: ReminderStore; loop: ReminderTickLoop }>('reminders')
    const row = await reminders.store.createRecurring({
      owner_slug: OWNER,
      topic_id: null,
      fire_at: Date.now() / 1000 - 10,
      message: 'evening wrap',
      recurrence_spec: '0 21 * * *',
    })

    await reminders.loop.runOnce()

    const advanced = reminders.store.get(row.id)
    // Still a live recurring row…
    expect(advanced?.status).toBe('pending')
    expect(advanced?.recurrence_spec).toBe('0 21 * * *')
    // …scheduled in the fallback zone.
    expect(wallClockIn((advanced?.fire_at as number) * 1000, REMINDER_FALLBACK_TIME_ZONE)).toBe(
      '21:00',
    )
  })
})
