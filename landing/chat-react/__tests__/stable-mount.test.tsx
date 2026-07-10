/**
 * W7 — STABLE-MOUNT DOM-IDENTITY acceptance.
 *
 * The core W7 guarantee: switching projects back-and-forth must NOT tear down and
 * rebuild the chat surface (the "everything flickers and rebuilds" complaint,
 * jank report #1/#343). The chat-react client keeps EACH visited conversation as
 * its own persistent, individually-mounted surface (`MountedConversation`) — only
 * the active one is shown (`hidden` toggles), so a switch swaps VISIBILITY, never
 * the component instances. This test proves that structurally, at the DOM level:
 * it captures the actual DOM nodes for a project's thread + composer + Work pane,
 * switches away to another project and back, and asserts the SAME nodes persist
 * (identity `===`, not a rebuilt equivalent) with a JS expando surviving the
 * round-trip — the strongest available proof that no remount happened.
 *
 * It also locks the W7 pane fix (#355): the Work pane used to be gated on the
 * ACTIVE surface (`active && showPane`), so it UNMOUNTED on every switch-away and
 * re-mounted (re-sliding) on return. Now each surface owns a PERSISTENT pane —
 * this test's pane-identity assertion fails against the old `active &&` gate and
 * passes against the fix.
 *
 * Finally it guards the #354 blank-screen regression from the DOM side: zero
 * `ChatErrorBoundary` fallback and zero React "Maximum update depth" /
 * "unmount a fiber that is already unmounted" console errors across the switches.
 * (jsdom/happy-dom + act() runs React synchronously and can't reproduce the
 * concurrent-mode notify-storm itself — `snapshot-stability.test.tsx` pins the
 * discriminating adapter-identity invariant for that; this is the lifecycle /
 * no-boundary complement.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((q: string) => ({
      // Desktop: match the ≥1024px query so any internal media checks read wide.
      matches: /min-width:\s*1024px/.test(q),
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

/** The single currently-VISIBLE conversation surface (the others are `hidden`). */
function activeConv(container: HTMLElement): HTMLElement {
  const convs = Array.from(container.querySelectorAll('.car-conv')) as HTMLElement[]
  const shown = convs.find((el) => !el.hidden)
  if (shown === undefined) throw new Error('no active .car-conv')
  return shown
}

describe('W7 stable-mount — thread/composer/pane DOM instances survive a project switch', () => {
  it('switch away and back reuses the SAME thread + composer + pane DOM nodes (no remount)', async () => {
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
    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void }> = []
    const projects = [
      { id: 'alpha', label: 'Alpha', emoji: '🅰️' },
      { id: 'beta', label: 'Beta', emoji: '🅱️' },
    ]
    const controller = new NeutronChatController({
      projectId: 'alpha',
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
      projectId: 'alpha',
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
      // paneEligible = desktop viewport: every surface mounts its own persistent pane.
      return <ChatApp vm={vm} controller={controller} config={config} draft={draft} paneEligible />
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
      sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'hello from alpha', ts: 1 })
      await tick()
    })

    // On Alpha: capture its live DOM instances and brand them with a JS expando.
    const convA = activeConv(container)
    const threadA = convA.querySelector('.car-thread') as HTMLElement
    const composerA = convA.querySelector('.car-composer') as HTMLElement
    const paneA = convA.querySelector('.car-plans') as HTMLElement
    expect(threadA).not.toBeNull()
    expect(composerA).not.toBeNull()
    expect(paneA).not.toBeNull()
    const brand = (el: HTMLElement) => {
      ;(el as unknown as Record<string, unknown>)['__w7probe'] = 'alpha-surface'
    }
    brand(threadA)
    brand(composerA)
    brand(paneA)

    // Switch to Beta. Alpha's surface stays MOUNTED (just hidden) — its nodes stay
    // connected — and Beta gets its OWN distinct nodes.
    await act(async () => {
      controller.setProject('beta')
      await tick()
    })
    expect(threadA.isConnected).toBe(true)
    expect(composerA.isConnected).toBe(true)
    expect(paneA.isConnected).toBe(true)
    const convB = activeConv(container)
    expect(convB).not.toBe(convA)
    expect(convB.querySelector('.car-composer')).not.toBe(composerA)
    // Some unrelated re-renders while off Alpha (the shape that would provoke a
    // stale remount if the surface weren't truly persistent).
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        bump(i + 1)
        await tick()
      })
    }

    // Switch back to Alpha. Its surface must be the SAME instances — reused, not
    // rebuilt. Identity `===` AND the expando prove it's the same physical node.
    await act(async () => {
      controller.setProject('alpha')
      await tick()
    })
    const convA2 = activeConv(container)
    const threadA2 = convA2.querySelector('.car-thread') as HTMLElement
    const composerA2 = convA2.querySelector('.car-composer') as HTMLElement
    const paneA2 = convA2.querySelector('.car-plans') as HTMLElement

    expect(convA2).toBe(convA)
    expect(threadA2).toBe(threadA)
    expect(composerA2).toBe(composerA)
    // The #355 discriminator: the pane is the SAME node — it was never unmounted
    // on the switch-away (so it never re-slid on return).
    expect(paneA2).toBe(paneA)
    expect((threadA2 as unknown as Record<string, unknown>)['__w7probe']).toBe('alpha-surface')
    expect((composerA2 as unknown as Record<string, unknown>)['__w7probe']).toBe('alpha-surface')
    expect((paneA2 as unknown as Record<string, unknown>)['__w7probe']).toBe('alpha-surface')
    // Alpha's transcript is intact (the surface kept its state, not a cold reload).
    expect(convA2.textContent ?? '').toContain('hello from alpha')

    await act(async () => {
      root.unmount()
    })
    console.error = origErr

    // #354 regression guard from the DOM side: no error boundary, no loop.
    expect(container.textContent ?? '').not.toContain('This conversation hit a snag')
    expect(errs.filter((e) => e.includes('Maximum update depth')).length).toBe(0)
    expect(errs.filter((e) => e.includes('already unmounted')).length).toBe(0)
  })
})
