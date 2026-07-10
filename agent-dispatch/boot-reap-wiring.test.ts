/**
 * @neutronai/agent-dispatch — boot-reap ↔ production report-adapter wiring.
 *
 * The runtime boot sweep (`runtime/subagent/boot-sweep.ts`) fires its report
 * through `buildDispatchWatchdogNotifier` in production (`open/composer.ts`).
 * That adapter SWALLOWS every `DispatchReporter` rejection internally
 * (`watchdog-report.ts`), so this end-to-end test proves the integrated
 * contract Codex flagged: even when the underlying `DispatchReporter` REJECTS,
 * the orphan is still durably claimed `crashed` (the surfacing that never
 * vanishes) and no rejection escapes the sweep. It also pins the adapter's
 * forge/argus skip end-to-end.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { SubagentRegistryStore } from '@neutronai/runtime/subagent/store.ts'
import {
  sweepOrphanedDispatchesOnBoot,
  type BootSweepReport,
} from '@neutronai/runtime/subagent/boot-sweep.ts'
import type { SubagentRecord } from '@neutronai/runtime/subagent/registry.ts'
import { buildDispatchWatchdogNotifier } from './watchdog-report.ts'
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

/** The exact adapter open/composer.ts builds: SubagentRecord → the production
 *  watchdog notifier (which maps to DispatchReport + swallows failures). */
function productionBootReport(report: (r: DispatchReport) => void | Promise<void>): BootSweepReport {
  const notifier = buildDispatchWatchdogNotifier(report)
  return (rec: SubagentRecord) => {
    const detected_at = rec.ended_at ?? Date.now()
    return notifier({
      run_id: rec.run_id,
      agent_kind: rec.agent_kind,
      instance_key: rec.instance_key,
      reason: 'process_dead',
      last_event_at: rec.last_event_at,
      detected_at,
      age_ms: detected_at - rec.started_at,
      ...(rec.delivery_target !== undefined ? { delivery_target: rec.delivery_target } : {}),
      ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
    })
  }
}

test('a REJECTING DispatchReporter through the real adapter still durably claims the orphan crashed', async () => {
  const store = new SubagentRegistryStore(db)
  const reg = new SubagentRegistry(store)
  reg.create({ run_id: 'orphan-atlas', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
  reg.update('orphan-atlas', { status: 'running' })

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
  const store = new SubagentRegistryStore(db)
  const reg = new SubagentRegistry(store)
  reg.create({ run_id: 'orphan-sentinel', instance_key: 'owner', agent_kind: 'sentinel', spawn_depth: 0 })
  reg.update('orphan-sentinel', { status: 'running' })

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

test('a forge orphan is claimed crashed but the adapter skips the report (Trident owns it)', async () => {
  const store = new SubagentRegistryStore(db)
  const reg = new SubagentRegistry(store)
  reg.create({ run_id: 'orphan-forge', instance_key: 'owner', agent_kind: 'forge', spawn_depth: 0 })
  reg.update('orphan-forge', { status: 'running' })

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
