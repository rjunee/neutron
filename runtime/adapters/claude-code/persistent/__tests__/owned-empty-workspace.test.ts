import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectWorkspaceManager, type ChatInspection, type ProjectPanePlacement } from '../project-workspaces.ts'
import { FakeHerdrWorkspaceServer } from './herdr-workspace-fake-server.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const scope: ProjectPanePlacement = { instanceId: 'instance', projectId: 'one', projectLabel: 'One', role: 'chat' }
const root = { type: 'pane' as const, cwd: '/tmp', command: ['fixture'], env: {} }
async function fixture(projectId: string | null = 'one') {
  const dir = mkdtempSync(join(tmpdir(), 'empty-owned-workspace-')); dirs.push(dir)
  const path = join(dir, 'journal.json'), manager = new ProjectWorkspaceManager(path)
  const server = new FakeHerdrWorkspaceServer(), placement = { ...scope, projectId }
  server.ownedEmptyWorkspaceRetirement = true
  const applied = await manager.applyLayout(server, root, placement)
  const workspace_id = applied.layout.workspace_id
  if (!workspace_id) throw new Error('fixture creation did not return a workspace identity')
  const created = { ...applied, layout: { ...applied.layout, workspace_id } }
  const observed = await manager.inspectChat(server, placement)
  server.panes.delete(created.layout.root.pane_id)
  const read = () => Object.values(JSON.parse(readFileSync(path, 'utf8')))[0] as Record<string, any>
  return { path, manager, server, placement, created, observed, read }
}

test('atomic empty retirement clears only ownership, and a fresh manager wakes the exact scope', async () => {
  for (const projectId of [null, 'general', 'one']) {
    const f = await fixture(projectId)
    expect(await f.manager.retireEmptyWorkspace(f.server, f.placement, f.observed)).toEqual({ status: 'retired' })
    expect(f.read().state).toBe('retired')
    expect(f.read().workspace).toBeUndefined()
    const next = await new ProjectWorkspaceManager(f.path).applyLayout(f.server, root, f.placement)
    expect(next.layout.workspace_id).not.toBe(f.created.layout.workspace_id)
    expect(f.server.callsTo('workspace.close')).toHaveLength(0)
    const calls = f.server.callsTo('workspace.retire_empty_owned')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.workspace_id).toBe(f.created.layout.workspace_id)
    expect(calls[0]!.params.workspace_token_key).toBe('neutron_project_owner')
  }
})

test('unsupported server preserves journal and never attempts a close', async () => {
  const f = await fixture(); f.server.ownedEmptyWorkspaceRetirement = false
  const before = readFileSync(f.path, 'utf8')
  expect(await f.manager.retireEmptyWorkspace(f.server, f.placement, f.observed)).toEqual({ status: 'unsupported' })
  expect(readFileSync(f.path, 'utf8')).toBe(before)
  expect(f.server.callsTo('workspace.retire_empty_owned')).toHaveLength(0)
  expect(f.server.callsTo('workspace.close')).toHaveLength(0)
})

test('only the exact protocol and explicit boolean capability authorize the operation', async () => {
  for (const pong of [
    { type: 'pong', protocol: 21, capabilities: { owned_empty_workspace_retirement: true } },
    { type: 'pong', protocol: 22 },
    { type: 'pong', protocol: 22, capabilities: { owned_empty_workspace_retirement: 'true' } },
  ]) {
    const f = await fixture(), call = f.server.call.bind(f.server)
    f.server.call = async (method, params) => method === 'ping' ? pong : call(method, params)
    const before = readFileSync(f.path, 'utf8')
    expect((await f.manager.retireEmptyWorkspace(f.server, f.placement, f.observed)).status).toBe('unsupported')
    expect(readFileSync(f.path, 'utf8')).toBe(before)
    expect(f.server.callsTo('workspace.retire_empty_owned')).toHaveLength(0)
  }
})

test('foreign pane arriving at the atomic boundary survives; unchanged empty sibling retires', async () => {
  const f = await fixture()
  f.server.beforeEmptyWorkspaceRetirement = () => {
    f.server.panes.set('foreign', { pane_id: 'foreign', tab_id: 'foreign-tab', workspace_id: f.created.layout.workspace_id,
      argv: ['foreign'], shell_pid: 1, label: 'foreign' })
  }
  expect((await f.manager.retireEmptyWorkspace(f.server, f.placement, f.observed)).status).toBe('refused')
  expect(f.server.panes.has('foreign')).toBe(true)
  expect(f.server.workspaces.has(f.created.layout.workspace_id)).toBe(true)
  expect(f.read().state).toBe('ready')
  expect(f.read().retirement).toBeUndefined()
  // An authenticated non-mutating refusal must not strand the next conversation.
  const wake = await new ProjectWorkspaceManager(f.path).applyLayout(f.server, root, f.placement)
  expect(wake.layout.workspace_id).toBe(f.created.layout.workspace_id)
  expect(f.server.panes.has('foreign')).toBe(true)
  const control = await fixture()
  expect((await control.manager.retireEmptyWorkspace(control.server, control.placement, control.observed)).status).toBe('retired')
})

test('changed marker, original observation or journal refuses with no ownership erasure', async () => {
  for (const field of ['marker', 'revision', 'workspace', 'pane', 'scope']) {
    const f = await fixture(), expected = structuredClone(f.observed) as Exclude<ChatInspection, { status: 'refused' }>
    if (field === 'marker') f.server.beforeEmptyWorkspaceRetirement = () => {
      f.server.workspaces.get(f.created.layout.workspace_id)!.tokens.neutron_project_owner = 'foreign'
    }
    else if (field === 'scope') f.placement.projectId = 'different'
    else expected[field as 'revision' | 'workspace' | 'pane'] = 'foreign'
    expect((await f.manager.retireEmptyWorkspace(f.server, f.placement, expected)).status).not.toBe('retired')
    expect(f.read().workspace).toBe(f.created.layout.workspace_id)
    expect(f.server.workspaces.has(f.created.layout.workspace_id)).toBe(true)
  }
})

test('lost reply reserves across process restart and exact retry accepts positively gone workspace', async () => {
  const f = await fixture(), call = f.server.call.bind(f.server)
  let lose = true
  f.server.call = async (method, params) => {
    const result = await call(method, params)
    if (method === 'workspace.retire_empty_owned' && lose) { lose = false; throw new Error('lost reply') }
    return result
  }
  expect((await f.manager.retireEmptyWorkspace(f.server, f.placement, f.observed)).status).toBe('unknown')
  const restarted = new ProjectWorkspaceManager(f.path)
  await expect(restarted.applyLayout(f.server, root, f.placement)).rejects.toThrow('pending')
  const observed = await restarted.inspectChat(f.server, f.placement)
  expect(observed.status).toBe('gone')
  expect((await restarted.retireEmptyWorkspace(f.server, f.placement, observed)).status).toBe('retired')
  const calls = f.server.callsTo('workspace.retire_empty_owned')
  expect(calls[1]!.params).toEqual(calls[0]!.params)
})

test('uncorrelated acknowledgement or concurrent journal rewrite cannot clear claims', async () => {
  for (const field of ['workspace_id', 'workspace_token_key', 'workspace_token_value', 'operation_id', 'journal']) {
    const f = await fixture(), call = f.server.call.bind(f.server)
    f.server.call = async (method, params) => {
      const reply = await call(method, params)
      if (method === 'workspace.retire_empty_owned') {
        if (field === 'journal') {
          const rows = JSON.parse(readFileSync(f.path, 'utf8'))
          Object.values(rows).forEach(row => { (row as Record<string, unknown>).revision = 'foreign' })
          writeFileSync(f.path, JSON.stringify(rows))
        } else reply[field] = 'foreign'
      }
      return reply
    }
    expect((await f.manager.retireEmptyWorkspace(f.server, f.placement, f.observed)).status).toBe('unknown')
    expect(f.read().state).toBe('retiring')
    expect(f.read().workspace).toBe(f.created.layout.workspace_id)
  }
})

test('retirement retains completed worker reservations across wake', async () => {
  const f = await fixture()
  const worker: ProjectPanePlacement = { ...f.placement, role: 'worker', operationId: 'one-operation', taskLabel: 'Build' }
  // Restore the existing Chat to place a worker without manufacturing a replacement.
  f.server.panes.set(f.created.layout.root.pane_id, { pane_id: f.created.layout.root.pane_id,
    tab_id: f.created.layout.tab_id, workspace_id: f.created.layout.workspace_id, argv: ['fixture'], shell_pid: 1, label: 'Chat' })
  await f.manager.applyLayout(f.server, root, worker)
  const observed = await f.manager.inspectChat(f.server, f.placement)
  f.server.panes.clear()
  const workers = structuredClone(f.read().workers)
  expect((await f.manager.retireEmptyWorkspace(f.server, f.placement, observed)).status).toBe('retired')
  expect(f.read().workers).toEqual(workers)
  const restarted = new ProjectWorkspaceManager(f.path)
  await expect(restarted.applyLayout(f.server, root, worker)).rejects.toThrow('operation completed')
  await restarted.applyLayout(f.server, root, f.placement)
  await expect(restarted.applyLayout(f.server, root, worker)).rejects.toThrow('operation completed')
})

test('unknown result and stale clean refusal cannot release a reservation', async () => {
  for (const status of ['unknown', 'not_empty']) {
    const f = await fixture()
    const call = f.server.call.bind(f.server)
    f.server.call = async (method, params) => {
      if (method !== 'workspace.retire_empty_owned') return call(method, params)
      if (status === 'not_empty') {
        const rows = JSON.parse(readFileSync(f.path, 'utf8'))
        Object.values(rows).forEach(row => { (row as Record<string, unknown>).revision = 'newer' })
        writeFileSync(f.path, JSON.stringify(rows))
      }
      return { type: 'workspace_retirement', ...params, status }
    }
    expect((await f.manager.retireEmptyWorkspace(f.server, f.placement, f.observed)).status).toBe('unknown')
    expect(f.read().state).toBe('retiring')
    expect(f.read().workspace).toBe(f.created.layout.workspace_id)
    await expect(new ProjectWorkspaceManager(f.path).applyLayout(f.server, root, f.placement)).rejects.toThrow('pending')
  }
})
