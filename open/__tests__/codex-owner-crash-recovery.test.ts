import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'
import { CodexOwnerRecoveryUnavailable, codexOwnerCredentialIdentity, openDurableCodexOwner } from '../wiring/codex-durable-owner.ts'
import * as bootstrap from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import * as crash from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-crash-recovery.ts'
import * as protocol from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { nextOwnerDirectory } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-retirement.ts'
import { ownerWorkspaceLaunch } from '../wiring/project-build-terminal.ts'

const dirs: string[] = []
const restores: (() => void)[] = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-boot-recovery-')); dirs.push(dir)
  const home = join(dir, 'home'); mkdirSync(home, { mode: 0o700 })
  writeFileSync(join(home, 'project-owner.json'), JSON.stringify('project-one'), { mode: 0o600 })
  const auth = JSON.stringify({ tokens: { account_id: 'fixture-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh' } })
  writeFileSync(join(home, 'auth.json'), auth, { mode: 0o600 })
  const facts: bootstrap.CodexOwnerBindingFacts = { threadId: 'thread-one', sessionId: 'session-one', cwd: dir, codexHome: home,
    rolloutPath: join(home, 'sessions', 'thread.jsonl'), paneHandle: 'native-pane', bindingRevision: 'b'.repeat(64),
    generation: 1, brokerGeneration: 1, credentialFingerprint: 'fingerprint', modelProvider: 'openai', controlSocketPath: join(home, 'owner.sock'),
    nativeMetadata: { sessionId: 'session-one', source: 'cli', originator: 'neutron-owner-bootstrap' },
    capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } }
  let closes = 0, opens = 0
  let fault: Error | undefined
  const binding = {} as bootstrap.CodexOwnerBinding
  const owner = { binding, recoveryKind: 'adopted', broker: { state: () => ({ phase: 'idle', epoch: 1 }) },
    async close() { closes++ }, writeTerminal() { throw new Error('No terminal input during recovery') } } as unknown as bootstrap.CodexOwnerBootstrap
  const project = { cwd: dir, codexHome: home, credentialIdentity: 'fixture', env: {} }
  const bindings = new CodexOwnerBindings(async () => project,
    async () => { opens++; if (fault) throw fault; return owner }, () => facts)
  const write = (file: string, value: unknown) => writeFileSync(join(home, file), JSON.stringify(value), { mode: 0o600 })
  return { dir, home, auth, project, facts, owner, bindings, write, fault: (value?: Error) => { fault = value }, opens: () => opens, closes: () => closes }
}

test('boot adopts or resumes an awake Codex owner without dispatching a turn; absent owners stay lazy', async () => {
  const f = fixture()
  expect(await f.bindings.recoverExisting('project-one')).toEqual({ status: 'skipped' })
  expect(f.opens()).toBe(0)
  f.write('.neutron-owner-launch.json', {})
  expect(await f.bindings.recoverExisting('project-one')).toEqual({ status: 'adopted' })
  expect(f.opens()).toBe(1)
  expect(await f.bindings.recoverExisting('project-one')).toEqual({ status: 'adopted' })
  expect(f.opens()).toBe(1)
  await f.bindings.close()
  const resumed = fixture(); resumed.write('.neutron-owner-launch.json', {})
  Object.assign(resumed.owner, { recoveryKind: 'resumed' })
  expect(await resumed.bindings.recoverExisting('project-one')).toEqual({ status: 'resumed' })
  await resumed.bindings.close()
})

test('host unavailable is retryable before attachment; unknown authority remains fenced', async () => {
  const f = fixture(); f.write('.neutron-owner-launch.json', {})
  f.fault(new CodexOwnerRecoveryUnavailable('host unavailable'))
  expect(await f.bindings.recoverExisting('project-one')).toEqual({ status: 'refused', reason: 'host unavailable', retryable: true })
  f.fault()
  expect(await f.bindings.recoverExisting('project-one')).toEqual({ status: 'adopted' })
  expect(f.opens()).toBe(2)
  await f.bindings.close()
  const uncertain = fixture(); uncertain.write('.neutron-owner-launch.json', {})
  uncertain.fault(new Error('authority unknown'))
  expect(await uncertain.bindings.recoverExisting('project-one')).toEqual({ status: 'refused', reason: 'authority unknown', retryable: false })
  uncertain.fault()
  expect((await uncertain.bindings.recoverExisting('project-one')).status).toBe('refused')
  expect(uncertain.opens()).toBe(1)
  await uncertain.bindings.close()
})

test('an idle disconnected frontend is reopened through native proof; active or unknown work is not discarded', async () => {
  const idle = fixture(); idle.write('.neutron-owner-launch.json', {})
  expect((await idle.bindings.recoverExisting('project-one')).status).toBe('adopted')
  let disconnected = true
  Object.assign(idle.owner, { async refreshState() { if (disconnected) { disconnected = false; throw new Error('connection lost') } } })
  expect((await idle.bindings.recoverExisting('project-one')).status).toBe('adopted')
  expect(idle.opens()).toBe(2)
  expect(idle.closes()).toBe(1)
  await idle.bindings.close()
  const busy = fixture(); busy.write('.neutron-owner-launch.json', {})
  expect((await busy.bindings.recoverExisting('project-one')).status).toBe('adopted')
  busy.write('.neutron-owner-work.json', { delivery: 'unknown' })
  Object.assign(busy.owner, { async refreshState() { throw new Error('connection lost') } })
  expect(await busy.bindings.recoverExisting('project-one')).toEqual({ status: 'refused', reason: 'connection lost', retryable: false })
  expect(busy.opens()).toBe(1)
  expect(busy.closes()).toBe(0)
  expect(JSON.parse(readFileSync(join(busy.home, '.neutron-owner-work.json'), 'utf8')).delivery).toBe('unknown')
  await busy.bindings.close()
})

test('completed explicit retirement stays asleep, and interrupted host work is never silently cleared', async () => {
  const asleep = fixture()
  const helper = { pid: 10, boot: 'fixture-prior-boot', start: '10' }
  const receipt = { version: 1, facts: asleep.facts, helper, terminal: helper, native: { identity: helper, code: 0, signal: null } }
  asleep.write('.neutron-owner-authority.json', { facts: asleep.facts, helper })
  asleep.write('.neutron-owner-retired.json', receipt)
  expect(await asleep.bindings.recoverExisting('project-one')).toEqual({ status: 'skipped' })
  expect(asleep.opens()).toBe(0)
  await asleep.bindings.close()
  const interrupted = fixture(); interrupted.write('.neutron-owner-launch.json', {})
  interrupted.write('.neutron-owner-work.json', { threadId: 'thread-one', status: 'unknown' })
  expect(await interrupted.bindings.recoverExisting('project-one')).toEqual({ status: 'refused', reason: 'Codex interrupted host work requires native reconciliation', retryable: false })
  expect(JSON.parse(readFileSync(join(interrupted.home, '.neutron-owner-work.json'), 'utf8')).status).toBe('unknown')
  expect(interrupted.closes()).toBe(1)
  await interrupted.bindings.close()
})

test('workspace cutover adopts a live pre-cutover owner without moving panes, rewriting history or spawning', async () => {
  const f = fixture()
  const helper = protocol.helperIdentity()
  const descriptor = { version: 1 as const, token: 'a'.repeat(64), socketPath: join(f.home, 'helper.sock'),
    socketIdentity: '1:1', facts: f.facts, helper }
  const scope = { projectId: 'project-one', cwd: f.dir, codexHome: f.home, credential: codexOwnerCredentialIdentity(f.auth) }
  f.write('.neutron-owner-launch.json', { scope })
  f.write('.neutron-owner-authority.json', descriptor)
  f.write('.neutron-owner-pane.json', { handle: 'legacy-helper', identity: helper })
  mkdirSync(join(f.home, 'sessions'))
  writeFileSync(f.facts.rolloutPath, 'existing native history\n')
  const originalLaunch = readFileSync(join(f.home, '.neutron-owner-launch.json'), 'utf8')
  const read = spyOn(protocol, 'readOwnerHelperDescriptor').mockReturnValue(descriptor)
  const inspect = spyOn(HerdrHost.prototype, 'inspectHandle').mockResolvedValue({ kind: 'live', pid: process.pid, argv: [] })
  const attach = spyOn(bootstrap, 'attachCodexOwner').mockResolvedValue(f.owner as bootstrap.CodexOwnerAttachment)
  const binding = spyOn(bootstrap, 'readCodexOwnerBinding').mockReturnValue(f.facts)
  const spawn = spyOn(HerdrHost.prototype, 'spawn').mockImplementation(async () => { throw new Error('No spawn during adoption') })
  const close = spyOn(HerdrHost.prototype, 'closeHandle').mockImplementation(async () => { throw new Error('No close during adoption') })
  restores.push(() => read.mockRestore(), () => inspect.mockRestore(), () => attach.mockRestore(),
    () => binding.mockRestore(), () => spawn.mockRestore(), () => close.mockRestore())
  const projectWorkspace = ownerWorkspaceLaunch(f.dir, { instanceId: 'instance', projectId: 'project-one', projectLabel: 'Same name' })
  const options = { projectId: 'project-one', binary: 'must-not-launch', cwd: f.dir, codexHome: f.home,
    socketPath: join(f.home, 'owner.sock'), env: {}, projectWorkspace }
  expect((await openDurableCodexOwner(options)).recoveryKind).toBe('adopted')
  expect((await openDurableCodexOwner(options)).recoveryKind).toBe('adopted')
  expect(spawn).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(readFileSync(join(f.home, '.neutron-owner-launch.json'), 'utf8')).toBe(originalLaunch)
  expect(readFileSync(f.facts.rolloutPath, 'utf8')).toBe('existing native history\n')
  expect(existsSync(projectWorkspace.journalPath)).toBe(false)
})

for (const failure of ['dead-helper', 'dead-native', 'descriptor-race', 'pane-race', 'binding-race', 'draining-native', 'unknown-native', 'foreign-native']) test(`durable recovery ${failure}: exact successor or fenced refusal`, async () => {
  const f = fixture()
  const oldHelper = { pid: 10, boot: 'fixture-prior-boot', start: '10' }
  const old = { version: 1 as const, token: 'a'.repeat(64), socketPath: join(f.home, 'helper.sock'), socketIdentity: '1:1', facts: f.facts, helper: oldHelper }
  const receipt: crash.CodexOwnerCrashReceipt = { version: 1, kind: 'crash', facts: f.facts, helper: oldHelper }
  const next = nextOwnerDirectory(f.facts)
  const current = { ...old, helper: protocol.helperIdentity(), facts: { ...f.facts, bindingRevision: 'c'.repeat(64) } }
  const scope = { projectId: 'project-one', cwd: f.dir, codexHome: f.home, credential: codexOwnerCredentialIdentity(f.auth) }
  f.write('.neutron-owner-launch.json', { scope })
  f.write('.neutron-owner-authority.json', old)
  f.write('.neutron-owner-pane.json', { handle: 'old-pane', identity: oldHelper })
  let descriptorReads = 0
  const descriptor = spyOn(protocol, 'readOwnerHelperDescriptor').mockImplementation(path => {
    if (!path.startsWith(next)) {
      if (failure === 'dead-helper' || failure === 'descriptor-race' && ++descriptorReads > 1) throw new Error('stale descriptor')
      return old
    }
    return current
  }); restores.push(() => descriptor.mockRestore())
  const observe = spyOn(crash, 'observeOwnerNativeStop').mockReturnValue(failure === 'foreign-native' ? 'dead'
    : failure === 'dead-native' || failure === 'draining-native' ? 'draining' : 'unknown')
  restores.push(() => observe.mockRestore())
  let recordAttempts = 0
  const record = spyOn(crash, 'recordCrashedOwner').mockImplementation(() => {
    recordAttempts++
    if (failure === 'foreign-native') throw new Error('Competing native owner')
    if (failure === 'draining-native' || failure === 'unknown-native' || failure === 'dead-native' && recordAttempts === 1) {
      throw new Error('Helper process still live or unknown')
    }
    f.write('.neutron-owner-crashed.json', receipt); return receipt
  })
  restores.push(() => record.mockRestore())
  const read = spyOn(crash, 'readCrashedOwner').mockReturnValue(receipt); restores.push(() => read.mockRestore())
  let spawns = 0
  const spawn = spyOn(HerdrHost.prototype, 'spawn').mockImplementation(async () => {
    spawns++
    writeFileSync(join(next, '.neutron-owner-helper.json'), JSON.stringify(current), { mode: 0o600 })
    return { pid: process.pid, paneHandle: 'new-pane', detach() {} } as never
  }); restores.push(() => spawn.mockRestore())
  const inspect = spyOn(HerdrHost.prototype, 'inspectHandle').mockImplementation(async handle => handle === 'old-pane'
    ? failure === 'dead-helper' || failure === 'pane-race' ? { kind: 'gone' } : { kind: 'live', pid: oldHelper.pid, argv: [] }
    : { kind: 'live', pid: process.pid, argv: [] })
  restores.push(() => inspect.mockRestore())
  const attach = spyOn(bootstrap, 'attachCodexOwner').mockImplementation(async options => {
    if (!options.descriptorPath.startsWith(next) && failure !== 'binding-race') throw new Error('Stale owner binding')
    return f.owner as bootstrap.CodexOwnerAttachment
  })
  restores.push(() => attach.mockRestore())
  let bindingReads = 0
  const readBinding = spyOn(bootstrap, 'readCodexOwnerBinding').mockImplementation(() => {
    if (failure === 'binding-race' && bindingReads++ === 0) throw new Error('Stale owner binding')
    return current.facts
  }); restores.push(() => readBinding.mockRestore())
  const projectWorkspace = ownerWorkspaceLaunch(f.dir, { instanceId: 'instance', projectId: 'project-one', projectLabel: 'Same name' })
  const options = { projectId: 'project-one', binary: 'must-not-launch', cwd: f.dir, codexHome: f.home, socketPath: join(f.home, 'owner.sock'), env: {},
    projectWorkspace, timeoutMs: failure === 'dead-native' ? 200 : 1 }
  if (failure === 'draining-native' || failure === 'unknown-native' || failure === 'foreign-native') {
    if (failure === 'draining-native') await expect(openDurableCodexOwner(options)).rejects.toBeInstanceOf(CodexOwnerRecoveryUnavailable)
    else if (failure === 'foreign-native') await expect(openDurableCodexOwner(options)).rejects.toThrow('Competing native owner')
    else await expect(openDurableCodexOwner(options)).rejects.toThrow('Stale owner binding')
    expect(spawns).toBe(0)
    expect(existsSync(join(f.home, '.neutron-owner-crashed.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(f.home, '.neutron-owner-authority.json'), 'utf8'))).toEqual(old)
    return
  }
  expect((await openDurableCodexOwner(options)).recoveryKind).toBe('resumed')
  const launch = JSON.parse(readFileSync(join(next, '.neutron-owner-launch.json'), 'utf8'))
  expect(launch.resume.receipt.facts.threadId).toBe('thread-one')
  expect(launch.resume.predecessorDirectory).toBe(f.home)
  expect(launch.scope).toEqual(scope)
  expect(launch.projectWorkspace).toEqual(projectWorkspace)
  expect((await openDurableCodexOwner(options)).recoveryKind).toBe('adopted')
  expect(spawns).toBe(1)
  expect(record).toHaveBeenCalledTimes(failure === 'dead-native' ? 2 : 1)
})
