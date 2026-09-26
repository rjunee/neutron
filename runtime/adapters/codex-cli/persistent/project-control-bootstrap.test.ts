import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitsBootstrapConfig, admitsOwnerTui, OWNER_BOOTSTRAP_ORIGINATOR, validateBootstrapMultiAgent, validateBootstrapThread } from './project-control-bootstrap-validation.ts'
import { openProjectControlJournal } from './project-control-broker-journal.ts'
import { readCodexOwnerBinding, type CodexOwnerBindingFacts } from './project-control-bootstrap.ts'

describe('owner bootstrap attestation', () => {
  test('only the exact required native feature can cross the bootstrap config boundary', () => {
    expect(admitsBootstrapConfig({ features: { multi_agent_v2: true }, personality: 'pragmatic', web_search: 'cached' })).toBe(true)
    for (const config of [null, [], {}, { features: {} }, { features: { multi_agent_v2: false } },
      { features: { multi_agent_v2: 'true' } }, { 'features.multi_agent_v2': true },
      { features: { multi_agent_v2: true, shell_tool: true } },
      { features: { multi_agent_v2: true }, cwd: '/foreign' },
      { features: { multi_agent_v2: true }, model_provider: 'foreign' }]) expect(admitsBootstrapConfig(config)).toBe(false)
  })

  test('native feature evidence must affirm one supported enabled feature in a complete response', () => {
    const feature = { name: 'multi_agent_v2', enabled: true, stage: 'underDevelopment' }
    expect(() => validateBootstrapMultiAgent({ data: [feature], nextCursor: null })).not.toThrow()
    for (const response of [null, {}, { data: [] }, { data: [feature], nextCursor: 'more' },
      { data: [feature, feature] }, { data: [{ ...feature, enabled: false }] },
      { data: [{ ...feature, enabled: 'true' }] }, { data: [{ ...feature, name: 'multi_agent' }] },
      { data: [{ ...feature, stage: 'removed' }] }, { data: [{ ...feature, stage: 'deprecated' }] },
      { data: [{ ...feature, stage: 'future' }] }, { data: [{ ...feature, stage: undefined }] }]) {
      expect(() => validateBootstrapMultiAgent(response === null ? null : { nextCursor: null, ...response })).toThrow('capability unavailable')
    }
    expect(() => validateBootstrapMultiAgent({ data: [feature] })).toThrow('capability unavailable')
  })

  test('native event and response agree on exact identity and project namespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-binding-test-'))
    const cwd = join(dir, 'project'), codexHome = join(dir, 'home')
    mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 })
    const thread = { id: 'exact-thread', sessionId: 'exact-session', cwd, path: join(codexHome, 'sessions', 'rollout.jsonl'),
      source: 'vscode', originator: OWNER_BOOTSTRAP_ORIGINATOR, modelProvider: 'fixture', ephemeral: false, turns: [],
      parentThreadId: null, forkedFromId: null, environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] }
    try {
      expect(() => validateBootstrapThread(thread, structuredClone(thread), cwd, codexHome)).not.toThrow()
      const previous: CodexOwnerBindingFacts = { threadId: thread.id, sessionId: thread.sessionId, cwd, codexHome,
        rolloutPath: thread.path, paneHandle: 'prior-pane', bindingRevision: 'a'.repeat(64), generation: 1,
        brokerGeneration: 1, credentialFingerprint: 'prior-account', modelProvider: thread.modelProvider,
        controlSocketPath: join(codexHome, 'owner.sock'), nativeMetadata: { sessionId: thread.sessionId, source: thread.source, originator: thread.originator },
        capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } }
      const resumed = { ...thread, turns: [{ id: 'retained-history' }] }
      expect(() => validateBootstrapThread(resumed, resumed, cwd, codexHome, previous)).not.toThrow()
      expect(() => validateBootstrapThread(resumed, resumed, cwd, codexHome)).toThrow('binding mismatch')
      expect(() => validateBootstrapThread(resumed, resumed, cwd, codexHome, { ...previous, threadId: 'foreign' })).toThrow('resumed owner identity')
      expect(() => validateBootstrapThread(resumed, resumed, cwd, codexHome, { ...previous, rolloutPath: join(codexHome, 'sessions', 'foreign') })).toThrow('resumed owner identity')
      for (const patch of [
        { id: 'foreign' }, { sessionId: 'foreign' }, { source: 'cli' }, { originator: 'codex-tui' },
        { path: join(dir, 'foreign.jsonl') }, { cwd: dir }, { modelProvider: 'other' },
        { environments: [{ environmentId: 'local', cwd: dir, runtimeWorkspaceRoots: [dir] }] },
      ]) expect(() => validateBootstrapThread(thread, { ...thread, ...patch }, cwd, codexHome)).toThrow()
      for (const patch of [
        { cwd: dir }, { path: join(dir, 'foreign.jsonl') }, { path: join(codexHome, 'sessions') },
        { originator: 'foreign' }, { ephemeral: true }, { turns: [{ id: 'seed' }] },
        { parentThreadId: 'foreign' }, { forkedFromId: 'foreign' },
        { environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [dir] }] },
      ]) {
        const changed = { ...thread, ...patch }
        expect(() => validateBootstrapThread(changed, changed, cwd, codexHome)).toThrow()
      }
      symlinkSync(cwd, join(codexHome, 'sessions'))
      expect(() => validateBootstrapThread(thread, thread, cwd, codexHome)).toThrow('Symlink')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('valid native bearer is admitted; missing/foreign/browser/second clients refuse', () => {
    const token = 'fixture-private-token'
    const request = (headers: Record<string, string> = {}, path = '/') => new Request(`http://127.0.0.1:1234${path}`, { headers })
    expect(admitsOwnerTui(request({ authorization: `Bearer ${token}` }), token, false)).toBe(true)
    expect(admitsOwnerTui(request(), token, false)).toBe(false)
    expect(admitsOwnerTui(request({ authorization: 'Bearer foreign' }), token, false)).toBe(false)
    expect(admitsOwnerTui(request({ authorization: `Bearer ${token}`, origin: 'http://foreign.test' }), token, false)).toBe(false)
    expect(admitsOwnerTui(request({ authorization: `Bearer ${token}` }, '/foreign'), token, false)).toBe(false)
    expect(admitsOwnerTui(request({ authorization: `Bearer ${token}` }), token, true)).toBe(false)
  })

  test('attestation cannot be rewritten, lost across reopening, or minted into a handle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-journal-test-'))
    const options = { socketPath: join(dir, 'owner'), cwd: dir, codexHome: dir, threadId: 'fresh-owner-bootstrap' }
    const journal = openProjectControlJournal(options)
    try {
      expect(journal.attestation()).toBeNull()
      journal.sealAttestation('immutable-native-binding')
      expect(journal.attestation()).toBe('immutable-native-binding')
      expect(() => journal.sealAttestation('replacement')).toThrow('already sealed')
      expect(() => openProjectControlJournal(options)).toThrow('still live')
      expect(() => readCodexOwnerBinding({ threadId: 'claimed' } as never)).toThrow('Unattested')
      const generation = journal.generation
      journal.close()
      const reopened = openProjectControlJournal(options)
      try {
        expect(reopened.generation).toBe(generation + 1)
        expect(reopened.attestation()).toBe('immutable-native-binding')
        expect(() => reopened.sealAttestation('replacement')).toThrow('already sealed')
        const tamper = new Database(`${options.socketPath}.sqlite`)
        tamper.exec('DELETE FROM attestation'); tamper.close()
        expect(() => reopened.attestation()).toThrow('identity missing')
      } finally { reopened.close() }
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
