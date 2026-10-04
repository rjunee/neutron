import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectWorkspaceManager } from '../project-workspaces.ts'
import { RelicProcFixture, RelicWorkspaceServer } from './workspace-relic-fixture.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const scope = { instanceId: 'instance', projectId: 'project', projectLabel: 'Project', role: 'chat' as const }
const root = { type: 'pane' as const, cwd: '/tmp', command: ['fixture-native'], env: {} }
async function fixture(birthReceipts = true) {
  const directory = mkdtempSync(join(tmpdir(), 'relic-retirement-')); directories.push(directory)
  const proc = new RelicProcFixture()
  const path = join(directory, 'journal.json'), manager = new ProjectWorkspaceManager(path, proc), server = new RelicWorkspaceServer()
  server.birthReceipts = birthReceipts
  const created = await manager.applyLayout(server, root, scope)
  const pane = server.panes.get(created.layout.root.pane_id)!
  pane.argv = ['/bin/bash']
  proc.add(pane.shell_pid)
  expect(await manager.relinquishDeadChat(server, scope, pane.pane_id, () => true)).toBe(true)
  const read = () => Object.values(JSON.parse(readFileSync(path, 'utf8')))[0] as Record<string, any>
  return { path, manager, server, pane, created, read, proc }
}

test('a creation-bound relic remains visible and retires before its empty workspace', async () => {
  const f = await fixture()
  expect(f.read().relinquishedChats[0].retirementIdentity).toEqual(f.server.births.get(f.pane.pane_id))
  const before = await f.manager.inspectChat(f.server, scope)
  expect(before.status).toBe('relics')
  const rawCloses = f.server.callsTo('pane.close').length
  expect(await f.manager.retireEmptyWorkspace(f.server, scope, before, () => true)).toEqual({ status: 'retired' })
  expect(f.server.panes.has(f.pane.pane_id)).toBe(false)
  expect(f.server.workspaces.size).toBe(0)
  expect(f.read().state).toBe('retired')
  expect(f.server.callsTo('pane.close')).toHaveLength(rawCloses)
  expect(f.server.callsTo('workspace.close')).toHaveLength(0)
})

test('legacy birth is never inferred from the current pane, but a positively absent legacy relic reconciles', async () => {
  const f = await fixture(false), before = await f.manager.inspectChat(f.server, scope)
  expect((await f.manager.retireEmptyWorkspace(f.server, scope, before, () => true)).status).toBe('unknown')
  expect(f.server.panes.has(f.pane.pane_id)).toBe(true)
  expect(f.server.callsTo('pane.hold_owned_input')).toHaveLength(0)
  expect(f.read().state).toBe('ready')
  // Separate operator authority has actually closed it: ordinary reconciliation
  // only observes absence and uses the atomic empty-workspace operation.
  f.server.panes.delete(f.pane.pane_id)
  const restarted = new ProjectWorkspaceManager(f.path, f.proc)
  expect(await restarted.retireEmptyWorkspace(f.server, scope, await restarted.inspectChat(f.server, scope), () => true)).toEqual({ status: 'retired' })
})

test.each(['birth', 'marker', 'reply', 'busy', 'epoch'] as const)('changed %s cannot retire a relic', async fault => {
  const f = await fixture()
  if (fault === 'birth') f.server.beforeHeldRetirement = () => f.server.births.set(f.pane.pane_id, { terminal_id: 'foreign', runtime_generation: 'foreign' })
  if (fault === 'marker') f.server.workspaces.get(f.pane.workspace_id)!.tokens.neutron_project_owner = 'foreign'
  if (fault === 'reply') f.server.alteredHoldReply = true
  if (fault === 'epoch') f.server.changedEpoch = true
  if (fault === 'busy') f.pane.argv = ['working-command']
  const observed = await f.manager.inspectChat(f.server, scope)
  expect((await f.manager.retireEmptyWorkspace(f.server, scope, observed, () => true)).status).not.toBe('retired')
  expect(f.server.panes.has(f.pane.pane_id)).toBe(true)
  if (fault === 'busy') {
    expect(f.server.inputHolds.size).toBe(0)
    expect(f.read().state).toBe('ready')
  }
})

test('lost retirement reply resumes without inventing another hold or losing ownership', async () => {
  const f = await fixture(); f.server.lostRetirementReply = true
  expect((await f.manager.retireEmptyWorkspace(f.server, scope, await f.manager.inspectChat(f.server, scope), () => true)).status).toBe('unknown')
  expect(f.read().retirement.relic.issued).toBe(true)
  const restarted = new ProjectWorkspaceManager(f.path, f.proc)
  await expect(restarted.applyLayout(f.server, root, scope)).rejects.toThrow('pending')
  expect(await restarted.retireEmptyWorkspace(f.server, scope, await restarted.inspectChat(f.server, scope), () => true)).toEqual({ status: 'retired' })
  expect(f.server.callsTo('pane.hold_owned_input')).toHaveLength(1)
})

test.each(['child', 'session', 'tty', 'unreadable', 'missing-control'] as const)('kernel %s evidence refuses an apparently idle foreground', async fault => {
  const f = await fixture(), shell = f.pane.shell_pid
  if (fault === 'child') f.proc.add(55555, shell, 55555, 55555)
  if (fault === 'session') f.proc.add(55555, 1, shell, 55555)
  if (fault === 'tty') f.proc.add(55555, 1, 55555, shell)
  if (fault === 'unreadable') f.proc.read = () => { throw new Error('unreadable') }
  if (fault === 'missing-control') f.proc.rows.delete(process.pid)
  expect((await f.manager.retireEmptyWorkspace(f.server, scope, await f.manager.inspectChat(f.server, scope), () => true)).status).not.toBe('retired')
  expect(f.server.panes.has(f.pane.pane_id)).toBe(true)
  expect(f.server.callsTo('pane.retire_held_owned')).toHaveLength(0)
  expect(f.server.inputHolds.size).toBe(0)
})

test('foreign splits survive relic cleanup and prevent empty-workspace retirement', async () => {
  const f = await fixture()
  f.server.beforeHeldRetirement = () => f.server.panes.set('foreign', { ...f.pane, pane_id: 'foreign', argv: ['editor'] })
  expect((await f.manager.retireEmptyWorkspace(f.server, scope, await f.manager.inspectChat(f.server, scope), () => true)).status).toBe('refused')
  expect(f.server.panes.has('foreign')).toBe(true)
  expect(f.server.panes.has(f.pane.pane_id)).toBe(false)
  expect(f.read().state).toBe('ready')
})

test('uncertain pre-retirement release re-holds its exact token and re-proves idle after intervening input', async () => {
  const f = await fixture()
  f.pane.argv = ['working-command']; f.server.lostReleaseReply = true
  expect((await f.manager.retireEmptyWorkspace(f.server, scope, await f.manager.inspectChat(f.server, scope), () => true)).status).toBe('unknown')
  expect(f.read().retirement.relic.releasing).toBe(true)
  expect(f.read().retirement.relic.issued).not.toBe(true)
  expect(f.server.inputHolds.size).toBe(0)
  f.server.inputEpoch = 2; f.pane.argv = ['/bin/bash']
  const restarted = new ProjectWorkspaceManager(f.path, f.proc)
  expect(await restarted.retireEmptyWorkspace(f.server, scope, await restarted.inspectChat(f.server, scope), () => true)).toEqual({ status: 'retired' })
  const holds = f.server.callsTo('pane.hold_owned_input')
  expect(holds).toHaveLength(2)
  expect(holds[0]!.params.hold_token).toBe(holds[1]!.params.hold_token)
  expect(f.server.callsTo('pane.retire_held_owned')[0]!.params.input_epoch).toBe(2)
})

test('an already issued uncertain retirement cannot be relabelled as a releasable input hold', async () => {
  const f = await fixture()
  f.server.beforeHeldRetirement = () => { throw new Error('retirement response unknown') }
  expect((await f.manager.retireEmptyWorkspace(f.server, scope, await f.manager.inspectChat(f.server, scope), () => true)).status).toBe('unknown')
  expect(f.read().retirement.relic.issued).toBe(true)
  delete f.server.beforeHeldRetirement; f.pane.argv = ['working-command']
  const restarted = new ProjectWorkspaceManager(f.path, f.proc)
  expect((await restarted.retireEmptyWorkspace(f.server, scope, await restarted.inspectChat(f.server, scope), () => true)).status).toBe('unknown')
  expect(f.server.callsTo('pane.release_owned_input')).toHaveLength(0)
  expect(f.read().state).toBe('retiring')
  expect(f.server.inputHolds.size).toBe(1)
})
