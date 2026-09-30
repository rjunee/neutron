import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { createNativeDispatchSigner } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { seedProject } from './wiring/__tests__/project-admission-fixture.ts'
import { ProjectAdmission } from './project-admission.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const request: BoundedWorkRequest = { run_id: 'run', step_id: 'run:plan:0', role: 'plan', model_id: 'model', effort: null,
  cwd: '/project', writable: true, network: true, tools: 'edit-and-run', brief: { path: '/brief', integrity: 'digest' },
  result: { path: '/result', schema: 'project-plan-v2' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-dispatch-admission-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  seedMigratedDb(join(dir, 'db'))
  const db = ProjectDb.open(join(dir, 'db')); cleanup.push(() => db.close())
  seedProject(db, 'general')
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'original' })
  const port = admission.forNativeChild(null)
  const child = await port.admit(request.run_id, request.step_id)
  if (child.status !== 'admitted') throw new Error('Expected admitted child')
  const authority = port.dispatchAuthority!(child.lease, request)
  authority.prepare()
  return { db, path: join(dir, 'db'), admission, port, child, authority }
}

test('fresh gateway verifies original signed refusal and releases exactly original token once', async () => {
  const f = await fixture()
  const receipt = f.authority.record({ kind: 'not-submitted' })
  // Same request in another generation, project, and token must survive.
  await f.admission.maintenance.beginMaintenance(f.admission.scopeFor(null))
  const fence = f.admission.maintenance.resume(f.admission.scopeFor(null))!
  await f.admission.maintenance.abandon(fence)
  await f.port.admit(request.run_id, request.step_id)
  await f.admission.forNativeChild('general').admit(request.run_id, request.step_id)
  const reopened = ProjectDb.open(f.path); cleanup.push(() => reopened.close())
  const restart = new ProjectAdmission({ db: reopened, ownerHandle: 'owner', bootId: 'restart' })
  expect(restart.producerFor('native-child')).not.toBe(f.admission.producerFor('native-child'))
  expect(await restart.forNativeChild(null).releaseUnsubmitted!(request, receipt)).toBe(true)
  expect(restart.listLeases('liveChild')).toHaveLength(2)
  expect(restart.listLeases('liveChild').some(row => row.token === f.child.lease.token)).toBe(false)
  expect(await restart.forNativeChild(null).releaseUnsubmitted!(request, receipt)).toBe(false)
  expect(restart.listLeases('liveChild')).toHaveLength(2)
})

test('forged, altered, foreign-scoped and legacy receipts do not affect stored lease', async () => {
  const f = await fixture()
  const receipt = f.authority.record({ kind: 'not-submitted' })
  expect(await f.admission.forNativeChild('general').releaseUnsubmitted!(request, receipt)).toBe(false)
  expect(await f.port.releaseUnsubmitted!({ ...request, model_id: 'changed' }, receipt)).toBe(false)
  const altered = structuredClone(receipt); altered.body.lease.generation++
  expect(await f.port.releaseUnsubmitted!(request, altered)).toBe(false)
  const malicious = createNativeDispatchSigner()
  const counterfeit = malicious.begin({ ...receipt.body.lease, producer: `native-child:original:${malicious.keyDigest}` }, request)
  counterfeit.prepare()
  expect(await f.port.releaseUnsubmitted!(request, counterfeit.record({ kind: 'not-submitted' }))).toBe(false)
  expect(f.admission.listLeases('liveChild')).toHaveLength(1)
  f.db.runSync('UPDATE project_admission_leases SET producer = ? WHERE token = ?', ['native-child:original', f.child.lease.token])
  expect(await f.port.releaseUnsubmitted!(request, receipt)).toBe(false)
  expect(f.admission.hasUnresolvedNativeChildForChat(null)).toBe(true)
})

test('submission intent, lost acknowledgement, wrong request and re-signing all remain fenced', async () => {
  const f = await fixture()
  expect(() => f.port.dispatchAuthority!(f.child.lease, request)).toThrow('fresh lease')
  f.authority.record({ kind: 'parent-bound', parent: { sessionId: 'session', childGeneration: 'generation', pid: 42, processIdentity: null } })
  const started = f.authority.record({ kind: 'submission-started' })
  f.port.finishPreparing!(f.child.lease)
  expect(await f.port.releaseUnsubmitted!(request, started)).toBe(false)
  expect(() => f.authority.record({ kind: 'not-submitted' })).toThrow('Possibly submitted')
  expect(f.admission.hasUnresolvedNativeChildForChat(null)).toBe(true)
  expect(f.admission.listLeases('liveChild')).toHaveLength(1)
  expect(() => f.port.dispatchAuthority!(f.child.lease, { ...request, step_id: 'foreign' })).toThrow('unavailable')
})

test('native continuation claims once across database connections and retains the original lease', async () => {
  const f = await fixture()
  f.authority.record({ kind: 'parent-bound', parent: { sessionId: 'session', childGeneration: 'generation', pid: 42, processIdentity: null } })
  f.authority.record({ kind: 'submission-started' })
  const receipt = f.authority.record({ kind: 'child-bound', nativeAgentId: 'child' })
  const reopened = ProjectDb.open(f.path); cleanup.push(() => reopened.close())
  const restart = new ProjectAdmission({ db: reopened, ownerHandle: 'owner', bootId: 'restart' })
  const original = f.port.continuation!(request, receipt)!
  const recovered = restart.forNativeChild(null).continuation!(request, receipt)!
  expect(original.current()).toBe(true)
  expect(recovered.current()).toBe(true)
  expect(original.read()).toBeUndefined()
  const claims = await Promise.all([original.claim('a'.repeat(64), 'original-preparation'), recovered.claim('a'.repeat(64), 'second-preparation')])
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect(original.read()).toBe(recovered.read())
  expect(await recovered.claim('a'.repeat(64), 'third-preparation')).toBe(false)
  expect(await recovered.claim('b'.repeat(64), 'successor-preparation')).toBe(true)
  expect(recovered.read()).toBe('successor-preparation')
  expect(await recovered.claim('a'.repeat(64), 'old-delayed-preparation')).toBe(false)
  expect(restart.listLeases('liveChild')).toHaveLength(1)
  expect(restart.forNativeChild('general').continuation!(request, receipt)).toBeUndefined()
  expect(restart.forNativeChild(null).continuation!({ ...request, model_id: 'foreign' }, receipt)).toBeUndefined()
})

test('native continuation refuses a fence installed after authentication and cannot refund a spent lease', async () => {
  const f = await fixture()
  f.authority.record({ kind: 'parent-bound', parent: { sessionId: 'session', childGeneration: 'generation', pid: 42, processIdentity: null } })
  f.authority.record({ kind: 'submission-started' })
  const receipt = f.authority.record({ kind: 'child-bound', nativeAgentId: 'child' })
  const continuation = f.port.continuation!(request, receipt)!
  expect(continuation.current()).toBe(true)
  await f.admission.maintenance.beginMaintenance(f.admission.scopeFor(null))
  expect(continuation.current()).toBe(false)
  expect(await continuation.claim('a'.repeat(64), 'must-not-send')).toBe(false)
  expect(continuation.read()).toBeUndefined()
  expect(f.admission.listLeases('liveChild')).toHaveLength(1)
})
