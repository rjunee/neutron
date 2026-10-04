import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { reconcileHostTerminatedChat } from '../host-terminated-chat.ts'
import { ProjectWorkspaceManager } from '../project-workspaces.ts'
import { FakeHerdrWorkspaceServer } from './herdr-workspace-fake-server.ts'
import { poolKeyFor } from '../pool.ts'
import { getRecord, saveRegistry, type ReplRegistryRecord } from '../repl-registry.ts'
import { sessionJsonlPath } from '../session-size-watchdog.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import * as capacity from '../../../../workers/claude-capacity-client.ts'
import { createPersistentReplSubstrate, shutdownAllPersistentRepls, setReplToolBridge, clearReplToolBridgeIf } from '../persistent-repl-substrate.ts'
import { pool } from '../pool-state.ts'
import { PLANNER_PROFILE_ID, PLANNER_ROLE } from '../../../../workers/planner-work.ts'
import { lifecycleReplHost } from './lifecycle-repl-host.ts'
import { rearmReplCap } from '../operator-cap-rearm.ts'
import { authFingerprintFor } from '../repl-session.ts'
import * as fs from 'node:fs'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'terminated-chat-')); dirs.push(dir)
  const server = new FakeHerdrWorkspaceServer()
  const manager = new ProjectWorkspaceManager(join(dir, 'workspaces.json'))
  const placement = { instanceId: 'test-instance', projectId: 'project-a', projectLabel: 'A', role: 'chat' as const }
  const root = { type: 'pane' as const, cwd: dir, command: ['/bin/bash'], env: {} }
  const created = await manager.applyLayout(server, root, placement)
  const pane = created.layout.root.pane_id
  const options: PersistentReplSubstrateOptions = { substrate_instance_id: 'test-chat', user_id: 'test-owner',
    project_id: 'project-a', conversationProjectId: 'project-a', cwd: dir, replRegistryPath: join(dir, 'registry.json'), projectsDir: join(dir, 'transcripts') }
  const key = poolKeyFor(options)
  const row: ReplRegistryRecord = { sessionKey: key, sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', child_generation: 'old-generation',
    pid: 876543, cwd: dir, channelName: 'neutron-11112222333344445555666677778888', conversationProjectId: 'project-a', has_session: true,
    model: 'captured-model', capped_at: 100, admission_generation: 0, pane_handle: pane,
    reuse: { auth_fingerprint: '', tool_surface: 'Read,Agent', tool_bridge: true } }
  saveRegistry(options.replRegistryPath!, { [key]: row, sibling: { ...row, sessionKey: 'sibling' } })
  const transcript = sessionJsonlPath(row.sessionId, dir, options.projectsDir)
  mkdirSync(dirname(transcript), { recursive: true }); writeFileSync(transcript, '{"retained":true}\n')
  const call = (authorize = () => true, listing: (() => { pid: number; cmdline: string }[] | undefined) = () => []) =>
    reconcileHostTerminatedChat(options, row, { relinquish: (id, commit) => manager.relinquishDeadChat(server, placement, id, commit) }, authorize, listing)
  return { dir, server, manager, placement, root, pane, options, key, row, transcript, call }
}

test('dead Chat relinquishes only ownership; real placement preserves the old shell and native conversation data', async () => {
  const f = await fixture(); const closed = [...f.server.closed]
  expect(await f.call()).toEqual({ status: 'reconciled' })
  const retained = getRecord(f.options.replRegistryPath!, f.key)!
  expect(retained.pane_handle).toBeUndefined(); expect(retained.pid).toBeUndefined()
  expect(retained.sessionId).toBe(f.row.sessionId); expect(retained.reuse).toEqual(f.row.reuse)
  expect(retained.capped_at).toBe(100); expect(retained.child_generation).toBe('old-generation')
  expect(getRecord(f.options.replRegistryPath!, 'sibling')).toEqual({ ...f.row, sessionKey: 'sibling' })
  expect(readFileSync(f.transcript, 'utf8')).toBe('{"retained":true}\n')
  const replacement = await f.manager.applyLayout(f.server, { ...f.root, command: ['claude', '--resume', retained.sessionId] }, f.placement)
  expect(replacement.layout.root.pane_id).not.toBe(f.pane)
  expect(f.server.panes.has(f.pane)).toBe(true)
  expect(f.server.closed).toEqual(closed)
})

test('ordinary admitted turn genuinely resumes the capped conversation with current tools and credentials before exact cap rearm', async () => {
  const f = await fixture()
  const pin = spyOn(capacity, 'loadClaudeCapacityPin').mockReturnValue(undefined)
  const route = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
  const bridge = { listToolSchemas: () => [], dispatch: async () => ({}) }
  setReplToolBridge(bridge)
  const fake = lifecycleReplHost()
  const argvs: string[][] = []
  writeFileSync(join(f.dir, 'claude'), '#!/bin/sh\nprintf "2.1.285 (Claude Code)\\n"\n', { mode: 0o700 })
  const options: PersistentReplSubstrateOptions = { ...f.options, claude_bin: join(f.dir, 'claude'),
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'current-authorized-fixture' }, skipTrustSeed: true, enableToolBridge: true,
    idleQuietMs: 0, admissionGeneration: async () => 1,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ptyHost: { async spawn(argv, opts) {
      argvs.push(argv)
      const placement = await f.manager.applyLayout(f.server, { type: 'pane', cwd: f.dir, command: argv, env: {} }, f.placement)
      return { ...await fake.host.spawn(argv, opts), paneHandle: placement.layout.root.pane_id }
    } },
  }
  try {
    expect(await f.call()).toEqual({ status: 'reconciled' })
    expect(getRecord(f.options.replRegistryPath!, f.key)!.reuse).toEqual(f.row.reuse)
    const oldRequest = { projectId: 'project-a', sessionKey: f.key, sessionId: f.row.sessionId, childGeneration: f.row.child_generation!, cappedAt: 100 }
    expect(rearmReplCap(options, oldRequest, () => true)).toBe(false)
    const substrate = createPersistentReplSubstrate(options)
    for await (const event of substrate.start({ prompt: 'readiness only', model_preference: ['claude-opus-4-7'],
      tools: [{ name: 'Read' }, { name: 'Agent' }, { name: 'SendMessage' }] as never }).events) {
      if (event.kind === 'error') throw new Error(event.message)
    }
    const session = (await pool.get(f.key))!
    const current = getRecord(f.options.replRegistryPath!, f.key)!
    expect(session.sessionId).toBe(f.row.sessionId)
    expect(session.childGeneration).not.toBe(f.row.child_generation)
    expect(session.plannerRole).toBe(PLANNER_ROLE)
    expect(current.reuse).toEqual({ auth_fingerprint: authFingerprintFor(options.env), tool_surface: 'Read,Agent,SendMessage', tool_bridge: true, planner_profile: PLANNER_PROFILE_ID })
    expect(current.capped_at).toBe(100)
    expect(current.admission_generation).toBe(1)
    expect(argvs).toHaveLength(1)
    expect(argvs[0]![argvs[0]!.indexOf('--resume') + 1]).toBe(f.row.sessionId)
    expect(f.server.panes.has(f.pane)).toBe(true)
    expect(rearmReplCap(options, oldRequest, () => true)).toBe(false)
    expect(rearmReplCap(options, { ...oldRequest, childGeneration: current.child_generation! }, () => false)).toBe(false)
    expect(rearmReplCap(options, { ...oldRequest, childGeneration: current.child_generation! }, () => true)).toBe(true)
    expect(getRecord(f.options.replRegistryPath!, f.key)!.capped_at).toBeUndefined()
  } finally {
    await shutdownAllPersistentRepls()
    clearReplToolBridgeIf(bridge); route.mockRestore(); pin.mockRestore()
  }
}, 15_000)

test.each(['live-owner', 'unknown-processes', 'authorization', 'changed-row', 'changed-pane', 'native-pane', 'foreign-workspace'] as const)
('refuses %s without altering either ownership record, then accepts the valid sibling', async kind => {
  const f = await fixture()
  const original = readFileSync(f.options.replRegistryPath!, 'utf8')
  if (kind === 'changed-row') saveRegistry(f.options.replRegistryPath!, { [f.key]: { ...f.row, child_generation: 'changed' } })
  if (kind === 'changed-pane') {
    const replacement = await f.manager.applyLayout(f.server, f.root, { ...f.placement, role: 'worker', taskLabel: 'Other shell', operationId: 'other' })
    const path = join(f.dir, 'workspaces.json')
    const journal = JSON.parse(readFileSync(path, 'utf8'))
    const entry = Object.values(journal)[0] as { chat: { pane: string; tab: string } }
    entry.chat = { pane: replacement.layout.root.pane_id, tab: replacement.layout.tab_id }
    writeFileSync(path, JSON.stringify(journal))
    saveRegistry(f.options.replRegistryPath!, { [f.key]: { ...f.row, pane_handle: replacement.layout.root.pane_id } })
  }
  if (kind === 'native-pane') f.server.panes.get(f.pane)!.argv = ['claude', '--resume', f.row.sessionId]
  if (kind === 'foreign-workspace') f.server.workspaces.values().next().value!.tokens = {}
  const before = readFileSync(f.options.replRegistryPath!, 'utf8')
  const journal = readFileSync(join(f.dir, 'workspaces.json'), 'utf8')
  const result = await f.call(() => kind !== 'authorization', () => kind === 'unknown-processes' ? undefined
    : kind === 'live-owner' ? [{ pid: 1, cmdline: `claude --resume ${f.row.sessionId}` }] : [])
  expect(result.status).toBe('refused')
  expect(readFileSync(f.options.replRegistryPath!, 'utf8')).toBe(before)
  expect(readFileSync(join(f.dir, 'workspaces.json'), 'utf8')).toBe(journal)
  writeFileSync(f.options.replRegistryPath!, original)
  const valid = await fixture(); expect(await valid.call()).toEqual({ status: 'reconciled' })
})

test.each(['registry', 'journal', 'owner'] as const)('a %s race after the pane probe refuses the ownership commit', async kind => {
  const f = await fixture()
  const journalPath = join(f.dir, 'workspaces.json')
  let raced = false
  const original = f.server.call.bind(f.server)
  f.server.call = async (method, params) => {
    const response = await original(method, params)
    if (method === 'pane.process_info') {
      raced = true
      if (kind === 'registry') saveRegistry(f.options.replRegistryPath!, { [f.key]: { ...f.row, model: 'concurrently-changed' } })
      if (kind === 'journal') {
        const rows = JSON.parse(readFileSync(journalPath, 'utf8'))
        ;(Object.values(rows)[0] as { revision: string }).revision = 'concurrently-changed'
        writeFileSync(journalPath, JSON.stringify(rows))
      }
    }
    return response
  }
  expect((await f.call(() => kind !== 'owner' || !raced)).status).toBe('refused')
  expect(raced).toBe(true)
  expect(getRecord(f.options.replRegistryPath!, f.key)!.pane_handle).toBe(f.pane)
  expect((Object.values(JSON.parse(readFileSync(journalPath, 'utf8')))[0] as { chat: { pane: string } }).chat.pane).toBe(f.pane)
  const valid = await fixture(); expect(await valid.call()).toEqual({ status: 'reconciled' })
})

test('a journal save interrupted after registry commit remains blocked and retries with exact historical identity', async () => {
  const f = await fixture(), path = join(f.dir, 'workspaces.json')
  const journal = readFileSync(path, 'utf8')
  const rename = fs.renameSync
  const fail = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === path) throw new Error('fixture interrupted journal save')
    return rename(from, to)
  })
  try { expect((await f.call()).status).toBe('refused') } finally { fail.mockRestore() }
  expect(readFileSync(path, 'utf8')).toBe(journal)
  const partial = getRecord(f.options.replRegistryPath!, f.key)!
  expect(partial.pane_handle).toBeUndefined()
  expect(partial.host_terminated_chat).toEqual({ pane: f.pane, pid: f.row.pid!, childGeneration: f.row.child_generation! })
  expect(partial.capped_at).toBe(f.row.capped_at)
  await expect(f.manager.applyLayout(f.server, f.root, f.placement)).rejects.toThrow()
  saveRegistry(f.options.replRegistryPath!, { [f.key]: { ...partial,
    host_terminated_chat: { ...partial.host_terminated_chat!, childGeneration: 'wrong-generation' } } })
  expect((await f.call()).status).toBe('refused')
  saveRegistry(f.options.replRegistryPath!, { [f.key]: partial })
  expect(await f.call()).toEqual({ status: 'reconciled' })
  const replacement = await f.manager.applyLayout(f.server, f.root, f.placement)
  expect(replacement.layout.root.pane_id).not.toBe(f.pane)
  expect(f.server.panes.has(f.pane)).toBe(true)
})
