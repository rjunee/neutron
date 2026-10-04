import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectAdmission } from './project-admission.ts'
import { ProjectAdmissionStore } from './project-admission-store.ts'
import { resumeProjectMaintenance } from './project-generation-replacement.ts'

test('operator hold survives old recovery across connections; real admitted work drains without lost pending work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-hold-'))
  const path = join(dir, 'db')
  seedMigratedDb(path)
  const oldDb = ProjectDb.open(path), operatorDb = ProjectDb.open(path)
  const admission = new ProjectAdmission({ db: oldDb, ownerHandle: 'owner', bootId: 'old-boot' })
  const operator = new ProjectAdmissionStore(operatorDb)
  const scope = admission.scopeFor(null)
  let finish!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
  try {
    const running = admission.withLease(null, 'conversation', 'acting-turn', 'genuine-turn', async () => {
      entered()
      await gate
      return 'settled'
    })
    await ready
    const hold = (await operator.holdOperatorMaintenance(scope, crypto.randomUUID()))!
    expect(hold.phase).toBe('draining')
    expect(admission.inspect(null)?.leases).toBe(1)
    expect(await operator.holdOperatorMaintenance(scope, crypto.randomUUID())).toBeNull()
    // This production recovery branch is the unchanged old gateway's writer:
    // it attempts canonical abandon; the SQL trigger, not a new JS guard, stops it.
    for (let i = 0; i < 3; i++) {
      expect(await resumeProjectMaintenance({ admission, ports: {} as never }, null)).toMatchObject({ status: 'held' })
      expect((await admission.admit(null, 'conversation', 'acting-turn', 'retry')).status).toBe('fenced')
      expect(operator.operatorMaintenanceCurrent(hold)).toBe(true)
    }
    expect(await operator.releaseOperatorMaintenance(hold, () => true)).toBe(false)
    finish()
    expect(await running).toMatchObject({ status: 'admitted', value: 'settled' })
    expect(admission.inspect(null)?.leases).toBe(0)
    expect(await operator.releaseOperatorMaintenance({ ...hold, operationId: crypto.randomUUID() }, () => true)).toBe(false)
    expect(await operator.releaseOperatorMaintenance({ ...hold, generation: hold.generation + 1 }, () => true)).toBe(false)
    expect(await operator.releaseOperatorMaintenance({ ...hold, scope: { ...scope, ownerHandle: 'foreign' } }, () => true)).toBe(false)
    expect(await operator.releaseOperatorMaintenance(hold, () => false)).toBe(false)
    expect(await operator.releaseOperatorMaintenance(hold, () => true)).toBe(true)
    expect(await operator.releaseOperatorMaintenance(hold, () => true)).toBe(false)
    expect(await admission.withLease(null, 'conversation', 'acting-turn', 'retry', async () => 'delivered'))
      .toMatchObject({ status: 'admitted', value: 'delivered' })
    // Positive control: ordinary unheld maintenance still abandons normally.
    const ordinary = (await admission.maintenance.beginMaintenance(scope))!
    expect(await admission.maintenance.abandon(ordinary)).toBe(true)
  } finally { finish?.(); oldDb.close(); operatorDb.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('hold acquisition and release are atomic, scoped, and do not steal another maintenance epoch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-atomic-'))
  const path = join(dir, 'db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path), store = new ProjectAdmissionStore(db)
  const scope = { ownerHandle: 'owner', projectId: null }
  try {
    expect(await store.holdOperatorMaintenance(scope, crypto.randomUUID())).toBeNull()
    await store.register(scope)
    const ordinary = (await store.beginMaintenance(scope))!
    expect(await store.holdOperatorMaintenance(scope, crypto.randomUUID())).toBeNull()
    expect(await store.abandon(ordinary)).toBe(true)
    const op = crypto.randomUUID()
    const hold = (await store.holdOperatorMaintenance(scope, op))!
    const other = { ownerHandle: 'other', projectId: null }
    await store.register(other)
    await expect(store.holdOperatorMaintenance(other, op)).rejects.toThrow()
    expect(store.inspect(other)?.phase).toBe('open') // failed insert rolled back begin
    const otherFence = (await store.beginMaintenance(other))!
    expect(await store.abandon(otherFence)).toBe(true)
    // A failed final release must restore the hold removal in the same transaction.
    await db.exec(`CREATE TRIGGER test_release_failure BEFORE UPDATE ON project_admission_fences
      WHEN NEW.phase = 'open' BEGIN SELECT RAISE(IGNORE); END`)
    await expect(store.releaseOperatorMaintenance(hold, () => true)).rejects.toThrow()
    expect(store.operatorMaintenanceCurrent(hold)).toBe(true)
    await db.exec('DROP TRIGGER test_release_failure')
    expect(await store.releaseOperatorMaintenance(hold, () => true)).toBe(true)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
