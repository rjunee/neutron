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

test('releaseWork removes only the matching work — other work and other scopes survive (#1237)', async () => {
  const { db, admission } = fixture()
  seedProject(db, 'alpha')
  const run1 = await admission.admit(null, 'build', 'work-board', 'run-1')
  await admission.admit(null, 'build', 'work-board', 'run-2')
  await admission.admit('alpha', 'build', 'work-board', 'run-1')
  await admission.admit(null, 'conversation', 'chat', 'run-1')
  expect(run1.status).toBe('admitted')

  // Two rows for the SAME work in the same scope (a re-lease) both go.
  await admission.admit(null, 'build', 'hold-drain', 'run-1')
  expect(await admission.releaseBuild(null, 'run-1')).toBe(2)
  // Idempotent: a second release removes nothing.
  expect(await admission.releaseBuild(null, 'run-1')).toBe(0)

  // Controls: another run's build lease, the same run id in ANOTHER scope, and a
  // non-build lease naming the same work reference are all untouched.
  expect(admission.listLeases('build').map((l) => [l.scope.projectId, l.workRef]))
    .toEqual([[null, 'run-2'], ['alpha', 'run-1']])
  expect(admission.listLeases('conversation').map((l) => l.workRef)).toEqual(['run-1'])
})

test('listLeases decodes the scope, reason, producer and work reference, and is owner-scoped (#1237)', async () => {
  const f = fixture()
  seedProject(f.db, 'alpha')
  await f.admission.admit('alpha', 'build', 'hold-drain', 'run-9')
  await f.admission.admit(null, 'queuedDispatch', 'wakeup', 'wake-1')
  const other = new ProjectAdmission({ db: f.db, ownerHandle: 'owner-b', bootId: 'boot-b' })
  await other.admit(null, 'build', 'work-board', 'foreign-run')

  expect(f.admission.listLeases('build')).toEqual([
    expect.objectContaining({
      scope: { ownerHandle: 'owner-a', projectId: 'alpha' },
      reason: 'build', producer: 'hold-drain:boot-a', workRef: 'run-9', generation: 0,
    }),
  ])
  expect(f.admission.listLeases().map((l) => l.reason)).toEqual(['build', 'queuedDispatch'])
  // Another owner's leases are never this owner's to reconcile.
  expect(other.listLeases().map((l) => l.workRef)).toEqual(['foreign-run'])
  // forDispatch is the same admission, scoped: its lease is a `build` lease.
  const dispatch = f.admission.forDispatch('alpha', 'work-board')
  const out = await dispatch.admit('run-10')
  expect(out.status).toBe('admitted')
  expect(f.admission.listLeases('build').map((l) => l.workRef)).toEqual(['run-9', 'run-10'])
  if (out.status === 'admitted') expect(await out.release()).toBe(true)
  expect(f.admission.listLeases('build').map((l) => l.workRef)).toEqual(['run-9'])
})

const childLeases = (admission: ProjectAdmission): Array<[string | null, string, number]> =>
  admission.listLeases('liveChild').map((l) => [l.scope.projectId, l.workRef, l.generation])

test('native child pending identities are exact-scope, durable and never expose release authority', async () => {
  const f = fixture()
  seedProject(f.db, 'general')
  await f.admission.forNativeChild(null).admit('run', 'one')
  await f.admission.forNativeChild('general').admit('run', 'two')
  const other = new ProjectAdmission({ db: f.db, ownerHandle: 'other-owner', bootId: 'other' })
  await other.forNativeChild(null).admit('foreign', 'three')
  const expected = [{ runId: 'run', stepId: 'one', generation: 0 }]
  expect(f.admission.forNativeChild(null).pending!()).toEqual(expected)
  expect(f.open('restart').admission.forNativeChild(null).pending!()).toEqual(expected)
  expect(f.admission.forNativeChild('general').pending!()).toEqual([{ runId: 'run', stepId: 'two', generation: 0 }])
  f.db.runSync("UPDATE project_admission_leases SET work_ref = 'malformed' WHERE work_ref = ?", ['["run","one"]'])
  expect(() => f.admission.forNativeChild(null).pending!()).toThrow()
  expect(f.admission.forNativeChild('general').pending!()).toHaveLength(1)
})

test('a native child JOINS its run under a draining fence, under the parent generation (#1237)', async () => {
  const { admission } = fixture()
  const run = await admission.forDispatch(null, 'work-board').admit('run-1')
  expect(run.status).toBe('admitted')
  const fence = (await admission.maintenance.beginMaintenance(admission.scopeFor(null)))!
  expect(fence.generation).toBe(1)

  // Guard: the admitted run's child drains with it — the fence does not strand it.
  const child = await admission.forNativeChild(null).admit('run-1', 'build:0')
  expect(child.status).toBe('admitted')
  if (child.status !== 'admitted') return
  expect(child.generation).toBe(0)
  const row = admission.listLeases('liveChild')[0]!
  expect(row).toMatchObject({ reason: 'liveChild', producer: 'native-child:boot-a', workRef: '["run-1","build:0"]', generation: 0 })

  // Opposite control: a run with NO build lease has no drain right; the fence refuses it.
  expect(await admission.forNativeChild(null).admit('run-unleased', 'build:0'))
    .toEqual({ status: 'fenced', phase: 'draining' })
  expect(childLeases(admission)).toEqual([[null, '["run-1","build:0"]', 0]])

  // Quiescence stays exact: the fence cannot leave draining while the child row exists.
  if (run.status === 'admitted') expect(await run.release()).toBe(true)
  expect(await admission.maintenance.advance(fence)).toBeNull()
  // The child's release is token-bound and idempotent.
  expect(await child.release()).toBe(true)
  expect(await child.release()).toBe(false)
  expect((await admission.maintenance.advance(fence))?.phase).toBe('quiesced')
})

test('a native child of an open scope with no build lease admits as ordinary work; unknown scopes refuse', async () => {
  const { admission } = fixture()
  const child = await admission.forNativeChild(null).admit('run-free', 'plan:0')
  expect(child.status).toBe('admitted')
  expect(childLeases(admission)).toEqual([[null, '["run-free","plan:0"]', 0]])
  expect(await admission.forNativeChild('ghost').admit('run-free', 'plan:0')).toEqual({ status: 'unknown' })
  expect(admission.inspect('ghost')).toBeNull()
})

test('releaseBuild preserves every unresolved child; completion releases only the exact request', async () => {
  const { admission } = fixture()
  await admission.forDispatch(null, 'work-board').admit('run-1')
  await admission.forDispatch(null, 'work-board').admit('run-2')
  await admission.forNativeChild(null).admit('run-1', 'plan:0')
  await admission.forNativeChild(null).admit('run-1', 'build:0')
  await admission.forNativeChild(null).admit('run-2', 'plan:0')
  expect(await admission.releaseBuild(null, 'run-1')).toBe(1)
  expect(await admission.releaseBuild(null, 'run-1')).toBe(0)
  // Control: the other run keeps both of its rows.
  expect(admission.listLeases('liveChild')).toHaveLength(3)
  expect(await admission.forNativeChild(null).complete('run-1', 'plan:0')).toBe(1)
  expect(admission.listLeases('liveChild').map(l => l.workRef)).toEqual([
    '["run-1","build:0"]', '["run-2","plan:0"]',
  ])
})

test('generationFor reads a live scope\'s current generation and is undefined for an unknown scope', async () => {
  const { db, admission } = fixture()
  expect(await admission.generationFor(null)).toBe(0)
  await admission.maintenance.beginMaintenance(admission.scopeFor(null))
  expect(await admission.generationFor(null)).toBe(1)
  expect(await admission.generationFor('ghost')).toBeUndefined()
  expect(admission.inspect('ghost')).toBeNull()
  seedProject(db, 'ghost')
  expect(await admission.generationFor('ghost')).toBe(0)
})

test('RESTART / lost acknowledgement: a child lease written by one connection is released through a second', async () => {
  const f = fixture()
  await f.admission.forDispatch(null, 'work-board').admit('run-x')
  // The child's acknowledgement is lost with the process: no handle survives.
  expect((await f.admission.forNativeChild(null).admit('run-x', 'build:0')).status).toBe('admitted')
  const restarted = f.open('boot-b').admission
  expect(childLeases(restarted)).toEqual([[null, '["run-x","build:0"]', 0]])
  expect(await restarted.releaseBuild(null, 'run-x')).toBe(1)
  expect(restarted.inspect(null)?.leases).toBe(1)
  expect(await restarted.forNativeChild(null).complete('run-x', 'build:0')).toBe(1)
  expect(restarted.inspect(null)?.leases).toBe(0)
})
