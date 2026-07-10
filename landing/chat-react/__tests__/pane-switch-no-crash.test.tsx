/**
 * #354 BLANK-SCREEN CRASH — pane-mounted project-switch coverage gap.
 *
 * The existing `chat-rail-stability` suite exercises project switches but NEVER
 * mounts the desktop Work slide-out (`showPane`), yet the #354 report's crash was
 * seen in Tabs WITH the Work pane visible. This test switches projects rapidly
 * with the pane mounted + interleaved unrelated re-renders and a streaming state,
 * asserting no infinite-loop ("Maximum update depth exceeded"), no
 * `ChatErrorBoundary` fallback, and the composer surviving every hop.
 *
 * NOTE: jsdom + `act()` runs React synchronously and cannot reproduce the
 * concurrent-mode notify-storm crash itself (that needs a real browser — see the
 * task's browser-verification gate). This guards the general no-boundary /
 * no-max-depth invariant with the pane in the tree; the ADAPTER-identity guard in
 * `snapshot-stability.test.tsx` is the discriminating regression test for the fix.
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

describe('#354 guard — Work pane mounted + rapid project switch never crashes', () => {
  it('no infinite loop / no error boundary under switch + pane + unrelated re-renders', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act, useState } = await import('react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChatVm } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const origErr = console.error
    const errs: string[] = []
    console.error = (...args: unknown[]) => {
      errs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    }

    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void }> = []
    const makeSocket = () => {
      const s = {
        onopen: null as null | (() => void),
        onmessage: null as null | ((ev: { data: unknown }) => void),
        onclose: null,
        onerror: null,
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

    let bump: (n: number) => void = () => {}
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const vm = useNeutronChatVm(controller)
      const [, setN] = useState(0)
      bump = setN
      return (
        <ChatApp
          vm={vm}
          controller={controller}
          config={config}
          draft={draft}
          paneEligible
        />
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
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'first', ts: 1 })
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a2', seq: 2, body: 'second', ts: 2 })
      await tick()
    })

    // Many unrelated re-renders while messages/isRunning are unchanged — the exact
    // shape a fresh-literal adapter would turn into a setAdapter→notify storm.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        bump(i + 1)
        await tick()
      })
    }

    const hops: Array<string | null> = ['alpha', 'beta', null, 'beta', 'alpha', null, 'alpha']
    for (const target of hops) {
      await act(async () => {
        controller.setProject(target)
        await tick()
      })
      await act(async () => {
        bump(Math.floor(Math.random() * 1e6))
        await tick()
      })
      // No crash on any hop: boundary absent, composer present.
      expect(container.textContent ?? '').not.toContain('This conversation hit a snag')
      expect(container.textContent ?? '').toContain('Send')
    }

    await act(async () => {
      root.unmount()
    })
    console.error = origErr

    const maxDepth = errs.filter((e) => e.includes('Maximum update depth')).length
    expect(maxDepth).toBe(0)
  })
})
