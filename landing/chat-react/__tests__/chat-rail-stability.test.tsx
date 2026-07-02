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
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
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

    // Switch into the empty project. Without the keyed remount this threw
    // `useClientLookup: Index 1 out of bounds (length: 0)` inside
    // <MessagePartPrimitive.Text> and unmounted the whole tree. It must now
    // resolve cleanly to the empty state.
    await act(async () => {
      controller.setProject('meditation')
      await tick()
    })
    expect(container.textContent).not.toContain('second msg')
    expect(container.textContent).not.toContain('first msg')
    expect(container.textContent).toContain('Send a message to begin.')
    // The tree is intact (no black-screen unmount) — the composer still renders.
    expect(container.textContent).toContain('Send')

    // And switching back is equally clean.
    await act(async () => {
      controller.setProject(null)
      await tick()
    })
    expect(container.textContent).toContain('Send')

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
