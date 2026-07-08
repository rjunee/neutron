/**
 * Component smoke test: render the full assistant-ui composition (ChatApp +
 * ExternalStoreRuntime) in happy-dom, backed by a real chat-core WebChatSession
 * over a fake socket. Asserts that an optimistic user send and a streamed agent
 * reply actually reach the DOM through the assistant-ui primitives — i.e. the
 * convertMessage adapter + runtime wiring render, not just the data layer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { ProjectTab } from '../config.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  // assistant-ui touches a couple of browser APIs happy-dom doesn't ship.
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (typeof g['ResizeObserver'] !== 'function') {
    g['ResizeObserver'] = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const TOPIC = 'app:sam'
const tick = () => new Promise((r) => setTimeout(r, 0))
const ready = () => ({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })

describe('ChatApp render (happy-dom)', () => {
  it('renders optimistic user sends and streamed agent replies', async () => {
    // Dynamic imports AFTER the DOM globals exist (React reads them at import).
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sockets: Array<{
      open: () => void
      deliver: (o: unknown) => void
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      send: (d: string) => void
      close: () => void
    }> = []
    const makeSocket = () => {
      const s = {
        onopen: null as null | (() => void),
        onmessage: null as null | ((ev: { data: unknown }) => void),
        onclose: null as null | (() => void),
        onerror: null as null | (() => void),
        send: () => {},
        close: () => {},
        open() {
          this.onopen?.()
        },
        deliver(o: unknown) {
          this.onmessage?.({ data: JSON.stringify(o) })
        },
      }
      sockets.push(s)
      return s as never
    }

    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })

    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: TOPIC,
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }

    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
        </AssistantRuntimeProvider>
      )
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })
    // Optimistic user send renders.
    await act(async () => {
      await controller.send('hello there')
      await tick()
    })
    expect(container.textContent).toContain('hello there')

    // Stream a couple of tokens — the live agent bubble exists (running status,
    // text is smooth-revealed via RAF which doesn't flush in happy-dom, so we
    // don't assert its mid-stream text here) — then the final canonical message
    // (status complete, no smoothing) renders its full body.
    await act(async () => {
      sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm1', body_delta: 'Hi ', ts: 1 })
      sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm1', body_delta: 'Sam', ts: 2 })
      await tick()
    })
    // While streaming, the typing indicator is up (Stop button present).
    expect(container.textContent).toContain('Stop')

    await act(async () => {
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'Hi Sam', ts: 3 })
      await tick()
    })
    expect(container.textContent).toContain('Hi Sam')
    // Reply done → composer shows Send again, not Stop.
    expect(container.textContent).toContain('Send')

    // Track B Phase 4 — a reaction_update on the agent message renders a chip.
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'reaction_update',
        message_id: 'm1',
        seq: 1,
        rev: 1,
        reactions: [{ emoji: '👍', device_id: 'devB' }],
        ts: 4,
      })
      await tick()
    })
    expect(container.textContent).toContain('👍 1')

    // Track B Phase 4 (edit/delete) — an edit_update rewrites the rendered body
    // + shows the "edited" marker; a later delete renders the tombstone.
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'edit_update',
        message_id: 'm1',
        seq: 1,
        rev: 1,
        body: 'Hi Sam (edited)',
        deleted: false,
        edited_at: 50,
        ts: 5,
      })
      await tick()
    })
    expect(container.textContent).toContain('Hi Sam (edited)')
    expect(container.textContent).toContain('edited')

    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'edit_update',
        message_id: 'm1',
        seq: 1,
        rev: 2,
        body: '',
        deleted: true,
        edited_at: 60,
        ts: 6,
      })
      await tick()
    })
    expect(container.textContent).toContain('This message was deleted')

    await act(async () => {
      root.unmount()
    })
  })

  it('BUG 7 — non-streamed pending reply shows ONLY typing dots, no empty agent bubble', async () => {
    // The live-agent reply arrives as a SINGLE `agent_message` (no
    // `agent_message_partial` frames). While it is pending, assistant-ui would
    // synthesize an empty optimistic assistant bubble (isRunning + last message
    // is the user's). Assert ONLY the typing indicator renders — no empty,
    // non-typing `.car-bubble-agent` stacked above it — until the real message
    // lands.
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sockets: Array<{
      open: () => void
      deliver: (o: unknown) => void
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      send: (d: string) => void
      close: () => void
    }> = []
    const makeSocket = () => {
      const s = {
        onopen: null as null | (() => void),
        onmessage: null as null | ((ev: { data: unknown }) => void),
        onclose: null as null | (() => void),
        onerror: null as null | (() => void),
        send: () => {},
        close: () => {},
        open() {
          this.onopen?.()
        },
        deliver(o: unknown) {
          this.onmessage?.({ data: JSON.stringify(o) })
        },
      }
      sockets.push(s)
      return s as never
    }

    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })
    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: TOPIC,
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
        </AssistantRuntimeProvider>
      )
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })
    // User sends; the reply is now pending with NO partials streamed.
    await act(async () => {
      await controller.send('are you there?')
      await tick()
    })
    expect(container.textContent).toContain('are you there?')
    // The typing indicator is up …
    const typing = container.querySelectorAll('.car-bubble-agent.car-typing')
    expect(typing.length).toBe(1)
    // … and there is NO empty (non-typing) agent bubble stacked above it.
    const nonTypingAgentBubbles = Array.from(
      container.querySelectorAll('.car-bubble-agent'),
    ).filter((b) => !b.classList.contains('car-typing'))
    expect(nonTypingAgentBubbles.length).toBe(0)

    // The real single-frame agent_message lands → its bubble renders, typing clears.
    await act(async () => {
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm9', seq: 1, body: 'Yes, here!', ts: 9 })
      await tick()
    })
    expect(container.textContent).toContain('Yes, here!')
    expect(container.querySelectorAll('.car-bubble-agent.car-typing').length).toBe(0)

    await act(async () => {
      root.unmount()
    })
  })

  it('chat-typing persistence — dots STAY through a background build after the ack, then stop when work is done', async () => {
    // Ryan live-test 2026-07-01: an ack turn settles (agent_message) but a
    // long/background build keeps running. The typing dots must stay visible the
    // whole time work is in flight (the same signal as the flashing Plan-tab
    // dot) and stop the moment the board reports the work done.
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sockets: Array<{
      open: () => void
      deliver: (o: unknown) => void
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      send: (d: string) => void
      close: () => void
    }> = []
    const makeSocket = () => {
      const s = {
        onopen: null as null | (() => void),
        onmessage: null as null | ((ev: { data: unknown }) => void),
        onclose: null as null | (() => void),
        onerror: null as null | (() => void),
        send: () => {},
        close: () => {},
        open() {
          this.onopen?.()
        },
        deliver(o: unknown) {
          this.onmessage?.({ data: JSON.stringify(o) })
        },
      }
      sockets.push(s)
      return s as never
    }

    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })
    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: TOPIC,
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
        </AssistantRuntimeProvider>
      )
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })
    // User asks for a build; the agent acks and dispatches a background build.
    await act(async () => {
      await controller.send('build me a meditation timer app')
      await tick()
    })
    const typingUp = () => container.querySelectorAll('.car-bubble-agent.car-typing').length
    expect(typingUp()).toBe(1)

    // The ack lands as a single agent_message — the turn settles, awaitingReply
    // clears. WITHOUT the fix the dots would vanish here even though the build
    // continues.
    await act(async () => {
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'ack1', seq: 1, body: 'On it — building now…', ts: 9 })
      await tick()
    })
    expect(container.textContent).toContain('On it — building now…')

    // The background build reports an in_progress work-board item (no project_id
    // → "this project"). The dots must come back / stay on.
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'work_board_changed',
        items: [
          {
            id: 'b1',
            title: 'Scaffold the timer UI',
            status: 'in_progress',
            sort_order: 1,
            design_doc_ref: null,
            inline_active: true,
            linked_run_id: null,
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-01T00:00:00Z',
            completed_at: null,
          },
        ],
        ts: 10,
      })
      await tick()
    })
    expect(typingUp()).toBe(1)

    // Build completes: the item flips to done → the dots stop.
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'work_board_changed',
        items: [
          {
            id: 'b1',
            title: 'Scaffold the timer UI',
            status: 'done',
            sort_order: 1,
            design_doc_ref: null,
            inline_active: false,
            linked_run_id: null,
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-01T00:00:00Z',
            completed_at: '2026-07-01T00:05:00Z',
          },
        ],
        ts: 11,
      })
      await tick()
    })
    expect(typingUp()).toBe(0)

    await act(async () => {
      root.unmount()
    })
  })

  it('renders agent button options and posts a button_choice on click (P1b)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sent: string[] = []
    const sockets: Array<{
      open: () => void
      deliver: (o: unknown) => void
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      send: (d: string) => void
      close: () => void
    }> = []
    const makeSocket = () => {
      const s = {
        onopen: null as null | (() => void),
        onmessage: null as null | ((ev: { data: unknown }) => void),
        onclose: null as null | (() => void),
        onerror: null as null | (() => void),
        send: (d: string) => {
          sent.push(d)
        },
        close: () => {},
        open() {
          this.onopen?.()
        },
        deliver(o: unknown) {
          this.onmessage?.({ data: JSON.stringify(o) })
        },
      }
      sockets.push(s)
      return s as never
    }

    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })
    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: TOPIC,
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
        </AssistantRuntimeProvider>
      )
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })
    // An agent message with a button prompt + an upload affordance.
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'agent_message',
        message_id: 'm1',
        seq: 1,
        ts: 1,
        body: 'Import your history?',
        prompt_id: 'p1',
        kind: 'buttons',
        upload_affordance: { source: 'chatgpt' },
        // BUG 3 — the server ships an A/B/C letter `label` (Telegram's legend)
        // alongside the real `body` text; the web buttons must render `body`.
        options: [
          { label: 'A', body: 'Yes, import', value: 'yes' },
          { label: 'B', body: 'Skip', value: 'skip' },
        ],
      })
      await tick()
    })
    expect(container.textContent).toContain('Yes, import')
    expect(container.textContent).toContain('Skip')
    // BUG 3 — buttons show the real choice text, NOT the bare A/B letters.
    const choiceTexts = Array.from(container.querySelectorAll('.car-choice')).map((b) => b.textContent)
    expect(choiceTexts).toContain('Yes, import')
    expect(choiceTexts).toContain('Skip')
    expect(choiceTexts).not.toContain('A')
    expect(choiceTexts).not.toContain('B')
    // BUG 2 (2026-06-29) — the old always-on passive "attach your export ZIP"
    // hint was REMOVED (it nagged from the first onboarding turn). An active
    // upload affordance now surfaces NO persistent banner; instead the 📎 picker
    // accepts .zip and a prominent drag-and-drop overlay appears on drag.
    expect(container.textContent).not.toContain('export ZIP to import your history')
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(fileInput).not.toBeNull()
    expect(fileInput!.accept).toContain('.zip')
    const attachBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label')?.includes('export ZIP'),
    )
    expect(attachBtn).toBeDefined()

    // Click the first option → posts a button_choice frame + collapses the row.
    const yesBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Yes, import',
    )
    expect(yesBtn).toBeDefined()
    await act(async () => {
      yesBtn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await tick()
    })
    const choiceFrames = sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === 'button_choice')
    expect(choiceFrames).toContainEqual({ v: 1, type: 'button_choice', prompt_id: 'p1', choice_value: 'yes' })
    // Collapsed summary shows the chosen label; the buttons are gone.
    expect(container.textContent).toContain('→ Yes, import')

    await act(async () => {
      root.unmount()
    })
  })

  it('BUG 2/3/4/5 — drag overlay on drag, live import progress, no reaction trigger', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sockets: Array<{
      open: () => void
      deliver: (o: unknown) => void
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      send: (d: string) => void
      close: () => void
    }> = []
    const makeSocket = () => {
      const s = {
        onopen: null as null | (() => void),
        onmessage: null as null | ((ev: { data: unknown }) => void),
        onclose: null as null | (() => void),
        onerror: null as null | (() => void),
        send: () => {},
        close: () => {},
        open() {
          this.onopen?.()
        },
        deliver(o: unknown) {
          this.onmessage?.({ data: JSON.stringify(o) })
        },
      }
      sockets.push(s)
      return s as never
    }
    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })
    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: TOPIC,
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
        </AssistantRuntimeProvider>
      )
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })

    // Codex r1 — with NO import affordance (normal chat), the surface drag
    // handler is STILL active (dragging an image must keep working): a dragover
    // shows the subtle outline, and NOT the import overlay.
    const mainEarly = container.querySelector('.car-main') as HTMLElement
    await act(async () => {
      mainEarly.dispatchEvent(new window.Event('dragover', { bubbles: true, cancelable: true }))
      await tick()
    })
    expect(mainEarly.classList.contains('car-dragover')).toBe(true)
    expect(container.querySelector('.car-dropzone')).toBeNull()
    // Leave the surface to reset drag state before the import-affordance leg.
    await act(async () => {
      mainEarly.dispatchEvent(new window.Event('dragleave', { bubbles: true }))
      await tick()
    })

    // An agent message with an active upload affordance (uploads accepted).
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'agent_message',
        message_id: 'm1',
        seq: 1,
        ts: 1,
        body: 'Want to import your ChatGPT history? Drop your export here.',
        upload_affordance: { source: 'chatgpt' },
      })
      await tick()
    })
    // BUG 5 — no add-reaction "＋" trigger anywhere.
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (b) => b.getAttribute('aria-label') === 'Add reaction',
      ),
    ).toBe(false)
    // BUG 2 — the prominent overlay is NOT shown at rest (no premature affordance).
    expect(container.querySelector('.car-dropzone')).toBeNull()

    // BUG 4 — dragging a file over the surface reveals the prominent dropzone.
    const main = container.querySelector('.car-main') as HTMLElement
    expect(main).not.toBeNull()
    await act(async () => {
      const ev = new window.Event('dragover', { bubbles: true, cancelable: true })
      main.dispatchEvent(ev)
      await tick()
    })
    const dropzone = container.querySelector('.car-dropzone')
    expect(dropzone).not.toBeNull()
    expect(dropzone?.textContent).toContain('Drop your ChatGPT export here')

    // BUG 3 — a live import_progress frame renders a spinner + body + bar.
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'import_progress',
        job_id: 'job-1',
        status: 'pass1-running',
        pass: 1,
        pct: 0.47,
        chunks_total_known: true,
        body: 'Pass 1: 47/57 batches · ~3 min remaining',
        ts: 2,
      })
      await tick()
    })
    expect(container.textContent).toContain('Pass 1: 47/57 batches')
    expect(container.querySelector('.car-spinner')).not.toBeNull()
    const fill = container.querySelector('.car-import-bar-fill') as HTMLElement | null
    expect(fill).not.toBeNull()
    expect(fill!.style.width).toBe('47%')

    await act(async () => {
      root.unmount()
    })
  })

  it('renders the pinned Create Project button and POSTs to /api/app/projects on click', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    // Create-project lives in the persistent rail, now owned by ProjectShell.
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const makeSocket = () =>
      ({
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: () => {},
        close: () => {},
      }) as never

    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })

    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: TOPIC,
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }

    // Capture the create POST; return a created project the controller navigates to.
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
      // The shell resolves its tab set (global, then per-project after navigate);
      // serve those empty and DON'T record them so `calls` is just the create POST.
      if (url.endsWith('/tabs')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, tabs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      // General now mounts the Work pane (happy-dom reports a desktop viewport), so
      // its WorkBoardTab lists the board on mount — serve it empty and DON'T record
      // it so `calls` stays just the create POST.
      if (url.includes('/work-board')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, items: [], project_id: 'general' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      calls.push({ url, ...(init !== undefined ? { init } : {}) })
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, project: { id: 'taxes', label: 'Taxes' }, created: true }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ProjectShell vm={vm} controller={controller} config={config} draft={draft} fetchImpl={fetchImpl} />
        </AssistantRuntimeProvider>
      )
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })

    // The header "+" new-project affordance is always present (even with zero
    // projects — only General). It replaced the old bottom "Create Project" button.
    const createBtn = container.querySelector('.car-rail-newp') as HTMLButtonElement | null
    expect(createBtn).not.toBeNull()
    expect(createBtn!.textContent).toContain('+')

    // Clicking it opens the INLINE name input (no native window.prompt).
    await act(async () => {
      createBtn!.click()
      await tick()
    })
    const input = container.querySelector('.car-rail-input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    // The header "+" stays put (it's a toggle); the inline form is now open.
    expect(container.querySelector('.car-rail-create-form')).not.toBeNull()

    // Type a name into the controlled input (native setter + input event), then
    // submit with Enter.
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      setInputValue.call(input!, 'Taxes')
      input!.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
    })
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
      await tick()
    })

    // It POSTed the trimmed name to the create endpoint with the bearer token…
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://sam.neutron.test/api/app/projects')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: 'Taxes' })
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer dev:sam')
    // …and navigated into the new project.
    expect(controller.getViewModel().projectId).toBe('taxes')
    // …and the inline form closed on success (the header "+" stays present).
    expect(container.querySelector('.car-rail-input')).toBeNull()
    expect(container.querySelector('.car-rail-newp')).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('inline Create Project: Escape cancels and an empty name does not POST', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    // Create-project lives in the persistent rail, now owned by ProjectShell.
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const makeSocket = () =>
      ({
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: () => {},
        close: () => {},
      }) as never

    const controller = new NeutronChatController({
      createSession: (sinks) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: TOPIC,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })

    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: TOPIC,
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }

    const calls: Array<{ url: string }> = []
    const fetchImpl = (url: string): Promise<Response> => {
      // Serve the shell's tab resolver empty without recording it (see above).
      if (url.endsWith('/tabs')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, tabs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      // General's Work pane lists its board on mount (desktop viewport) — serve it
      // empty and don't record it, so `calls` reflects only the create flow.
      if (url.includes('/work-board')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, items: [], project_id: 'general' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      calls.push({ url })
      return Promise.resolve(new Response('{}', { status: 201 }))
    }

    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ProjectShell vm={vm} controller={controller} config={config} draft={draft} fetchImpl={fetchImpl} />
        </AssistantRuntimeProvider>
      )
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })

    // Open the inline form via the header "+".
    await act(async () => {
      ;(container.querySelector('.car-rail-newp') as HTMLButtonElement).click()
      await tick()
    })
    const input = container.querySelector('.car-rail-input') as HTMLInputElement | null
    expect(input).not.toBeNull()

    // Empty-name Enter shows an inline error and does NOT POST.
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
    })
    expect(calls.length).toBe(0)
    expect(container.querySelector('.car-rail-create-error')).not.toBeNull()

    // Escape closes the form (still no POST); the header "+" stays present.
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await tick()
    })
    expect(calls.length).toBe(0)
    expect(container.querySelector('.car-rail-input')).toBeNull()
    expect(container.querySelector('.car-rail-newp')).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  // ── Item 2 (2026-06-30 fresh-install fix) — the "Setting things up…" onboarding
  // loader is gated on the GENERAL topic only. `config.onboardingActive` is a
  // page-global bootstrap flag; without the `vm.projectId === null` guard an
  // empty PROJECT topic painted the infinite loader forever. ──────────────────
  const renderEmpty = async (
    projectId: string | null,
  ): Promise<{ text: string; unmount: () => Promise<void> }> => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const makeSocket = () =>
      ({
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send() {},
        close() {},
      }) as never

    const topicId = projectId === null ? 'app:sam' : `app:sam:${projectId}`
    const controller = new NeutronChatController({
      projectId,
      createSession: (sinks, scope) =>
        new WebChatSession({
          url: 'wss://t/ws/app/chat',
          topic_id: scope.topicId,
          store: new InMemoryStore(),
          createSocket: makeSocket,
          onChange: sinks.onChange,
          onStatus: sinks.onStatus,
          onFrame: sinks.onFrame,
        }),
    })
    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId,
      userId: 'sam',
      projectId,
      projects: [{ id: 'proj-a', label: 'Proj A' }],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
      // Page-global: the owner is mid/just-finished onboarding.
      onboardingActive: true,
    }
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
        </AssistantRuntimeProvider>
      )
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      await tick()
    })
    const text = container.textContent ?? ''
    return {
      text,
      unmount: async (): Promise<void> => {
        await act(async () => {
          root.unmount()
        })
      },
    }
  }

  it('empty PROJECT topic does NOT show the onboarding loader, even while onboardingActive', async () => {
    const { text, unmount } = await renderEmpty('proj-a')
    expect(text).not.toContain('Setting things up')
    // Resolves to a usable empty state instead of an infinite loader.
    expect(text).toContain('Send a message to begin.')
    await unmount()
  })

  it('empty GENERAL topic DOES still show the onboarding loader while onboardingActive', async () => {
    const { text, unmount } = await renderEmpty(null)
    expect(text).toContain('Setting things up')
    await unmount()
  })
})

describe('TopicRail render (rail-redesign)', () => {
  it('renders per-project emoji + unread badge, and hides the badge on the active project', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const React = await import('react')
    const { TopicRail } = await import('../ChatApp.tsx')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(TopicRail, {
          projects: [
            { id: 'p1', label: 'Fitness', emoji: '🏋️', unread: 4 },
            // The ACTIVE project — its badge must be suppressed (the user is viewing it).
            { id: 'p2', label: 'Reading', emoji: '📚', unread: 7 },
            // No emoji from the server → generic fallback glyph, no badge at 0.
            { id: 'p3', label: 'Misc', unread: 0 },
          ],
          activeId: 'p2',
          onSelect: () => {},
          onCreate: async () => null,
          creating: false,
          narrow: false,
        }),
      )
    })

    const items = Array.from(container.querySelectorAll('.car-rail-item'))
    // General + 3 projects.
    expect(items.length).toBe(4)
    const emojis = Array.from(container.querySelectorAll('.car-rail-emoji')).map((e) => e.textContent)
    expect(emojis).toEqual(['💬', '🏋️', '📚', '📁'])

    const badges = Array.from(container.querySelectorAll('.car-rail-badge')).map((e) => e.textContent)
    // Only p1's badge shows: General(0) hidden, p2 active→hidden, p3(0) hidden.
    expect(badges).toEqual(['4'])

    // The active project carries the active class, not the unread class.
    const active = container.querySelector('.car-rail-item-active') as HTMLElement
    expect(active.textContent).toContain('Reading')
    expect(active.className).not.toContain('car-rail-item-unread')

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('caps a very large unread count at 99+', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const React = await import('react')
    const { TopicRail } = await import('../ChatApp.tsx')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(TopicRail, {
          projects: [{ id: 'p1', label: 'Busy', emoji: '📥', unread: 250 }],
          activeId: null,
          onSelect: () => {},
          onCreate: async () => null,
          creating: false,
          narrow: false,
        }),
      )
    })
    expect(container.querySelector('.car-rail-badge')!.textContent).toBe('99+')
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})

describe('rail helpers (M1 UX redesign — pure)', () => {
  it('formatRailTime: today→HH:MM, this week→weekday, older→Mon Day, blank on missing', async () => {
    const { formatRailTime } = await import('../ChatApp.tsx')
    const now = new Date('2026-07-02T14:32:00')
    // Same calendar day → 24h clock.
    expect(formatRailTime('2026-07-02T09:05:00', now)).toBe('09:05')
    expect(formatRailTime('2026-07-02T00:00:00', now)).toBe('00:00')
    // Within the last week (but not today) → weekday abbreviation.
    expect(formatRailTime('2026-06-29T10:00:00', now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/)
    // Older than a week → "Mon Day".
    expect(formatRailTime('2026-06-15T10:00:00', now)).toBe('Jun 15')
    // Missing / unparseable → empty (row renders no timestamp).
    expect(formatRailTime(undefined, now)).toBe('')
    expect(formatRailTime('', now)).toBe('')
    expect(formatRailTime('not-a-date', now)).toBe('')
  })

  it('railDotClass: working→work, attention→attention, idle/undefined→none, General→none', async () => {
    const { railDotClass } = await import('../ChatApp.tsx')
    expect(railDotClass('working', false)).toBe('car-rail-dot-work')
    expect(railDotClass('attention', false)).toBe('car-rail-dot-attention')
    expect(railDotClass('idle', false)).toBeNull()
    expect(railDotClass(undefined, false)).toBeNull()
    // General never shows a dot even if a stray activity slips through.
    expect(railDotClass('working', true)).toBeNull()
  })

  it('railEmojiFor: server emoji wins, generic fallback otherwise', async () => {
    const { railEmojiFor } = await import('../ChatApp.tsx')
    expect(railEmojiFor('🚀')).toBe('🚀')
    expect(railEmojiFor(undefined)).toBe('📁')
    expect(railEmojiFor('')).toBe('📁')
  })
})

describe('TopicRail 2-line rows + branding (M1 UX redesign)', () => {
  const renderRail = async (
    props: { projects: ProjectTab[]; activeId: string | null; narrow?: boolean; now?: Date },
  ): Promise<{ container: HTMLElement; cleanup: () => Promise<void> }> => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const React = await import('react')
    const { TopicRail } = await import('../ChatApp.tsx')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(TopicRail, {
          onSelect: () => {},
          onCreate: async () => null,
          creating: false,
          ...props,
        }),
      )
    })
    return {
      container,
      cleanup: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  it('renders the ⚛ atom + Neutron wordmark header with the "+" new-project affordance', async () => {
    const { container, cleanup } = await renderRail({ projects: [], activeId: null, narrow: false })
    // No old "PROJECTS" caps label.
    expect(container.querySelector('.car-rail-title')).toBeNull()
    expect(container.querySelector('.car-rail-atom')).not.toBeNull()
    expect(container.querySelector('.car-rail-atom')!.tagName.toLowerCase()).toBe('svg')
    expect(container.querySelector('.car-rail-wordmark')!.textContent).toBe('Neutron')
    const newp = container.querySelector('.car-rail-newp') as HTMLButtonElement
    expect(newp).not.toBeNull()
    expect(newp.getAttribute('aria-label')).toBe('New project')
    await cleanup()
  })

  it('wide rows carry emoji+dot, name+timestamp, preview with a You: prefix on own messages', async () => {
    const now = new Date('2026-07-02T14:32:00')
    const { container, cleanup } = await renderRail({
      now,
      activeId: null,
      narrow: false,
      projects: [
        {
          id: 'p1',
          label: 'Neutron',
          emoji: '🚀',
          unread: 2,
          activity: 'working',
          preview: 'Building the task engine…',
          preview_from: 'agent',
          last_activity_at: '2026-07-02T09:05:00',
        },
        {
          id: 'p2',
          label: 'Pristine',
          emoji: '🧪',
          unread: 0,
          activity: 'attention',
          preview: 'remind me to review the pipeline',
          preview_from: 'user',
          last_activity_at: '2026-06-15T10:00:00',
        },
      ],
    })
    const rows = Array.from(container.querySelectorAll('.car-rail-item'))
    // General + 2 projects.
    expect(rows.length).toBe(3)
    // General (row 0) has no work-activity dot.
    expect(rows[0]!.querySelector('.car-rail-dot')).toBeNull()
    // p1 pulses a work dot; p2 shows the static attention dot.
    expect(rows[1]!.querySelector('.car-rail-dot-work')).not.toBeNull()
    expect(rows[2]!.querySelector('.car-rail-dot-attention')).not.toBeNull()
    // Names + timestamps on line 1.
    expect(rows[1]!.querySelector('.car-rail-name')!.textContent).toBe('Neutron')
    expect(rows[1]!.querySelector('.car-rail-time')!.textContent).toBe('09:05')
    expect(rows[2]!.querySelector('.car-rail-time')!.textContent).toBe('Jun 15')
    // p1's preview (agent) has NO You: prefix; p2's (user) does.
    expect(rows[1]!.querySelector('.car-rail-you')).toBeNull()
    expect(rows[2]!.querySelector('.car-rail-you')!.textContent).toBe('You: ')
    expect(rows[2]!.querySelector('.car-rail-preview')!.textContent).toContain(
      'remind me to review the pipeline',
    )
    await cleanup()
  })

  it('narrow rail collapses to icon rows: no meta, a corner count badge, name in the title', async () => {
    const { container, cleanup } = await renderRail({
      activeId: null,
      narrow: true,
      projects: [{ id: 'p1', label: 'Neutron', emoji: '🚀', unread: 2, activity: 'working' }],
    })
    const rows = Array.from(container.querySelectorAll('.car-rail-item'))
    expect(rows.every((r) => r.className.includes('car-rail-item-narrow'))).toBe(true)
    // The 2-line meta is not rendered in the icon rail…
    expect(container.querySelector('.car-rail-meta')).toBeNull()
    expect(container.querySelector('.car-rail-badge')).toBeNull()
    // …the unread count moves to the corner overlay, and the name lives in title.
    const project = rows[1] as HTMLElement
    expect(project.querySelector('.car-rail-count')!.textContent).toBe('2')
    expect(project.querySelector('.car-rail-emoji')!.textContent).toBe('🚀')
    expect(project.getAttribute('title')).toBe('Neutron')
    // The button carries an explicit accessible name (name + unread) so a screen
    // reader never announces it as just "2 unread" (Codex P2). General has no unread.
    expect(project.getAttribute('aria-label')).toBe('Neutron, 2 unread')
    expect((rows[0] as HTMLElement).getAttribute('aria-label')).toBe('General')
    // The work dot still rides the avatar in the collapsed rail.
    expect(project.querySelector('.car-rail-dot-work')).not.toBeNull()
    await cleanup()
  })

  it('opening the create form expands the narrow rail so the name field fits (Codex P2)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const React = await import('react')
    const { TopicRail } = await import('../ChatApp.tsx')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(TopicRail, {
          projects: [],
          activeId: null,
          onSelect: () => {},
          onCreate: async () => null,
          creating: false,
          narrow: true,
        }),
      )
    })
    // Collapsed to the icon rail initially…
    expect(container.querySelector('.car-rail')!.className).toContain('car-rail-narrow')
    // …clicking the header "+" opens the create form AND expands the rail to full
    // width (so the name field isn't crushed into the 68px column).
    await act(async () => {
      ;(container.querySelector('.car-rail-newp') as HTMLButtonElement).click()
      await tick()
    })
    expect(container.querySelector('.car-rail-input')).not.toBeNull()
    expect(container.querySelector('.car-rail')!.className).not.toContain('car-rail-narrow')
    // Rows render 2-line again while expanded.
    expect(container.querySelector('.car-rail-meta')).not.toBeNull()
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
