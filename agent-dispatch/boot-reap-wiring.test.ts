/**
 * @neutronai/agent-dispatch — boot-reap ↔ report-adapter unit contract.
 *
 * This exercises the SHARED production adapter `buildBootSweepReport` (the exact
 * function `open/composer.ts` wires as the boot sweep's report sink) against a
 * real store, at the unit level. The COMPOSER-level "is it actually fired on
 * boot" gate lives in `open/__tests__/open-subagent-boot-reap-wiring.test.ts`
 * (which boots the real composer); this file pins the adapter's behaviour:
 *   - the adapter SWALLOWS every `DispatchReporter` rejection internally
 *     (`buildDispatchWatchdogNotifier`), so even a REJECTING reporter leaves the
 *     orphan durably claimed `crashed` and no rejection escapes the sweep;
 *   - a working reporter receives the crashed `DispatchReport` (sentinel→review);
 *   - a forge/argus orphan is reaped but its report is SKIPPED (Trident owns it).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { SubagentRegistryStore } from '@neutronai/runtime/subagent/store.ts'
import { sweepOrphanedDispatchesOnBoot } from '@neutronai/runtime/subagent/boot-sweep.ts'
import { buildBootSweepReport } from './watchdog-report.ts'
import type { DispatchReport } from './service.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-boot-reap-wiring-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// Exercises the SHARED production adapter (open/composer.ts wires this exact
// function), not a local re-implementation.
const productionBootReport = buildBootSweepReport

test('a REJECTING DispatchReporter through the real adapter still durably claims the orphan crashed', async () => {
  // Seed under a PRIOR boot id so the current-boot sweep (default CURRENT_BOOT_ID)
  // sees the row as a reapable prior-process orphan.
  const store = new SubagentRegistryStore(db, 'boot-prior-process')
  const reg = new SubagentRegistry(store)
  await reg.create({ run_id: 'orphan-atlas', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
  await reg.update('orphan-atlas', { status: 'running' })

  let attempts = 0
  const rejecting = (): Promise<void> => {
    attempts++
    return Promise.reject(new Error('WS delivery down'))
  }

  // Must NOT throw (the adapter swallows the rejection), and must still claim.
  const swept = await sweepOrphanedDispatchesOnBoot({
    store: new SubagentRegistryStore(db),
    report: productionBootReport(rejecting),
    now: () => 100,
  })

  expect(attempts).toBe(1) // the adapter DID attempt delivery
  expect(swept.map((r) => r.run_id)).toEqual(['orphan-atlas'])
  // Durable surfacing survived the delivery failure — not vanished.
  expect(store.get('orphan-atlas')?.status).toBe('crashed')
  expect(store.get('orphan-atlas')?.failure_reason).toBe('process_dead')
})

test('a working DispatchReporter receives a crashed report for the orphan', async () => {
  // Seed under a PRIOR boot id so the current-boot sweep (default CURRENT_BOOT_ID)
  // sees the row as a reapable prior-process orphan.
  const store = new SubagentRegistryStore(db, 'boot-prior-process')
  const reg = new SubagentRegistry(store)
  await reg.create({ run_id: 'orphan-sentinel', instance_key: 'owner', agent_kind: 'sentinel', spawn_depth: 0 })
  await reg.update('orphan-sentinel', { status: 'running' })

  const reports: DispatchReport[] = []
  await sweepOrphanedDispatchesOnBoot({
    store: new SubagentRegistryStore(db),
    report: productionBootReport((r) => {
      reports.push(r)
    }),
    now: () => 200,
  })

  expect(reports).toHaveLength(1)
  expect(reports[0]?.run_id).toBe('orphan-sentinel')
  expect(reports[0]?.status).toBe('crashed')
  expect(reports[0]?.kind).toBe('review') // sentinel → review
})

test('END-TO-END sweep→adapter reports the TRUE orphan age (progress→reap), not 0ms', async () => {
  // Regression: the sweep overwrote the reported record's `last_event_at` with the
  // reap time, so `buildBootSweepReport` computed `ended_at - last_event_at = 0ms`
  // for EVERY real sweep. Exercised through the actual sweep (not the adapter in
  // isolation) with DISTINCT progress vs reap timestamps, the reported age must be
  // `reap - last_progress`, matching what a live watchdog reap reports.
  const LAST_EVENT_AT = 900
  const REAP_AT = 1000
  const store = new SubagentRegistryStore(db, 'boot-prior-process')
  const reg = new SubagentRegistry(store)
  await reg.create({ run_id: 'orphan-aged', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
  // Last progress at 900 (durably persisted), well before the reap at 1000.
  await reg.update('orphan-aged', { status: 'running', last_event_at: LAST_EVENT_AT })

  const reports: DispatchReport[] = []
  await sweepOrphanedDispatchesOnBoot({
    store: new SubagentRegistryStore(db),
    report: productionBootReport((r) => {
      reports.push(r)
    }),
    now: () => REAP_AT,
  })

  expect(reports).toHaveLength(1)
  const age = Number(/age at reap: (\d+)ms/.exec(reports[0]!.markdown)![1])
  expect(age).toBe(REAP_AT - LAST_EVENT_AT) // 100ms — the true age
  expect(age).not.toBe(0) // NOT the reap-overwrites-progress bug
})

test('a forge orphan is claimed crashed but the adapter skips the report (Trident owns it)', async () => {
  // Seed under a PRIOR boot id so the current-boot sweep (default CURRENT_BOOT_ID)
  // sees the row as a reapable prior-process orphan.
  const store = new SubagentRegistryStore(db, 'boot-prior-process')
  const reg = new SubagentRegistry(store)
  await reg.create({ run_id: 'orphan-forge', instance_key: 'owner', agent_kind: 'forge', spawn_depth: 0 })
  await reg.update('orphan-forge', { status: 'running' })

  const reports: DispatchReport[] = []
  const swept = await sweepOrphanedDispatchesOnBoot({
    store: new SubagentRegistryStore(db),
    report: productionBootReport((r) => {
      reports.push(r)
    }),
    now: () => 300,
  })

  // Still durably reaped, but the dispatch adapter does not report a forge kind.
  expect(swept.map((r) => r.run_id)).toEqual(['orphan-forge'])
  expect(store.get('orphan-forge')?.status).toBe('crashed')
  expect(reports).toHaveLength(0)
})
