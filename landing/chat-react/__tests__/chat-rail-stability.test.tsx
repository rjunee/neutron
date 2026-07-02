/**
 * SEV1 chat-rail stability (2026-07-01) — the crash-on-project-switch fix.
 *
 * Two guarantees, in happy-dom over the real assistant-ui composition:
 *   1. Switching into an EMPTY project after the outgoing one had ≥2 messages
 *      does NOT throw (the assistant-ui `useClientLookup` index-out-of-bounds
 *      that unmounted the whole tree to a black screen) — the keyed remount tears
 *      the stale message parts down atomically with the switch.
 *   2. `ChatErrorBoundary` catches a render throw into a recoverable fallback
 *      (Retry / Back to General / Reload) instead of a dead screen, and recovers
 *      in-place once the underlying problem clears.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat' })
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

describe('chat-rail stability — project switch never crashes the thread', () => {
  it('switches from a message-laden General into an empty project without throwing', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChatVm } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sockets: Array<{
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      send: (d: string) => void
      close: () => void
      open: () => void
      deliver: (o: unknown) => void
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
      projectId: null,
      projects: [{ id: 'meditation', label: 'Meditation', emoji: '🧘' }],
      // Each scope gets its OWN store so the project topic hydrates empty.
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
      projects: [{ id: 'meditation', label: 'Meditation', emoji: '🧘' }],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }

    // Mirror PRODUCTION wiring: no external `AssistantRuntimeProvider`. `ChatApp`
    // owns a per-conversation runtime (`ConversationRuntimeHost`, keyed by
    // convId), so the runtime RESETS on a switch rather than being reused.
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const vm = useNeutronChatVm(controller)
      return <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    // Seed General with TWO agent messages (so a MessagePart at index 1 exists —
    // the exact index the crash reported: "Index 1 out of bounds").
    await act(async () => {
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })
    await act(async () => {
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'first msg', ts: 1 })
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a2', seq: 2, body: 'second msg', ts: 2 })
      await tick()
    })
    expect(container.textContent).toContain('second msg')

    // Switch into the empty project. With a SHARED runtime this threw
    // `useClientLookup: Index 1 out of bounds (length: 0)` inside
    // <MessagePartPrimitive.Text> and tripped the boundary. The fresh
    // per-conversation runtime means the outgoing runtime is discarded whole
    // (never shrunk in place), so the switch resolves cleanly to the empty state.
    await act(async () => {
      controller.setProject('meditation')
      await tick()
    })
    expect(container.textContent).not.toContain('second msg')
    expect(container.textContent).not.toContain('first msg')
    expect(container.textContent).toContain('Send a message to begin.')
    // The tree is intact (no black-screen unmount) — the composer still renders.
    expect(container.textContent).toContain('Send')
    // CRUCIAL — prove the RUNTIME RESET (not the boundary catching a throw) is
    // what kept the switch clean: the `ChatErrorBoundary` fallback must be ABSENT.
    // If a stale MessagePart had thrown, the boundary would show this card; its
    // absence proves nothing threw in the first place.
    expect(container.textContent).not.toContain('This conversation hit a snag')

    // And switching back is equally clean.
    await act(async () => {
      controller.setProject(null)
      await tick()
    })
    expect(container.textContent).toContain('Send')
    expect(container.textContent).not.toContain('This conversation hit a snag')

    await act(async () => {
      root.unmount()
    })
  })

  it('survives RAPID switching across General + multiple projects (incl. empty) with no index throw', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChatVm } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sockets: Array<{
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      open: () => void
      deliver: (o: unknown) => void
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

    const projects = [
      { id: 'alpha', label: 'Alpha', emoji: '🅰️' },
      { id: 'beta', label: 'Beta', emoji: '🅱️' },
      { id: 'empty', label: 'Empty', emoji: '⬜' },
    ]
    const controller = new NeutronChatController({
      projectId: null,
      projects,
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
      projects,
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }

    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const vm = useNeutronChatVm(controller)
      return <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    // Seed General with a couple of messages so the very first switch is the
    // dangerous "laden → empty" transition that used to throw at index ≥1.
    await act(async () => {
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'g1', seq: 1, body: 'general one', ts: 1 })
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'g2', seq: 2, body: 'general two', ts: 2 })
      await tick()
    })
    expect(container.textContent).toContain('general two')

    // Hammer the switch path: General → alpha → beta → empty → General → beta →
    // empty → alpha → General. Each hop tears down the socket and remounts a
    // fresh runtime; a stale MessagePart indexing an emptied shared list would
    // throw here. The boundary card must NEVER appear.
    const hops: Array<string | null> = ['alpha', 'beta', 'empty', null, 'beta', 'empty', 'alpha', null]
    for (const target of hops) {
      await act(async () => {
        controller.setProject(target)
        await tick()
      })
      expect(container.textContent).not.toContain('This conversation hit a snag')
      // Every scope hydrates empty here (fresh per-scope store), so the empty
      // state renders and the composer stays mounted — the tree is always intact.
      expect(container.textContent).toContain('Send a message to begin.')
      expect(container.textContent).toContain('Send')
    }
    // Stale content from the outgoing conversations never bleeds through.
    expect(container.textContent).not.toContain('general two')

    await act(async () => {
      root.unmount()
    })
  })
})

describe('ChatErrorBoundary — recoverable fallback', () => {
  it('catches a child render throw and recovers in-place on Retry', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act, useState } = await import('react')
    const { ChatErrorBoundary } = await import('../ChatErrorBoundary.tsx')
    const React = await import('react')

    function Bomb({ boom }: { boom: boolean }): React.JSX.Element {
      if (boom) throw new Error('kaboom — simulated render crash')
      return <div className="safe">all good now</div>
    }

    let setBoom: (v: boolean) => void = () => {}
    function Harness(): React.JSX.Element {
      const [boom, _setBoom] = useState(true)
      setBoom = _setBoom
      return (
        <ChatErrorBoundary onBackToGeneral={() => {}}>
          <Bomb boom={boom} />
        </ChatErrorBoundary>
      )
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })

    // The throw is caught → the recoverable fallback renders (NOT a blank tree).
    expect(container.textContent).toContain('This conversation hit a snag')
    expect(container.textContent).toContain('Try again')
    expect(container.textContent).toContain('Back to General')
    expect(container.querySelector('.safe')).toBeNull()

    // Fix the underlying condition, then click "Try again" → boundary clears its
    // error state and re-renders the (now-safe) children in place.
    await act(async () => {
      setBoom(false)
      await tick()
    })
    // Still showing the fallback until the user retries (error state sticky).
    expect(container.textContent).toContain('This conversation hit a snag')

    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Try again',
    )
    expect(retryBtn).toBeDefined()
    await act(async () => {
      retryBtn!.click()
      await tick()
    })
    expect(container.textContent).toContain('all good now')
    expect(container.textContent).not.toContain('This conversation hit a snag')

    await act(async () => {
      root.unmount()
    })
  })
})
