import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectWorkspaceHost } from '../adapters/claude-code/persistent/project-workspace-host.ts'
import { FakeHerdrWorkspaceServer } from '../adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import { createWorkerPlacement, openWorkerView, VIEW_FOLLOW_SCRIPT, workerTaskLabel, type WorkerPlacementScope } from './worker-placement.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(projectId: string | null = 'project-one', server = new FakeHerdrWorkspaceServer()) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-placement-'))
  directories.push(directory)
  const journal = join(directory, 'terminal', 'workspaces.json')
  const host = createProjectWorkspaceHost(journal, { connect: async () => server, pidWaitMs: 500, outputGateMaxMs: 1, pollIntervalMs: 10 })
  const scope: WorkerPlacementScope = { instanceId: 'instance', projectId, projectLabel: 'Project One' }
  const placement = createWorkerPlacement({ host, scope })
  const input = (key = 'claude-headless-k1', taskLabel = workerTaskLabel('review', 'authentication')) =>
    ({ key, taskLabel, cwd: directory, viewPath: join(directory, `${key}.view.log`), receiptDir: directory })
  const receipt = (key = 'claude-headless-k1') => JSON.parse(readFileSync(join(directory, `${key}.placement.json`), 'utf8'))
  return { directory, journal, host, server, scope, placement, input, receipt }
}

const createdWorkspaces = (server: FakeHerdrWorkspaceServer) => new Set([...server.workspaces.keys()])

test('worker task label names the role and task, bounded and control-free', () => {
  expect(workerTaskLabel('review', 'authentication')).toBe('Review · authentication')
  expect(workerTaskLabel('build', '  fix\nthe\tbuild  ')).toBe('Build · fix the build')
  expect(workerTaskLabel('synthesis', '')).toBe('Synthesis · task')
  expect(workerTaskLabel('plan', 'x'.repeat(80))).toHaveLength('Plan · '.length + 48)
})

test('project placement sends the exact workspace/tab RPCs and runs a credential-free view, never a worker', async () => {
  const previous = process.env['HERDR_WORKSPACE_ID']
  process.env['HERDR_WORKSPACE_ID'] = 'ambient-foreign-workspace'
  try {
    const f = fixture()
    const view = await f.placement.place(f.input())
    expect(view.kind).toBe('placed')
    expect(f.server.callsTo('workspace.create').map(call => call.params['label'])).toEqual(['Project One'])
    const workspace = [...createdWorkspaces(f.server)][0]!
    const applies = f.server.callsTo('layout.apply')
    expect(applies.map(call => call.params['tab_label'])).toEqual(['Chat', 'Review · authentication'])
    const worker = applies[1]!.params as { workspace_id: string; tab_label: string; focus: boolean
      root: { label: string; command: string[]; env: Record<string, string> } }
    expect(worker.workspace_id).toBe(workspace)
    expect(worker.focus).toBe(false)
    expect(worker.root.label).toBe('Review · authentication')
    expect(worker.root.command.slice(0, 2)).toEqual(['/usr/bin/env', '-i'])
    expect(worker.root.command).toContain(VIEW_FOLLOW_SCRIPT)
    expect(worker.root.command.at(-1)).toBe(f.input().viewPath)
    for (const token of worker.root.command) expect(token).not.toMatch(/(^|\/)(claude|codex)$|codex-build\.sh$/)
    // Nothing from the gateway reaches the view but the host's own lane marker.
    expect(Object.keys(worker.root.env).filter(name => name !== 'NEUTRON_LANE_CLAIM')).toEqual([])
    const [row] = Object.values(JSON.parse(readFileSync(f.journal, 'utf8'))) as Array<{ chat: { tab: string } }>
    expect(f.server.callsTo('tab.move').map(call => call.params)).toEqual([{ tab_id: row!.chat.tab, insert_index: 0 }])
    expect(f.server.tabs.get(row!.chat.tab)?.label).toBe('Chat')
    // The inherited workspace never appears on the wire.
    expect(JSON.stringify(f.server.calls)).not.toContain('ambient-foreign-workspace')
    // Detached at once: the host never polls the view's screen, even after several
    // poll intervals have passed (the rig polls every 10ms with no output gate).
    await Bun.sleep(100)
    expect(f.server.callsTo('pane.read')).toHaveLength(0)
    expect(f.receipt()).toEqual({ state: 'placed', pane: (view as { paneHandle: string }).paneHandle })
  } finally {
    if (previous === undefined) delete process.env['HERDR_WORKSPACE_ID']
    else process.env['HERDR_WORKSPACE_ID'] = previous
  }
})

test('General uses Neutron General and the literal project id general is a different workspace', async () => {
  const server = new FakeHerdrWorkspaceServer()
  const general = fixture(null, server)
  expect((await general.placement.place(general.input())).kind).toBe('placed')
  const literal = createWorkerPlacement({ host: general.host, scope: { instanceId: 'instance', projectId: 'general', projectLabel: 'general' } })
  expect((await literal.place(general.input('claude-headless-k2'))).kind).toBe('placed')
  const creates = server.callsTo('workspace.create').map(call => call.params['label'])
  expect(creates).toEqual(['Neutron General', 'general'])
  const rows = Object.values(JSON.parse(readFileSync(general.journal, 'utf8'))) as Array<{ scope: unknown }>
  expect(rows.map(row => row.scope)).toEqual([['instance', null], ['instance', 'general']])
  const workers = server.workerLayouts().map(call => call.params['workspace_id'])
  expect(new Set(workers).size).toBe(2)
})

test('no terminal host means unplaced with a recorded reason and zero RPC', async () => {
  const f = fixture()
  const placement = createWorkerPlacement({ host: null, unavailable: 'herdr-unconfigured' })
  expect(placement.available).toBe(false)
  expect(await placement.place(f.input())).toEqual({ kind: 'unplaced', reason: 'herdr-unconfigured' })
  expect(f.receipt()).toEqual({ state: 'unplaced', reason: 'herdr-unconfigured' })
  await placement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  expect(f.server.calls).toEqual([])
})

for (const failure of ['ownership-mismatch', 'layout-apply', 'connect', 'invalid-scope'] as const) {
  test(`placement failure (${failure}) is unplaced and never falls back to an unmanaged workspace`, async () => {
    const f = fixture()
    let placement = f.placement
    if (failure === 'ownership-mismatch') {
      expect((await f.placement.place(f.input('claude-headless-first'))).kind).toBe('placed')
      for (const workspace of f.server.workspaces.values()) workspace.tokens = { neutron_project_owner: 'foreign' }
    } else if (failure === 'layout-apply') {
      f.server.failMethod('layout.apply')
    } else if (failure === 'connect') {
      placement = createWorkerPlacement({ scope: f.scope,
        host: createProjectWorkspaceHost(join(f.directory, 'other', 'workspaces.json'), { connect: async () => { throw new Error('socket unavailable') } }) })
    } else {
      placement = createWorkerPlacement({ host: f.host, scope: { ...f.scope, instanceId: '' } })
    }
    const before = f.server.workerLayouts().length
    const view = await placement.place(f.input())
    expect(view.kind).toBe('unplaced')
    expect((view as { reason: string }).reason).toMatch(/^placement-refused: /)
    expect(f.receipt()).toMatchObject({ state: 'unplaced' })
    if (failure !== 'layout-apply') expect(f.server.workerLayouts()).toHaveLength(before)
    // Every layout.apply ever sent names a workspace the manager created and owns.
    for (const call of f.server.callsTo('layout.apply')) expect(f.server.workspaces.has(String(call.params['workspace_id']))).toBe(true)
  })
}

test('retire closes the recorded view pane once and ignores unplaced or closed receipts', async () => {
  const f = fixture()
  const view = await f.placement.place(f.input())
  if (view.kind !== 'placed') throw new Error('expected placement')
  // A replacement host (fresh placement over the same receipts) retires it.
  const replacement = createWorkerPlacement({ host: f.host, scope: f.scope })
  await replacement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  expect(f.server.closed.filter(pane => pane === view.paneHandle)).toEqual([view.paneHandle])
  expect(f.server.panes.has(view.paneHandle)).toBe(false)
  expect(f.receipt()).toEqual({ state: 'closed', pane: view.paneHandle })
  const closes = f.server.callsTo('pane.close').length
  await replacement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  await replacement.retire({ key: 'never-placed', receiptDir: f.directory })
  expect(f.server.callsTo('pane.close')).toHaveLength(closes)
  expect(f.server.workerLayouts()).toHaveLength(1)
})

test('a failed close keeps the receipt placed so a later retire still owns the pane', async () => {
  const f = fixture()
  const view = await f.placement.place(f.input())
  if (view.kind !== 'placed') throw new Error('expected placement')
  f.server.failMethod('pane.close')
  await view.close()
  expect(f.receipt()).toEqual({ state: 'placed', pane: view.paneHandle })
  f.server.clearFailure('pane.close')
  expect(f.server.panes.has(view.paneHandle)).toBe(true)
  await f.placement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  expect(f.server.panes.has(view.paneHandle)).toBe(false)
  expect(f.receipt()).toEqual({ state: 'closed', pane: view.paneHandle })
})

test('view session tees bytes, places after start, and closes on finish; unavailable keeps no view file', async () => {
  const f = fixture()
  const session = openWorkerView(f.placement, f.input())
  session.tee('{"type":"result"}')
  expect(f.server.calls).toHaveLength(0)
  session.started()
  const view = await session.finish()
  expect(view?.kind).toBe('placed')
  expect(readFileSync(f.input().viewPath, 'utf8')).toBe('{"type":"result"}\n[host] worker exited\n')
  expect(f.server.closed).toContain((view as { paneHandle: string }).paneHandle)
  expect(f.server.panes.has((view as { paneHandle: string }).paneHandle)).toBe(false)

  const unavailable = openWorkerView(createWorkerPlacement({ host: null, unavailable: 'herdr-unconfigured' }), f.input('codex-headless-k9'))
  unavailable.tee('bytes')
  unavailable.started()
  expect(await unavailable.finish()).toEqual({ kind: 'unplaced', reason: 'herdr-unconfigured' })
  expect(() => readFileSync(f.input('codex-headless-k9').viewPath)).toThrow()
})

test('the follower prints the view file as it grows without any provider or credential', async () => {
  const f = fixture()
  const path = join(f.directory, 'follow.log')
  await Bun.write(path, 'first\n')
  const child = Bun.spawn(['/usr/bin/env', '-i', process.execPath, '-e', VIEW_FOLLOW_SCRIPT, path], { stdout: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    let seen = ''
    while (!seen.includes('first')) seen += new TextDecoder().decode((await reader.read()).value)
    await Bun.write(path, 'first\nsecond\n')
    while (!seen.includes('second')) seen += new TextDecoder().decode((await reader.read()).value)
    expect(seen).toBe('first\nsecond\n')
    reader.releaseLock()
  } finally { child.kill('SIGKILL'); await child.exited }
})
