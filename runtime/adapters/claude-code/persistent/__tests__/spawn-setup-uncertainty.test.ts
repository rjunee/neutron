import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as capacity from '../../../../workers/claude-capacity-client.ts'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPersistentReplSubstrate } from '../persistent-repl-substrate.ts'
import { childByKey } from '../pool-state.ts'
import { poolKeyFor } from '../pool.ts'
import { loadRegistry } from '../repl-registry.ts'
import type { PtyHost } from '../pty-host.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import { lifecycleReplHost } from './lifecycle-repl-host.ts'

let unregisteredPin: ReturnType<typeof spyOn>
let unregisteredRoute: ReturnType<typeof spyOn>
beforeEach(() => {
  // Fake children exercise native self-host lifecycle, not host registration.
  unregisteredPin = spyOn(capacity, 'loadClaudeCapacityPin').mockReturnValue(undefined)
  unregisteredRoute = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
})
afterEach(() => {
  unregisteredRoute.mockRestore()
  unregisteredPin.mockRestore()
})

test.each([false, true])('failed setup refuses repeated starts until exact child exit, then recovers (registry=%s)', async registry => {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-spawn-retry-'))
  const peer = lifecycleReplHost()
  const configs: string[] = []
  const realKills: Array<() => void> = []
  const host: PtyHost = { async spawn(argv, options) {
    const configPath = argv[argv.indexOf('--mcp-config') + 1]!
    configs.push(configPath)
    if (peer.children.length === 0) {
      writeFileSync(configPath.replace(/-mcp\.json$/, '-mcp-identity.json'), 'occupied receipt', { flag: 'wx', mode: 0o600 })
    }
    const child = await peer.host.spawn(argv, options)
    realKills.push(child.kill.bind(child))
    if (peer.children.length === 1) child.kill = () => {}
    return child
  } }
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: `spawn-retry-${registry}`, cwd: dir,
    ...(registry ? { replRegistryPath: join(dir, 'registry.json') } : {}),
    ptyHost: host, skipTrustSeed: true, idleQuietMs: 0,
  }
  const key = poolKeyFor(options)
  const sub = createPersistentReplSubstrate(options)
  const start = async () => {
    const events = []
    for await (const event of sub.start({ prompt: 'hello', tools: [], model_preference: ['claude-opus-4-7'] }).events) events.push(event)
    return events
  }
  try {
    expect((await start()).some(event => event.kind === 'error' && event.message.includes('child exit is unproven'))).toBe(true)
    expect(peer.children).toHaveLength(1)
    const failed = peer.children[0]!.child
    const receipt = configs[0]!.replace(/-mcp\.json$/, '-mcp-identity.json')
    for (let attempt = 0; attempt < 2; attempt++) {
      const events = await start()
      expect(peer.children).toHaveLength(1)
      expect(events.some(event => event.kind === 'error' && event.message.includes('child exit is unproven'))).toBe(true)
      expect(failed.hasExited()).toBe(false)
      expect(childByKey.get(key)).toBe(failed)
      expect(existsSync(configs[0]!)).toBe(true)
      expect(existsSync(receipt)).toBe(true)
    }
    realKills[0]!()
    await failed.exited
    expect(existsSync(configs[0]!)).toBe(false)
    expect(existsSync(receipt)).toBe(false)
    expect(childByKey.has(key)).toBe(false)
    if (options.replRegistryPath) expect(loadRegistry(options.replRegistryPath)[key]?.spawn_reservation_by).toBeUndefined()
    expect((await start()).some(event => event.kind === 'completion')).toBe(true)
    expect(peer.children).toHaveLength(2)
    expect(peer.children[1]!.child.hasExited()).toBe(false)
    expect(childByKey.get(key)).toBe(peer.children[1]!.child)
  } finally {
    for (const kill of realKills) kill()
    for (const { child } of peer.children) await child.exited
    childByKey.delete(key)
    for (const configPath of configs) rmSync(dirname(configPath), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

test.each([false, true])('failed setup retains ownership evidence only while child exit is unproven (uncertain=%s)', async uncertain => {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-spawn-uncertainty-'))
  const peer = lifecycleReplHost()
  let configPath = ''
  let receiptPath = ''
  let realKill: (() => void) | undefined
  let kills = 0
  const host: PtyHost = { async spawn(argv, options) {
    configPath = argv[argv.indexOf('--mcp-config') + 1]!
    receiptPath = configPath.replace(/-mcp\.json$/, '-mcp-identity.json')
    writeFileSync(receiptPath, 'occupied receipt', { flag: 'wx', mode: 0o600 })
    const child = await peer.host.spawn(argv, options)
    realKill = child.kill.bind(child)
    child.kill = () => { kills++; if (!uncertain) realKill!() }
    return child
  } }
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: `spawn-uncertainty-${uncertain}`, cwd: dir,
    replRegistryPath: join(dir, 'registry.json'), ptyHost: host,
    skipTrustSeed: true, idleQuietMs: 0,
  }
  const key = poolKeyFor(options)
  try {
    const events = []
    const sub = createPersistentReplSubstrate(options)
    for await (const event of sub.start({ prompt: 'hello', tools: [], model_preference: ['claude-opus-4-7'] }).events) events.push(event)
    expect(peer.children).toHaveLength(1)
    const child = peer.children[0]!.child
    expect(events.some(event => event.kind === 'error' && event.message.includes(uncertain ? 'child exit is unproven' : 'EEXIST'))).toBe(true)
    expect(kills).toBe(uncertain ? 2 : 1)
    expect(child.hasExited()).toBe(!uncertain)
    expect(childByKey.get(key)).toBe(uncertain ? child : undefined)
    expect(existsSync(configPath)).toBe(uncertain)
    expect(existsSync(receiptPath)).toBe(uncertain)
    const reservation = loadRegistry(options.replRegistryPath!)[key]?.spawn_reservation_by
    if (uncertain) expect(reservation).toEqual(expect.any(String))
    else expect(reservation).toBeUndefined()
  } finally {
    realKill?.()
    for (const { child } of peer.children) await child.exited
    childByKey.delete(key)
    // These directories belong only to this injected fake-host attempt.
    if (configPath) rmSync(dirname(configPath), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}, 10_000)
