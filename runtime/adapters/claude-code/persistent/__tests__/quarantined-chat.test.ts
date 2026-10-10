import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relinquishQuarantinedConversationChat, type CompletedConversationQuarantine } from '../quarantined-chat.ts'
import { readProcessIdentity } from '../process-identity.ts'
import { upsertRecord } from '../repl-registry.ts'
import { committedDispatches } from '../pool-state.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'terminated-chat-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
  cleanups.push(async () => { if (child.exitCode === null) child.kill(); await child.exited })
  const identity = readProcessIdentity(child.pid)!
  expect(identity).toBeDefined()
  const registryPath = join(dir, 'registry.json'), channel = `neutron-${'a'.repeat(32)}`
  const row = { sessionKey: 'fixture-key', sessionId: 'fixture-session', cwd: dir, conversationProjectId: 'project',
    channelName: channel, has_session: true, pid: child.pid, child_generation: 'generation', pane_handle: 'fixture-pane' }
  upsertRecord(registryPath, row)
  const proof: CompletedConversationQuarantine = { operationId: 'operation', parent: { sessionId: row.sessionId,
    childGeneration: row.child_generation, pid: child.pid, processIdentity: identity,
    launch: { version: 1, sessionId: row.sessionId, childGeneration: row.child_generation, projectId: 'project',
      executable: { realPath: process.execPath, sha256: 'a'.repeat(64), version: 'fixture' }, argv: ['fixture', channel], tools: [] } } }
  let currentProof: CompletedConversationQuarantine | undefined = proof, calls = 0
  const run = () => relinquishQuarantinedConversationChat({ scope: 'project', registryPath, pane: row.pane_handle,
    completed: () => currentProof, relinquish: async (_identity, current) => { calls++; return current() } })
  return { child, registryPath, row, proof, run, calls: () => calls, setProof: (p: typeof currentProof) => { currentProof = p } }
}

test('only completed termination releases a dead parent pane; registry history stays intact', async () => {
  const f = await fixture(), before = readFileSync(f.registryPath, 'utf8')
  expect(await f.run()).toBe(true) // Existing quarantined, living-parent protocol.
  const terminated = { ...f.proof, nativeLoop: 'terminated' as const }
  f.setProof(terminated)
  expect(await f.run()).toBe(false) // Signed completion cannot overrule a still-live process.
  f.child.kill(); await f.child.exited
  f.setProof(undefined); expect(await f.run()).toBe(false)
  f.setProof(f.proof); expect(await f.run()).toBe(false)
  f.setProof(terminated); expect(await f.run()).toBe(true)
  expect(f.calls()).toBe(2)
  expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
})

test('changed identity, pending dispatch and changed registry refuse terminated pane handoff', async () => {
  const f = await fixture(); f.child.kill(); await f.child.exited
  const terminated = { ...f.proof, nativeLoop: 'terminated' as const }
  f.setProof(terminated); expect(await f.run()).toBe(true)
  f.setProof({ ...terminated, parent: { ...terminated.parent, childGeneration: 'foreign' } })
  expect(await f.run()).toBe(false)
  f.setProof(terminated)
  committedDispatches.set(f.row.sessionKey, 1)
  try { expect(await f.run()).toBe(false) } finally { committedDispatches.delete(f.row.sessionKey) }
  upsertRecord(f.registryPath, { ...f.row, conversationProjectId: 'other' })
  expect(await f.run()).toBe(false)
  expect(f.calls()).toBe(1)
})
