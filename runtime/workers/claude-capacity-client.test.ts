import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { CLAUDE_CAPACITY_PIN_DIRECTORY, loadClaudeCapacityPin, nativeQuotaEpisodeId, nativeRelayRouteFingerprint, NativeRelayUnavailable,
  resolveClaudeCapacityPin, type ClaudeCapacityInput, type ClaudeContinuationControlInput } from './claude-capacity-client.ts'
import { capacityFixture, unprovisionedClaudeCapacityPin } from './claude-capacity-client.test-support.ts'
import { prepareNativeRequestRelay } from '../adapters/claude-code/persistent/native-request-relay.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(mode = 'available') {
  const server = await capacityFixture(mode); cleanup.push(server.close)
  const input: ClaudeCapacityInput = { request: { model_id: 'fable' } as BoundedWorkRequest,
    leaseId: 'original-lease', childId: 'original-child', eventDigest: 'b'.repeat(64),
    deadlineMs: Date.now() + 1000, budgetDigest: 'c'.repeat(64), fenceDigest: 'd'.repeat(64),
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

test('prepare and exact promotion echo the complete immutable intent and derive the successor from its native tool ID', async () => {
  const f = await fixture()
  const intent: ClaudeContinuationControlInput = { ...f.input, action: 'prepare',
    episodeId: nativeQuotaEpisodeId(f.input.leaseId, f.input.eventDigest, null), intentId: 'nonce', hostMessage: 'Complete original work. Receipt: nonce',
    deadlineMs: f.input.deadline, budgetDigest: 'c'.repeat(64), fenceDigest: 'd'.repeat(64) }
  expect(await f.control(intent)).toBe(true)
  const promote: ClaudeContinuationControlInput = { ...intent, action: 'promote', toolUseId: 'native-tool', resumedAgentId: f.input.childId }
  expect(await f.control(promote)).toBe(true)
  expect(await f.control(promote)).toBe(true)
  expect(await f.control({ ...promote, hostMessage: 'Altered message' })).toBe(false)
  expect(await f.control({ ...promote, deadlineMs: Date.now() - 1 })).toBe(false)
  expect(await f.control({ ...promote, resumedAgentId: 'foreign' })).toBe(false)
})

test.each(['episodeId', 'intentId', 'hostMessage', 'deadlineMs', 'budgetDigest', 'fenceDigest', 'state', 'requestDigest', 'leaseId', 'scopeDigest', 'challenge'])('signed continuation control rejects mismatched %s', async field => {
  const f = await fixture(`control-wrong-${field}`)
  expect(await f.control({ ...f.input, action: 'prepare', episodeId: nativeQuotaEpisodeId(f.input.leaseId, f.input.eventDigest, null),
    intentId: 'nonce', hostMessage: 'Original host message', deadlineMs: f.input.deadline, budgetDigest: 'c'.repeat(64), fenceDigest: 'd'.repeat(64) })).toBe(false)
})

test('an expired original deadline permits only a bounded cancellation control', async () => {
  const f = await fixture()
  const intent = { ...f.input, episodeId: nativeQuotaEpisodeId(f.input.leaseId, f.input.eventDigest, null),
    intentId: 'nonce', hostMessage: 'Original host message', deadlineMs: Date.now() + 30 }
  expect(await f.control({ ...intent, action: 'prepare' })).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 35))
  expect(await f.control({ ...intent, action: 'promote', toolUseId: 'tool', resumedAgentId: f.input.childId })).toBe(false)
  expect(await f.control({ ...intent, action: 'cancel', signal: AbortSignal.timeout(1000), deadline: Date.now() + 1000 })).toBe(true)
})

// POSITIVE CONTROL for the injected pin seam (host-suite-baseline-green). Tests
// that model an unregistered self-host inject an absent source; this proves the
// production loader itself still refuses a present broken pin in every consumer
// and that only absence selects native self-host authentication.
test('a present but untrusted pin refuses in every consumer and never falls back to native authentication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capacity-pin-control-'))
  const host = await capacityFixture(); cleanup.push(host.close)
  try {
    expect(loadClaudeCapacityPin(directory)).toBeUndefined()
    // A well-formed pin in a directory and file that are not root-protected:
    // present, therefore authoritative, and broken, therefore refused.
    await writeFile(join(directory, `${process.geteuid!()}.json`), JSON.stringify(host.pin), { mode: 0o600 })
    const broken = () => loadClaudeCapacityPin(directory)
    const consumers: (() => unknown)[] = [broken, () => resolveClaudeCapacityPin(broken),
      () => nativeRelayRouteFingerprint(broken),
      () => prepareNativeRequestRelay({ ANTHROPIC_API_KEY: 'synthetic-direct' }, broken)]
    for (const consumer of consumers) {
      let refused: unknown
      try { consumer() } catch (error) { refused = error }
      expect(refused).toBeInstanceOf(NativeRelayUnavailable)
      expect(refused).toMatchObject({ substrateErrorClass: 'repl_unreconciled' })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('an omitted pin source is the production loader, and only an injected source models an absent host', () => {
  const observe = (read: () => unknown) => {
    try { return { value: read() } } catch (error) { return { refused: error instanceof NativeRelayUnavailable } }
  }
  const production = observe(() => loadClaudeCapacityPin(CLAUDE_CAPACITY_PIN_DIRECTORY))
  expect(observe(() => resolveClaudeCapacityPin())).toEqual(production)
  expect(observe(() => loadClaudeCapacityPin())).toEqual(production)
  expect(observe(() => nativeRelayRouteFingerprint()))
    .toEqual(observe(() => nativeRelayRouteFingerprint(() => loadClaudeCapacityPin(CLAUDE_CAPACITY_PIN_DIRECTORY))))
  expect(resolveClaudeCapacityPin(unprovisionedClaudeCapacityPin)).toBeUndefined()
  expect(nativeRelayRouteFingerprint(unprovisionedClaudeCapacityPin)).toBeUndefined()
  expect(prepareNativeRequestRelay({}, unprovisionedClaudeCapacityPin)).toBeUndefined()
})
