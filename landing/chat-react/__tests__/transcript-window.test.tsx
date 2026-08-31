/**
 * THE TRANSCRIPT WINDOW — how many message bubbles a surface is allowed to mount.
 *
 * ── THE MEASUREMENT THIS FILE EXISTS TO PROTECT ─────────────────────────────────
 * The owner ran `document.getElementsByTagName('*').length` on the live web app:
 * 56,096 nodes. In the typing trace `Layout` was 1,584.9 ms / 27.2% self time — the
 * single largest entry — and a switch produced single frames of 2,618 ms and
 * 2,284 ms. The cause was structural, not a re-render count: the active surface
 * mounted EVERY message of the conversation, and a mounted-but-never-re-rendered
 * bubble still pays full price at Layout, Recalculate Style and Hit Test. The fix is
 * fewer mounted nodes; `TRANSCRIPT_WINDOW_MESSAGES` is the whole of it.
 *
 * ── WHY THE ASSERTIONS ARE EXACT EQUALITIES WITH A PRESENCE/ABSENCE PAIR ────────
 * The deliverable is a BOUNDED NODE COUNT, and a bound is exactly the shape of
 * assertion an empty query satisfies for free: `toBeLessThan(2000)` passes on a
 * surface that never mounted, on a selector that was renamed, and on a harness whose
 * `act()` never settled. So every count here is `toBe(N)` — 0 fails — and every
 * "this message is not mounted" claim is paired with the same message asserted
 * PRESENT in the fixture rows and with a neighbour asserted present in the DOM, so
 * an absence can only mean windowing.
 *
 * ── WHAT EACH CASE PINS ─────────────────────────────────────────────────────────
 * it 1: the bound itself (100 of 2,000), the newest message on mount, the control's
 *       label, the load-older extension keeping the previously-first message
 *       mounted, and an arrival on a PINNED window growing the list rather than
 *       sliding it (nothing the reader scrolled back to is dropped).
 * it 2: the switch-away reset (a hidden keep-alive surface is bounded too), the
 *       switch-back with NO ChatErrorBoundary fallback — the shrink happens through
 *       React state, never an in-place array mutation, and this is the guard on that
 *       SEV1-class path — and a trailing-mode arrival sliding the window forward
 *       with the newest message still mounted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { ChatMessage } from '@neutronai/chat-core'
import type { ControllerSession, ControllerSinks } from '../controller.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((q: string) => ({
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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function row(topic: string, i: number): ChatMessage {
  return {
    topic_id: topic,
    message_id: `${topic}-m${i}`,
    client_msg_id: '',
    seq: i + 1,
    // Alternating roles so every message renders its own `.car-row` — the node
    // the count is about.
    role: i % 2 === 0 ? 'agent' : 'user',
    kind: null,
    attachments: null,
    transcript: null,
    body: `${topic} message ${i}`,
    created_at: i + 1,
    status: 'acked',
    delivered_to: null,
    read_by: null,
    reactions: null,
    reactions_rev: null,
    edited_at: null,
    deleted: false,
    edit_rev: null,
  } as ChatMessage
}

/** A session that answers from a fixed row set — a fresh clone per read, exactly as
 *  a real store does, so nothing here passes by accidental identity reuse. */
class FixedSession implements ControllerSession {
  rows: ChatMessage[] = []
  constructor(readonly topicId: string) {}
  start(): void {}
  stop(): void {}
  setActive(): void {}
  status(): 'open' {
    return 'open'
  }
  async send(): Promise<void> {}
  async messages(): Promise<ChatMessage[]> {
    return this.rows.map((m) => ({ ...m }))
  }
  async pendingCount(): Promise<number> {
    return 0
  }
  markRead(ids: readonly string[]): readonly string[] {
    return ids
  }
}

const PROJECTS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
]
const topicFor = (p: string | null): string => (p === null ? 'app:owner' : `app:owner:${p}`)
/** Alpha is the long transcript under test; beta is a cheap somewhere-else. */
const SIZES: Record<string, number> = { [topicFor('alpha')]: 2_000, [topicFor('beta')]: 30 }

/** A FRESH controller per `it` — the live-arrival cases append rows to the fixture,
 *  and a shared controller would make one case's appends another case's baseline. */
async function freshWorld(): Promise<{
  controller: import('../controller.ts').NeutronChatController
  sessions: Map<string, FixedSession>
  /** The controller's own sinks, per topic: `onChange()` on the ACTIVE session is
   *  how a real store announces a new row (controller.ts:1084 → re-read + publish). */
  sinksByTopic: Map<string, ControllerSinks>
}> {
  const { NeutronChatController } = await import('../controller.ts')
  const sessions = new Map<string, FixedSession>()
  const sinksByTopic = new Map<string, ControllerSinks>()
  const controller = new NeutronChatController({
    projectId: null,
    projects: PROJECTS,
    topicForProject: topicFor,
    createSession: (sinks, scope) => {
      const existing = sessions.get(scope.topicId)
      if (existing !== undefined) return existing
      const s = new FixedSession(scope.topicId)
      const n = SIZES[scope.topicId] ?? 0
      s.rows = Array.from({ length: n }, (_, i) => row(scope.topicId, i))
      sessions.set(scope.topicId, s)
      sinksByTopic.set(scope.topicId, sinks)
      return s
    },
  })
  return { controller, sessions, sinksByTopic }
}

const config = {
  wsUrl: 'wss://t/ws/app/chat',
  topicId: topicFor(null),
  userId: 'owner',
  projectId: null,
  projects: PROJECTS,
  origin: 'https://sam.neutron.test',
  deviceId: 'dev-test',
  token: 'dev:owner',
}

async function mountApp(controller: import('../controller.ts').NeutronChatController): Promise<{
  container: HTMLElement
  root: import('react-dom/client').Root
  act: typeof import('react').act
}> {
  const { createRoot } = await import('react-dom/client')
  const React = await import('react')
  const { act } = React
  const { ChatApp } = await import('../ChatApp.tsx')
  const { useNeutronChatVm } = await import('../useNeutronChat.ts')
  const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')

  function Harness(): React.JSX.Element {
    const draft = useAttachmentDraft({ token: config.token })
    const vm = useNeutronChatVm(controller)
    return (
      <ChatApp
        vm={vm}
        controller={controller}
        config={config as never}
        draft={draft}
        onOpenActivity={() => {}}
      />
    )
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  return { container, root, act }
}

describe('a long transcript mounts only a window of itself', () => {
  it('a 2,000-message transcript mounts only the trailing window; load-older extends it; a pinned window grows on arrival', async () => {
    const { TRANSCRIPT_WINDOW_MESSAGES } = await import('../ChatApp.tsx')
    const { controller, sessions, sinksByTopic } = await freshWorld()
    const { container, root, act } = await mountApp(controller)
    const activeConv = (): HTMLElement => {
      const el = container.querySelector('.car-conv:not([hidden])')
      expect(el).not.toBeNull()
      return el as HTMLElement
    }
    const rowsIn = (el: HTMLElement): NodeListOf<Element> => el.querySelectorAll('.car-row')
    try {
      await act(async () => {
        controller.start()
        controller.setProject('alpha')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })

      // ── THE BOUND. Exact, so a surface that never mounted (0 rows) FAILS here
      // rather than satisfying an upper bound for free.
      const conv = activeConv()
      expect(rowsIn(conv).length).toBe(TRANSCRIPT_WINDOW_MESSAGES)

      // ── The newest message is on screen, and the window is the TRAILING one.
      const alphaTopic = topicFor('alpha')
      const text = (): string => activeConv().textContent ?? ''
      expect(text()).toContain('alpha message 1999')
      const rows = rowsIn(activeConv())
      expect(rows[rows.length - 1]!.textContent).toContain('message 1999')
      expect(rows[0]!.textContent).toContain('message 1900')
      // Just-outside control: 1899 is absent from the DOM but PRESENT in the
      // fixture, so the absence is the window and not a short fixture.
      expect(text()).not.toContain('message 1899')
      expect(sessions.get(alphaTopic)!.rows.some((r) => r.body === `${alphaTopic} message 1899`)).toBe(true)

      // ── The explicit control, labelled with what it will reveal.
      const btn = activeConv().querySelector('.car-load-older')
      expect(btn).not.toBeNull()
      expect(btn!.textContent).toContain('1900')

      // Presence/absence pair for the extension: 1800 is NOT mounted now…
      expect(text()).not.toContain('message 1800')
      await act(async () => {
        ;(btn as HTMLElement).click()
        await tick()
        await tick()
      })
      // …and IS after one click, which also doubles the bound exactly.
      expect(rowsIn(activeConv()).length).toBe(2 * TRANSCRIPT_WINDOW_MESSAGES)
      expect(text()).toContain('message 1800')
      // The card's assertion: the previously-visible first message is still in
      // the document — an extension reveals, it never replaces.
      expect(text()).toContain('message 1900')
      expect(activeConv().querySelector('.car-load-older')!.textContent).toContain('1800')

      // ── A live arrival on a PINNED window GROWS the rendered list: the start is
      // held by id, so nothing the reader scrolled back to is pushed out.
      expect(text()).not.toContain('message 2000')
      await act(async () => {
        const s = sessions.get(alphaTopic)!
        s.rows = [...s.rows, row(alphaTopic, 2_000)]
        sinksByTopic.get(alphaTopic)!.onChange()
        await tick()
        await tick()
      })
      expect(text()).toContain('message 2000')
      expect(rowsIn(activeConv()).length).toBe(2 * TRANSCRIPT_WINDOW_MESSAGES + 1)
      expect(text()).toContain('message 1800')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }, 60_000)

  it('a switch resets the window to trailing N, hidden surfaces stay bounded, and the trailing window follows arrivals', async () => {
    const { TRANSCRIPT_WINDOW_MESSAGES } = await import('../ChatApp.tsx')
    const { controller, sessions, sinksByTopic } = await freshWorld()
    const { container, root, act } = await mountApp(controller)
    const activeConv = (): HTMLElement => {
      const el = container.querySelector('.car-conv:not([hidden])')
      expect(el).not.toBeNull()
      return el as HTMLElement
    }
    const rowsIn = (el: HTMLElement): NodeListOf<Element> => el.querySelectorAll('.car-row')
    const alphaTopic = topicFor('alpha')
    try {
      await act(async () => {
        controller.start()
        controller.setProject('alpha')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      // Extend once, and assert the extension actually happened (positive control
      // for the reset below — a reset is only meaningful from a non-default state).
      await act(async () => {
        ;(activeConv().querySelector('.car-load-older') as HTMLElement).click()
        await tick()
        await tick()
      })
      expect(rowsIn(activeConv()).length).toBe(2 * TRANSCRIPT_WINDOW_MESSAGES)

      // ── Switch AWAY: the extended surface shrinks back to trailing N while it is
      // hidden, so the keep-alive DOM stays bounded across every mounted surface.
      await act(async () => {
        controller.setProject('beta')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      const hidden = [...container.querySelectorAll('.car-conv[hidden]')] as HTMLElement[]
      const hiddenRows = hidden.reduce((n, el) => n + rowsIn(el).length, 0)
      expect(hiddenRows).toBe(TRANSCRIPT_WINDOW_MESSAGES)
      // Positive control: those rows are ALPHA's trailing window (General's hidden
      // surface is empty, so a count alone could not say which surface they are).
      expect(hidden.map((el) => el.textContent ?? '').join('')).toContain('alpha message 1999')

      // ── Switch BACK: trailing N, newest mounted, control available again — and
      // no error boundary. The shrink goes through React state → adapter → runtime
      // notify (never an in-place array mutation); this assertion is the guard on
      // that path.
      await act(async () => {
        controller.setProject('alpha')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      expect(rowsIn(activeConv()).length).toBe(TRANSCRIPT_WINDOW_MESSAGES)
      expect(activeConv().textContent ?? '').toContain('message 1999')
      expect(activeConv().querySelector('.car-load-older')).not.toBeNull()
      expect(container.querySelector('.car-error-boundary')).toBeNull()

      // ── A live arrival in TRAILING mode slides the window forward: the count
      // holds and the newest message is mounted.
      expect(activeConv().textContent ?? '').not.toContain('message 2000')
      await act(async () => {
        const s = sessions.get(alphaTopic)!
        s.rows = [...s.rows, row(alphaTopic, 2_000)]
        sinksByTopic.get(alphaTopic)!.onChange()
        await tick()
        await tick()
      })
      expect(activeConv().textContent ?? '').toContain('message 2000')
      expect(rowsIn(activeConv()).length).toBe(TRANSCRIPT_WINDOW_MESSAGES)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }, 60_000)
})
