import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCrashedOwnerDead, assertNoOtherCodexOwner, observeOwnerNativeStop, readCrashedOwner, recordCrashedOwner, type OwnerCrashProbes, type OwnerProcessCensus } from './project-owner-crash-recovery.ts'
import type { OwnerHelperDescriptor } from './project-owner-helper-protocol.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-crash-proof-')); dirs.push(dir)
  mkdirSync(join(dir, 'sessions'), { mode: 0o700 })
  const identity = (pid: number) => ({ pid, boot: 'old-boot', start: String(pid) })
  const authority: OwnerHelperDescriptor = {
    version: 1, socketPath: join(dir, 'helper.sock'), socketIdentity: '1:2', token: 'a'.repeat(64), helper: identity(11),
    facts: { threadId: 'thread-one', sessionId: 'session-one', cwd: dir, codexHome: dir,
      rolloutPath: join(dir, 'sessions', 'thread.jsonl'), paneHandle: 'native-pane', bindingRevision: 'b'.repeat(64),
      generation: 1, brokerGeneration: 1, credentialFingerprint: 'fingerprint', modelProvider: 'openai', controlSocketPath: join(dir, 'owner.sock'),
      nativeMetadata: { sessionId: 'session-one', source: 'cli', originator: 'neutron-owner-bootstrap' },
      capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' },
      processes: { native: identity(12), terminal: identity(13) } },
  }
  const write = (file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value), { mode: 0o600 })
  const seal = () => {
    write('.neutron-owner-authority.json', authority); write('.neutron-owner-helper.json', authority)
    write('.neutron-owner-pane.json', { handle: 'helper-pane', identity: authority.helper })
    const db = new Database(join(dir, '.neutron-owner-bootstrap.sqlite'))
    db.exec('CREATE TABLE IF NOT EXISTS attestation (id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS broker (id INTEGER PRIMARY KEY, generation INTEGER, unresolved TEXT, binding TEXT)')
    db.query('INSERT OR REPLACE INTO attestation VALUES (1, ?)').run(JSON.stringify(authority.facts))
    db.query('INSERT OR REPLACE INTO broker VALUES (1, 1, NULL, ?)').run(JSON.stringify([join(dir, '.neutron-owner-bootstrap'), 'fresh-owner-bootstrap', dir, dir]))
    db.close(); chmodSync(join(dir, '.neutron-owner-bootstrap.sqlite'), 0o600)
  }
  seal(); writeFileSync(authority.facts.rolloutPath, 'existing conversation\n', { mode: 0o600 })
  const inspected: number[] = []
  let census = 0
  const probe: OwnerCrashProbes = { boot: () => 'old-boot', dead: identity => { inspected.push(identity.pid) }, noOtherOwner: () => { census++ } }
  return { dir, authority, probe, inspected, census: () => census, write, seal }
}

test('proven same-boot crash preserves exact transcript and immutable predecessor, never manufactures retirement', () => {
  const f = fixture()
  chmodSync(f.authority.facts.rolloutPath, 0o644) // Native file under the private home.
  const before = readFileSync(join(f.dir, '.neutron-owner-authority.json'), 'utf8')
  const receipt = recordCrashedOwner(f.dir, f.probe)
  expect(receipt).toEqual({ version: 1, kind: 'crash', facts: f.authority.facts, helper: f.authority.helper })
  expect(f.inspected).toEqual([11, 12, 13, 11, 12, 13])
  expect(f.census()).toBe(1)
  expect(readCrashedOwner(f.dir, f.probe)).toEqual(receipt)
  expect(recordCrashedOwner(f.dir, f.probe)).toEqual(receipt)
  expect(readFileSync(join(f.dir, '.neutron-owner-authority.json'), 'utf8')).toBe(before)
  expect(readFileSync(f.authority.facts.rolloutPath, 'utf8')).toBe('existing conversation\n')
  expect(existsSync(join(f.dir, '.neutron-owner-retired.json'))).toBe(false)
})

test('a descriptor without sealed predecessor authority cannot create or consume a crash receipt', () => {
  const f = fixture()
  expect(recordCrashedOwner(f.dir, f.probe, f.authority).facts).toEqual(f.authority.facts)
  const receipt = readFileSync(join(f.dir, '.neutron-owner-crashed.json'), 'utf8')
  unlinkSync(join(f.dir, '.neutron-owner-authority.json'))
  expect(() => recordCrashedOwner(f.dir, f.probe, f.authority)).toThrow()
  expect(() => readCrashedOwner(f.dir, f.probe)).toThrow()
  expect(readFileSync(join(f.dir, '.neutron-owner-crashed.json'), 'utf8')).toBe(receipt)
  f.seal()
  expect(readCrashedOwner(f.dir, f.probe).facts).toEqual(f.authority.facts)
})

test('legacy attestation resumes after proven reboot, but same-boot death lacks required evidence', () => {
  const f = fixture(); delete (f.authority.facts as { processes?: unknown }).processes; f.seal()
  expect(() => recordCrashedOwner(f.dir, f.probe)).toThrow('Legacy')
  expect(existsSync(join(f.dir, '.neutron-owner-crashed.json'))).toBe(false)
  f.probe.boot = () => 'new-boot'
  expect(recordCrashedOwner(f.dir, f.probe).facts.threadId).toBe('thread-one')
  expect(f.census()).toBe(1)
})

test('each live/unknown native, terminal or helper identity refuses with no receipt', () => {
  for (const pid of [11, 12, 13]) {
    const f = fixture()
    f.probe.dead = identity => { if (identity.pid === pid) throw new Error('still live or unknown') }
    expect(() => recordCrashedOwner(f.dir, f.probe)).toThrow('still live or unknown')
    expect(existsSync(join(f.dir, '.neutron-owner-crashed.json'))).toBe(false)
    expect(f.census()).toBe(0)
  }
})

test('live helper with dead native children is draining, never dead until all three birth identities are proven gone', () => {
  const f = fixture(), deadPids = new Set<number>()
  const dead = (identity: { pid: number }) => { if (!deadPids.has(identity.pid)) throw new Error('live or unknown') }
  expect(observeOwnerNativeStop(f.dir, f.authority, dead)).toBe('unknown')
  deadPids.add(12)
  expect(observeOwnerNativeStop(f.dir, f.authority, dead)).toBe('draining')
  deadPids.add(13)
  expect(observeOwnerNativeStop(f.dir, f.authority, dead)).toBe('draining')
  deadPids.add(11)
  expect(observeOwnerNativeStop(f.dir, f.authority, dead)).toBe('dead')
  expect(existsSync(join(f.dir, '.neutron-owner-crashed.json'))).toBe(false)
  expect(() => observeOwnerNativeStop(f.dir, { ...f.authority, helper: { ...f.authority.helper, start: 'changed' } }, dead)).toThrow('exact process authority')
  expect(() => recordCrashedOwner(f.dir, f.probe, { ...f.authority, helper: { ...f.authority.helper, start: 'changed' } })).toThrow('changed during attachment')
  expect(existsSync(join(f.dir, '.neutron-owner-crashed.json'))).toBe(false)
})

test('competing transcript owner, unavailable census, and missing boot refuse before successor authority', () => {
  for (const reason of ['competing owner', 'unreadable process census']) {
    const f = fixture(); f.probe.noOtherOwner = () => { throw new Error(reason) }
    expect(() => recordCrashedOwner(f.dir, f.probe)).toThrow(reason)
    expect(existsSync(join(f.dir, '.neutron-owner-crashed.json'))).toBe(false)
  }
  const f = fixture(); f.probe.boot = () => ''
  expect(() => assertCrashedOwnerDead(f.authority, f.probe)).toThrow('boot identity')
})

test('changed descriptor, sealed generation, transcript and interrupted retirement all fail closed', () => {
  for (const fault of ['descriptor', 'generation', 'transcript', 'retiring']) {
    const f = fixture()
    if (fault === 'descriptor') f.write('.neutron-owner-helper.json', { ...f.authority, token: 'changed' })
    if (fault === 'generation') {
      const db = new Database(join(f.dir, '.neutron-owner-bootstrap.sqlite'))
      db.exec('UPDATE broker SET generation=2'); db.close()
    }
    if (fault === 'transcript') {
      rmSync(f.authority.facts.rolloutPath)
    }
    if (fault === 'retiring') f.write('.neutron-owner-retiring.json', {})
    expect(() => recordCrashedOwner(f.dir, f.probe)).toThrow()
    expect(existsSync(join(f.dir, '.neutron-owner-crashed.json'))).toBe(false)
  }
})

test('unresolved work evidence is preserved and forged crash receipts cannot redirect a thread', () => {
  const f = fixture(); f.write('.neutron-owner-work.json', { threadId: 'thread-one', delivery: 'unknown' })
  recordCrashedOwner(f.dir, f.probe)
  expect(JSON.parse(readFileSync(join(f.dir, '.neutron-owner-work.json'), 'utf8')).delivery).toBe('unknown')
  f.write('.neutron-owner-crashed.json', { version: 1, kind: 'crash', helper: f.authority.helper, facts: { ...f.authority.facts, threadId: 'foreign-thread' } })
  expect(() => readCrashedOwner(f.dir, f.probe)).toThrow('corroborated')
})

test('process census finds home and exact thread competitors while allowing unrelated processes', () => {
  const f = fixture()
  const census: OwnerProcessCensus = { self: 1, uid: 1000, pids: () => [1, 2],
    stat: pid => ({ uid: 1000, state: 'S', identity: { pid, boot: 'current', start: '1' } }),
    argv: () => ['unrelated'], env: () => ['CODEX_HOME=/other-home'] }
  expect(() => assertNoOtherCodexOwner(f.authority.facts, census)).not.toThrow()
  census.env = () => [`CODEX_HOME=${f.dir}`]
  expect(() => assertNoOtherCodexOwner(f.authority.facts, census)).toThrow('Another process')
  census.env = () => []
  for (const value of [f.authority.facts.threadId, f.authority.facts.rolloutPath]) {
    census.argv = () => ['codex', 'resume', value]
    expect(() => assertNoOtherCodexOwner(f.authority.facts, census)).toThrow('Another process')
  }
  census.argv = () => ['codex', 'resume', `${f.authority.facts.threadId}-unrelated`]
  expect(() => assertNoOtherCodexOwner(f.authority.facts, census)).not.toThrow()
  census.env = () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) }
  expect(() => assertNoOtherCodexOwner(f.authority.facts, census)).toThrow('permission denied')
  census.pids = () => [2]
  expect(() => assertNoOtherCodexOwner(f.authority.facts, census)).toThrow('incomplete')
})
