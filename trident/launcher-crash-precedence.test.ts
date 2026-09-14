import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { deployRestartKillReason, undeterminedLauncherDeathReason } from './deploy-kill-reason.ts'

let directory: string
let db: ProjectDb
let store: TridentRunStore
const generation = 'dead-generation'
const observedAt = new Date('2026-09-14T00:00:00.000Z')
// Actual producer formats, not strings that merely resemble the classification.
const unexplained = 'inner workflow child crashed: pooled child exited'
const undetermined = undeterminedLauncherDeathReason({ generationKey: generation, detail: 'cause could not be established', observedAt })
const measured = deployRestartKillReason({ generationKey: generation, detail: 'the shutdown killed this child', observedAt, witness: 'child-crash-sink' })
const reasons = [unexplained, undetermined, measured]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'launcher-precedence-'))
  seedMigratedDb(join(directory, 'project.db'))
  db = ProjectDb.open(join(directory, 'project.db'))
  store = new TridentRunStore(db)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function tombstone(): { failure_reason: string; crashed_at: string } {
  return db.get<{ failure_reason: string; crashed_at: string }>(
    'SELECT failure_reason, crashed_at FROM trident_launcher_crashes WHERE session_key = ?', [generation],
  )!
}

async function runningSnapshot() {
  const run = await store.create({ slug: 'race', project_slug: 'test', repo_path: '/repo', task: 'test' })
  await store.update(run.id, { subagent_status: 'running', workflow_run_id: generation, subagent_run_id: 'workflow' })
  return store.get(run.id)!
}

describe('launcher report information precedence', () => {
  // Enumerate all three unequal rank pairs, in each arrival order.
  for (let lower = 0; lower < reasons.length; lower++) {
    for (let higher = lower + 1; higher < reasons.length; higher++) {
      test(`promotion ${lower} to ${higher} reaches the stale-snapshot veto`, async () => {
        const snapshot = await runningSnapshot()
        expect(await store.crashRunningByLauncher(generation, reasons[lower]!)).toBe(true)
        const originalTime = tombstone().crashed_at
        expect(await store.crashRunningByLauncher(generation, reasons[higher]!)).toBe(true)
        expect(tombstone().failure_reason).toBe(reasons[higher]!)
        expect(tombstone().crashed_at).toBe(originalTime)
        // The run was latched by the first report; the veto must read the winner.
        expect(await store.saveIfActive(snapshot)).toBe(false)
        expect(store.get(snapshot.id)?.failure_reason).toBe(reasons[higher]!)
        expect(store.get(snapshot.id)?.subagent_status).toBe('crashed')
      })
      test(`downgrade ${higher} to ${lower} is declined and cannot poison a snapshot`, async () => {
        const snapshot = await runningSnapshot()
        expect(await store.crashRunningByLauncher(generation, reasons[higher]!)).toBe(true)
        expect(await store.crashRunningByLauncher(generation, reasons[lower]!)).toBe(false)
        expect(tombstone().failure_reason).toBe(reasons[higher]!)
        expect(await store.saveIfActive(snapshot)).toBe(false)
        expect(store.get(snapshot.id)?.failure_reason).toBe(reasons[higher]!)
      })
    }
  }

  for (const [rank, reason] of reasons.entries()) {
    for (const reverse of [false, true]) {
      test(`equal rank ${rank} resolves deterministically, reverse=${reverse}`, async () => {
        const preferred = `${reason} A`
        const other = `${reason} Z`
        const [first, second] = reverse ? [preferred, other] : [other, preferred]
        expect(await store.crashRunningByLauncher(generation, first)).toBe(true)
        expect(await store.crashRunningByLauncher(generation, second)).toBe(!reverse)
        expect(tombstone().failure_reason).toBe(preferred)
        expect(await store.crashRunningByLauncher(generation, preferred)).toBe(false)
      })
    }
  }

  test('declined delivery logs a no-op, while an accepted report does not', async () => {
    const level = process.env['NEUTRON_LOG_LEVEL']
    process.env['NEUTRON_LOG_LEVEL'] = 'info'
    const logged = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await store.crashRunningByLauncher(generation, measured)).toBe(true)
      expect(logged).not.toHaveBeenCalled()
      expect(await store.crashRunningByLauncher(generation, unexplained)).toBe(false)
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged.mock.calls[0]![0]).toContain('event=launcher_crash_report_declined')
      expect(logged.mock.calls[0]![0]).toContain('disposition=no-op')
      expect(logged.mock.calls[0]![0]).toContain('incoming_rank=0 retained_rank=2')
    } finally {
      logged.mockRestore()
      if (level === undefined) delete process.env['NEUTRON_LOG_LEVEL']
      else process.env['NEUTRON_LOG_LEVEL'] = level
    }
  })

  test('undetermined classification takes precedence over a quoted deploy marker', async () => {
    const quoted = undeterminedLauncherDeathReason({
      generationKey: generation, detail: `could not verify: ${measured}`, observedAt,
    })
    const preferredUnknown = undeterminedLauncherDeathReason({
      generationKey: generation, detail: 'A cause could not be established', observedAt,
    })
    expect(await store.crashRunningByLauncher(generation, preferredUnknown)).toBe(true)
    expect(await store.crashRunningByLauncher(generation, quoted)).toBe(false)
    expect(tombstone().failure_reason).toBe(preferredUnknown)
    expect(await store.crashRunningByLauncher(generation, measured)).toBe(true)
    expect(tombstone().failure_reason).toBe(measured)
    expect(await store.crashRunningByLauncher(generation, quoted)).toBe(false)
    expect(tombstone().failure_reason).toBe(measured)
  })

  test('existing persisted attribution survives reopening and an unrecognised report', async () => {
    // A pre-upgrade tombstone has only the original columns; no in-memory rank.
    await db.run('INSERT INTO trident_launcher_crashes (session_key, failure_reason, crashed_at) VALUES (?, ?, ?)',
      [generation, measured, new Date().toISOString()])
    db.close()
    db = ProjectDb.open(join(directory, 'project.db'))
    store = new TridentRunStore(db)
    const snapshot = await runningSnapshot()
    expect(await store.crashRunningByLauncher(generation, 'a new unclassified death report')).toBe(false)
    // Even the running-row update on a declined report must use the retained reason.
    expect(store.get(snapshot.id)?.failure_reason).toBe(measured)
    expect(store.get(snapshot.id)?.subagent_status).toBe('crashed')
  })
})
