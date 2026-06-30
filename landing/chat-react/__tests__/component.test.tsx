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
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
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

    // The closed button is always present, even with zero projects (only General).
    const createBtn = container.querySelector('.car-rail-create') as HTMLButtonElement | null
    expect(createBtn).not.toBeNull()
    expect(createBtn!.textContent).toContain('Create Project')

    // Clicking it opens the INLINE name input (no native window.prompt).
    await act(async () => {
      createBtn!.click()
      await tick()
    })
    const input = container.querySelector('.car-rail-input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    // The closed button is replaced by the form.
    expect(container.querySelector('.car-rail-create')).toBeNull()

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
    // …and the inline form closed back to the button on success.
    expect(container.querySelector('.car-rail-input')).toBeNull()
    expect(container.querySelector('.car-rail-create')).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('inline Create Project: Escape cancels and an empty name does not POST', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
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

    // Open the inline form.
    await act(async () => {
      ;(container.querySelector('.car-rail-create') as HTMLButtonElement).click()
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

    // Escape closes the form back to the button (still no POST).
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await tick()
    })
    expect(calls.length).toBe(0)
    expect(container.querySelector('.car-rail-input')).toBeNull()
    expect(container.querySelector('.car-rail-create')).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
  })
})
