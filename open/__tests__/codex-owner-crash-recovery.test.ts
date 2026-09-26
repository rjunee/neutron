import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'
import { CodexOwnerRecoveryUnavailable, codexOwnerCredentialIdentity, openDurableCodexOwner } from '../wiring/codex-durable-owner.ts'
import * as bootstrap from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import * as crash from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-crash-recovery.ts'
import * as protocol from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { nextOwnerDirectory } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-retirement.ts'

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

test('durable recovery launches exactly one successor for the same thread and adopts it on the next opening', async () => {
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
  const descriptor = spyOn(protocol, 'readOwnerHelperDescriptor').mockImplementation(path => {
    if (!path.startsWith(next)) throw new Error('stale descriptor')
    return current
  }); restores.push(() => descriptor.mockRestore())
  const record = spyOn(crash, 'recordCrashedOwner').mockImplementation(() => { f.write('.neutron-owner-crashed.json', receipt); return receipt })
  restores.push(() => record.mockRestore())
  const read = spyOn(crash, 'readCrashedOwner').mockReturnValue(receipt); restores.push(() => read.mockRestore())
  let spawns = 0
  const spawn = spyOn(HerdrHost.prototype, 'spawn').mockImplementation(async () => {
    spawns++
    writeFileSync(join(next, '.neutron-owner-helper.json'), JSON.stringify(current), { mode: 0o600 })
    return { pid: process.pid, paneHandle: 'new-pane', detach() {} } as never
  }); restores.push(() => spawn.mockRestore())
  const inspect = spyOn(HerdrHost.prototype, 'inspectHandle').mockImplementation(async handle => handle === 'old-pane'
    ? { kind: 'gone' } : { kind: 'live', pid: process.pid, argv: [] })
  restores.push(() => inspect.mockRestore())
  const attach = spyOn(bootstrap, 'attachCodexOwner').mockResolvedValue(f.owner as bootstrap.CodexOwnerAttachment)
  restores.push(() => attach.mockRestore())
  const readBinding = spyOn(bootstrap, 'readCodexOwnerBinding').mockReturnValue(current.facts); restores.push(() => readBinding.mockRestore())
  const options = { projectId: 'project-one', binary: 'must-not-launch', cwd: f.dir, codexHome: f.home, socketPath: join(f.home, 'owner.sock'), env: {} }
  expect((await openDurableCodexOwner(options)).recoveryKind).toBe('resumed')
  const launch = JSON.parse(readFileSync(join(next, '.neutron-owner-launch.json'), 'utf8'))
  expect(launch.resume.receipt.facts.threadId).toBe('thread-one')
  expect(launch.resume.predecessorDirectory).toBe(f.home)
  expect(launch.scope).toEqual(scope)
  expect((await openDurableCodexOwner(options)).recoveryKind).toBe('adopted')
  expect(spawns).toBe(1)
  expect(record).toHaveBeenCalledTimes(1)
})
