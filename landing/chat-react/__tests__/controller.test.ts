/**
 * Integration test: the React data layer (NeutronChatController) over a REAL
 * `@neutron/chat-core` WebChatSession + a fake socket. Exercises the whole
 * chat-core contract end-to-end (sync engine + store + send-queue + the
 * additive onFrame stream) the way the React UI drives it — no DOM, no network.
 */

import { describe, expect, it } from 'bun:test'
import { InMemoryStore, WebChatSession } from '@neutron/chat-core'
import type { SocketLike } from '@neutron/chat-core'

import { NeutronChatController } from '../controller.ts'

const TOPIC = 'app:sam'

class FakeSocket implements SocketLike {
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false
  send(data: string): void {
    if (this.closed) throw new Error('closed')
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.()
  }
  deliver(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  userMessages(): Array<Record<string, unknown>> {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === 'user_message')
  }
}

function setup(projectId: string | null = null) {
  const sockets: FakeSocket[] = []
  let id = 0
  const controller = new NeutronChatController({
    projectId,
    createSession: (sinks) =>
      new WebChatSession({
        url: 'wss://t/ws/app/chat',
        topic_id: TOPIC,
        store: new InMemoryStore(),
        createSocket: () => {
          const s = new FakeSocket()
          sockets.push(s)
          return s
        },
        onChange: sinks.onChange,
        onStatus: sinks.onStatus,
        onFrame: sinks.onFrame,
        generateId: () => `cmid-${++id}`,
        now: (() => {
          let t = 0
          return () => ++t
        })(),
      }),
  })
  return { controller, sockets }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const ready = () => ({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })

describe('NeutronChatController — view model over chat-core', () => {
  it('renders an optimistic user bubble and flips the typing indicator on send', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    await controller.send('hello')
    await tick()
    const vm = controller.getViewModel()
    expect(vm.messages.map((m) => m.text)).toEqual(['hello'])
    expect(vm.messages[0]?.role).toBe('user')
    // Awaiting a reply → typing indicator on.
    expect(vm.isRunning).toBe(true)
    expect(vm.status).toBe('open')
  })

  it('accumulates streaming partials into a live agent bubble, then the final message supersedes it', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('hi')
    await tick()
    // Stream three tokens for message m9 (not yet persisted).
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'Hel', ts: 1 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'lo ', ts: 2 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'Sam', ts: 3 })
    await tick()
    let vm = controller.getViewModel()
    const live = vm.messages.find((m) => m.streaming)
    expect(live?.text).toBe('Hello Sam')
    expect(live?.role).toBe('agent')
    expect(vm.isRunning).toBe(true)
    // The final canonical agent_message persists (with a seq) and replaces it.
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm9', seq: 1, body: 'Hello Sam', ts: 4 })
    await tick()
    vm = controller.getViewModel()
    expect(vm.messages.filter((m) => m.streaming).length).toBe(0)
    const agent = vm.messages.find((m) => m.role === 'agent')
    expect(agent?.text).toBe('Hello Sam')
    expect(agent?.streaming).toBe(false)
    // No reply pending, no stream → indicator off.
    expect(vm.isRunning).toBe(false)
    // User bubble + final agent message, no duplicate.
    expect(vm.messages.length).toBe(2)
  })

  it('queues a send while offline (pending) and surfaces it optimistically', async () => {
    const { controller, sockets } = setup()
    controller.start() // socket created but not opened
    await controller.send('queued while offline')
    await tick()
    const vm = controller.getViewModel()
    expect(vm.messages.map((m) => m.text)).toEqual(['queued while offline'])
    expect(vm.pending).toBe(1)
    expect(sockets[0]!.userMessages().length).toBe(0)
  })

  it('reflects connection status transitions', async () => {
    const { controller, sockets } = setup()
    controller.start()
    expect(['connecting', 'reconnecting']).toContain(controller.getViewModel().status)
    sockets[0]!.open()
    await tick()
    expect(controller.getViewModel().status).toBe('open')
  })

  it('tags sends with the active project after setProject', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    controller.setProject('proj-7')
    expect(controller.getViewModel().projectId).toBe('proj-7')
    await controller.send('tagged')
    await tick()
    const env = sockets[0]!.userMessages().at(-1)
    expect(env?.['project_id']).toBe('proj-7')
  })

  it('hydrates the durable transcript + pending on start (instant cold-open)', async () => {
    // Seed a store as if a previous session persisted a transcript + a send
    // that never flushed (offline tail), then mount a controller over it.
    const store = new InMemoryStore()
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: '',
      message_id: 'm-old',
      seq: 1,
      role: 'agent',
      body: 'welcome back',
      project_id: null,
      attachments: null,
      created_at: 1,
      status: 'acked',
    })
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: 'cmid-queued',
      message_id: null,
      seq: null,
      role: 'user',
      body: 'sent while offline',
      project_id: null,
      attachments: null,
      created_at: 2,
      status: 'queued',
    })
    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store,
          createSocket: () => new FakeSocket(),
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })
    // No frames, no sends — just mount.
    controller.start()
    await tick()
    const vm = controller.getViewModel()
    expect(vm.messages.map((m) => m.text)).toEqual(['welcome back', 'sent while offline'])
    expect(vm.pending).toBe(1)
  })

  it('notifies subscribers on every change', async () => {
    const { controller, sockets } = setup()
    let notifications = 0
    controller.subscribe(() => {
      notifications++
    })
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('x')
    await tick()
    expect(notifications).toBeGreaterThan(0)
  })

  it('reflects a reaction_update on the message VM and sends a reaction frame on react()', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    // An agent message arrives (the user reacts to agent messages on web).
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'hello', ts: 1 })
    await tick()

    // A reaction_update from the server lands on the message's VM chips.
    sockets[0]!.deliver({
      v: 1,
      type: 'reaction_update',
      message_id: 'm1',
      seq: 1,
      rev: 1,
      reactions: [{ emoji: '👍', device_id: 'devB' }],
      ts: 2,
    })
    await tick()
    let agent = controller.getViewModel().messages.find((m) => m.messageId === 'm1')
    expect(agent?.reactions).toEqual([{ emoji: '👍', count: 1, reactedBySelf: false }])

    // react() puts a reaction frame on the wire.
    controller.react('m1', '🎉', 'add')
    const reactionFrames = sockets[0]!.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === 'reaction')
    expect(reactionFrames).toContainEqual({ v: 1, type: 'reaction', message_id: 'm1', emoji: '🎉', action: 'add' })

    // A higher-rev empty update clears the chips (removal).
    sockets[0]!.deliver({ v: 1, type: 'reaction_update', message_id: 'm1', seq: 1, rev: 2, reactions: [], ts: 3 })
    await tick()
    agent = controller.getViewModel().messages.find((m) => m.messageId === 'm1')
    expect(agent?.reactions).toEqual([])
  })

  it('reflects an edit_update + delete on the VM and sends edit/delete frames (Track B Phase 4)', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'helo', ts: 1 })
    await tick()

    // An edit_update rewrites the body + sets the edited marker.
    sockets[0]!.deliver({
      v: 1,
      type: 'edit_update',
      message_id: 'm1',
      seq: 1,
      rev: 1,
      body: 'hello',
      deleted: false,
      edited_at: 50,
      ts: 2,
    })
    await tick()
    let msg = controller.getViewModel().messages.find((m) => m.messageId === 'm1')
    expect(msg?.text).toBe('hello')
    expect(msg?.edited).toBe(true)
    expect(msg?.deleted).toBe(false)

    // editMessage()/deleteMessage() put frames on the wire.
    controller.editMessage('m1', 'hello there')
    controller.deleteMessage('m1')
    const editFrames = sockets[0]!.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === 'edit')
    expect(editFrames).toContainEqual({ v: 1, type: 'edit', message_id: 'm1', action: 'edit', body: 'hello there' })
    expect(editFrames).toContainEqual({ v: 1, type: 'edit', message_id: 'm1', action: 'delete' })

    // A higher-rev delete tombstones the message.
    sockets[0]!.deliver({ v: 1, type: 'edit_update', message_id: 'm1', seq: 1, rev: 2, body: '', deleted: true, edited_at: 60, ts: 3 })
    await tick()
    msg = controller.getViewModel().messages.find((m) => m.messageId === 'm1')
    expect(msg?.deleted).toBe(true)
    expect(msg?.text).toBe('')
    expect(msg?.edited).toBe(false)
  })
})
