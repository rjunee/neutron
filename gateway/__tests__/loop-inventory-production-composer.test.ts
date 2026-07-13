/**
 * §F2 — production-composer reachability guard for the LOOP INVENTORY (the
 * ISSUE-#32 "assert the set, not archaeology" pattern applied to long-lived
 * loops).
 *
 * What this pins:
 *   1. `composeProductionGraph` STARTS exactly the expected set of long-lived
 *      tick loops — cron, reminders, trident, watchdog — and exposes them via
 *      `graph.loopRegistry`. A future loop that silently stops starting (a
 *      wiring regression) OR a silently-added new loop breaks the pinned set.
 *   2. The two D-7 DORMANT loops (`project-backup-scheduler`, comments
 *      `agent-watcher`) are NOT in the running set — they are explicitly
 *      enumerated in `DORMANT_LOOPS`, never silently dead. If someone wires one
 *      for real (a future feature PR) without moving it out of `DORMANT_LOOPS`,
 *      or lets a third loop go silently-dead, this test flags it.
 *   3. The ONE boot inventory line names every running loop (cron with its job
 *      detail) plus the dormant set.
 *
 * MUTATION-VERIFIED: deleting any `loopRegistry.register(...)` line in
 * `gateway/composition/build-core-modules.ts` (or the cron registration in
 * `composition.ts`) drops that loop from `graph.loopRegistry.names()` and this
 * test goes red — the closing condition for F2.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { composeProductionGraph, DORMANT_LOOPS } from '../composition.ts'

const OWNER = 'loop-inventory-composer-owner'

/** The exact set of loops the Open production composition starts. */
const EXPECTED_RUNNING_LOOPS = ['cron', 'reminders', 'trident', 'watchdog'] as const
/** The exact set of D-7 dormant loops (built, never started). */
const EXPECTED_DORMANT_LOOPS = ['agent-watcher', 'project-backup-scheduler'] as const

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

interface Harness {
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-loop-inventory-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
  })
  return {
    graph,
    close: async () => {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('composeProductionGraph starts exactly the expected loop set', () => {
  expect(harness.graph.loopRegistry.names()).toEqual([...EXPECTED_RUNNING_LOOPS])
})

test('every running loop exposes a live descriptor (cadence, startedAt, health)', () => {
  for (const name of EXPECTED_RUNNING_LOOPS) {
    const desc = harness.graph.loopRegistry.get(name)
    expect(desc, `loop '${name}' missing`).toBeDefined()
    if (desc === undefined) continue
    expect(desc.name).toBe(name)
    expect(desc.startedAt).toBeGreaterThan(0)
    // cron is variable-cadence (0); the interval loops carry a real cadence.
    if (name === 'cron') expect(desc.cadenceMs).toBe(0)
    else expect(desc.cadenceMs).toBeGreaterThan(0)
    // health() is callable and returns the live shape.
    const health = desc.health()
    expect('lastTickAt' in health).toBe(true)
    expect('lastError' in health).toBe(true)
  }
})

test('cron descriptor lists its running jobs via detail()', () => {
  const cron = harness.graph.loopRegistry.get('cron')
  expect(cron?.detail).toBeDefined()
  const detail = cron?.detail?.() ?? ''
  expect(detail).toMatch(/^\d+ jobs/)
})

test('D-7 dormant loops are enumerated + NOT running (no silent dead loop)', () => {
  const dormantNames = DORMANT_LOOPS.map((d) => d.name).sort()
  expect(dormantNames).toEqual([...EXPECTED_DORMANT_LOOPS])
  // The dormancy is documented (reason + deferral pointer), not silent.
  for (const d of DORMANT_LOOPS) {
    expect(d.reason.length).toBeGreaterThan(0)
    expect(d.deferredTo.length).toBeGreaterThan(0)
    // A dormant loop must NEVER also be in the running set.
    expect(harness.graph.loopRegistry.has(d.name)).toBe(false)
  }
})

test('the ONE boot line names running loops (with cron jobs) + the dormant set', () => {
  const line = harness.graph.loopRegistry.bootLine(OWNER, DORMANT_LOOPS)
  expect(line).toContain(`project=${OWNER}`)
  expect(line).toContain('4 loop(s) running')
  for (const name of EXPECTED_RUNNING_LOOPS) expect(line).toContain(name)
  expect(line).toMatch(/cron \(\d+ jobs/)
  expect(line).toContain('2 dormant (deferred): [agent-watcher, project-backup-scheduler]')
})
