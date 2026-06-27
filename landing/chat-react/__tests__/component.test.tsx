/**
 * Component smoke test: render the full assistant-ui composition (ChatApp +
 * ExternalStoreRuntime) in happy-dom, backed by a real chat-core WebChatSession
 * over a fake socket. Asserts that an optimistic user send and a streamed agent
 * reply actually reach the DOM through the assistant-ui primitives — i.e. the
 * convertMessage adapter + runtime wiring render, not just the data layer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

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
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
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

  it('renders agent button options and posts a button_choice on click (P1b)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
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
        options: [
          { label: 'Yes, import', body: 'Yes, import', value: 'yes' },
          { label: 'Skip', body: 'Skip', value: 'skip' },
        ],
      })
      await tick()
    })
    expect(container.textContent).toContain('Yes, import')
    expect(container.textContent).toContain('Skip')
    // The upload-affordance hint is surfaced above the composer.
    expect(container.textContent).toContain('ChatGPT export ZIP')

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
})
