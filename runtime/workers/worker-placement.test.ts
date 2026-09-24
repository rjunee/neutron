import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectWorkspaceHost } from '../adapters/claude-code/persistent/project-workspace-host.ts'
import { FakeHerdrWorkspaceServer, until } from '../adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import { HerdrError } from '../adapters/claude-code/persistent/herdr-client.ts'
import { createWorkerPlacement, followerOwnsPane, followerScriptDigest, openWorkerView, VIEW_FOLLOW_SCRIPT, workerTaskLabel,
  type WorkerPlacementOptions, type WorkerPlacementScope } from './worker-placement.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

type Timeouts = Pick<Extract<WorkerPlacementOptions, { scope: unknown }>, 'placeTimeoutMs' | 'closeTimeoutMs' | 'inspectTimeoutMs'>

function fixture(projectId: string | null = 'project-one', server = new FakeHerdrWorkspaceServer(), timeouts: Timeouts = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-placement-'))
  directories.push(directory)
  const journal = join(directory, 'terminal', 'workspaces.json')
  const host = createProjectWorkspaceHost(journal, { connect: async () => server, pidWaitMs: 500, outputGateMaxMs: 1, pollIntervalMs: 10 })
  const scope: WorkerPlacementScope = { instanceId: 'instance', projectId, projectLabel: 'Project One' }
  const placement = createWorkerPlacement({ host, scope, ...timeouts })
  const input = (key = 'claude-headless-k1', taskLabel = workerTaskLabel('review', 'authentication')) =>
    ({ key, taskLabel, cwd: directory, viewPath: join(directory, `${key}.view.log`), receiptDir: directory })
  const receipt = (key = 'claude-headless-k1') => JSON.parse(readFileSync(join(directory, `${key}.placement.json`), 'utf8'))
  /** The `pane.*` methods sent from call index `from` on, in order. */
  const paneCalls = (from: number) => server.calls.slice(from).map(call => call.method).filter(method => method.startsWith('pane.'))
  return { directory, journal, host, server, scope, placement, input, receipt, paneCalls }
}

/** The identity a placed receipt must carry: the pane, the host-reported pid, the view
 * path the follower tails (its last argv token) and the tab label. */
function placedReceipt(f: ReturnType<typeof fixture>, pane: string, key = 'claude-headless-k1') {
  return { state: 'placed', pane, pid: f.server.panes.get(pane)!.shell_pid, viewPath: f.input(key).viewPath, taskLabel: 'Review · authentication',
    script: followerScriptDigest(VIEW_FOLLOW_SCRIPT) }
}

const createdWorkspaces = (server: FakeHerdrWorkspaceServer) => new Set([...server.workspaces.keys()])

test.each(['transport', 'typed'] as const)('A/B/B/C lost %s reply preserves operation and cleanup receipts without duplicate views', async fault => {
  const f = fixture()
  const a = await f.placement.place(f.input('a'))
  expect(a.kind).toBe('placed')
  const receiptA = f.receipt('a')
  const originalCall = f.server.call.bind(f.server)
  let loseReply = true
  f.server.call = async (method, params) => {
    const result = await originalCall(method, params)
    if (loseReply && method === 'layout.apply' && params.tab_label !== 'Chat') {
      if (fault === 'typed') throw new HerdrError('server_error', 'reply failed after commit')
      throw new Error('reply lost after commit')
    }
    return result
  }
  expect((await f.placement.place(f.input('b'))).kind).toBe('unplaced')
  const receiptB = f.receipt('b')
  const journal = readFileSync(f.journal, 'utf8')
  const count = f.server.workerLayouts().length
  loseReply = false
  const restarted = createWorkerPlacement({ host: createProjectWorkspaceHost(f.journal, { connect: async () => f.server }), scope: f.scope })
  expect((await restarted.place(f.input('b'))).kind).toBe('unplaced')
  expect(f.receipt('a')).toEqual(receiptA)
  expect(f.receipt('b')).toEqual(receiptB)
  expect(readFileSync(f.journal, 'utf8')).toBe(journal)
  expect(f.server.workerLayouts()).toHaveLength(count)
  expect((await restarted.place(f.input('c'))).kind).toBe('placed')
  expect(f.server.workerLayouts()).toHaveLength(count + 1)
  expect(f.server.callsTo('workspace.create')).toHaveLength(1)
  await restarted.retire({ key: 'a', receiptDir: f.directory })
  expect(f.receipt('a').state).toBe('closed')
})

test('stable operation key survives a failed view and duplicate receipt cannot erase cleanup identity', async () => {
  const f = fixture()
  const first = await f.placement.place(f.input('a'))
  expect(first.kind).toBe('placed')
  const originalReceipt = f.receipt('a')
  const applies = f.server.callsTo('layout.apply').length
  expect((await f.placement.place(f.input('a'))).kind).toBe('unplaced')
  expect(f.receipt('a')).toEqual(originalReceipt)
  const unavailable = createWorkerPlacement({ host: null, unavailable: 'temporarily offline' })
  expect((await unavailable.place(f.input('a'))).kind).toBe('unplaced')
  expect(f.receipt('a')).toEqual(originalReceipt)
  expect((await unavailable.place(f.input('offline'))).kind).toBe('unplaced')
  expect(f.receipt('offline')).toEqual({ state: 'unplaced', reason: 'temporarily offline' })
  expect(f.server.callsTo('layout.apply')).toHaveLength(applies)
  f.server.failMethod('layout.apply')
  expect((await f.placement.place(f.input('b'))).kind).toBe('unplaced')
  f.server.clearFailure('layout.apply')
  const restarted = createWorkerPlacement({ host: createProjectWorkspaceHost(f.journal, { connect: async () => f.server }), scope: f.scope })
  expect((await restarted.place(f.input('c'))).kind).toBe('placed')
  expect(f.server.callsTo('workspace.create')).toHaveLength(1)
  // Even moving the caller's receipt directory cannot repurchase the same key.
  const otherReceipts = mkdtempSync(join(tmpdir(), 'worker-retry-')); directories.push(otherReceipts)
  const before = f.server.callsTo('layout.apply').length
  expect((await restarted.place({ ...f.input('b'), receiptDir: otherReceipts })).kind).toBe('unplaced')
  expect(f.server.callsTo('layout.apply')).toHaveLength(before)
  await restarted.retire({ key: 'a', receiptDir: f.directory })
  expect(f.receipt('a').state).toBe('closed')
})

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
    const pane = (view as { paneHandle: string }).paneHandle
    expect(f.receipt()).toEqual(placedReceipt(f, pane))
    expect(typeof f.receipt().pid).toBe('number')
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
  expect(f.receipt()).toEqual(placedReceipt(f, view.paneHandle))
  // A replacement host (fresh placement over the same receipts) retires it — only after
  // re-verifying the live pane still runs the recorded follower.
  const replacement = createWorkerPlacement({ host: f.host, scope: f.scope })
  const from = f.server.calls.length
  await replacement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  expect(f.paneCalls(from)).toEqual(['pane.get', 'pane.process_info', 'pane.close'])
  expect(f.server.closed.filter(pane => pane === view.paneHandle)).toEqual([view.paneHandle])
  expect(f.server.panes.has(view.paneHandle)).toBe(false)
  expect(f.receipt()).toEqual({ state: 'closed', pane: view.paneHandle })
  const after = f.server.calls.length
  await replacement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  await replacement.retire({ key: 'never-placed', receiptDir: f.directory })
  expect(f.server.calls).toHaveLength(after)
  expect(f.server.workerLayouts()).toHaveLength(1)
})

// --- Retirement re-verifies identity: a saved pane id is a handle, not identity. ---

for (const change of ['argv', 'pid', 'view-path'] as const) {
  test(`retire REFUSES a pane whose live identity changed (${change}) and disowns it for good`, async () => {
    const f = fixture()
    const view = await f.placement.place(f.input())
    if (view.kind !== 'placed') throw new Error('expected placement')
    const live = f.server.panes.get(view.paneHandle)!
    // The server restarted and re-issued this id to somebody else's work.
    if (change === 'argv') live.argv = ['claude', '--resume', 'someone-else']
    else if (change === 'pid') live.shell_pid += 1
    else live.argv = [...live.argv.slice(0, -1), join(f.directory, 'another-dispatch.view.log')]
    const replacement = createWorkerPlacement({ host: f.host, scope: f.scope })
    const from = f.server.calls.length
    await replacement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
    expect(f.paneCalls(from)).toEqual(['pane.get', 'pane.process_info'])
    expect(f.server.panes.has(view.paneHandle)).toBe(true)
    expect(f.receipt()).toEqual({ state: 'disowned', pane: view.paneHandle, reason: expect.stringMatching(/another process|changed/) })
    // Disowned is terminal: a later retire sends no RPC at all.
    const after = f.server.calls.length
    await replacement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
    expect(f.server.calls).toHaveLength(after)
  })
}

for (const unknown of ['process-info-fails', 'empty-argv', 'pane-get-transport', 'legacy-receipt'] as const) {
  test(`retire REFUSES unknown identity (${unknown}) and keeps the receipt for a later re-verify`, async () => {
    const f = fixture()
    const view = await f.placement.place(f.input())
    if (view.kind !== 'placed') throw new Error('expected placement')
    if (unknown === 'process-info-fails') f.server.failMethod('pane.process_info')
    else if (unknown === 'empty-argv') f.server.malformMethod('pane.process_info', { process_info: { pane_id: view.paneHandle, foreground_processes: [] } })
    else if (unknown === 'pane-get-transport') f.server.failMethod('pane.get', new Error('transport'))
    // A receipt from before identity was recorded: a bare pane id proves nothing.
    else writeFileSync(join(f.directory, 'claude-headless-k1.placement.json'), JSON.stringify({ state: 'placed', pane: view.paneHandle }))
    const before = JSON.stringify(f.receipt())
    const from = f.server.calls.length
    await f.placement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
    expect(f.paneCalls(from)).not.toContain('pane.close')
    expect(f.server.panes.has(view.paneHandle)).toBe(true)
    expect(JSON.stringify(f.receipt())).toBe(before)
    expect(f.receipt().state).toBe('placed')
    if (unknown === 'process-info-fails') {
      // Unknown is not "not ours": once identity can be established, retire proceeds.
      f.server.clearFailure('pane.process_info')
      await f.placement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
      expect(f.server.panes.has(view.paneHandle)).toBe(false)
      expect(f.receipt()).toEqual({ state: 'closed', pane: view.paneHandle })
    }
  })
}

test('retire of a pane the server positively reports gone records closed without sending a close', async () => {
  const f = fixture()
  const view = await f.placement.place(f.input())
  if (view.kind !== 'placed') throw new Error('expected placement')
  f.server.panes.delete(view.paneHandle)
  const from = f.server.calls.length
  await f.placement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  expect(f.paneCalls(from)).toEqual(['pane.get'])
  expect(f.receipt()).toEqual({ state: 'closed', pane: view.paneHandle })
})

test('identity check reads the process sample, never the pane label', () => {
  const receipt = { state: 'placed' as const, pane: 'pane-1', pid: 7, viewPath: '/v/one.log', taskLabel: 'Build · x' }
  const argv = ['/bin/bun', '-e', VIEW_FOLLOW_SCRIPT, '/v/one.log']
  expect(followerOwnsPane(receipt, { kind: 'live', argv, pid: 7, label: 'renamed by the owner' })).toEqual({ ok: true })
  expect(followerOwnsPane(receipt, { kind: 'live', argv: ['vim', '/v/one.log'], pid: 7, label: 'Build · x' }))
    .toMatchObject({ ok: false, refuse: 'changed' })
  expect(followerOwnsPane(receipt, { kind: 'live', argv: [], pid: 7, label: 'Build · x' })).toMatchObject({ ok: false, refuse: 'unknown' })
  expect(followerOwnsPane(receipt, { kind: 'unavailable', reason: 'socket' })).toMatchObject({ ok: false, refuse: 'unknown' })
})

test('identity is the script the RECEIPT recorded: an older build\'s follower is still ours, a different script is not', () => {
  const older = `${VIEW_FOLLOW_SCRIPT}\n// an older build's follower`
  const receipt = { state: 'placed' as const, pane: 'pane-1', pid: 7, viewPath: '/v/one.log', script: followerScriptDigest(older) }
  // A later build edited VIEW_FOLLOW_SCRIPT; the pane still runs the recorded older script.
  expect(followerOwnsPane(receipt, { kind: 'live', argv: ['/bin/bun', '-e', older, '/v/one.log'], pid: 7, label: 'x' })).toEqual({ ok: true })
  // Complement: the CURRENT script is not what this receipt recorded.
  expect(followerOwnsPane(receipt, { kind: 'live', argv: ['/bin/bun', '-e', VIEW_FOLLOW_SCRIPT, '/v/one.log'], pid: 7, label: 'x' }))
    .toMatchObject({ ok: false, refuse: 'changed' })
  // A receipt without a digest predates it and was written by the current script.
  const { script: _script, ...legacy } = receipt
  expect(followerOwnsPane(legacy, { kind: 'live', argv: ['/bin/bun', '-e', VIEW_FOLLOW_SCRIPT, '/v/one.log'], pid: 7, label: 'x' })).toEqual({ ok: true })
})

test('a failed worker tab leaves the ready workspace usable: the next placement in the scope is placed', async () => {
  for (const fault of [new Error('transport timeout'), new HerdrError('invalid_layout', 'rejected')]) {
    const f = fixture()
    expect((await f.placement.place(f.input('claude-headless-a'))).kind).toBe('placed')
    f.server.failMethod('layout.apply', fault)
    expect(await f.placement.place(f.input('claude-headless-b'))).toEqual({ kind: 'unplaced', reason: expect.stringMatching(/^placement-refused: /) })
    f.server.clearFailure('layout.apply')
    // Refusing complement of the defect: the THIRD placement, with Herdr healthy again,
    // is placed — not refused by a row the failed tab left `pending`.
    const third = await f.placement.place(f.input('claude-headless-c'))
    expect(third.kind).toBe('placed')
    expect(f.receipt('claude-headless-c').state).toBe('placed')
    expect(Object.values(JSON.parse(readFileSync(f.journal, 'utf8'))).map((row: any) => row.state)).toEqual(['ready'])
    expect(f.server.callsTo('workspace.create')).toHaveLength(1)
    expect(f.server.workerLayouts().map(call => call.params['tab_label'])).toEqual(Array(3).fill('Review · authentication'))
  }
})

test('a failed close keeps the receipt placed so a later retire still owns the pane', async () => {
  const f = fixture()
  const view = await f.placement.place(f.input())
  if (view.kind !== 'placed') throw new Error('expected placement')
  f.server.failMethod('pane.close')
  await view.close()
  expect(f.receipt()).toEqual(placedReceipt(f, view.paneHandle))
  f.server.clearFailure('pane.close')
  expect(f.server.panes.has(view.paneHandle)).toBe(true)
  await f.placement.retire({ key: 'claude-headless-k1', receiptDir: f.directory })
  expect(f.server.panes.has(view.paneHandle)).toBe(false)
  expect(f.receipt()).toEqual({ state: 'closed', pane: view.paneHandle })
})

test('view session tees bytes, places after start, and closes after release; unavailable keeps no view file', async () => {
  const f = fixture()
  const session = openWorkerView(f.placement, f.input())
  session.tee('{"type":"result"}')
  expect(f.server.calls).toHaveLength(0)
  session.started()
  const placed = await until(() => f.receipt().state === 'placed' ? f.receipt() as { pane: string } : undefined)
  const from = f.server.calls.length
  // release() is synchronous: the view file is finished before it returns.
  session.release()
  expect(readFileSync(f.input().viewPath, 'utf8')).toBe('{"type":"result"}\n[host] worker exited\n')
  const view = await session.settled()
  expect(view?.kind).toBe('placed')
  // The in-run close is verified exactly like a restart retire.
  expect(f.paneCalls(from)).toEqual(['pane.get', 'pane.process_info', 'pane.close'])
  expect(f.server.closed).toContain(placed.pane)
  expect(f.server.panes.has(placed.pane)).toBe(false)
  expect(f.receipt()).toEqual({ state: 'closed', pane: placed.pane })

  const unavailable = openWorkerView(createWorkerPlacement({ host: null, unavailable: 'herdr-unconfigured' }), f.input('codex-headless-k9'))
  unavailable.tee('bytes')
  unavailable.started()
  unavailable.release()
  expect(await unavailable.settled()).toEqual({ kind: 'unplaced', reason: 'herdr-unconfigured' })
  expect(() => readFileSync(f.input('codex-headless-k9').viewPath)).toThrow()
})

test('the in-run close refuses a pane whose identity changed while the worker ran', async () => {
  const f = fixture()
  const session = openWorkerView(f.placement, f.input())
  session.started()
  const placed = await until(() => f.receipt().state === 'placed' ? f.receipt() as { pane: string } : undefined)
  f.server.panes.get(placed.pane)!.argv = ['claude', '--resume', 'someone-else']
  const from = f.server.calls.length
  session.release()
  expect((await session.settled())?.kind).toBe('placed')
  expect(f.paneCalls(from)).toEqual(['pane.get', 'pane.process_info'])
  expect(f.server.panes.has(placed.pane)).toBe(true)
  expect(f.receipt()).toMatchObject({ state: 'disowned', pane: placed.pane })
})

test('release never waits for cleanup: a held close leaves the session released and the receipt placed', async () => {
  const f = fixture()
  const session = openWorkerView(f.placement, f.input())
  session.started()
  const placed = await until(() => f.receipt().state === 'placed' ? f.receipt() as { pane: string } : undefined)
  const releaseClose = f.server.holdMethod('pane.close')
  session.release()
  let settled = false
  const cleanup = session.settled().then(view => { settled = true; return view })
  await until(() => f.server.callsTo('pane.close').length > 0 ? true : undefined)
  expect(settled).toBe(false)
  expect(f.receipt()).toEqual(placedReceipt(f, placed.pane))
  releaseClose()
  expect((await cleanup)?.kind).toBe('placed')
  expect(f.receipt()).toEqual({ state: 'closed', pane: placed.pane })
})

test('a placement that outlives its timeout is unplaced; the late pane is closed by the verified path', async () => {
  const f = fixture('project-one', new FakeHerdrWorkspaceServer(), { placeTimeoutMs: 50 })
  // Let the workspace and its Chat reservation exist first, so the hold catches the
  // WORKER's layout.apply.
  expect((await f.placement.place(f.input('claude-headless-warm'))).kind).toBe('placed')
  const releaseApply = f.server.holdMethod('layout.apply')
  const view = await f.placement.place(f.input())
  expect(view).toEqual({ kind: 'unplaced', reason: 'placement-timeout after 50ms' })
  expect(f.receipt()).toEqual({ state: 'unplaced', reason: 'placement-timeout after 50ms' })
  const from = f.server.calls.length
  const closedBefore = f.server.closed.length
  releaseApply()
  const late = await until(() => f.server.closed.length > closedBefore ? f.server.closed.at(-1) : undefined)
  expect(f.paneCalls(from).slice(-3)).toEqual(['pane.get', 'pane.process_info', 'pane.close'])
  expect(f.server.panes.has(late)).toBe(false)
  // The timeout verdict is never rewritten by the late close.
  expect(f.receipt()).toEqual({ state: 'unplaced', reason: 'placement-timeout after 50ms' })
  expect(f.server.workerLayouts()).toHaveLength(2)
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
