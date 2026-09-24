import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerdrHost } from '../herdr-host.ts'
import { createProjectWorkspaceHost } from '../project-workspace-host.ts'
import { FakeHerdrServer } from './herdr-fake-server.ts'
import { FakeHerdrWorkspaceServer } from './herdr-workspace-fake-server.ts'

const placement = { instanceId: 'instance', projectId: 'project', projectLabel: 'Project', role: 'chat' as const }

test('explicit scope cannot fall back to inherited workspace when manager missing', async () => {
  const server = new FakeHerdrServer()
  const host = new HerdrHost({ connect: async () => server, workspaceId: 'wrong-workspace' })
  await expect(host.spawn(['test-agent'], { cwd: '/tmp', env: {}, onScreen() {}, projectPlacement: placement })).rejects.toThrow('requires a workspace manager')
  expect(server.callsTo('layout.apply')).toHaveLength(0)
  // Positive control: an explicitly unscoped host still exercises the real spawn.
  const child = await host.spawn(['test-agent'], { cwd: '/tmp', env: {}, label: 'Utility', onScreen() {} })
  expect(server.callsTo('layout.apply')[0]!.params.tab_label).toBe('Utility')
  await child.kill()
})

test('host delegates project scope/root to manager and uses returned pane', async () => {
  const server = new FakeHerdrServer()
  let routed = false
  const host = new HerdrHost({ connect: async () => server, workspaceId: 'wrong-workspace',
    projectWorkspaces: { async applyLayout(client, root, scope) {
      expect(client).toBe(server)
      expect(scope).toEqual(placement)
      expect(root.command).toEqual(['test-agent'])
      routed = true
      return { layout: { workspace_id: 'project-workspace', tab_id: 'chat-tab', root: { pane_id: server.paneId } } }
    } },
  })
  const child = await host.spawn(['test-agent'], { cwd: '/tmp', env: {}, onScreen() {}, projectPlacement: placement })
  expect(routed).toBe(true)
  expect(child.paneHandle).toBe(server.paneId)
  expect(server.callsTo('layout.apply')).toHaveLength(0)
  expect(server.callsTo('pane.process_info').length).toBeGreaterThan(0)
  await child.kill()
})

const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })

test('a worker-role spawn through the strict project host sends the exact workspace/tab RPC sequence', async () => {
  const server = new FakeHerdrWorkspaceServer()
  const directory = mkdtempSync(join(tmpdir(), 'herdr-worker-placement-')); temporary.push(directory)
  const host = createProjectWorkspaceHost(join(directory, 'terminal', 'workspaces.json'), { connect: async () => server, pidWaitMs: 500 })
  const worker = (taskLabel: string) => ({ instanceId: 'instance', projectId: 'project', projectLabel: 'Project', role: 'worker' as const, taskLabel, operationId: taskLabel })
  const first = await host.spawn(['viewer'], { cwd: directory, env: {}, label: 'Review · first', onScreen() {}, projectPlacement: worker('Review · first') })
  first.detach?.()
  expect(server.calls.map(call => call.method)).toEqual(['ping', 'workspace.create', 'workspace.report_metadata',
    'layout.apply', 'pane.close', 'tab.move', 'layout.apply', 'pane.process_info'])
  const applies = server.callsTo('layout.apply').map(call => [call.params['workspace_id'], call.params['tab_label']])
  expect(server.workspaces.size).toBe(1)
  const [workspace] = [...server.workspaces.keys()]
  expect(applies).toEqual([[workspace, 'Chat'], [workspace, 'Review · first']])
  // A second worker in the same project reuses the verified workspace: no create.
  const before = server.calls.length
  const second = await host.spawn(['viewer'], { cwd: directory, env: {}, label: 'Build · second', onScreen() {}, projectPlacement: worker('Build · second') })
  second.detach?.()
  expect(server.calls.slice(before).map(call => call.method)).toEqual(['ping', 'workspace.get', 'pane.get', 'tab.get',
    'pane.process_info', 'tab.move', 'layout.apply', 'pane.process_info'])
  expect(server.callsTo('layout.apply').at(-1)!.params['workspace_id']).toBe(workspace)
  expect(server.callsTo('workspace.create')).toHaveLength(1)
})

test('the strict project host refuses an unplaced spawn before any layout is applied', async () => {
  const server = new FakeHerdrWorkspaceServer()
  const directory = mkdtempSync(join(tmpdir(), 'herdr-worker-placement-')); temporary.push(directory)
  const host = createProjectWorkspaceHost(join(directory, 'terminal', 'workspaces.json'), { connect: async () => server, pidWaitMs: 500 })
  await expect(host.spawn(['viewer'], { cwd: directory, env: {}, label: 'Review · loose', onScreen() {} })).rejects.toThrow()
  expect(server.callsTo('layout.apply')).toHaveLength(0)
  expect(server.callsTo('workspace.create')).toHaveLength(0)
})
