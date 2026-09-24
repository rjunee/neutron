import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { seedProject } from './wiring/__tests__/project-admission-fixture.ts'
import { ProjectAdmission } from './project-admission.ts'
import type { MaintenanceFence } from './project-admission-store.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'project-admission-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const open = (bootId = 'boot-a') => {
    const db = ProjectDb.open(path)
    cleanup.push(() => db.close())
    return { db, admission: new ProjectAdmission({ db, ownerHandle: 'owner-a', bootId }) }
  }
  return { ...open(), open }
}

async function admitted(admission: ProjectAdmission, projectId: string | null) {
  const out = await admission.admit(projectId, 'conversation', 'chat', 'turn')
  if (out.status !== 'admitted') throw new Error(`expected admission, got ${out.status}`)
  return out
}

test('General and a real project literally named general are distinct scopes', async () => {
  const { db, admission } = fixture()
  seedProject(db, 'general')
  expect(admission.scopeFor(undefined)).toEqual({ ownerHandle: 'owner-a', projectId: null })
  expect(admission.scopeFor('general')).toEqual({ ownerHandle: 'owner-a', projectId: 'general' })
  await admitted(admission, null)
  await admitted(admission, 'general')
  const fence = await admission.maintenance.beginMaintenance(admission.scopeFor(null))
  expect(fence).not.toBeNull()
  expect(await admission.admit(null, 'conversation', 'chat', 't')).toEqual({ status: 'fenced', phase: 'draining' })
  // Opposite control: the literal-id project is untouched by General's fence.
  expect((await admission.admit('general', 'conversation', 'chat', 't')).status).toBe('admitted')
})

test('an unknown project refuses without registering; the same id admits once its row exists', async () => {
  const { db, admission } = fixture()
  expect(await admission.admit('ghost', 'conversation', 'chat', 't')).toEqual({ status: 'unknown' })
  expect(admission.inspect('ghost')).toBeNull()
  // A missing row must never fall back to General.
  expect(admission.inspect(null)).toBeNull()
  seedProject(db, 'ghost')
  expect((await admission.admit('ghost', 'conversation', 'chat', 't')).status).toBe('admitted')
  expect(admission.inspect('ghost')).toEqual({ generation: 0, phase: 'open', leases: 1 })
})

test('a soft-deleted project refuses even after it was registered', async () => {
  const { db, admission } = fixture()
  seedProject(db, 'gone')
  await admitted(admission, 'gone')
  db.runSync("UPDATE projects SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'gone'")
  expect(await admission.admit('gone', 'conversation', 'chat', 't')).toEqual({ status: 'unknown' })
})

test('release binds the exact lease and is idempotent; the producer carries the boot id', async () => {
  const { db, admission } = fixture()
  const work = await admitted(admission, null)
  const row = db.get<{ producer: string; reason: string }>(
    'SELECT producer, reason FROM project_admission_leases WHERE token = ?', [work.lease.token])
  expect(row).toEqual({ producer: 'chat:boot-a', reason: 'conversation' })
  expect(admission.inspect(null)?.leases).toBe(1)
  expect(await work.release()).toBe(true)
  expect(await work.release()).toBe(false)
  expect(admission.inspect(null)?.leases).toBe(0)
})

test('withLease runs only when admitted and releases on every unwind', async () => {
  const { admission } = fixture()
  let observed = -1
  const ok = await admission.withLease(null, 'conversation', 'chat', 'w', async () => {
    observed = admission.inspect(null)!.leases
    return 'done'
  })
  expect(ok).toEqual({ status: 'admitted', value: 'done' })
  expect(observed).toBe(1)
  expect(admission.inspect(null)?.leases).toBe(0)
  await expect(admission.withLease(null, 'conversation', 'chat', 'w', async () => { throw new Error('boom') }))
    .rejects.toThrow('boom')
  expect(admission.inspect(null)?.leases).toBe(0)
  await admission.maintenance.beginMaintenance(admission.scopeFor(null))
  let ran = false
  expect(await admission.withLease(null, 'conversation', 'chat', 'w', async () => { ran = true }))
    .toEqual({ status: 'fenced', phase: 'draining' })
  expect(ran).toBe(false)
})

test('a lost maintenance acknowledgement is recovered after restart by resume', async () => {
  const f = fixture()
  const scope = f.admission.scopeFor(null)
  await admitted(f.admission, null).then((w) => w.release())
  expect(f.admission.maintenance.resume(scope)).toBeNull()
  const fence = (await f.admission.maintenance.beginMaintenance(scope))!
  // The caller "crashed" before recording `fence`. A new process resumes it.
  const restarted = f.open('boot-b').admission
  const resumed = restarted.maintenance.resume(scope)
  expect(resumed).toEqual(fence)
  expect((await restarted.admit(null, 'conversation', 'chat', 't')).status).toBe('fenced')
  const quiesced = (await restarted.maintenance.advance(resumed!))!
  expect(quiesced.phase).toBe('quiesced')
  expect(f.open('boot-c').admission.maintenance.resume(scope)).toEqual(quiesced)
})

test('abandon reopens from draining or quiesced even with draining work, never from replacing or attesting', async () => {
  const { db, admission } = fixture()
  const scope = admission.scopeFor(null)
  const store = admission.maintenance
  const inFlight = await admitted(admission, null)
  const draining = (await store.beginMaintenance(scope))!
  expect(await store.abandon({ ...draining, token: 'forged' })).toBe(false)
  expect(await store.abandon(draining)).toBe(true)
  expect(admission.inspect(null)).toEqual({ generation: 1, phase: 'open', leases: 1 })
  expect(await store.abandon(draining)).toBe(false)
  expect((await admission.admit(null, 'conversation', 'chat', 't')).status).toBe('admitted')
  await inFlight.release()

  // Drain everything, then abandon from quiesced.
  db.runSync('DELETE FROM project_admission_leases')
  const second = (await store.beginMaintenance(scope))!
  const quiesced = (await store.advance(second))!
  expect(await store.abandon(quiesced)).toBe(true)
  expect(admission.inspect(null)?.phase).toBe('open')

  // Opposite control: once replacement began, abandon refuses.
  let fence: MaintenanceFence = (await store.beginMaintenance(scope))!
  fence = (await store.advance(fence))!
  fence = (await store.advance(fence))!
  expect(fence.phase).toBe('replacing')
  expect(await store.abandon(fence)).toBe(false)
  fence = (await store.advance(fence))!
  expect(fence.phase).toBe('attesting')
  expect(await store.abandon(fence)).toBe(false)
  expect(admission.inspect(null)?.phase).toBe('attesting')
  expect(await store.reopen(fence)).toBe(true)
})
