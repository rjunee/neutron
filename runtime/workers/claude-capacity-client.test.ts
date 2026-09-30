import { afterEach, expect, test } from 'bun:test'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import type { ClaudeCapacityInput } from './claude-capacity-client.ts'
import { capacityFixture } from './claude-capacity-client.test-support.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(mode = 'available') {
  const server = await capacityFixture(mode); cleanup.push(server.close)
  const input: ClaudeCapacityInput = { request: { model_id: 'fable' } as BoundedWorkRequest,
    leaseId: 'original-lease', childId: 'original-child', eventDigest: 'b'.repeat(64),
    relay: await server.register(), signal: new AbortController().signal, deadline: Date.now() + 1000 }
  return { ...server, input, run: () => server.acquire(input) }
}
test('registers and joins the original child before accepting signed native model and capacity', async () => {
  const f = await fixture(), result = await f.run()
  expect(result.kind).toBe('available')
  if (result.kind !== 'available') throw Error('Missing positive control')
  expect(f.requests.map(row => row.kind)).toEqual(['claude-native-register', 'claude-native-bind-child', 'claude-native-observe'])
  expect(result.receipt.body.capacity).toMatchObject({ modelId: 'claude-fable-5-1', accountGeneration: 'a'.repeat(64) })
  expect(result.current()).toBe(true); result.release(); expect(result.current()).toBe(false)
})
test('actual warm native model changes remain authoritative while bounded request aliases stay unchanged', async () => {
  const f = await fixture()
  expect((await f.run()).kind).toBe('available')
  f.setModel('claude-opus-4-6')
  const result = await f.run()
  expect(result.kind).toBe('available')
  if (result.kind === 'available') expect(result.receipt.body.capacity.modelId).toBe('claude-opus-4-6')
  expect(f.input.request.model_id).toBe('fable')
})
test('all-full waits; uncertainty and already successful native rotation never authorize continuation', async () => {
  const f = await fixture('all-full')
  expect(await f.run()).toMatchObject({ kind: 'waiting' })
  f.setMode('unknown'); expect(await f.run()).toEqual({ kind: 'unknown' })
  f.setMode('available'); f.setNativeStatus('available'); expect(await f.run()).toEqual({ kind: 'unknown' })
})
test.each(['forged', 'wrong-hostId', 'wrong-instanceId', 'wrong-bootId', 'wrong-challenge', 'wrong-modelId',
  'wrong-requestDigest', 'wrong-leaseId', 'wrong-childId', 'wrong-eventDigest', 'wrong-accountGeneration',
  'wrong-parentSessionId', 'wrong-parentPid', 'wrong-parentStartTicks', 'wrong-nativeAgentId', 'wrong-scopeDigest',
  'observation-sessionId', 'observation-nativeAgentId', 'observation-parentAgentId', 'observation-scopeDigest',
  'stale', 'future', 'extra-frame', 'disconnect'])('refuses %s evidence without changing the original binding', async mode => {
  const f = await fixture(mode)
  expect(await f.run()).toEqual({ kind: 'unknown' })
})
test.each(['scopeToken', 'parentPid', 'parentStartTicks', 'bootId', 'parentSessionId'] as const)('refuses changed original %s', async key => {
  const f = await fixture()
  if (key === 'scopeToken') f.input.relay.scopeToken = 'x'.repeat(43)
  else (f.input.relay.registration.body as unknown as Record<string, unknown>)[key] = 'foreign'
  expect(await f.run()).toEqual({ kind: 'unknown' })
  expect(f.requests).toHaveLength(1)
})
test('deadline and cancellation refuse; a completed control socket is not held as an account reservation', async () => {
  const f = await fixture('timeout'); f.input.deadline = Date.now() + 20
  expect(await f.run()).toEqual({ kind: 'unknown' })
  const g = await fixture(), controller = new AbortController(); g.input.signal = controller.signal
  const result = await g.run(); expect(result.kind).toBe('available')
  if (result.kind !== 'available') throw Error('Missing positive control')
  controller.abort(); expect(result.current()).toBe(false)
})
