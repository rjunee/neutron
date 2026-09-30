import { afterEach, expect, test } from 'bun:test'
import { prepareNativeRequestRelay, readNativeRequestRelay } from '../native-request-relay.ts'
import { capacityFixture } from '../../../../workers/claude-capacity-client.test-support.ts'
import { nativeRelayRouteFingerprint } from '../../../../workers/claude-capacity-client.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
test('native launch uses one registered socket and OAuth mode while preserving native model selection', async () => {
  const host = await capacityFixture(); cleanup.push(host.close)
  const source = { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-old', ANTHROPIC_API_KEY: 'synthetic-paid',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-other', ANTHROPIC_CUSTOM_HEADERS: 'authorization: unsafe\nx-api-key: unsafe\nx-neutron-native-scope: stale\nx-custom: intended',
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '4', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1' }
  const launch = prepareNativeRequestRelay(source, host.pin)!
  expect(launch.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'ssh-placeholder', ANTHROPIC_UNIX_SOCKET: host.pin.socketPath,
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1' })
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK']) expect(launch.env[key]).toBeUndefined()
  expect(launch.env.ANTHROPIC_CUSTOM_HEADERS).toMatch(/^x-custom: intended\nx-neutron-native-scope: [A-Za-z0-9_-]{43}$/)
  const parent = { sessionId: 'parent', child: { pid: process.pid } }
  expect(readNativeRequestRelay(parent)).toBeUndefined()
  await launch.register(parent)
  expect(readNativeRequestRelay(parent)?.registration.body).toMatchObject({ parentSessionId: 'parent', parentPid: process.pid })
  expect(source.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-old')
})
test('route identity remains stable without account credentials and changes with host authority', async () => {
  const host = await capacityFixture(); cleanup.push(host.close)
  const route = nativeRelayRouteFingerprint(host.pin)
  expect(route).toMatch(/^native-relay-v2:[a-f0-9]{64}$/)
  expect(nativeRelayRouteFingerprint({ ...host.pin })).toBe(route)
  for (const [key, value] of [['hostId', 'another-host'], ['instanceId', 'another-instance'], ['socketPath', '/another.sock']] as const) {
    expect(nativeRelayRouteFingerprint({ ...host.pin, [key]: value })).not.toBe(route)
  }
  const other = await capacityFixture(); cleanup.push(other.close)
  expect(nativeRelayRouteFingerprint({ ...host.pin, publicKey: other.pin.publicKey })).not.toBe(route)
})
test('missing process and dead registered socket fail as local refusal without any scope publication', async () => {
  const host = await capacityFixture()
  const launch = prepareNativeRequestRelay({}, host.pin)!
  const unknown = { sessionId: 'parent', child: { pid: -1 } }
  await expect(launch.register(unknown)).rejects.toMatchObject({ substrateErrorClass: 'repl_unreconciled' })
  expect(readNativeRequestRelay(unknown)).toBeUndefined()
  await host.close()
  const live = { sessionId: 'parent', child: { pid: process.pid } }
  await expect(launch.register(live)).rejects.toMatchObject({ substrateErrorClass: 'repl_unreconciled' })
  expect(readNativeRequestRelay(live)).toBeUndefined()
})
