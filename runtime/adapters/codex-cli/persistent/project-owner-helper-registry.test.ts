import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectControlBroker } from './project-control-broker.ts'
import { OwnerHelperRegistry } from './project-owner-helper-registry.ts'
import { decodeOwnerHelperResponse } from './project-owner-helper-client.ts'

test('real broker approval ownership survives reconnect and excludes a different gateway client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-helper-registry-'))
  let receive: (message: unknown) => void = () => {}
  const sent: Record<string, unknown>[] = []
  const broker = await createProjectControlBroker({ socketPath: join(dir, 'broker.sock'), cwd: dir, codexHome: dir, threadId: 'same-thread',
    upstream: { close() {}, listen(fn) { receive = fn }, send(message) {
      sent.push(message)
      if (message.method) queueMicrotask(() => receive({ id: message.id, result: message.method === 'turn/start' ? { turn: { id: 'same-turn' } } : {} }))
    } } })
  const registry = new OwnerHelperRegistry(broker, () => { if (broker.state().phase === 'closed') throw new Error('closed') })
  const signal = AbortSignal.abort()
  try {
    const grant = registry.attach().grant
    const a = await registry.handle({ operation: 'open', grant, clientId: 'client-a' }, signal)
    const b = await registry.handle({ operation: 'open', grant, clientId: 'client-b' }, signal)
    await registry.handle({ operation: 'request', grant, clientId: 'client-a', writerGrant: a.grant,
      method: 'turn/start', params: { threadId: 'same-thread', input: [] }, epoch: broker.state().epoch }, signal)
    const approval = { id: 'approval-one', method: 'item/commandExecution/requestApproval', params: { threadId: 'same-thread', turnId: 'same-turn' } }
    receive(approval)
    const eventA = await registry.handle({ operation: 'poll', grant, clientId: 'client-a', writerGrant: a.grant, cursor: a.cursor }, signal)
    const eventB = await registry.handle({ operation: 'poll', grant, clientId: 'client-b', writerGrant: b.grant, cursor: b.cursor }, signal)
    expect((eventA.events as { message: unknown }[]).map(event => event.message)).toContainEqual(approval)
    expect((eventB.events as { message: unknown }[]).map(event => event.message)).not.toContainEqual(approval)
    const epoch = broker.state().epoch
    await expect(registry.handle({ operation: 'reply', grant, clientId: 'client-b', writerGrant: b.grant, id: approval.id, result: { decision: 'accept' }, epoch }, signal)).rejects.toThrow()
    expect(sent.filter(message => message.id === approval.id)).toHaveLength(0)
    expect(await registry.handle({ operation: 'closeWriter', grant, clientId: 'client-a', writerGrant: a.grant }, signal)).toEqual({ retired: false })
    await expect(registry.handle({ operation: 'request', grant, clientId: 'client-a', writerGrant: a.grant,
      method: 'turn/interrupt', params: { threadId: 'same-thread', turnId: 'same-turn' }, epoch }, signal)).rejects.toThrow('Stale')
    expect(sent.filter(message => message.method === 'turn/interrupt')).toHaveLength(0)
    await expect(registry.handle({ operation: 'reply', grant, clientId: 'client-a', writerGrant: a.grant, id: approval.id, result: { decision: 'accept' }, epoch }, signal)).rejects.toThrow('Stale')
    expect(sent.filter(message => message.id === approval.id)).toHaveLength(0)
    const nextGrant = registry.attach().grant
    const reopened = await registry.handle({ operation: 'open', grant: nextGrant, clientId: 'client-a' }, signal)
    expect(reopened.approvals).toEqual([approval])
    await expect(registry.handle({ operation: 'reply', grant, clientId: 'client-a', writerGrant: a.grant, id: approval.id, result: {}, epoch }, signal)).rejects.toThrow('Stale')
    await registry.handle({ operation: 'reply', grant: nextGrant, clientId: 'client-a', writerGrant: reopened.grant, id: approval.id, result: { decision: 'accept' }, epoch }, signal)
    expect(sent.filter(message => message.id === approval.id)).toEqual([{ id: approval.id, result: { decision: 'accept' } }])
    expect(broker.state().activeTurnId).toBe('same-turn')
  } finally { registry.destroy(); broker.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('complete response remains writable; truncated or malformed response bodies revoke authority', async () => {
  let writable = true
  const fail = () => { writable = false }
  expect(await decodeOwnerHelperResponse(Response.json({ result: 'accepted' }), fail)).toEqual({ result: 'accepted' })
  expect(writable).toBe(true)
  await expect(decodeOwnerHelperResponse(new Response('{"result":'), fail)).rejects.toThrow('outcome may be unknown')
  expect(writable).toBe(false)
  writable = true
  const broken = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"result":')); controller.error(new Error('socket lost')) } })
  await expect(decodeOwnerHelperResponse(new Response(broken), fail)).rejects.toThrow('outcome may be unknown')
  expect(writable).toBe(false)
})
