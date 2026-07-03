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

/** FIX #343 — each visited conversation is a persistent, individually-mounted
 *  `.car-conv` surface; only the ACTIVE one is un-`hidden`. Inactive surfaces stay
 *  in the DOM (their scroll/draft/messages preserved) but hidden, so a switched-
 *  away project's messages remain in `container.textContent`. Assertions about
 *  what the USER SEES must therefore read the visible pane, not the whole tree. */
const visibleText = (container: HTMLElement): string =>
  container.querySelector('.car-conv:not([hidden])')?.textContent ?? ''

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
    // <MessagePartPrimitive.Text> and tripped the boundary. Each conversation now
    // owns its OWN persistent runtime that is only ever fed ITS messages, so the
    // outgoing runtime is never shrunk in place and the switch resolves cleanly
    // to the incoming project's (empty) state.
    await act(async () => {
      controller.setProject('meditation')
      await tick()
    })
    // The VISIBLE pane is the empty project — its own transcript, not General's.
    // (General's surface stays MOUNTED but hidden, preserving its messages for an
    // instant switch-back, so they're still in the full tree — just not visible.)
    expect(visibleText(container)).not.toContain('second msg')
    expect(visibleText(container)).not.toContain('first msg')
    expect(visibleText(container)).toContain('Send a message to begin.')
    // The tree is intact (no black-screen unmount) — the composer still renders.
    expect(container.textContent).toContain('Send')
    // CRUCIAL — nothing threw: the `ChatErrorBoundary` fallback must be ABSENT.
    // A stale MessagePart indexing an emptied runtime would have tripped it; its
    // absence proves the switch was clean.
    expect(container.textContent).not.toContain('This conversation hit a snag')

    // Switching BACK is instant and preserves General's messages from the mounted
    // cache (no teardown, no refetch flash): the visible pane shows them again.
    await act(async () => {
      controller.setProject(null)
      await tick()
    })
    expect(visibleText(container)).toContain('second msg')
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
    // empty → alpha → General. Each hop re-scopes the socket; a stale MessagePart
    // indexing an emptied runtime would throw. The boundary card must NEVER
    // appear, and a non-General pane must never show General's messages.
    const hops: Array<string | null> = ['alpha', 'beta', 'empty', null, 'beta', 'empty', 'alpha', null]
    for (const target of hops) {
      await act(async () => {
        controller.setProject(target)
        await tick()
      })
      // No throw / no boundary on any hop; the composer always renders.
      expect(container.textContent).not.toContain('This conversation hit a snag')
      expect(container.textContent).toContain('Send')
      if (target === null) {
        // Returning to General shows its preserved messages instantly (mounted
        // cache), not a refetch flash.
        expect(visibleText(container)).toContain('general two')
      } else {
        // A non-General pane shows its OWN (empty) transcript — General's messages
        // live only in the hidden General surface and never bleed into what the
        // user sees.
        expect(visibleText(container)).toContain('Send a message to begin.')
        expect(visibleText(container)).not.toContain('general two')
      }
    }

    await act(async () => {
      root.unmount()
    })
  })

  it('keeps each conversation surface MOUNTED across a switch (no teardown) so switching back is instant', async () => {
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

    const controller = new NeutronChatController({
      projectId: null,
      projects: [{ id: 'meditation', label: 'Meditation', emoji: '🧘' }],
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
      const vm = useNeutronChatVm(controller)
      return <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
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
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'first msg', ts: 1 })
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a2', seq: 2, body: 'second msg', ts: 2 })
      await tick()
    })
    // The General surface is the sole mounted `.car-conv`. Capture its node.
    const generalNode = container.querySelector('.car-conv')!
    expect(generalNode).not.toBeNull()

    // Switch away: General's surface stays in the DOM (hidden) as the SAME node —
    // it was NOT torn down and rebuilt (that teardown was the visible flicker).
    await act(async () => {
      controller.setProject('meditation')
      await tick()
    })
    const generalHidden = Array.from(container.querySelectorAll('.car-conv')).find((el) =>
      el.hasAttribute('hidden'),
    )
    expect(generalHidden).toBe(generalNode)
    expect(generalNode!.textContent).toContain('second msg')

    // Switch back: still the SAME node, now visible — instant, no remount.
    await act(async () => {
      controller.setProject(null)
      await tick()
    })
    const generalVisible = container.querySelector('.car-conv:not([hidden])')
    expect(generalVisible).toBe(generalNode)
    expect(generalVisible!.textContent).toContain('second msg')

    await act(async () => {
      root.unmount()
    })
  })

  it('Codex P2 — accepts an authoritative EMPTY transcript after the grace window (no permanent stale mask, no crash)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChatVm } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void }> = []
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

    // Fresh per-scope store, so returning to General re-hydrates EMPTY — a stand-in
    // for a transcript that was cleared/expired server-side.
    const controller = new NeutronChatController({
      projectId: null,
      projects: [{ id: 'meditation', label: 'Meditation', emoji: '🧘' }],
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
      const vm = useNeutronChatVm(controller)
      return <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
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
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'first msg', ts: 1 })
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a2', seq: 2, body: 'second msg', ts: 2 })
      await tick()
    })
    await act(async () => {
      controller.setProject('meditation')
      await tick()
    })
    // Back to General: during the grace window it shows the cached messages (no
    // empty flash).
    await act(async () => {
      controller.setProject(null)
      await tick()
    })
    expect(visibleText(container)).toContain('second msg')

    // Wait past the grace window: the still-empty transcript is now accepted as
    // authoritative — the surface remounts onto the empty vm (no in-place shrink),
    // shows the empty state, and nothing throws (boundary absent).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 750))
    })
    expect(visibleText(container)).not.toContain('second msg')
    expect(visibleText(container)).toContain('Send a message to begin.')
    expect(container.textContent).not.toContain('This conversation hit a snag')

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
