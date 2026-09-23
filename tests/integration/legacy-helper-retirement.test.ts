import { afterEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as adapter from '@neutronai/runtime/adapters/claude-code/index.ts'
import { buildLlmCallSubstrate } from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import { poolKeyFor } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { pool, childByKey, committedDispatches, respawnGates, retiringSessionKeys, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { loadRegistry, saveRegistry, type ReplRegistryRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import type { PtyChild } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'legacy-helper-retirement-'))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const { stateDir, replRegistryPath } = adapter.deriveReplSupervisionPaths(cwd)
  mkdirSync(stateDir, { recursive: true })
  const identity = { substrate_instance_id: `cc-nudge-${randomUUID()}`, cwd,
    user_id: 'owner', credential_identity: 'ambient-test' }
  const key = poolKeyFor(identity)
  const row: ReplRegistryRecord = { sessionKey: key, sessionId: randomUUID(),
    child_generation: randomUUID(), cwd, channelName: `neutron-${randomUUID().replaceAll('-', '')}`,
    has_session: true, pane_handle: 'test:p-helper' }
  const helper = buildLlmCallSubstrate({
    ...identity,
    pool: newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'ambient-test', kind: 'ambient', secret: '' }] }),
    ephemeral: true,
  })!
  // A future regression must not reach ordinary adoption, even in a test. It
  // can kill before returning, so intercept it rather than touching any host.
  const adoption = spyOn(adapter, 'reconcileExistingClaudeRepl').mockImplementation(async () => {
    throw new Error('ordinary adoption is forbidden during cleanup')
  })
  cleanups.push(() => adoption.mockRestore())
  function own(
    record: ReplRegistryRecord,
    screen: () => Promise<string> = async () => 'Finished\n❯\n',
    afterKill: () => void = () => {},
  ) {
    let dead = false
    let kills = 0
    let resolveExit!: (code: number | null) => void
    const exited = new Promise<number | null>(resolve => { resolveExit = resolve })
    const child: PtyChild = { pid: 880001, paneHandle: record.pane_handle!, exited,
      hasExited: () => dead, readScreen: screen, write() {},
      kill() { kills += 1; dead = true; resolveExit(null); afterKill() },
    }
    const session = new ReplSession(record.sessionKey, record.child_generation!, record.sessionId, record.channelName, cwd)
    session.attachChild(child)
    session.paneClaimBy = 'owned-test-claim'
    const ownedRow = { ...record, adoption_claim_by: session.paneClaimBy, adoption_claim_at: Date.now() }
    pool.set(record.sessionKey, Promise.resolve(session))
    childByKey.set(record.sessionKey, child)
    supervisedBySessionKey.set(record.sessionKey, { ...identity, replRegistryPath })
    cleanups.push(() => {
      pool.delete(record.sessionKey)
      childByKey.delete(record.sessionKey)
      supervisedBySessionKey.delete(record.sessionKey)
      committedDispatches.delete(record.sessionKey)
      respawnGates.delete(record.sessionKey)
      retiringSessionKeys.delete(record.sessionKey)
      session.paneClaimBy = undefined
    })
    return { session, ownedRow, kills: () => kills }
  }
  return { helper, key, row, path: replRegistryPath, adoption, own }
}

test.each(['missing-health', 'expired-evidence', 'missing-reuse', 'host-change', 'active-native-work'])
('registry-only helper is preserved without adoption: %s', async failure => {
  const f = fixture()
  const row = { ...f.row,
    ...(failure === 'missing-health' ? { devchannel_port: 1 } : {}),
    ...(failure === 'expired-evidence' ? { adoption_claim_at: 1, adoption_claim_by: 'old-claim' } : {}),
    ...(failure === 'host-change' ? { pane_handle: 'other-host:p-helper' } : {}),
  }
  saveRegistry(f.path, { [f.key]: row })
  expect(await f.helper.retireExistingHelpers()).toEqual([{ sessionKey: f.key, outcome: 'refused' }])
  expect(f.adoption).not.toHaveBeenCalled()
  expect(loadRegistry(f.path)[f.key]).toEqual(row)
  expect(retiringSessionKeys.has(f.key)).toBe(false)
})

test.each(['idle', 'busy', 'unknown', 'capture-failed', 'generation-changed', 'registry-changed'])
('owned helper retirement observes current evidence and preserves cc-agent: %s', async state => {
  const f = fixture()
  const owned = f.own(f.row, async () => {
    if (state === 'capture-failed') throw new Error('capture unavailable')
    if (state === 'registry-changed') {
      const options = supervisedBySessionKey.get(f.key)!
      supervisedBySessionKey.set(f.key, { ...options, replRegistryPath: `${f.path}.other` })
    }
    return state === 'busy' ? 'Working\n❯\nesc to interrupt' : state === 'unknown' ? 'unclassified' : 'Finished\n❯\n'
  })
  const chatKey = `cc-agent-control-${randomUUID()}`
  const chat = f.own({ ...f.row, sessionKey: chatKey, sessionId: randomUUID(), pane_handle: 'test:p-chat' })
  const row = { ...owned.ownedRow, ...(state === 'generation-changed' ? { child_generation: randomUUID() } : {}) }
  saveRegistry(f.path, { [f.key]: row, [chatKey]: chat.ownedRow })
  expect(await f.helper.retireExistingHelpers()).toEqual([{ sessionKey: f.key,
    outcome: state === 'idle' ? 'retired' : 'refused' }])
  expect(f.adoption).not.toHaveBeenCalled()
  expect(owned.kills()).toBe(state === 'idle' ? 1 : 0)
  expect(loadRegistry(f.path)[f.key]).toEqual(state === 'idle' ? undefined : row)
  expect(chat.kills()).toBe(0)
  expect(loadRegistry(f.path)[chatKey]).toEqual(chat.ownedRow)
  expect(retiringSessionKeys.has(f.key)).toBe(state === 'idle')
})

test('an active gateway helper is preserved before any idle capture or retirement marker', async () => {
  const f = fixture()
  let captures = 0
  const owned = f.own(f.row, async () => { captures += 1; return '❯\n' })
  saveRegistry(f.path, { [f.key]: owned.ownedRow })
  committedDispatches.set(f.key, 1)
  expect(await f.helper.retireExistingHelpers()).toEqual([{ sessionKey: f.key, outcome: 'refused' }])
  expect(captures).toBe(0)
  expect(owned.kills()).toBe(0)
  expect(retiringSessionKeys.has(f.key)).toBe(false)
  expect(f.adoption).not.toHaveBeenCalled()
})

test('concurrent cleanup retires one owned helper at most once', async () => {
  const f = fixture()
  let captures = 0
  const owned = f.own(f.row, async () => { captures += 1; return '❯\n' })
  saveRegistry(f.path, { [f.key]: owned.ownedRow })
  const results = await Promise.all([f.helper.retireExistingHelpers(), f.helper.retireExistingHelpers()])
  expect(results.flat().map(result => result.outcome).sort()).toEqual(['refused', 'retired'])
  expect(captures).toBe(1)
  expect(owned.kills()).toBe(1)
  expect(retiringSessionKeys.has(f.key)).toBe(true)
  expect(f.adoption).not.toHaveBeenCalled()
})

test('retirement renews the exact owned claim through the ownership funnel before termination', async () => {
  const f = fixture()
  let atTermination: ReplRegistryRecord | undefined
  const owned = f.own(f.row, async () => '❯\n', () => {
    atTermination = loadRegistry(f.path)[f.key]
  })
  const row = { ...owned.ownedRow, adoption_claim_at: 1, adoption_claim_pid: 123 }
  saveRegistry(f.path, { [f.key]: row })
  expect(await f.helper.retireExistingHelpers()).toEqual([{ sessionKey: f.key, outcome: 'retired' }])
  expect(atTermination?.adoption_claim_at).toBeGreaterThan(1)
  expect(atTermination).toEqual({ ...row, adoption_claim_at: atTermination!.adoption_claim_at!,
    adoption_claim_pid: process.pid })
  expect(owned.kills()).toBe(1)
})

test('a post-exit registry change is preserved without reopening admission or respawn', async () => {
  const f = fixture()
  const replacement = { ...f.row, child_generation: randomUUID() }
  const owned = f.own(f.row, async () => '❯\n', () => {
    saveRegistry(f.path, { [f.key]: replacement })
  })
  saveRegistry(f.path, { [f.key]: owned.ownedRow })
  expect(await f.helper.retireExistingHelpers()).toEqual([{ sessionKey: f.key, outcome: 'refused' }])
  expect(owned.kills()).toBe(1)
  expect(loadRegistry(f.path)[f.key]).toEqual(replacement)
  expect(retiringSessionKeys.has(f.key)).toBe(true)
  expect(f.adoption).not.toHaveBeenCalled()
})
