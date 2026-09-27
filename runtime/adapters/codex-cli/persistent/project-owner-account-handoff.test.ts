import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { abortAccountHandoff, acknowledgeAccountHandoff, attestAccountHandoff, completeAccountHandoff, prepareAccountHandoff,
  readAccountHandoff, readGeneralOwnerAuthority, stageAccountHandoff, validateAccountHandoffTranscript, type GeneralOwnerScope } from './project-owner-account-handoff.ts'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'
import { helperIdentity } from './project-owner-helper-protocol.ts'
import type { CodexOwnerRetirementReceipt } from './project-owner-retirement.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const write = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
const exited = { pid: 1, boot: 'fixture-previous-boot', start: '1' }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'account-handoff-')); roots.push(root)
  const first = join(root, 'first'), second = join(root, 'second')
  mkdirSync(first, { mode: 0o700 }); mkdirSync(second, { mode: 0o700 })
  const source: GeneralOwnerScope = { projectId: null, cwd: root, codexHome: first, credential: 'a'.repeat(64) }
  const target: GeneralOwnerScope = { ...source, codexHome: second, credential: 'b'.repeat(64) }
  const authorityPath = join(root, 'general.json')
  write(authorityPath, source)
  mkdirSync(join(first, 'sessions'), { mode: 0o700 })
  const rolloutPath = join(first, 'sessions', 'rollout-thread.jsonl')
  writeFileSync(rolloutPath, 'original conversation\n', { mode: 0o600 })
  writeFileSync(join(first, 'auth.json'), 'first credential must stay here', { mode: 0o600 })
  writeFileSync(join(second, 'auth.json'), 'second credential must stay here', { mode: 0o600 })
  const facts: CodexOwnerBindingFacts = { threadId: 'original-thread', sessionId: 'original-session', cwd: root,
    codexHome: first, rolloutPath, paneHandle: 'old-pane', bindingRevision: 'c'.repeat(64), generation: 1, brokerGeneration: 1,
    credentialFingerprint: 'old-fingerprint', modelProvider: 'fixture', controlSocketPath: join(first, 'owner.sock'),
    nativeMetadata: { sessionId: 'original-session', source: 'vscode', originator: 'neutron-owner-bootstrap' },
    capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } }
  const receipt = retire(first, source, facts)
  const reserve = () => {
    const locator = prepareAccountHandoff(authorityPath, source, target, first, facts)
    completeAccountHandoff(locator)
    return locator
  }
  return { root, first, second, source, target, authorityPath, facts, receipt, reserve }
}
function retire(directory: string, scope: GeneralOwnerScope, facts: CodexOwnerBindingFacts) {
  const receipt: CodexOwnerRetirementReceipt = { version: 1, facts, helper: exited, terminal: exited,
    native: { identity: exited, code: 0, signal: null } }
  write(join(directory, '.neutron-owner-launch.json'), { scope })
  write(join(directory, '.neutron-owner-authority.json'), { facts, helper: exited })
  write(join(directory, '.neutron-owner-retired.json'), receipt)
  return receipt
}
function successor(f: ReturnType<typeof fixture>, locator = f.reserve()) {
  const resume = stageAccountHandoff(locator), handoff = readAccountHandoff(locator)
  const facts: CodexOwnerBindingFacts = { ...f.facts, codexHome: f.second, rolloutPath: handoff.rolloutPath,
    credentialIdentity: f.target.credential, bindingRevision: 'd'.repeat(64), paneHandle: 'successor-pane' }
  return { locator, resume, handoff, facts }
}

test('General intent survives restart, copies only history, and publishes only a corroborated native acknowledgement', () => {
  const f = fixture(), original = readFileSync(f.authorityPath, 'utf8'), locator = f.reserve()
  expect(readGeneralOwnerAuthority(f.authorityPath)).toMatchObject({ scope: f.target, pending: { locator } })
  expect(() => f.reserve()).toThrow('authority changed')
  const s = successor(f, locator)
  expect(readFileSync(s.handoff.rolloutPath, 'utf8')).toBe('original conversation\n')
  expect(stageAccountHandoff(locator)).toEqual(s.resume)
  expect(readFileSync(join(f.first, 'auth.json'), 'utf8')).toBe('first credential must stay here')
  expect(readFileSync(join(f.second, 'auth.json'), 'utf8')).toBe('second credential must stay here')
  expect(() => acknowledgeAccountHandoff(locator, s.facts)).toThrow()
  write(join(s.handoff.stateDirectory, '.neutron-owner-authority.json'), { facts: s.facts })
  appendFileSync(s.handoff.rolloutPath, 'native resume append\n')
  expect(() => validateAccountHandoffTranscript(s.handoff)).not.toThrow()
  acknowledgeAccountHandoff(locator, s.facts)
  expect(readGeneralOwnerAuthority(f.authorityPath)).toEqual({ scope: f.target, rootDirectory: s.handoff.stateDirectory, nextIndex: 1 })
  expect(readFileSync(f.authorityPath, 'utf8')).toBe(original)
  expect(() => acknowledgeAccountHandoff(locator, s.facts)).toThrow('reserved successor')
})

test('native acknowledgement cannot substitute another account, thread, history path, scope or generation', () => {
  const f = fixture(), s = successor(f)
  expect(() => attestAccountHandoff(s.handoff, s.facts)).not.toThrow()
  for (const mutation of [
    { threadId: 'foreign' }, { sessionId: 'foreign' }, { cwd: f.second }, { codexHome: f.first },
    { rolloutPath: f.facts.rolloutPath }, { credentialIdentity: undefined }, { credentialIdentity: f.source.credential },
    { modelProvider: 'foreign' }, { bindingRevision: f.facts.bindingRevision },
    { nativeMetadata: { ...s.facts.nativeMetadata, source: 'foreign' } },
  ]) expect(() => attestAccountHandoff(s.handoff, { ...s.facts, ...mutation } as CodexOwnerBindingFacts)).toThrow('acknowledge')
})

test('live predecessor stays reserved; foreign grant and same-account retargeting cannot prepare', () => {
  const live = fixture()
  write(join(live.first, '.neutron-owner-retired.json'), { ...live.receipt, terminal: helperIdentity() })
  expect(() => live.reserve()).toThrow('still live')
  expect(readGeneralOwnerAuthority(live.authorityPath)?.preparing).toBeDefined()
  const f = fixture()
  write(join(f.first, '.neutron-owner-launch.json'), { scope: { ...f.source, projectId: 'general' } })
  expect(() => f.reserve()).toThrow('predecessor')
  write(join(f.first, '.neutron-owner-launch.json'), { scope: f.source })
  expect(() => prepareAccountHandoff(f.authorityPath, f.source, { ...f.target, credential: f.source.credential }, f.first, f.facts)).toThrow('Invalid')
  write(join(f.second, 'project-owner.json'), 'general')
  expect(() => f.reserve()).toThrow('General owner')
  expect(existsSync(`${f.authorityPath}.handoff-0.json`)).toBe(false)
})

test('foreign destination, partial copy, source mutation and symlink namespace each remain fenced', () => {
  const collision = fixture()
  mkdirSync(join(collision.second, '.neutron-account-handoffs', collision.facts.bindingRevision), { recursive: true, mode: 0o700 })
  expect(() => collision.reserve()).toThrow('already exists')
  const partial = fixture(), locator = partial.reserve(), handoff = readAccountHandoff(locator)
  mkdirSync(dirname(handoff.rolloutPath), { recursive: true, mode: 0o700 })
  writeFileSync(handoff.rolloutPath, 'partial', { mode: 0o600 })
  expect(() => stageAccountHandoff(locator)).toThrow('prefix')
  expect(readGeneralOwnerAuthority(partial.authorityPath)?.pending).toBeDefined()
  const changed = fixture(), staged = successor(changed)
  appendFileSync(changed.facts.rolloutPath, 'not retired anymore\n')
  expect(() => readGeneralOwnerAuthority(changed.authorityPath)).toThrow('changed after handoff')
  expect(() => stageAccountHandoff(staged.locator)).toThrow()
  const linked = fixture(), reserved = linked.reserve(), outside = join(linked.root, 'outside')
  mkdirSync(outside, { mode: 0o700 }); symlinkSync(outside, join(linked.second, 'sessions'))
  expect(() => stageAccountHandoff(reserved)).toThrow('canonical')
  expect(existsSync(join(outside, `handoff-${linked.facts.bindingRevision}`))).toBe(false)
})

test('returning to an earlier account creates a new transcript and immutable generation instead of overwriting history', () => {
  const f = fixture(), s = successor(f)
  retire(s.handoff.stateDirectory, f.target, s.facts)
  acknowledgeAccountHandoff(s.locator, s.facts)
  appendFileSync(s.handoff.rolloutPath, 'continued conversation\n')
  const back = prepareAccountHandoff(f.authorityPath, f.target, f.source, s.handoff.stateDirectory, s.facts)
  completeAccountHandoff(back)
  stageAccountHandoff(back)
  const second = readAccountHandoff(back)
  expect(second.rolloutPath).not.toBe(f.facts.rolloutPath)
  expect(readFileSync(second.rolloutPath, 'utf8')).toBe('original conversation\ncontinued conversation\n')
  expect(readFileSync(f.facts.rolloutPath, 'utf8')).toBe('original conversation\n')
  expect(readGeneralOwnerAuthority(f.authorityPath)?.pending?.locator.index).toBe(1)
})

test('a different retired conversation in the same account is not this General owner lineage', () => {
  const f = fixture(), other = join(f.first, 'unrelated-owner')
  mkdirSync(other, { mode: 0o700 }); retire(other, f.source, { ...f.facts, threadId: 'foreign-thread' })
  expect(() => prepareAccountHandoff(f.authorityPath, f.source, f.target, other, { ...f.facts, threadId: 'foreign-thread' })).toThrow('lineage')
  expect(readGeneralOwnerAuthority(f.authorityPath)?.pending).toBeUndefined()
})

test('preparation survives absent retirement, refuses contradictory abort, and advances only the exact completed owner', () => {
  const f = fixture(); unlinkSync(join(f.first, '.neutron-owner-retired.json'))
  const locator = prepareAccountHandoff(f.authorityPath, f.source, f.target, f.first, f.facts)
  expect(() => completeAccountHandoff(locator)).toThrow()
  expect(readGeneralOwnerAuthority(f.authorityPath)?.preparing?.preparation.target).toEqual(f.target)
  expect(() => abortAccountHandoff(locator, { ...f.facts, bindingRevision: 'e'.repeat(64) })).toThrow('uncertain')
  write(join(f.first, '.neutron-owner-retiring.json'), { facts: f.facts })
  expect(() => abortAccountHandoff(locator, f.facts)).toThrow('uncertain')
  write(join(f.first, '.neutron-owner-retired.json'), f.receipt)
  completeAccountHandoff(locator)
  expect(readGeneralOwnerAuthority(f.authorityPath)?.pending?.locator).toEqual(locator)
  expect(() => abortAccountHandoff(locator, f.facts)).toThrow('uncertain')
})

test('clean busy abort is immutable and restores source admission without erasing the prepared target', () => {
  const f = fixture(); unlinkSync(join(f.first, '.neutron-owner-retired.json'))
  const locator = prepareAccountHandoff(f.authorityPath, f.source, f.target, f.first, f.facts)
  abortAccountHandoff(locator, f.facts)
  expect(readGeneralOwnerAuthority(f.authorityPath)).toEqual({ scope: f.source, rootDirectory: f.first, nextIndex: 1 })
  expect(existsSync(`${f.authorityPath}.handoff-0.json.prepare`)).toBe(true)
  expect(existsSync(`${f.authorityPath}.handoff-0.json.abort`)).toBe(true)
  expect(() => completeAccountHandoff(locator)).toThrow('not current')
  expect(prepareAccountHandoff(f.authorityPath, f.source, f.target, f.first, f.facts).index).toBe(1)
})
