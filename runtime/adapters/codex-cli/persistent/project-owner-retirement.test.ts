import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helperIdentity } from './project-owner-helper-protocol.ts'
import { assertOwnerProcessDead, nextOwnerDirectory, readCompletedOwnerRetirement, validateOwnerResume, type CodexOwnerRetirementReceipt } from './project-owner-retirement.ts'

test('recorded live process refuses retirement recovery; its proven exit permits the same record', async () => {
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const identity = helperIdentity(child.pid)
    expect(() => assertOwnerProcessDead(identity)).toThrow('still live')
    child.kill(); await child.exited
    expect(() => assertOwnerProcessDead(identity)).not.toThrow()
    expect(() => assertOwnerProcessDead({ ...identity, pid: 0 })).toThrow('incomplete')
    expect(() => assertOwnerProcessDead({ ...identity, boot: '' })).toThrow('incomplete')
  } finally { child.kill(); await child.exited }
})

test('completed generation preserves history and permits only its exact successor after all owners exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-retirement-'))
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const identity = helperIdentity(child.pid)
    mkdirSync(join(dir, 'sessions'))
    const rolloutPath = join(dir, 'sessions', 'rollout.jsonl')
    writeFileSync(rolloutPath, 'retained conversation\n')
    const receipt: CodexOwnerRetirementReceipt = { version: 1, helper: identity, terminal: identity,
      native: { identity, code: null, signal: 'SIGTERM' },
      facts: { threadId: 'thread', sessionId: 'session', cwd: dir, codexHome: dir, rolloutPath,
        paneHandle: 'owned-pane', bindingRevision: 'a'.repeat(64), generation: 1, brokerGeneration: 1,
        credentialFingerprint: 'fingerprint', modelProvider: 'fixture', controlSocketPath: join(dir, 'owner.sock'),
        nativeMetadata: { sessionId: 'session', source: 'vscode', originator: 'neutron-owner-bootstrap' },
        capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } } }
    writeFileSync(join(dir, '.neutron-owner-authority.json'), JSON.stringify({ facts: receipt.facts, helper: identity }), { mode: 0o600 })
    const path = join(dir, '.neutron-owner-retired.json')
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 })
    expect(() => readCompletedOwnerRetirement(dir)).toThrow('still live')
    child.kill(); await child.exited
    expect(readCompletedOwnerRetirement(dir)).toEqual(receipt)
    const resume = { predecessorDirectory: dir, receipt }
    expect(() => validateOwnerResume(nextOwnerDirectory(receipt.facts), resume, dir, dir)).not.toThrow()
    expect(() => validateOwnerResume(dir, resume, dir, dir)).toThrow('predecessor')
    expect(() => validateOwnerResume(nextOwnerDirectory(receipt.facts), resume, join(dir, 'foreign'), dir)).toThrow('predecessor')
    expect(readFileSync(rolloutPath, 'utf8')).toBe('retained conversation\n')
    writeFileSync(path, JSON.stringify({ ...receipt, facts: { ...receipt.facts, threadId: 'foreign' } }))
    expect(() => readCompletedOwnerRetirement(dir)).toThrow('corroborated')
    writeFileSync(path, JSON.stringify({ ...receipt, native: { ...receipt.native, signal: null } }))
    expect(() => readCompletedOwnerRetirement(dir)).toThrow('corroborated')
  } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }) }
})
