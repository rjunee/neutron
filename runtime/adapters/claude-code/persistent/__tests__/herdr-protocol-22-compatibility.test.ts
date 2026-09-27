import { describe, expect, it } from 'bun:test'
import { createHerdrRpc, type HerdrCallOpts } from '../herdr-client.ts'
import { HerdrHost } from '../herdr-host.ts'

// Independently transcribed from official Herdr v0.9.1, commit 065ef9d:
// src/api/schema/{response,panes}.rs. Deliberately independent of the shared
// fake server and Neutron's version constant: changing a pin cannot change these.
const paneId = 'w7:p3'
const argv = ['claude', '--resume', 'fixture-session']
const workspace = { workspace_id: 'w7', number: 7, label: 'fixture', focused: false,
  pane_count: 1, tab_count: 1, active_tab_id: 'w7:t2', agent_status: 'idle',
  tokens: { neutron_project_owner: 'fixture-owner' } }
const tab = { tab_id: 'w7:t2', workspace_id: 'w7', number: 2, label: 'Chat',
  focused: false, pane_count: 1, agent_status: 'idle' }
const pane = {
  pane_id: paneId, terminal_id: 'terminal-fixture', workspace_id: 'w7', tab_id: 'w7:t2',
  focused: false, label: 'fixture', agent_status: 'idle', revision: 7,
  scroll: { offset_from_bottom: 0, max_offset_from_bottom: 10, viewport_rows: 40 },
}
const results: Record<string, Record<string, unknown>> = {
  ping: { type: 'pong', version: '0.9.1', protocol: 22, capabilities: null },
  'layout.apply': { type: 'layout_apply', layout: {
    workspace_id: 'w7', tab_id: 'w7:t2', zoomed: false, focused_pane_id: paneId,
    root: { type: 'pane', pane_id: paneId, label: 'fixture', command: argv, env: {} },
  } },
  'pane.get': { type: 'pane_info', pane },
  'pane.process_info': { type: 'pane_process_info', process_info: {
    pane_id: paneId, shell_pid: 31337,
    foreground_processes: [{ pid: 31337, name: 'claude', argv0: 'claude', argv }],
  } },
  'pane.read': { type: 'pane_read', read: {
    pane_id: paneId, workspace_id: 'w7', tab_id: 'w7:t2', source: 'recent_unwrapped',
    format: 'text', text: 'fixture output ✅', revision: 7, truncated: false,
  } },
  'pane.send_text': { type: 'ok' },
  'pane.send_keys': { type: 'ok' },
  'pane.close': { type: 'ok' },
  'workspace.create': { type: 'workspace_created', workspace, tab, root_pane: pane },
  'workspace.get': { type: 'workspace_info', workspace },
  'workspace.report_metadata': { type: 'ok' },
  'tab.get': { type: 'tab_info', tab },
  'tab.move': { type: 'ok' },
}

function fixtureTransport(overrides: Record<string, Record<string, unknown>> = {}) {
  const requests: { id: string; method: string; params: Record<string, unknown> }[] = []
  const connect: NonNullable<HerdrCallOpts['connect']> = async (_path, handlers) => ({
    write(frame) {
      const request = JSON.parse(frame) as typeof requests[number]
      requests.push(request)
      const result = overrides[request.method] ?? results[request.method]
      if (result === undefined) throw new Error(`unreviewed method ${request.method}`)
      queueMicrotask(() => handlers.onBytes(new TextEncoder().encode(
        `${JSON.stringify({ id: request.id, result })}\n`,
      )))
      return Buffer.byteLength(frame)
    },
    end() {},
  })
  return { requests, rpc: createHerdrRpc({ socketPath: '/fixture', connect }) }
}

describe('official protocol 22 consumed JSON shapes', () => {
  it('preserves project placement and ownership metadata envelopes', async () => {
    const { rpc, requests } = fixtureTransport()
    const created = await rpc.call('workspace.create', { cwd: '/tmp', label: 'fixture', focus: false })
    expect(created['workspace']).toMatchObject({ workspace_id: 'w7' })
    expect(created['root_pane']).toMatchObject({ pane_id: paneId })
    await rpc.call('workspace.report_metadata', { workspace_id: 'w7', source: 'neutron-project-workspaces',
      tokens: { neutron_project_owner: 'fixture-owner' } })
    expect((await rpc.call('workspace.get', { workspace_id: 'w7' }))['workspace'])
      .toMatchObject({ tokens: { neutron_project_owner: 'fixture-owner' } })
    expect((await rpc.call('tab.get', { tab_id: 'w7:t2' }))['tab'])
      .toMatchObject({ workspace_id: 'w7', tab_id: 'w7:t2' })
    await rpc.call('tab.move', { tab_id: 'w7:t2', insert_index: 0 })
    expect(requests.at(-1)?.params).toEqual({ tab_id: 'w7:t2', insert_index: 0 })
  })
  it('spawns, inspects, reads, submits and closes through the actual socket codec', async () => {
    const { rpc, requests } = fixtureTransport()
    const host = new HerdrHost({ connect: async () => rpc, workspaceId: 'w7', pollIntervalMs: 60_000 })
    const child = await host.spawn(argv, { cwd: '/tmp', env: {}, label: 'fixture' })
    try {
      expect(child.pid).toBe(31337)
      expect(await child.readScreen!()).toBe('fixture output ✅')
      expect(await host.inspectHandle(paneId)).toMatchObject({ kind: 'live', pid: 31337, argv })
      child.beginOutput?.()
      await child.submitLine!('fixture prompt')
      const read = await rpc.call('pane.read', {
        pane_id: paneId, source: 'recent_unwrapped', lines: 240, format: 'text', strip_ansi: true,
      })
      expect(read['read']).toMatchObject({ text: 'fixture output ✅', revision: 7, truncated: false })
      expect(requests.find(r => r.method === 'layout.apply')?.params).toMatchObject({
        workspace_id: 'w7', focus: false, root: { type: 'pane', command: argv },
      })
      expect(requests.filter(r => r.method === 'pane.send_text').at(-1)?.params)
        .toEqual({ pane_id: paneId, text: '\x1b[200~fixture prompt\x1b[201~' })
      expect(requests.filter(r => r.method === 'pane.send_keys').at(-1)?.params)
        .toEqual({ pane_id: paneId, keys: ['enter'] })
      await host.closeHandle(paneId)
      expect(requests.at(-1)?.method).toBe('pane.close')
    } finally {
      child.detach?.()
    }
  })

  it('refuses a changed pane.read nesting rather than inventing an empty screen', async () => {
    const { rpc } = fixtureTransport({ 'pane.read': { type: 'pane_read', text: 'wrong nesting' } })
    const host = new HerdrHost({ connect: async () => rpc, workspaceId: 'w7', pollIntervalMs: 60_000 })
    const child = await host.spawn(argv, { cwd: '/tmp', env: {} })
    try {
      await expect(child.readScreen!()).rejects.toThrow('screen capture unavailable')
    } finally {
      child.detach?.()
    }
  })
})
