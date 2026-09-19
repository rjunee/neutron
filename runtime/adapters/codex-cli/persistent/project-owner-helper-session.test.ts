import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectControlGateway, ProjectControlState } from './project-control-broker.ts'
import { OwnerHelperSession } from './project-owner-helper-session.ts'
import { assertProjectOwner, assertSeparateOwnerCgroup, helperIdentity, requireIndependentOwnerHost } from './project-owner-helper-protocol.ts'

function fixture() {
  let emit: (message: Record<string, unknown>) => void = () => {}
  let alive = true, closes = 0
  const requests: unknown[] = [], replies: unknown[] = []
  const state: ProjectControlState = { generation: 7, epoch: 12, phase: 'idle', activeTurnId: null, unresolved: null }
  const writer: ProjectControlGateway = {
    async request(method, params, epoch) { requests.push({ method, params, epoch }); return { accepted: true } },
    reply(id, result, epoch) { replies.push({ id, result, epoch }) },
    subscribe(listener) { emit = listener; return () => {} }, close() { closes++ },
  }
  const session = new OwnerHelperSession(writer, () => state, () => { if (!alive) throw new Error('Native owner unknown') })
  return { session, state, requests, replies, emit: (message: Record<string, unknown>) => emit(message), loseOwner: () => { alive = false }, closes: () => closes }
}

test('durability admission requires positive cgroup separation, not a detached PID', () => {
  expect(() => assertSeparateOwnerCgroup('0::/user.slice/owner.service\n', '0::/user.slice/gateway.service\n')).not.toThrow()
  for (const owner of ['0::/user.slice/gateway.service\n', '0::/user.slice/gateway.service/child\n', 'unknown']) {
    expect(() => assertSeparateOwnerCgroup(owner, '0::/user.slice/gateway.service\n')).toThrow('outside')
  }
  expect(() => assertSeparateOwnerCgroup('0::/owner\n', '0::/\n')).toThrow('outside')
  expect(() => requireIndependentOwnerHost(helperIdentity())).toThrow('outside')
  expect(() => requireIndependentOwnerHost({ ...helperIdentity(), start: 'forged' })).toThrow('identity')
})

test('project credential namespace is revalidated against its complete owner marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helper-project-owner-'))
  try {
    expect(() => assertProjectOwner(dir, 'project-one')).toThrow()
    writeFileSync(join(dir, 'project-owner.json'), JSON.stringify('project-one'), { mode: 0o600 })
    expect(() => assertProjectOwner(dir, 'project-one')).not.toThrow()
    expect(() => assertProjectOwner(dir, 'project-two')).toThrow('another project')
    writeFileSync(join(dir, 'project-owner.json'), JSON.stringify('project-two'))
    expect(() => assertProjectOwner(dir, 'project-one')).toThrow('another project')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('new grant serves a turn with unchanged broker generation and fences old frontend', async () => {
  const f = fixture(), first = f.session.attach(), second = f.session.attach()
  await expect(f.session.request(first.grant, 'turn/start', {}, 12)).rejects.toThrow('Stale')
  expect(f.requests).toHaveLength(0)
  expect((await f.session.request(second.grant, 'turn/start', { threadId: 'same' }, 12)).result).toEqual({ accepted: true })
  expect(f.requests).toEqual([{ method: 'turn/start', params: { threadId: 'same' }, epoch: 12 }])
  expect(second.state.generation).toBe(first.state.generation)
  expect(f.closes()).toBe(0)
  f.session.destroy()
})

test('detach retains an active turn and approval owner until authenticated reattachment replies', () => {
  const f = fixture(), first = f.session.attach()
  f.state.phase = 'turn'; f.state.activeTurnId = 'same-turn'
  const approval = { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'same' } }
  f.emit(approval)
  f.session.detach(first.grant)
  expect(f.closes()).toBe(0)
  const next = f.session.attach()
  expect(next.state.activeTurnId).toBe('same-turn')
  expect(next.approvals).toEqual([approval])
  expect(() => f.session.reply(first.grant, 'approval-1', { decision: 'accept' }, 12)).toThrow('Stale')
  expect(f.replies).toHaveLength(0)
  f.session.reply(next.grant, 'approval-1', { decision: 'accept' }, 12)
  expect(f.replies).toEqual([{ id: 'approval-1', result: { decision: 'accept' }, epoch: 12 }])
  expect(f.session.attach().approvals).toHaveLength(0)
  f.session.destroy()
})

test('unknown native owner cannot mint a frontend grant or forward a write', async () => {
  const f = fixture(), first = f.session.attach()
  await f.session.request(first.grant, 'thread/read', {}, undefined)
  f.loseOwner()
  expect(() => f.session.attach()).toThrow('unknown')
  await expect(f.session.request(first.grant, 'turn/start', {}, 12)).rejects.toThrow('unknown')
  expect(f.requests).toHaveLength(1)
  f.session.destroy()
})

test('a detached poll wakes and refuses rather than yielding authority to the stale frontend', async () => {
  const f = fixture(), first = f.session.attach()
  const waiting = f.session.poll(first.grant, first.cursor, new AbortController().signal)
  f.session.attach()
  await expect(waiting).rejects.toThrow('Stale')
  f.session.destroy()
})

test('retained approvals clear only after native completion or their own accepted reply', () => {
  const f = fixture()
  f.emit({ id: 1, method: 'item/permissions/requestApproval' })
  f.emit({ method: 'item/agentMessage/delta', params: { delta: 'still working' } })
  expect(f.session.attach().approvals).toHaveLength(1)
  f.emit({ method: 'turn/completed' })
  expect(f.session.attach().approvals).toHaveLength(0)
  f.session.destroy()
})
