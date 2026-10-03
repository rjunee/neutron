import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveReplSupervisionPaths, recordedClaudeConversationIdentities } from '../index.ts'
import { poolKeyFor } from '../persistent/pool.ts'
import { type ReplRegistryRecord } from '../persistent/repl-registry.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(scope: string | null = 'project-a') {
  const cwd = mkdtempSync(join(tmpdir(), 'recorded-chat-'))
  roots.push(cwd)
  const options = { substrate_instance_id: 'cc-agent-fixture', user_id: 'owner', cwd,
    project_id: scope ?? 'general', conversationProjectId: scope }
  const paths = deriveReplSupervisionPaths(cwd)
  mkdirSync(paths.stateDir)
  const rows: Record<string, ReplRegistryRecord> = {}
  function row(id: string, overrides: Partial<ReplRegistryRecord> = {}, identity = options) {
    const key = poolKeyFor({ ...identity, credential_identity: id })
    rows[key] = { sessionKey: key, sessionId: `session-${id}`, cwd, channelName: `neutron-${'a'.repeat(32)}`,
      has_session: true, conversationProjectId: identity.conversationProjectId, ...overrides }
    return key
  }
  function save() { writeFileSync(paths.replRegistryPath, JSON.stringify(rows)) }
  return { options, paths, rows, row, save, read: () => recordedClaudeConversationIdentities(options) }
}

test('a readable empty registry is the first-conversation control; dead and asleep identities remain distinct from absence', () => {
  const f = fixture()
  expect(f.read()).toEqual([])
  f.save()
  expect(f.read()).toEqual([])
  f.row('original', { pid: 99999999 })
  f.save()
  expect(f.read()).toEqual(['original'])
  f.row('_nocred', { asleep_at: 10 })
  f.save()
  expect(f.read()).toEqual(['original', '_nocred'])
})

test('record discovery preserves capped rows without changing their authority', () => {
  const f = fixture()
  f.row('original', { capped_at: 123, reuse: { auth_fingerprint: 'old', tool_surface: 'Read', tool_bridge: false } })
  f.save()
  expect(f.read()).toEqual(['original'])
  expect(JSON.parse(readFileSync(f.paths.replRegistryPath, 'utf8'))[Object.keys(f.rows)[0]!]!.capped_at).toBe(123)
})

test('corrupt and matching dropped records refuse; a malformed foreign project does not hide a valid exact record', () => {
  const f = fixture()
  writeFileSync(f.paths.replRegistryPath, '{')
  expect(f.read).toThrow('unreadable')
  const key = f.row('original')
  f.save()
  expect(f.read()).toEqual(['original'])
  writeFileSync(f.paths.replRegistryPath, JSON.stringify({ ...f.rows, [key]: { sessionId: 'incomplete' } }))
  expect(f.read).toThrow('dropped')
  const foreign = poolKeyFor({ ...f.options, project_id: 'foreign', credential_identity: 'unknown' })
  writeFileSync(f.paths.replRegistryPath, JSON.stringify({ ...f.rows, [foreign]: { sessionId: 'incomplete' } }))
  expect(f.read()).toEqual(['original'])
})

test('record identity and exact conversation scope are checked in both directions', () => {
  const f = fixture()
  const key = f.row('original')
  f.save()
  expect(f.read()).toEqual(['original'])
  f.rows[key]!.sessionKey = 'foreign-key'
  f.save()
  expect(f.read).toThrow('ambiguous')
  f.rows[key]!.sessionKey = key
  delete f.rows[key]!.conversationProjectId
  f.save()
  expect(f.read).toThrow('ambiguous')
  f.rows[key]!.conversationProjectId = 'foreign'
  f.save()
  expect(f.read).toThrow('ambiguous')
})

test('foreign instance and owner cannot supply this conversation identity', () => {
  const f = fixture()
  f.row('foreign-user', {}, { ...f.options, user_id: 'foreign' })
  f.row('foreign-instance', {}, { ...f.options, substrate_instance_id: 'cc-agent-foreign' })
  f.save()
  expect(f.read()).toEqual([])
  f.row('original')
  f.save()
  expect(f.read()).toEqual(['original'])
})

test('General and the literal general project retain distinct exact identities', () => {
  const f = fixture(null)
  f.row('general-owner')
  f.row('literal-owner', {}, { ...f.options, conversationProjectId: 'general' })
  f.save()
  expect(f.read()).toEqual(['general-owner'])
  expect(recordedClaudeConversationIdentities({ ...f.options, conversationProjectId: 'general' })).toEqual(['literal-owner'])
})
