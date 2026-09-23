import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectWorkspaceHost } from '../project-workspace-host.ts'
import { FakeHerdrServer } from './herdr-fake-server.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

test.each([null, 'general', 'project'])('strict host routes exact scope %s through durable manager', async projectId => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-host-'))
  directories.push(directory)
  const journal = join(directory, 'workspaces.json')
  const server = new FakeHerdrServer()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const host = createProjectWorkspaceHost(journal, { connect: async () => ({ async call(method, params) {
    calls.push({ method, params })
    if (method === 'workspace.create') return { workspace: { workspace_id: 'w9' }, root_pane: { pane_id: 'initial' } }
    if (method === 'workspace.report_metadata' || method === 'tab.move'
      || method === 'pane.close' && params.pane_id === 'initial') return {}
    return server.call(method, params)
  } }) })
  const options = { cwd: '/tmp', env: { HERDR_WORKSPACE_ID: 'foreign' }, onScreen() {} }
  await expect(host.spawn(['test-agent'], options)).rejects.toThrow('requires explicit placement')
  expect(calls).toEqual([])
  const child = await host.spawn(['test-agent'], { ...options,
    projectPlacement: { instanceId: 'instance', projectId, projectLabel: 'Same display name', role: 'chat' } })
  try {
    expect(child.paneHandle).toBe(server.paneId)
    expect(calls.find(call => call.method === 'workspace.create')?.params.label)
      .toBe(projectId === null ? 'Neutron General' : 'Same display name')
    expect(server.callsTo('layout.apply')[0]?.params).toMatchObject({ workspace_id: 'w9', tab_label: 'Chat', focus: false })
    expect(Object.values(JSON.parse(readFileSync(journal, 'utf8')))).toMatchObject([{ scope: ['instance', projectId], state: 'ready' }])
    expect(calls.find(call => call.method === 'tab.move')?.params.insert_index).toBe(0)
  } finally { child.detach?.() }
})

test('relative journal path is refused before a host can be used', () => {
  expect(() => createProjectWorkspaceHost('workspaces.json')).toThrow('absolute path')
})

test('invalid explicit scope cannot fall through to an inherited workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-host-'))
  directories.push(directory)
  const server = new FakeHerdrServer()
  const host = createProjectWorkspaceHost(join(directory, 'workspaces.json'), { connect: async () => server })
  await expect(host.spawn(['test-agent'], { cwd: '/tmp', env: {}, onScreen() {},
    projectPlacement: { instanceId: '', projectId: null, projectLabel: 'General', role: 'chat' },
  })).rejects.toThrow('invalid explicit scope')
  expect(server.callsTo('layout.apply')).toHaveLength(0)
})
