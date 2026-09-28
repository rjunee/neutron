import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'
import { openDurableCodexOwner } from '../wiring/codex-durable-owner.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import type { CodexOwnerBinding, CodexOwnerBindingFacts, CodexOwnerBootstrap } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import * as probe from '@neutronai/runtime/adapters/codex-cli/persistent/project-account-probe.ts'
import { acknowledgeAccountHandoff, readGeneralOwnerAuthority, stageAccountHandoff } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-account-handoff.ts'
import type { CodexOwnerRetirementReceipt } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-retirement.ts'
import { ownerWorkspaceLaunch } from '../wiring/project-build-terminal.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const write = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
const exited = { pid: 1, boot: 'previous-fixture-boot', start: '1' }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }

function fixture(alias = false) {
  const root = mkdtempSync(join(tmpdir(), 'general-handoff-consumer-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const homes = [join(root, 'first'), join(root, 'second')]
  for (const home of homes) mkdirSync(home, { mode: 0o700 })
  const aliasRoot = join(root, 'alias')
  if (alias) symlinkSync(root, aliasRoot)
  const credentials = ['fixture-first', 'fixture-second'].map((account, index) => {
    write(join(homes[index]!, 'auth.json'), { tokens: { account_id: account, access_token: 'fixture-access', refresh_token: 'fixture-refresh' } })
    return createHash('sha256').update(JSON.stringify(['chatgpt-account', account])).digest('hex')
  })
  const authorityPath = join(root, 'general.json')
  const projectWorkspace = ownerWorkspaceLaunch(root, { instanceId: 'instance', projectId: null, projectLabel: 'Neutron General' })
  const facts = new Map<CodexOwnerBinding, CodexOwnerBindingFacts>()
  const events: string[] = []
  let selected = 0, nativeStatus: 'idle' | 'busy' | 'unknown' = 'idle', failLaunch = false, missingAck = false
  let crashAfterRetirement = false
  let probeGate: Promise<void> | undefined, refusedProbe = false, sequence = 0
  const configured = new Set(homes)
  const preflight = spyOn(probe, 'probeCodexAccountViability').mockImplementation(async options => {
    events.push('probe')
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    expect(options.codexHome).toBe(homes[selected]!)
    await probeGate
    if (refusedProbe) throw new Error('Target account viability is unproven')
  })
  cleanup.push(() => preflight.mockRestore())
  const general = async (retained?: string) => {
    const home = retained ? realpathSync(retained) : homes[selected]!
    if (!configured.has(home)) throw new Error('Account grant unavailable')
    return { cwd: alias ? aliasRoot : root, codexHome: alias ? join(aliasRoot, homes.indexOf(home) === 0 ? 'first' : 'second') : home,
      credentialIdentity: credentials[homes.indexOf(home)]!, generalAuthorityPath: authorityPath,
      env: { OPENAI_API_KEY: 'must-not-reach-native' }, projectWorkspace }
  }
  const makeBindings = () => new CodexOwnerBindings(async () => { throw new Error('Explicit project grant required') }, async options => {
    expect(options.projectWorkspace).toEqual(projectWorkspace)
    const index = homes.indexOf(options.codexHome)
    events.push(`launch:${index}`)
    const scope = { projectId: null, cwd: root, codexHome: options.codexHome, credential: credentials[index] }
    if (!existsSync(authorityPath)) write(authorityPath, scope)
    const authority = readGeneralOwnerAuthority(authorityPath)!
    const directory = authority.rootDirectory
    if (authority.pending) stageAccountHandoff(authority.pending.locator)
    if (failLaunch && authority.pending) throw new Error('Successor launch uncertain')
    const rolloutPath = authority.pending?.handoff.rolloutPath ?? join(options.codexHome, 'sessions', 'rollout.jsonl')
    if (!existsSync(rolloutPath)) {
      mkdirSync(join(options.codexHome, 'sessions'), { mode: 0o700 })
      writeFileSync(rolloutPath, 'original conversation\n', { mode: 0o600 })
    }
    const binding = {} as CodexOwnerBinding
    const identity: CodexOwnerBindingFacts = { threadId: 'same-native-thread', sessionId: 'same-native-session', cwd: root,
      codexHome: options.codexHome, rolloutPath, paneHandle: `pane-${++sequence}`, bindingRevision: sequence.toString(16).padStart(64, '0'),
      generation: sequence, brokerGeneration: 1, credentialFingerprint: 'native-fingerprint', credentialIdentity: credentials[index]!,
      modelProvider: 'fixture', controlSocketPath: options.socketPath,
      nativeMetadata: { sessionId: 'same-native-session', source: 'cli', originator: 'neutron-owner-bootstrap' },
      capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } }
    facts.set(binding, identity)
    write(join(directory, '.neutron-owner-launch.json'), { scope })
    write(join(directory, '.neutron-owner-authority.json'), { facts: identity, helper: exited })
    if (authority.pending && !missingAck) { acknowledgeAccountHandoff(authority.pending.locator, identity); events.push('ack') }
    return { binding, writeTerminal() { throw new Error('Unexpected terminal input') }, async close() {},
      async refreshState() { return { phase: 'idle', epoch: 0, generation: 1, activeTurnId: null, unresolved: null } },
      async retire() {
        events.push('retire')
        if (nativeStatus !== 'idle') return { status: nativeStatus, reason: 'Native scope is not idle' }
        const receipt: CodexOwnerRetirementReceipt = { version: 1, facts: identity, helper: exited, terminal: exited,
          native: { identity: exited, code: 0, signal: null } }
        write(join(directory, '.neutron-owner-retired.json'), receipt)
        if (crashAfterRetirement) throw new Error('Injected gateway loss after completed retirement')
        return { status: 'retired', receipt }
      },
      broker: { state: () => ({ phase: 'idle', epoch: 0, generation: 1, activeTurnId: null, unresolved: null }),
        gateway: () => ({ subscribe: () => () => {}, close() {}, request: async () => ({}), reply() {} }), close() {} },
    } as CodexOwnerBootstrap
  }, binding => facts.get(binding)!, general)
  const bindings = makeBindings()
  const acquire = (host = bindings, projectId: string | null = null) => host.host.acquireTurn({ projectId, cwd: root, env: {} }, new AbortController().signal)
  return { root, homes, authorityPath, events, bindings, acquire, makeBindings,
    select: (index: number) => { selected = index }, revoke: (index: number) => configured.delete(homes[index]!),
    native: (status: typeof nativeStatus) => { nativeStatus = status },
    probeGate: (gate: Promise<void>) => { probeGate = gate }, refuseProbe: () => { refusedProbe = true },
    failLaunch: (value: boolean) => { failLaunch = value }, missingAck: () => { missingAck = true },
    crashAfterRetirement: () => { crashAfterRetirement = true } }
}

test('canonical General authority accepts configured path aliases without changing the account or project grant', async () => {
  const f = fixture(true), first = await f.acquire()
  await first.release('completed')
  const same = await f.acquire()
  expect(same.identity.threadId).toBe(first.identity.threadId)
  expect(f.events).toEqual(['launch:0'])
  await same.release('completed'); f.select(1)
  const next = await f.acquire()
  expect(next.identity.threadId).toBe(first.identity.threadId)
  expect((next.identity as unknown as CodexOwnerBindingFacts).codexHome).toBe(f.homes[1]!)
  expect(f.events).toEqual(['launch:0', 'probe', 'retire', 'launch:1', 'ack'])
  await next.release('completed'); await f.bindings.close()
})

test('consuming General admission probes, retires, resumes the same history and commits before delivering a lease', async () => {
  const f = fixture(), first = await f.acquire()
  await first.release('completed'); f.select(1)
  const second = await f.acquire()
  expect(second.identity.threadId).toBe(first.identity.threadId)
  expect((second.identity as unknown as CodexOwnerBindingFacts).sessionId).toBe((first.identity as unknown as CodexOwnerBindingFacts).sessionId)
  expect((second.identity as unknown as CodexOwnerBindingFacts).codexHome).toBe(f.homes[1]!)
  expect(readFileSync(second.identity.rolloutPath, 'utf8')).toBe('original conversation\n')
  expect(f.events).toEqual(['launch:0', 'probe', 'retire', 'launch:1', 'ack'])
  expect(readGeneralOwnerAuthority(f.authorityPath)?.pending).toBeUndefined()
  await second.release('completed'); await f.bindings.close()
})

test('an admitted General lease refuses handoff without probing or retiring; release permits the same candidate', async () => {
  const f = fixture(), held = await f.acquire(); f.select(1)
  await expect(f.acquire()).rejects.toThrow()
  expect(f.events).toEqual(['launch:0'])
  await held.release('completed')
  const next = await f.acquire(); expect((next.identity as unknown as CodexOwnerBindingFacts).codexHome).toBe(f.homes[1]!)
  await next.release('completed'); await f.bindings.close()
})

test('preflight failure and lost target grant preserve the original native owner', async () => {
  const f = fixture(), first = await f.acquire(); await first.release('completed')
  f.select(1); f.refuseProbe()
  await expect(f.acquire()).rejects.toThrow('viability')
  expect(f.events).toEqual(['launch:0', 'probe'])
  expect(readGeneralOwnerAuthority(f.authorityPath)?.scope.codexHome).toBe(f.homes[0])
  f.revoke(1); await expect(f.acquire()).rejects.toThrow('grant')
  f.select(0); const retained = await f.acquire(); expect(retained.identity.threadId).toBe(first.identity.threadId)
  await retained.release('completed'); await f.bindings.close()
})

test('scope admission stays reserved during target preflight and rechecks native activity afterward', async () => {
  const f = fixture(), first = await f.acquire(); await first.release('completed'); f.select(1)
  const gate = deferred(); f.probeGate(gate.promise)
  const handoff = f.acquire()
  while (!f.events.includes('probe')) await Promise.resolve()
  await expect(f.acquire()).rejects.toThrow('retiring')
  f.native('busy'); gate.resolve()
  await expect(handoff).rejects.toThrow('native work')
  expect(f.events).toEqual(['launch:0', 'probe', 'retire'])
  expect(readGeneralOwnerAuthority(f.authorityPath)?.pending).toBeUndefined()
  expect(readGeneralOwnerAuthority(f.authorityPath)?.preparing).toBeUndefined()
  expect(existsSync(`${f.authorityPath}.handoff-0.json.abort`)).toBe(true)
  f.native('idle'); const next = await f.acquire(); await next.release('completed'); await f.bindings.close()
})

test('unknown retirement and missing native acknowledgement cannot publish a new owner lease', async () => {
  for (const fault of ['unknown-retirement', 'missing-ack']) {
    const f = fixture(), first = await f.acquire(); await first.release('completed'); f.select(1)
    if (fault === 'unknown-retirement') f.native('unknown'); else f.missingAck()
    await expect(f.acquire()).rejects.toThrow(fault === 'unknown-retirement' ? 'retirement is unproven' : 'acknowledgement')
    await expect(f.acquire()).rejects.toThrow('reconciliation')
    if (fault === 'unknown-retirement') expect(f.events).not.toContain('launch:1')
    else expect(readGeneralOwnerAuthority(f.authorityPath)?.pending).toBeDefined()
    await f.bindings.close()
  }
})

test('restart after reserved successor launch failure follows its pending account, never the retired source', async () => {
  const f = fixture(), first = await f.acquire(); await first.release('completed'); f.select(1); f.failLaunch(true)
  await expect(f.acquire()).rejects.toThrow('launch uncertain')
  expect(readGeneralOwnerAuthority(f.authorityPath)?.pending).toBeDefined()
  f.failLaunch(false)
  const restarted = f.makeBindings(), recovered = await f.acquire(restarted)
  expect(recovered.identity.threadId).toBe(first.identity.threadId)
  expect((recovered.identity as unknown as CodexOwnerBindingFacts).codexHome).toBe(f.homes[1]!)
  expect(f.events.filter(event => event === 'launch:0')).toHaveLength(1)
  expect(f.events.filter(event => event === 'retire')).toHaveLength(1)
  await recovered.release('completed'); await restarted.close(); await f.bindings.close()
})

test('global General handoff authority never grants an actual project named general', async () => {
  const f = fixture(), first = await f.acquire(); await first.release('completed'); f.select(1)
  await expect(f.acquire(f.bindings, 'general')).rejects.toThrow('Explicit project grant')
  expect(f.events).toEqual(['launch:0']); await f.bindings.close()
})

test('crash immediately after retirement cannot ordinary-resume the old account before the target reservation is completed', async () => {
  const f = fixture(), first = await f.acquire(); await first.release('completed'); f.select(1); f.crashAfterRetirement()
  await expect(f.acquire()).rejects.toThrow('gateway loss')
  const prepared = readGeneralOwnerAuthority(f.authorityPath)
  expect(prepared?.preparing?.preparation.target.codexHome).toBe(f.homes[1]!)
  expect(prepared?.pending).toBeUndefined()
  expect(existsSync(join(f.homes[0]!, '.neutron-owner-retired.json'))).toBe(true)
  expect(existsSync(join(f.homes[0]!, '.neutron-owner-work.json'))).toBe(false)
  // Exercise the real durable opener, not merely the fake bootstrap below:
  // even a completed old-account retirement cannot bypass the preparation guard.
  let oldLaunchAttempts = 0
  const host = spyOn(HerdrHost.prototype, 'spawn').mockImplementation(async () => {
    oldLaunchAttempts++; throw new Error('Old-account native launch attempted')
  }); cleanup.push(() => host.mockRestore())
  await expect(openDurableCodexOwner({ projectId: null, binary: 'must-not-launch', cwd: f.root, codexHome: f.homes[0]!,
    socketPath: join(f.homes[0]!, 'owner.sock'), generalAuthorityPath: f.authorityPath, env: {} })).rejects.toThrow()
  expect(oldLaunchAttempts).toBe(0)
  const restarted = f.makeBindings(), recovered = await f.acquire(restarted)
  expect((recovered.identity as unknown as CodexOwnerBindingFacts).codexHome).toBe(f.homes[1]!)
  expect(recovered.identity.threadId).toBe(first.identity.threadId)
  expect(f.events).toEqual(['launch:0', 'probe', 'retire', 'launch:1', 'ack'])
  expect(readGeneralOwnerAuthority(f.authorityPath)?.pending).toBeUndefined()
  await recovered.release('completed'); await restarted.close(); await f.bindings.close()
})

test('restart with no completed retirement retains exact preparation and launches neither account', async () => {
  const f = fixture(), first = await f.acquire(); await first.release('completed'); f.select(1); f.native('unknown')
  await expect(f.acquire()).rejects.toThrow('unproven')
  const path = `${f.authorityPath}.handoff-0.json.prepare`, before = readFileSync(path, 'utf8')
  const restarted = f.makeBindings()
  await expect(f.acquire(restarted)).rejects.toThrow()
  expect(f.events).toEqual(['launch:0', 'probe', 'retire'])
  expect(readFileSync(path, 'utf8')).toBe(before)
  expect(readGeneralOwnerAuthority(f.authorityPath)?.preparing).toBeDefined()
  expect(existsSync(`${f.authorityPath}.handoff-0.json.abort`)).toBe(false)
  await restarted.close(); await f.bindings.close()
})
