import { expect, test } from 'bun:test'
import { HerdrHost } from '../herdr-host.ts'
import { FakeHerdrServer } from './herdr-fake-server.ts'

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
