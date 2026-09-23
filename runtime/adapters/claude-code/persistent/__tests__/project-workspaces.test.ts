import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectWorkspaceManager, type ProjectPanePlacement } from '../project-workspaces.ts'
import { HerdrError, type HerdrRpc } from '../herdr-client.ts'
import { setFlockImplForTests } from '../registry-lock.ts'

const directories: string[] = []
afterEach(() => { setFlockImplForTests(undefined); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const scope = (projectId: string | null = 'one', role: 'chat' | 'worker' = 'chat'): ProjectPanePlacement => ({
  instanceId: 'instance', projectId, projectLabel: 'Same display name', role,
  ...(role === 'worker' ? { taskLabel: 'Review · ownership' } : {}),
})
const root = { type: 'pane' as const, cwd: '/tmp', command: ['test-agent'], env: {} }

class Server implements HerdrRpc {
  calls: { method: string; params: Record<string, unknown> }[] = []
  workspaces = new Map<string, { workspace_id: string; tokens: Record<string, unknown> }>()
  panes = new Map<string, { pane_id: string; workspace_id: string; tab_id: string; argv: unknown }>()
  tabs = new Map<string, { tab_id: string; workspace_id: string; pane_count: number }>()
  failure: string | undefined
  rejectWorker = false
  foreignOnReject = false
  afterProcessInfo?: (pane: { pane_id: string; workspace_id: string; tab_id: string; argv: unknown }) => void
  serial = 0
  ordering: string[] = []
  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    if (this.failure === method) throw new Error('transport unavailable')
    switch (method) {
      case 'workspace.create': {
        const workspace_id = `workspace-${++this.serial}`
        const tab_id = `tab-${++this.serial}`
        const workspace = { workspace_id, tokens: {} }
        const pane_id = `pane-${++this.serial}`
        this.ordering.push(tab_id)
        this.workspaces.set(workspace_id, workspace)
        this.tabs.set(tab_id, { workspace_id, tab_id, pane_count: 1 })
        this.panes.set(pane_id, { workspace_id, tab_id, pane_id, argv: ['initial-shell'] })
        return { workspace, tab: { tab_id }, root_pane: { pane_id } }
      }
      case 'workspace.report_metadata': {
        this.workspaces.get(params.workspace_id as string)!.tokens = params.tokens as Record<string, unknown>
        return {}
      }
      case 'workspace.get': {
        const workspace = this.workspaces.get(params.workspace_id as string)
        if (!workspace) throw new HerdrError('workspace_not_found', 'gone')
        return { workspace }
      }
      case 'layout.apply': {
        if (params.workspace_id && params.tab_id) throw new HerdrError('invalid_target', 'use either tab_id or workspace_id, not both')
        const workspace_id = (params.workspace_id ?? this.tabs.get(params.tab_id as string)!.workspace_id) as string
        if (this.rejectWorker && params.tab_label !== 'Chat') {
          if (this.foreignOnReject) this.panes.set('foreign', { pane_id: 'foreign', workspace_id: params.workspace_id as string, tab_id: 'foreign-tab', argv: ['user-shell'] })
          throw new HerdrError('invalid_layout', 'worker rejected')
        }
        if (params.tab_id) {
          this.tabs.delete(params.tab_id as string)
          this.ordering = this.ordering.filter(id => id !== params.tab_id)
          for (const [id, pane] of this.panes) if (pane.tab_id === params.tab_id) this.panes.delete(id)
        }
        const tab_id = `tab-${++this.serial}`
        const pane_id = `pane-${++this.serial}`
        this.tabs.set(tab_id, { tab_id, workspace_id, pane_count: 1 })
        this.ordering.push(tab_id)
        const command = (params.root as Record<string, unknown>).command as string[]
        this.panes.set(pane_id, { workspace_id, tab_id, pane_id, argv: command[0] === '/usr/bin/env' ? command.slice(2) : command })
        return { layout: { workspace_id, tab_id, root: { pane_id } } }
      }
      case 'pane.get': {
        const pane = this.panes.get(params.pane_id as string)
        if (!pane) throw new HerdrError('pane_not_found', 'gone')
        return { pane }
      }
      case 'pane.process_info': {
        const pane = this.panes.get(params.pane_id as string)!
        const result = { process_info: { foreground_processes: [{ argv: pane.argv }] } }
        this.afterProcessInfo?.(pane)
        return result
      }
      case 'tab.get': return { tab: this.tabs.get(params.tab_id as string) }
      case 'tab.move': this.ordering = [params.tab_id as string, ...this.ordering.filter(id => id !== params.tab_id)]; return {}
      case 'tab.close': {
        this.tabs.delete(params.tab_id as string)
        for (const [id, pane] of this.panes) if (pane.tab_id === params.tab_id) this.panes.delete(id)
        return {}
      }
      case 'pane.close': {
        const pane = this.panes.get(params.pane_id as string)
        this.panes.delete(params.pane_id as string)
        if (pane && ![...this.panes.values()].some(other => other.tab_id === pane.tab_id)) {
          this.tabs.delete(pane.tab_id)
          this.ordering = this.ordering.filter(id => id !== pane.tab_id)
        }
        if (pane && ![...this.panes.values()].some(other => other.workspace_id === pane.workspace_id)) this.workspaces.delete(pane.workspace_id)
        return {}
      }
      case 'pane.list': return { panes: [...this.panes.values()].filter(pane => pane.workspace_id === params.workspace_id) }
      case 'workspace.close': {
        this.workspaces.delete(params.workspace_id as string)
        for (const [id, pane] of this.panes) if (pane.workspace_id === params.workspace_id) this.panes.delete(id)
        return {}
      }
      default: throw new Error(`unexpected ${method}`)
    }
  }
  count(method: string) { return this.calls.filter(call => call.method === method).length }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'project-workspaces-'))
  directories.push(directory)
  const path = join(directory, 'registry.json')
  return { path, manager: new ProjectWorkspaceManager(path), server: new Server() }
}

test('General, literal general and another project are distinct even with same label/cwd', async () => {
  const { manager, server } = fixture()
  for (const id of [null, 'general', 'one']) await manager.applyLayout(server, root, scope(id))
  expect(server.count('workspace.create')).toBe(3)
  expect(server.calls.find(c => c.method === 'workspace.create')!.params.label).toBe('Neutron General')
  expect(server.calls.filter(c => c.method === 'layout.apply').every(c => c.params.tab_label === 'Chat')).toBe(true)
  expect(server.calls.filter(c => c.method === 'tab.move').map(c => c.params.insert_index)).toEqual([0, 0, 0])
  expect(server.calls.filter(c => ['workspace.create', 'layout.apply'].includes(c.method)).every(c => c.params.focus === false)).toBe(true)
})

test('worker-first reserves inert Chat then creates named worker; verified Chat retires only placeholder', async () => {
  const { manager, server, path } = fixture()
  const worker = await manager.applyLayout(server, root, scope('one', 'worker'))
  const before = JSON.parse(readFileSync(path, 'utf8'))
  const row = Object.values(before)[0] as { chat: { pane: string; tab: string } }
  expect(server.panes.get(row.chat.pane)!.argv).not.toEqual(root.command)
  const chat = await manager.applyLayout(server, root, scope())
  const mutations = server.calls.filter(c => c.method === 'layout.apply')
  expect(mutations.map(c => c.params.tab_label)).toEqual(['Chat', 'Review · ownership', 'Chat'])
  expect(mutations[2]!.params.tab_id).toBeUndefined()
  expect(mutations[2]!.params.workspace_id).toBe(worker.layout.workspace_id)
  expect(server.panes.has(worker.layout.root.pane_id)).toBe(true)
  expect(server.panes.has(row.chat.pane)).toBe(false)
  expect(server.panes.has(chat.layout.root.pane_id)).toBe(true)
})

test('foreign argv or split placeholder tab refuses replacement, valid restored identity permits it', async () => {
  const { manager, server } = fixture()
  await manager.applyLayout(server, root, scope('one', 'worker'))
  const placeholder = [...server.panes.values()][0]!
  const original = placeholder.argv
  placeholder.argv = ['unrelated-shell']
  await expect(manager.applyLayout(server, root, scope())).rejects.toThrow('identity is not verified')
  expect(server.count('layout.apply')).toBe(2)
  placeholder.argv = original
  server.tabs.get(placeholder.tab_id)!.pane_count = 2
  await expect(manager.applyLayout(server, root, scope())).rejects.toThrow('exclusively owned')
  expect(server.count('layout.apply')).toBe(2)
  server.tabs.get(placeholder.tab_id)!.pane_count = 1
  await manager.applyLayout(server, root, scope())
  expect(server.count('layout.apply')).toBe(3)
})

test('live Chat refuses duplicate spawn but known closed Chat can be recreated', async () => {
  const { manager, server } = fixture()
  const first = await manager.applyLayout(server, root, scope())
  await expect(manager.applyLayout(server, root, scope())).rejects.toThrow('live owner')
  expect(server.count('layout.apply')).toBe(1)
  server.panes.delete(first.layout.root.pane_id)
  await manager.applyLayout(server, root, scope())
  expect(server.count('layout.apply')).toBe(2)
  expect(server.count('workspace.create')).toBe(1)
})

test('concurrent worker wake shares one workspace and names each actual tab', async () => {
  const { manager, server } = fixture()
  await Promise.all(Array.from({ length: 3 }, (_, i) => manager.applyLayout(server, root, { ...scope('one', 'worker'), taskLabel: `Build ${i}` })))
  expect(server.count('workspace.create')).toBe(1)
  expect(server.count('layout.apply')).toBe(4)
  expect(server.calls.filter(c => c.method === 'layout.apply').map(c => c.params.tab_label)).toEqual(['Chat', 'Build 0', 'Build 1', 'Build 2'])
})

test('restart reuses verified workspace; mismatched marker and unavailable server never recreate', async () => {
  const { manager, server, path } = fixture()
  await manager.applyLayout(server, root, scope())
  const restarted = new ProjectWorkspaceManager(path)
  await restarted.applyLayout(server, root, scope('one', 'worker'))
  const workspace = [...server.workspaces.values()][0]!
  const original = workspace.tokens
  workspace.tokens = { neutron_project_owner: 'foreign' }
  await expect(restarted.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('ownership mismatch')
  workspace.tokens = original
  server.failure = 'workspace.get'
  await expect(restarted.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('transport unavailable')
  expect(server.count('workspace.create')).toBe(1)
  server.failure = undefined
  await restarted.applyLayout(server, root, scope('one', 'worker'))
  expect(server.count('workspace.create')).toBe(1)
})

test('positive workspace absence permits recreation, unlike transport errors', async () => {
  const { manager, server } = fixture()
  await manager.applyLayout(server, root, scope())
  server.workspaces.clear()
  await manager.applyLayout(server, root, scope())
  expect(server.count('workspace.create')).toBe(2)
})

test('interrupted creation stays reserved across manager restart; no duplicate workspace', async () => {
  const { manager, server, path } = fixture()
  server.failure = 'workspace.report_metadata'
  await expect(manager.applyLayout(server, root, scope())).rejects.toThrow('transport unavailable')
  server.failure = undefined
  await expect(new ProjectWorkspaceManager(path).applyLayout(server, root, scope())).rejects.toThrow('pending')
  expect(server.count('workspace.create')).toBe(1)
})

test('unavailable lock prevents all external creation; restored lock permits it', async () => {
  const { manager, server } = fixture()
  setFlockImplForTests(null)
  await expect(manager.applyLayout(server, root, scope())).rejects.toThrow('lock unavailable')
  expect(server.calls).toHaveLength(0)
  setFlockImplForTests(undefined)
  await manager.applyLayout(server, root, scope())
  expect(server.count('workspace.create')).toBe(1)
})

test('definitely refused first worker retires only its verified placeholder; server removes empty workspace', async () => {
  const { manager, server, path } = fixture()
  server.rejectWorker = true
  await expect(manager.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('worker rejected')
  expect(server.workspaces.size).toBe(0)
  expect(server.panes.size).toBe(0)
  expect(Object.values(JSON.parse(readFileSync(path, 'utf8'))).map((row: any) => row.state)).toEqual(['ready'])
  expect(server.count('workspace.close')).toBe(0)
  server.rejectWorker = false
  await manager.applyLayout(server, root, scope('one', 'worker'))
  expect(server.workspaces.size).toBe(1)
  expect(server.panes.size).toBe(2)
})

test('post-spawn ordering failure closes the unreturned real child and retains uncertain claim', async () => {
  const { manager, server, path } = fixture()
  server.failure = 'tab.move'
  await expect(manager.applyLayout(server, root, scope())).rejects.toThrow('transport unavailable')
  expect(server.count('pane.close')).toBe(1)
  expect([...server.panes.values()].map(pane => pane.argv)).toEqual([['initial-shell']])
  server.failure = undefined
  await expect(new ProjectWorkspaceManager(path).applyLayout(server, root, scope())).rejects.toThrow('pending')
})

test('failed worker never closes workspace after an unrelated pane has arrived', async () => {
  const { manager, server } = fixture()
  server.rejectWorker = true
  server.foreignOnReject = true
  await expect(manager.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('worker rejected')
  expect(server.workspaces.size).toBe(1)
  expect(server.panes.has('foreign')).toBe(true)
  expect(server.count('workspace.close')).toBe(0)
})

test('failed-worker cleanup preserves a foreign split arriving after its final identity sample', async () => {
  const { manager, server } = fixture()
  server.rejectWorker = true
  let placeholder = ''
  server.afterProcessInfo = pane => {
    placeholder = pane.pane_id
    server.panes.set('late-foreign', { ...pane, pane_id: 'late-foreign', argv: ['user-shell'] })
    server.tabs.get(pane.tab_id)!.pane_count += 1
  }
  await expect(manager.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('worker rejected')
  expect(placeholder).not.toBe('')
  expect(server.panes.has(placeholder)).toBe(false)
  expect(server.panes.has('late-foreign')).toBe(true)
  expect(server.workspaces.size).toBe(1)
  expect(server.count('workspace.close')).toBe(0)
})

test('unknown placeholder identity leaves its pane and pending ownership intact', async () => {
  const { manager, server, path } = fixture()
  server.rejectWorker = true
  server.failure = 'pane.process_info'
  await expect(manager.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('worker rejected')
  const record = Object.values(JSON.parse(readFileSync(path, 'utf8')))[0] as any
  expect(record.state).toBe('pending')
  expect(server.panes.has(record.chat.pane)).toBe(true)
  expect(server.calls.filter(call => call.method === 'pane.close' && call.params.pane_id === record.chat.pane)).toHaveLength(0)
  expect(server.count('workspace.close')).toBe(0)
})

test('real Chat creation preserves a foreign split arriving after placeholder identity verification', async () => {
  const { manager, server } = fixture()
  await manager.applyLayout(server, root, scope('one', 'worker'))
  let placeholder = ''
  let placeholderTab = ''
  server.afterProcessInfo = pane => {
    placeholder = pane.pane_id
    placeholderTab = pane.tab_id
    server.panes.set('late-foreign', { ...pane, pane_id: 'late-foreign', argv: ['user-shell'] })
    server.tabs.get(pane.tab_id)!.pane_count += 1
  }
  const chat = await manager.applyLayout(server, root, scope())
  expect(placeholder).not.toBe('')
  expect(chat.layout.tab_id).not.toBe(placeholderTab)
  expect(server.panes.has(placeholder)).toBe(false)
  expect(server.panes.has('late-foreign')).toBe(true)
  expect(server.ordering[0]).toBe(chat.layout.tab_id)
  expect(server.calls.filter(call => call.method === 'layout.apply').every(call => call.params.tab_id === undefined)).toBe(true)
})

test('competing manager cannot acquire a pending creation, but can use ready ownership', async () => {
  const { manager, server, path } = fixture()
  const first = manager.applyLayout(server, root, scope('one', 'worker'))
  const other = new ProjectWorkspaceManager(path)
  const second = other.applyLayout(server, root, scope('one', 'worker'))
  await expect(second).rejects.toThrow('pending')
  await first
  await other.applyLayout(server, root, scope('one', 'worker'))
  expect(server.count('workspace.create')).toBe(1)
  expect(server.count('layout.apply')).toBe(3)
})

test('worker reuse repairs closed Chat and reorders a moved live slot; uncertainty and foreign slots refuse', async () => {
  const { manager, server } = fixture()
  const chat = await manager.applyLayout(server, root, scope())
  const worker = await manager.applyLayout(server, root, scope('one', 'worker'))
  server.ordering = [worker.layout.tab_id, chat.layout.tab_id]
  await manager.applyLayout(server, root, scope('one', 'worker'))
  expect(server.ordering[0]).toBe(chat.layout.tab_id)
  const count = server.count('layout.apply')
  server.failure = 'pane.get'
  await expect(manager.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('transport unavailable')
  expect(server.count('layout.apply')).toBe(count)
  server.failure = undefined
  const original = server.panes.get(chat.layout.root.pane_id)!
  original.workspace_id = 'foreign'
  await expect(manager.applyLayout(server, root, scope('one', 'worker'))).rejects.toThrow('Chat placement changed')
  expect(server.count('layout.apply')).toBe(count)
  original.workspace_id = chat.layout.workspace_id!
  server.panes.delete(chat.layout.root.pane_id)
  await manager.applyLayout(server, root, scope('one', 'worker'))
  expect(server.count('layout.apply')).toBe(count + 2)
  const replacement = server.calls.filter(call => call.method === 'layout.apply').at(-2)!
  expect(replacement.params.tab_label).toBe('Chat')
  const repaired = [...server.panes.values()].find(pane => Array.isArray(pane.argv) && pane.argv.length === 4)!
  expect(server.ordering[0]).toBe(repaired.tab_id)
})

test('ready-record CAS admits only one concurrent manager mutation', async () => {
  const { manager, server, path } = fixture()
  await manager.applyLayout(server, root, scope())
  const other = new ProjectWorkspaceManager(path)
  const results = await Promise.allSettled([
    manager.applyLayout(server, root, scope('one', 'worker')),
    other.applyLayout(server, root, scope('one', 'worker')),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(server.count('layout.apply')).toBe(2)
  await other.applyLayout(server, root, scope('one', 'worker'))
  expect(server.count('layout.apply')).toBe(3)
})

test.if(process.platform === 'linux')('real placeholder exec clears inherited synthetic credentials', async () => {
  const { manager, server } = fixture()
  const workerEnv = { NEUTRON_TEST_EXPLICIT_WORKER_VALUE: 'preserved' }
  await manager.applyLayout(server, { ...root, env: workerEnv }, scope('one', 'worker'))
  const command = (server.calls.find(call => call.method === 'layout.apply')!.params.root as { command: string[] }).command
  const actualWorker = server.calls.filter(call => call.method === 'layout.apply').at(-1)!.params.root as { env: Record<string, string>; command: string[] }
  expect(actualWorker.env).toEqual(workerEnv)
  expect(actualWorker.command).toEqual(root.command)
  const env = { NEUTRON_TEST_INHERITED_SECRET: 'synthetic' }
  const control = Bun.spawn([process.execPath, '-e', 'console.log(process.env.NEUTRON_TEST_INHERITED_SECRET === "synthetic")'], { env, stdout: 'pipe' })
  expect((await new Response(control.stdout).text()).trim()).toBe('true')
  expect(await control.exited).toBe(0)
  const child = Bun.spawn(command, { env, stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('Chat is asleep')
    reader.releaseLock()
    expect(readFileSync(`/proc/${child.pid}/environ`, 'utf8')).not.toContain('NEUTRON_TEST_INHERITED_SECRET')
  } finally { child.kill(); await child.exited }
})
