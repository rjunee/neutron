import { expect, spyOn, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import type { Socket } from 'node:net'
import {
  assertRootProtectedPath, loadNativeHostRecoveryAuthority, nativeHostRecoveryConfigPath,
  requestNativeHostBoot,
} from '../native-host-recovery-authority.ts'
import * as authorityLoader from '../native-host-recovery-authority.ts'
import * as composition from '../composer.ts'
import { startOpenServer } from '../server.ts'
import { createIsolatedHome } from '../../tests/support/test-isolation.ts'

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const config = { version: 1, publicKey, hostId: 'operator-host', instanceId: 'install', socketPath: '/run/neutron-host-recovery/attestor.sock' }

test('fixed effective-UID configuration supplies the pin and challenged Unix transport', async () => {
  const reads: string[] = []; const calls: unknown[] = []
  const authority = loadNativeHostRecoveryAuthority({ uid: () => 1234,
    read: path => { reads.push(path); return config },
    request: async (...args) => { calls.push(args.slice(0, 3)); return 'observation' } })!
  expect(reads).toEqual(['/etc/neutron/native-host-recovery/1234.json'])
  expect(authority.publicKey).toBe(publicKey)
  expect(await authority.attestBoot('fresh-challenge', new AbortController().signal)).toBe('observation')
  expect(calls).toEqual([[config.socketPath, 'install', 'fresh-challenge']])
  expect(Object.isFrozen(authority)).toBe(true)
  expect(loadNativeHostRecoveryAuthority({ uid: () => 1234, read: () => undefined })).toBeUndefined()
  expect(() => nativeHostRecoveryConfigPath(-1)).toThrow()
})

for (const malformed of [null, {}, { ...config, version: 2 }, { ...config, hostId: '' },
  { ...config, instanceId: '' }, { ...config, publicKey: 'untrusted' }, { ...config, socketPath: '../socket' },
  { ...config, socketPath: '/run/../run/socket' }]) {
  test(`present malformed authority refuses instead of dropping protection: ${JSON.stringify(malformed)?.slice(0, 35)}`, () => {
    expect(() => loadNativeHostRecoveryAuthority({ uid: () => 1234, read: () => malformed })).toThrow()
  })
}

function safeStat(path: string): Stats {
  return { uid: 0, mode: path.endsWith('.sock') ? 0o666 : 0o755, isSymbolicLink: () => false,
    isFile: () => path.endsWith('.json'), isSocket: () => path.endsWith('.sock'),
    isDirectory: () => !path.endsWith('.json') && !path.endsWith('.sock') } as unknown as Stats
}

test('root leaf and every ancestor must be protected; socket permission permits connections only', () => {
  const path = nativeHostRecoveryConfigPath(1234)
  const checked: string[] = []
  assertRootProtectedPath(path, 'file', entry => { checked.push(entry); return safeStat(entry) })
  expect(checked).toEqual([path, '/etc/neutron/native-host-recovery', '/etc/neutron', '/etc', '/'])
  assertRootProtectedPath(config.socketPath, 'socket', safeStat)
  for (const target of checked) {
    for (const patch of [{ uid: 1234 }, { mode: 0o777 }, { isSymbolicLink: () => true }]) {
      expect(() => assertRootProtectedPath(path, 'file', entry => entry === target ? { ...safeStat(entry), ...patch } as Stats : safeStat(entry))).toThrow()
    }
  }
  expect(() => assertRootProtectedPath(config.socketPath, 'socket', entry => entry === '/run' ? { ...safeStat(entry), mode: 0o777 } as Stats : safeStat(entry))).toThrow()
})

function socketFixture() {
  const socket = new EventEmitter() as EventEmitter & { destroy(): void; write(value: string): void }
  let destroyed = false
  const writes: string[] = []
  socket.destroy = () => { destroyed = true }
  socket.write = value => { writes.push(value) }
  return { socket, writes, destroyed: () => destroyed }
}

test('transport sends only request identity/challenge, decodes fragmented bounded response, and closes', async () => {
  const f = socketFixture(); const checked: string[] = []
  const reply = requestNativeHostBoot(config.socketPath, 'install', 'nonce', new AbortController().signal,
    { connect: () => f.socket as Socket, check: path => { checked.push(path) } })
  f.socket.emit('connect')
  expect(f.writes).toEqual(['{"version":1,"kind":"host-boot-request","instanceId":"install","challenge":"nonce"}\n'])
  expect(checked).toEqual([config.socketPath])
  f.socket.emit('data', Buffer.from('{"body":'))
  f.socket.emit('data', Buffer.from('{"kind":"host-boot"},"signature":"example"}\n'))
  expect(await reply).toEqual({ body: { kind: 'host-boot' }, signature: 'example' })
  expect(f.destroyed()).toBe(true)
})

for (const failure of ['aborted', 'too-large', 'invalid-json', 'multiple', 'end', 'error', 'close'] as const) {
  test(`transport fails closed and closes socket on ${failure}`, async () => {
    const f = socketFixture(); const controller = new AbortController()
    const reply = requestNativeHostBoot(config.socketPath, 'install', 'nonce', controller.signal,
      { connect: () => f.socket as Socket, check: () => {} })
    const rejected = reply.then(() => false, () => true)
    if (failure === 'aborted') controller.abort()
    else if (failure === 'too-large') f.socket.emit('data', Buffer.alloc(65_537))
    else if (failure === 'invalid-json') f.socket.emit('data', Buffer.from('invalid\n'))
    else if (failure === 'multiple') f.socket.emit('data', Buffer.from('{}\n{}\n'))
    else f.socket.emit(failure, new Error('unavailable'))
    expect(await rejected).toBe(true)
    expect(f.destroyed()).toBe(true)
  })
}

for (const malformed of [false, true]) test(`real server entrypoint carries operator authority or refuses before composition: malformed=${malformed}`, async () => {
  const home = createIsolatedHome({ extraEnvKeys: ['NEUTRON_GRAPH_COMPOSER_MODULE', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET', 'NEUTRON_OWNER_BEARER'],
    env: { NEUTRON_GRAPH_COMPOSER_MODULE: undefined, NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'isolated-cookie-secret-0123456789',
      NEUTRON_OWNER_BEARER: 'isolated-owner-bearer-01234567890123456789' } })
  const authority = loadNativeHostRecoveryAuthority({ uid: () => 1234, read: () => config })!
  const load = spyOn(authorityLoader, 'loadNativeHostRecoveryAuthority').mockImplementation(() => {
    if (malformed) throw new Error('unsafe operator configuration')
    return authority
  })
  const compose = spyOn(composition, 'buildOpenGraphComposer').mockImplementation(options => {
    expect(options?.nativeHostRecoveryAuthority).toBe(authority)
    throw new Error('composition reached')
  })
  try {
    await expect(startOpenServer()).rejects.toThrow(malformed ? 'unsafe operator configuration' : 'composition reached')
    expect(load).toHaveBeenCalledTimes(1)
    expect(compose).toHaveBeenCalledTimes(malformed ? 0 : 1)
  } finally { compose.mockRestore(); load.mockRestore(); home.restore() }
})
