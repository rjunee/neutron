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

  it('renders an agent message with button options and posts a button_choice on choose (P1b)', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    sockets[0]!.deliver({
      v: 1,
      type: 'agent_message',
      message_id: 'm1',
      seq: 1,
      ts: 1,
      body: 'Want to import your history?',
      prompt_id: 'p1',
      allow_freeform: false,
      kind: 'buttons',
      options: [
        { label: 'Yes, import', body: 'Yes, import', value: 'yes' },
        { label: 'Skip', body: 'Skip', value: 'skip', decoration: { style: 'destructive' } },
      ],
    })
    await tick()

    // The option metadata reaches the RenderMessage.
    const msg = controller.getViewModel().messages.find((m) => m.messageId === 'm1')
    expect(msg?.options?.map((o) => o.value)).toEqual(['yes', 'skip'])
    expect(msg?.promptId).toBe('p1')
    expect(msg?.kind).toBe('buttons')
    expect(msg?.allowFreeform).toBe(false)
    expect(msg?.chosenValue).toBeNull()

    // Choosing posts a button_choice frame (value, NOT label) + records the
    // choice locally so the row collapses optimistically.
    controller.onChoose(msg!.id, msg!.promptId, 'yes')
    const choiceFrames = sockets[0]!.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === 'button_choice')
    expect(choiceFrames).toContainEqual({ v: 1, type: 'button_choice', prompt_id: 'p1', choice_value: 'yes' })
    const after = controller.getViewModel().messages.find((m) => m.messageId === 'm1')
    expect(after?.chosenValue).toBe('yes')
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

  it('renders a chat_command_result as an agent bubble and clears the typing indicator', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('/note buy milk')
    await tick()
    // After the send, the typing indicator is on (awaiting a reply).
    expect(controller.getViewModel().isRunning).toBe(true)
    // The server answers a MATCHED slash command with exactly ONE
    // chat_command_result frame and NO agent_message ever follows. Before this
    // fix the spinner spun forever and the command output was lost entirely.
    sockets[0]!.deliver({
      v: 1,
      type: 'chat_command_result',
      channel_topic_id: TOPIC,
      text: '📝 Saved note: buy milk',
      ts: 5,
      client_msg_id: 'cmid-1',
    })
    await tick()
    const vm = controller.getViewModel()
    // Typing indicator cleared — no agent_message will arrive.
    expect(vm.isRunning).toBe(false)
    expect(vm.awaitingFirstToken).toBe(false)
    // The command output is rendered as an agent-style bubble, after the
    // user's command bubble.
    expect(vm.messages.map((m) => m.text)).toEqual(['/note buy milk', '📝 Saved note: buy milk'])
    expect(vm.messages[1]?.role).toBe('agent')
  })

  it('falls back to the error message when a chat_command_result has empty text', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('/remind every weekday at 8am')
    await tick()
    sockets[0]!.deliver({
      v: 1,
      type: 'chat_command_result',
      channel_topic_id: TOPIC,
      text: '',
      error: { code: 'unsupported_recurrence', message: 'Recurring reminders are not supported in v1.' },
      ts: 6,
    })
    await tick()
    const vm = controller.getViewModel()
    expect(vm.isRunning).toBe(false)
    expect(vm.messages.some((m) => m.text === 'Recurring reminders are not supported in v1.')).toBe(true)
  })

  it('surfaces an error frame as a visible notice and clears the spinner (parity with native)', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('do a thing')
    await tick()
    expect(controller.getViewModel().isRunning).toBe(true)
    sockets[0]!.deliver({ v: 1, type: 'error', code: 'dispatch_failed', message: 'The agent could not start.' })
    await tick()
    const vm = controller.getViewModel()
    expect(vm.isRunning).toBe(false)
    expect(vm.messages.some((m) => m.text === 'The agent could not start.')).toBe(true)
  })
})

describe('NeutronChatController — live projects_changed (FIX 1)', () => {
  const projectsChanged = (
    projects: Array<{ id: string; label: string }>,
    active_project_id: string | null,
  ) => ({ v: 1, type: 'projects_changed', projects, active_project_id, ts: 1 })

  it('seeds the rail from the bootstrap projects', () => {
    const sockets: FakeSocket[] = []
    const controller = new NeutronChatController({
      projectId: null,
      projects: [{ id: 'seed', label: 'Seed' }],
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
        }),
    })
    expect(controller.getViewModel().projects).toEqual([{ id: 'seed', label: 'Seed' }])
  })

  it('refreshes the rail AND auto-selects the first project on a 0→N transition', async () => {
    const { controller, sockets } = setup(null)
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    // Brand-new owner: empty rail, General (no active project) — the bug's
    // starting state.
    expect(controller.getViewModel().projects).toEqual([])
    expect(controller.getViewModel().projectId).toBeNull()

    // Onboarding creates a project → the server fans projects_changed.
    sockets[0]!.deliver(projectsChanged([{ id: 'p1', label: 'Acme' }], 'p1'))
    await tick()
    const vm = controller.getViewModel()
    expect(vm.projects).toEqual([{ id: 'p1', label: 'Acme' }])
    // Auto-selected so the per-project Documents/Tasks/Admin tabs render live
    // (mirrors the page bootstrap's active_project_id — no reload needed).
    expect(vm.projectId).toBe('p1')
  })

  it('does NOT hijack a user already viewing General once projects exist', async () => {
    // Returning user: projects already exist (seeded from the bootstrap) and one
    // is active — the realistic shape for "projects exist".
    const sockets: FakeSocket[] = []
    const controller = new NeutronChatController({
      projectId: 'p1',
      projects: [{ id: 'p1', label: 'Acme' }],
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
        }),
    })
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    // User is on an active project; deliberately switch to General.
    controller.setProject(null)
    expect(controller.getViewModel().projectId).toBeNull()

    // A later refresh updates the list but must NOT auto-select (no 0→N: the
    // user chose General on purpose).
    sockets[0]!.deliver(
      projectsChanged(
        [
          { id: 'p1', label: 'Acme' },
          { id: 'p2', label: 'Globex' },
        ],
        'p1',
      ),
    )
    await tick()
    const vm = controller.getViewModel()
    expect(vm.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(vm.projectId).toBeNull()
  })

  it('ignores a malformed projects_changed frame (no rows, keeps state)', async () => {
    const { controller, sockets } = setup(null)
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    sockets[0]!.deliver({ v: 1, type: 'projects_changed', projects: 'nope', active_project_id: 5, ts: 1 })
    await tick()
    const vm = controller.getViewModel()
    expect(vm.projects).toEqual([])
    expect(vm.projectId).toBeNull()
  })
})

describe('NeutronChatController — BUG 7 (no empty bubble above the typing indicator)', () => {
  it('does NOT materialize a streaming bubble for a leading empty-delta open frame; keeps the typing indicator', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('hi')
    await tick()
    // Server opens the stream with a zero-length delta (a "starting" signal).
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: '', ts: 1 })
    await tick()
    let vm = controller.getViewModel()
    // No empty agent bubble — only the user message renders.
    expect(vm.messages.filter((m) => m.streaming).length).toBe(0)
    expect(vm.messages.filter((m) => m.role === 'agent').length).toBe(0)
    // The reply is still pending with nothing streamed → the typing indicator
    // (driven by awaitingFirstToken) is shown.
    expect(vm.awaitingFirstToken).toBe(true)
    expect(vm.isRunning).toBe(true)
    // First REAL token materializes the bubble AND hides the typing dots (the
    // bubble itself is now the pending affordance).
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'Hi', ts: 2 })
    await tick()
    vm = controller.getViewModel()
    const live = vm.messages.find((m) => m.streaming)
    expect(live?.text).toBe('Hi')
    expect(vm.awaitingFirstToken).toBe(false)
    expect(vm.isRunning).toBe(true)
  })

  it('awaitingFirstToken is false once a streaming bubble exists (no double indicator)', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('hi')
    await tick()
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'Hel', ts: 1 })
    await tick()
    const vm = controller.getViewModel()
    expect(vm.messages.some((m) => m.streaming)).toBe(true)
    expect(vm.awaitingFirstToken).toBe(false)
  })
})

describe('NeutronChatController — server-authoritative typing (agent_typing)', () => {
  it('shows typing on a start frame and clears it on an end frame', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    // No optimistic send — the server alone drives the indicator for a warm
    // turn (e.g. the agent replies to a prior message, or onboarding pushes).
    expect(controller.getViewModel().isRunning).toBe(false)
    sockets[0]!.deliver({ v: 1, type: 'agent_typing', state: 'start', ts: 1 })
    await tick()
    let vm = controller.getViewModel()
    expect(vm.isRunning).toBe(true)
    expect(vm.awaitingFirstToken).toBe(true)
    // The turn settles → typing clears.
    sockets[0]!.deliver({ v: 1, type: 'agent_typing', state: 'end', ts: 2 })
    await tick()
    vm = controller.getViewModel()
    expect(vm.isRunning).toBe(false)
    expect(vm.awaitingFirstToken).toBe(false)
  })

  it('a normal agent_message still clears typing after a start frame', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await controller.send('hi')
    await tick()
    // Server confirms it picked up the turn.
    sockets[0]!.deliver({ v: 1, type: 'agent_typing', state: 'start', ts: 1 })
    await tick()
    expect(controller.getViewModel().isRunning).toBe(true)
    // The reply lands as a single non-streamed agent_message (no `end` frame
    // needed) — the indicator must still clear, no regression.
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'hello', ts: 2 })
    await tick()
    const vm = controller.getViewModel()
    expect(vm.isRunning).toBe(false)
    expect(vm.awaitingFirstToken).toBe(false)
    expect(vm.messages.some((m) => m.role === 'agent' && m.text === 'hello')).toBe(true)
  })

  it('a streaming bubble keeps isRunning even after an end frame (bubble supersedes the dots)', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    sockets[0]!.deliver({ v: 1, type: 'agent_typing', state: 'start', ts: 1 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'Hi', ts: 2 })
    await tick()
    // A live stream already supersedes the typing dots.
    expect(controller.getViewModel().awaitingFirstToken).toBe(false)
    // An `end` frame arrives while the bubble is still in flight — isRunning
    // stays true off the streaming bubble (composer keeps showing Stop).
    sockets[0]!.deliver({ v: 1, type: 'agent_typing', state: 'end', ts: 3 })
    await tick()
    const vm = controller.getViewModel()
    expect(vm.messages.some((m) => m.streaming)).toBe(true)
    expect(vm.isRunning).toBe(true)
  })

  it('ignores a start frame tagged for a different project than the active one', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    controller.setProject('proj-A')
    // A stray typing frame for ANOTHER project must not light this surface.
    sockets[0]!.deliver({ v: 1, type: 'agent_typing', state: 'start', ts: 1, project_id: 'proj-B' })
    await tick()
    expect(controller.getViewModel().isRunning).toBe(false)
    // The same project's frame DOES drive it.
    sockets[0]!.deliver({ v: 1, type: 'agent_typing', state: 'start', ts: 2, project_id: 'proj-A' })
    await tick()
    expect(controller.getViewModel().isRunning).toBe(true)
  })

  // BUG 3 (2026-06-29) — live history-import progress off the `import_progress`
  // frame the engine emits every ~5s. Pre-fix the controller DROPPED this frame
  // (no handler), so a long import showed no live feedback.
  it('surfaces import_progress on the view model and refreshes it per frame', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    expect(controller.getViewModel().importProgress).toBeNull()

    sockets[0]!.deliver({
      v: 1,
      type: 'import_progress',
      job_id: 'job-1',
      status: 'pass1-running',
      pass: 1,
      pct: 0.4,
      chunks_total_known: true,
      body: 'Pass 1: 4/10 batches',
      ts: 1,
    })
    await tick()
    let prog = controller.getViewModel().importProgress
    expect(prog).not.toBeNull()
    expect(prog?.jobId).toBe('job-1')
    expect(prog?.pass).toBe(1)
    expect(prog?.pct).toBeCloseTo(0.4)
    expect(prog?.body).toBe('Pass 1: 4/10 batches')

    // A later frame refreshes (pass 2, further along).
    sockets[0]!.deliver({
      v: 1,
      type: 'import_progress',
      job_id: 'job-1',
      status: 'pass2-running',
      pass: 2,
      pct: 0.8,
      chunks_total_known: true,
      body: 'Pass 2: synthesizing',
      ts: 2,
    })
    await tick()
    prog = controller.getViewModel().importProgress
    expect(prog?.pass).toBe(2)
    expect(prog?.pct).toBeCloseTo(0.8)
    expect(prog?.body).toBe('Pass 2: synthesizing')
  })

  it('clears import_progress on a terminal status frame', async () => {
    const { controller, sockets } = setup()
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    sockets[0]!.deliver({
      v: 1, type: 'import_progress', job_id: 'j', status: 'pass1-running', pass: 1, pct: 0.2,
      chunks_total_known: true, body: 'Pass 1: 2/10 batches', ts: 1,
    })
    await tick()
    expect(controller.getViewModel().importProgress).not.toBeNull()
    sockets[0]!.deliver({
      v: 1, type: 'import_progress', job_id: 'j', status: 'completed', pass: 2, pct: 1,
      chunks_total_known: true, body: 'done', ts: 2,
    })
    await tick()
    expect(controller.getViewModel().importProgress).toBeNull()
  })

  it('auto-clears stale import_progress when frames stop arriving', async () => {
    const sockets: FakeSocket[] = []
    const controller = new NeutronChatController({
      // A tiny staleness window so the test doesn't wait on the 12s default.
      importProgressStaleMs: 20,
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
        }),
    })
    controller.start()
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
    sockets[0]!.deliver({
      v: 1, type: 'import_progress', job_id: 'j', status: 'pass1-running', pass: 1, pct: 0.5,
      chunks_total_known: true, body: 'Pass 1: 5/10 batches', ts: 1,
    })
    await tick()
    expect(controller.getViewModel().importProgress).not.toBeNull()
    await new Promise((r) => setTimeout(r, 40))
    expect(controller.getViewModel().importProgress).toBeNull()
    controller.stop()
  })
})
