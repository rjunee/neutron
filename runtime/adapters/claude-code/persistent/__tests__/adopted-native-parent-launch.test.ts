import { expect, test } from 'bun:test'
import { prepareAdoptedNativeParentLaunch, type AdoptedNativeLaunchDeps } from '../adopted-native-parent-launch.ts'
import { readNativeParentLaunchEvidence } from '../native-parent-launch-evidence.ts'
import type { HandleInspection } from '../pty-host.ts'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { capacityFixture } from '../../../../workers/claude-capacity-client.test-support.ts'
import { NATIVE_RELAY_BASE_URL } from '../../../../workers/claude-capacity-client.ts'
import { readProcessIdentity } from '../process-identity.ts'

function fixture() {
  const argv = ['claude', '--resume', 'session', '--tools', 'Agent,SendMessage',
    '--dangerously-load-development-channels', 'server:channel']
  const state = { identity: { boot_id: 'boot', start_ticks: 10 }, argv: [...argv], current: true,
    host: { kind: 'live', pid: 42, argv: [...argv] } as HandleInspection }
  const input = { pid: 42, sessionId: 'session', childGeneration: 'generation', projectId: 'project',
    channelName: 'channel', cwd: '/tmp', claudeBasename: 'claude', argv,
    inspect: async () => state.host }
  const deps: AdoptedNativeLaunchDeps = {
    loadRelayPin: () => undefined,
    readIdentity: () => state.identity, readArgv: () => state.argv,
    observeExecutable: async (path, _cwd, env) => {
      expect(path).toBe('/proc/42/exe')
      expect(env).toEqual({})
      return { executable: { realPath: '/opt/claude.exe', version: '2.1.285', sha256: 'measured' }, isCurrent: () => state.current }
    },
  }
  return { input, deps, state }
}

test('remeasures exact live parent and binds only when adoption publishes', async () => {
  const f = fixture(), session = {}
  const prepared = await prepareAdoptedNativeParentLaunch(f.input, f.deps)
  expect(prepared).toBeDefined()
  expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
  prepared!.record(session)
  expect(readNativeParentLaunchEvidence(session)).toMatchObject({ sessionId: 'session', childGeneration: 'generation',
    projectId: 'project', argv: f.input.argv, tools: ['Agent', 'SendMessage'], executable: { sha256: 'measured' } })
})

test('missing identity, foreign host/PID/argv/session/channel and ambiguous grants refuse evidence', async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.deps.readIdentity = () => undefined },
    f => { f.deps.readArgv = () => undefined },
    f => { f.state.host = { kind: 'unavailable', reason: 'unreadable' } },
    f => { f.state.host = { kind: 'live', pid: 43, argv: f.input.argv } },
    f => { f.state.argv[0] = 'other' },
    f => { f.input.sessionId = 'foreign' },
    f => { f.input.channelName = 'foreign' },
    f => { f.input.projectId = '' },
    f => { f.input.childGeneration = '' },
    f => { f.input.argv.push('--tools', 'Agent'); f.state.argv = [...f.input.argv] },
    f => { f.input.argv.push('--session-id', 'session'); f.state.argv = [...f.input.argv] },
    f => { f.input.argv[4] = 'Agent'; f.state.argv = [...f.input.argv] },
    f => { f.deps.observeExecutable = async () => undefined },
  ]
  for (const change of cases) {
    const f = fixture(); change(f)
    expect(await prepareAdoptedNativeParentLaunch(f.input, f.deps)).toBeUndefined()
  }
})

test('recycled PID, changed boot, argv or executable before publication never stamp', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.identity = { ...f.state.identity, start_ticks: 11 } },
    (f: ReturnType<typeof fixture>) => { f.state.identity = { ...f.state.identity, boot_id: 'other-boot' } },
    (f: ReturnType<typeof fixture>) => { f.state.argv[4] = 'Agent' },
    (f: ReturnType<typeof fixture>) => { f.state.current = false },
  ]) {
    const f = fixture(), session = {}
    const prepared = await prepareAdoptedNativeParentLaunch(f.input, f.deps)
    expect(prepared).toBeDefined()
    change(f)
    prepared!.record(session)
    expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
  }
})

test('identity change inside image measurement refuses preparation', async () => {
  const f = fixture(), observe = f.deps.observeExecutable!
  f.deps.observeExecutable = async (...args) => {
    const result = await observe(...args)
    f.state.identity = { ...f.state.identity, start_ticks: 12 }
    return result
  }
  expect(await prepareAdoptedNativeParentLaunch(f.input, f.deps)).toBeUndefined()
})

async function relayFixture() {
  const host = await capacityFixture(), f = fixture()
  const token = randomBytes(32).toString('base64url')
  const state = { environment: `ANTHROPIC_UNIX_SOCKET=${host.pin.socketPath}\0ANTHROPIC_BASE_URL=${NATIVE_RELAY_BASE_URL}\0ANTHROPIC_CUSTOM_HEADERS=x-neutron-native-scope: ${token}\0` }
  f.input.pid = process.pid
  f.state.host = { kind: 'live', pid: process.pid, argv: f.input.argv }
  f.deps.readIdentity = readProcessIdentity
  f.deps.observeExecutable = async () => ({ executable: { realPath: '/opt/claude.exe', version: '2.1.285', sha256: 'measured' }, isCurrent: () => true })
  f.deps.loadRelayPin = () => host.pin
  f.deps.readEnvironment = () => state.environment
  return { ...f, host, token, route: state }
}

test('adopted survivor recovers a signed relay for its original exact physical parent and token', async () => {
  const f = await relayFixture(), session = {}
  try {
    const prepared = await prepareAdoptedNativeParentLaunch(f.input, f.deps)
    expect(prepared).toBeDefined()
    expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
    expect(f.host.requests).toHaveLength(1)
    expect(f.host.requests[0]).toMatchObject({ kind: 'claude-native-register', scopeToken: f.token,
      parentPid: process.pid, parentSessionId: 'session', parentStartTicks: readProcessIdentity(process.pid)!.start_ticks })
    prepared!.record(session)
    expect(readNativeParentLaunchEvidence(session)?.relay).toMatchObject({ scopeToken: f.token,
      registration: { body: { kind: 'claude-native-registered', parentPid: process.pid, parentSessionId: 'session' } } })
    expect(readNativeParentLaunchEvidence(session)?.relay?.registration.signature).toBeTruthy()
  } finally { await f.host.close() }
})

test('missing, foreign, old-protocol, duplicate or unreadable original route cannot be promoted', async () => {
  const changes = [
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.route.environment = '' },
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.route.environment = f.route.environment.replace(f.token, 'invalid') },
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.route.environment = f.route.environment.replace(f.host.pin.socketPath, '/foreign.sock') },
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.route.environment = f.route.environment.replace(NATIVE_RELAY_BASE_URL, 'http://127.0.0.1:1234') },
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.route.environment += `ANTHROPIC_UNIX_SOCKET=${f.host.pin.socketPath}\0` },
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.route.environment = f.route.environment.replace(f.token, `${f.token}\nx-neutron-native-scope: ${f.token}`) },
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.deps.readEnvironment = () => { throw new Error('unreadable') } },
    (f: Awaited<ReturnType<typeof relayFixture>>) => { f.deps.loadRelayPin = () => { throw new Error('invalid protected pin') } },
  ]
  for (const change of changes) {
    const f = await relayFixture()
    try {
      change(f)
      expect(await prepareAdoptedNativeParentLaunch(f.input, f.deps)).toBeUndefined()
      expect(f.host.requests).toHaveLength(0)
    } finally { await f.host.close() }
  }
})

test('host signature and actual physical-parent identity are verified, not reconstructed from labels', async () => {
  for (const failure of ['signature', 'parent'] as const) {
    const f = await relayFixture()
    try {
      if (failure === 'signature') {
        const publicKey = String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))
        f.deps.loadRelayPin = () => ({ ...f.host.pin, publicKey })
      } else {
        const identity = readProcessIdentity(process.pid)!
        f.deps.readIdentity = () => ({ ...identity, start_ticks: identity.start_ticks + 1 })
      }
      expect(await prepareAdoptedNativeParentLaunch(f.input, f.deps)).toBeUndefined()
      expect(f.host.requests).toHaveLength(1)
    } finally { await f.host.close() }
  }
})

test('route or protected pin changing before publication invalidates recovered authority', async () => {
  for (const failure of ['environment', 'pin'] as const) {
    const f = await relayFixture(), session = {}
    let currentPin: typeof f.host.pin | undefined = f.host.pin
    f.deps.loadRelayPin = () => currentPin
    try {
      const prepared = await prepareAdoptedNativeParentLaunch(f.input, f.deps)
      expect(prepared).toBeDefined()
      if (failure === 'environment') f.route.environment = f.route.environment.replace(f.token, randomBytes(32).toString('base64url'))
      else currentPin = undefined
      prepared!.record(session)
      expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
    } finally { await f.host.close() }
  }
})
