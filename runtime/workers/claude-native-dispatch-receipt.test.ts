import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { createClaudeNativeDispatchReceipt, createNativeDispatchSigner, nativeDispatchReceiptPath,
  readClaudeNativeDispatchReceipt, verifyNativeDispatchNotSubmitted, type NativeDispatchLease,
  type SignedNativeDispatchRecord } from './claude-native-dispatch-receipt.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const request: BoundedWorkRequest = { run_id: 'run', step_id: 'run:plan:0', role: 'plan', model_id: 'model', effort: 'max',
  cwd: '/project', writable: true, network: true, tools: 'edit-and-run', brief: { path: '/brief', integrity: 'sha256:x' },
  result: { path: '/result', schema: 'project-plan-v2' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
const parent = { sessionId: 'native-session', childGeneration: 'native-generation', pid: 4321,
  processIdentity: { boot_id: 'kernel-boot', start_ticks: 42 } }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-dispatch-receipt-')); dirs.push(dir)
  const signer = createNativeDispatchSigner()
  const lease: NativeDispatchLease = { scope: { ownerHandle: 'owner', projectId: 'project' }, token: crypto.randomUUID(),
    generation: 2, reason: 'liveChild', producer: `native-child:boot:${signer.keyDigest}`, workRef: JSON.stringify([request.run_id, request.step_id]) }
  const authority = signer.begin(lease, request)
  const writer = createClaudeNativeDispatchReceipt(dir, request, authority)
  return { dir, signer, lease, authority, writer, path: nativeDispatchReceiptPath(dir, request),
    read: () => readClaudeNativeDispatchReceipt(dir, request) }
}

test('original pre-input refusal is signed, durable, exact and terminal across fresh verification', () => {
  const f = fixture()
  f.writer.record({ kind: 'parent-bound', parent })
  f.writer.record({ kind: 'not-submitted' })
  const receipt = f.read() as SignedNativeDispatchRecord
  expect(receipt.body.parent).toEqual(parent)
  expect(verifyNativeDispatchNotSubmitted(receipt, structuredClone(request), structuredClone(f.lease))).toBe(true)
  expect(() => f.authority.record({ kind: 'submission-started' })).toThrow('not open')
  expect(() => f.signer.begin(f.lease, request)).toThrow('fresh lease')
  expect(() => createClaudeNativeDispatchReceipt(f.dir, request, f.authority)).toThrow()
})

test('post-submit uncertainty and actual native child IDs never certify non-submission', () => {
  const f = fixture()
  f.writer.record({ kind: 'parent-bound', parent })
  f.writer.record({ kind: 'submission-started' })
  expect(verifyNativeDispatchNotSubmitted(f.read(), request, f.lease)).toBe(false)
  expect(() => f.authority.record({ kind: 'not-submitted' })).toThrow('Possibly submitted')
  f.writer.record({ kind: 'child-bound', nativeAgentId: 'real-native-id' })
  expect((f.read() as SignedNativeDispatchRecord).body.nativeAgentId).toBe('real-native-id')
  expect(verifyNativeDispatchNotSubmitted(f.read(), request, f.lease)).toBe(false)
})

test('worker mutation, foreign key, request, scope, token, generation and producer cannot release', () => {
  const f = fixture(); f.writer.record({ kind: 'not-submitted' })
  const original = f.read() as SignedNativeDispatchRecord
  for (const mutate of [
    (r: SignedNativeDispatchRecord) => { (r.body.request as { model_id: string }).model_id = 'other' },
    (r: SignedNativeDispatchRecord) => { r.body.lease.generation++ },
    (r: SignedNativeDispatchRecord) => { r.body.lease.token = 'other' },
    (r: SignedNativeDispatchRecord) => { r.body.lease.scope.projectId = null },
    (r: SignedNativeDispatchRecord) => { r.body.parent = { ...parent, childGeneration: 'foreign-generation' } },
    (r: SignedNativeDispatchRecord) => { r.body.nativeAgentId = 'invented-agent' },
    (r: SignedNativeDispatchRecord) => { r.body.lease.producer = 'native-child:legacy' },
    (r: SignedNativeDispatchRecord) => { r.signature = Buffer.alloc(64).toString('base64') },
    (r: SignedNativeDispatchRecord) => { r.publicKey = 'invalid' },
  ]) {
    const changed = structuredClone(original); mutate(changed)
    expect(verifyNativeDispatchNotSubmitted(changed, request, f.lease)).toBe(false)
  }
  const forged = fixture(); forged.writer.record({ kind: 'not-submitted' })
  expect(verifyNativeDispatchNotSubmitted(forged.read(), request, f.lease)).toBe(false)
  expect(verifyNativeDispatchNotSubmitted(original, { ...request, step_id: 'other' }, f.lease)).toBe(false)
  expect(verifyNativeDispatchNotSubmitted(original, request, { ...f.lease, generation: 3 })).toBe(false)
  expect(verifyNativeDispatchNotSubmitted(original, request, { ...f.lease, producer: 'native-child:legacy' })).toBe(false)
})

test('missing, torn, symlinked or oversized receipt is unknown; signed old proof cannot become post-submit proof', () => {
  const f = fixture(); f.writer.record({ kind: 'not-submitted' })
  const bytes = readFileSync(f.path)
  writeFileSync(f.path, bytes.subarray(0, bytes.length - 1)); expect(f.read()).toBeUndefined()
  writeFileSync(f.path, 'x'.repeat(1024 * 1024 + 1)); expect(f.read()).toBeUndefined()
  rmSync(f.path); expect(f.read()).toBeUndefined()
  const other = join(f.dir, 'other'); writeFileSync(other, bytes); symlinkSync(other, f.path)
  expect(f.read()).toBeUndefined()
})
