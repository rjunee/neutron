/**
 * RE-ACTIVATION SCROLL RESTORE — where a kept-alive surface lands when you switch
 * back into it.
 *
 * ── THE BUG THIS FILE EXISTS TO PIN ─────────────────────────────────────────────
 * An inactive surface is `.car-conv[hidden]`, and `chat-react.html` gives that
 * `display: none`. A display:none element has no layout box, so the viewport's
 * `scrollTop` is NOT preserved — it comes back 0 on re-show. Nothing in ChatApp
 * restored it, and assistant-ui's `useThreadViewportAutoScroll` is `isAtBottom`-
 * gated, so at scrollTop 0 it deliberately declines to act. The owner saw the
 * consequence directly (2026-09-01): switching into a project landed at the TOP of
 * the mounted transcript window, staring at "Load older messages (2,373 more)".
 *
 * ── HAPPY-DOM FACTS THESE TESTS ENCODE (empirically verified on this repo) ──────
 * happy-dom has no layout engine, so three things a browser does for free must be
 * done by hand here, and each is load-bearing rather than ceremony:
 *   1. Setting `scrollTop` does NOT dispatch a `scroll` event → after assigning it
 *      the test dispatches `new Event('scroll')` so the capture listener sees it.
 *   2. `scrollTop` is stored UNCLAMPED and `scrollHeight`/`clientHeight` are always
 *      0 → the geometry is supplied with instance `Object.defineProperty` getters
 *      (scrollHeight 1000, clientHeight 100).
 *   3. The `hidden` attribute does NOT zero `scrollTop` in happy-dom, while a real
 *      browser's `display: none` DOES → after each switch-away the test assigns
 *      `scrollTop = 0` itself, modelling the browser tearing down the scroll box.
 *      WITHOUT that line the must-fail control passes VACUOUSLY against the
 *      unfixed code (the stale 900 simply survives), which is precisely the
 *      false-green this card was written to forbid.
 *
 * ── WHAT EACH CASE PINS ─────────────────────────────────────────────────────────
 * it 1 (MUST-FAIL CONTROL): switching back lands at the BOTTOM. Red against the
 *      pre-change tree with `scrollTop` 0.
 * it 2 (must-pass sibling): a surface the user had DELIBERATELY scrolled back in
 *      returns to that exact position, not to the bottom — asserted both as an
 *      equality and as an explicit "this is not the bottom path" bound.
 * it 3: the same switch made from ANOTHER TAB. `ProjectShell` resets the tab to Chat
 *      in a PASSIVE effect, so the restore's layout effect runs while
 *      `.car-tabpanel[hidden]` still makes the viewport `display: none` — no layout
 *      box, `scrollHeight` 0, a `scrollTop` write discarded. The restore must WAIT
 *      for the reveal instead of spending itself on a box that does not exist.
 * it 4: the mounted slice was RE-TRIMMED while the user was away. They had loaded
 *      older (window pinned at message 100, 200 rows) and switching away resets
 *      `olderAnchorId`, so they come back to the trailing 100 and their offset is
 *      into a slice that no longer exists. The card's rule for that is the BOTTOM,
 *      not an arbitrary offset. Note what the oracle CANNOT be: a rendered-count
 *      comparison sees 200 on the way out and 200 again on the activating commit
 *      (the runtime applies the trimmed list one commit later), so it declares the
 *      position valid — which is why the check is the mounted slice's HEAD MESSAGE,
 *      re-checked when the runtime catches up.
 *
 * The harness wraps `ChatApp` in a `.car-tabpanel` exactly as `ProjectShell` does, so
 * the `[hidden]` ancestor it 3 is about is the real one and not a test fiction.
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
    // Alternating roles so every message renders its own `.car-row`.
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
/** Alpha is long enough to be windowed (300 > 100); beta is a cheap somewhere-else. */
const SIZES: Record<string, number> = { [topicFor('alpha')]: 300, [topicFor('beta')]: 30 }

/** A FRESH controller per `it` — a shared one would make one case's state another's
 *  baseline. */
async function freshWorld(): Promise<{
  controller: import('../controller.ts').NeutronChatController
  sessions: Map<string, FixedSession>
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
    // The `.car-tabpanel` wrapper is not decoration: it is the element ProjectShell
    // toggles `hidden` on (ProjectShell.tsx renders exactly this around ChatApp), and
    // `chat-react.html` gives `.car-tabpanel[hidden]` `display: none`. `hidden` is
    // never passed as a JSX prop here, so a test may set the attribute by hand and
    // React will not reconcile it away.
    root.render(
      <div className="car-tabpanel" role="tabpanel">
        <Harness />
      </div>,
    )
  })
  return { container, root, act }
}

/** The `.car-tabpanel` ProjectShell hides when Chat is not the visible tab. */
function tabPanel(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.car-tabpanel')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

/** Alpha's surface, found by its CONTENT rather than by DOM order — the surface is
 *  kept alive and hidden across the switch, so `:not([hidden])` cannot name it while
 *  the user is on beta, and index-based lookup would silently follow a reordering. */
function alphaSurface(container: HTMLElement): HTMLElement {
  const el = [...container.querySelectorAll('.car-conv')].find((c) =>
    (c.textContent ?? '').includes('alpha message 299'),
  )
  expect(el).toBeDefined()
  return el as HTMLElement
}

function viewportOf(surface: HTMLElement): HTMLElement {
  const vp = surface.querySelector('.car-viewport')
  expect(vp).not.toBeNull()
  return vp as HTMLElement
}

/** happy-dom reports 0 for every layout-derived box. Supply the geometry the
 *  restore reasons about: a 1000px-tall scroll content in a 100px-tall window, so
 *  "the bottom" is scrollTop 900.
 *
 *  A `[hidden]` ancestor reports ZERO, because that is what a browser does: `display:
 *  none` leaves the element with no layout box at all, so `scrollHeight` is 0 and a
 *  `scrollTop` written there is discarded. happy-dom models none of that, and without
 *  it modelled here it 3 would pass vacuously against the unfixed code — the stub
 *  would hand a hidden viewport a 1000px scroll height it does not have. */
function stubGeometry(viewport: HTMLElement): void {
  const laidOut = (): boolean => viewport.closest('[hidden]') === null
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => (laidOut() ? 1000 : 0),
  })
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => (laidOut() ? 100 : 0),
  })
}

describe('switching back into a kept-alive conversation restores its scroll position', () => {
  it('switching back lands at the bottom', async () => {
    const { controller } = await freshWorld()
    const { container, root, act } = await mountApp(controller)
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

      // ── Positive controls: the surface under test really is alpha's, really is
      // the visible one, and really mounted its windowed transcript. Without these
      // an assertion about `scrollTop` could pass against an empty surface.
      const surface = alphaSurface(container)
      expect(surface.hasAttribute('hidden')).toBe(false)
      expect(surface.textContent ?? '').toContain('alpha message 299')
      expect(surface.querySelectorAll('.car-row').length).toBe(100)

      const viewport = viewportOf(surface)
      stubGeometry(viewport)

      // ── The user is sitting at the bottom, following the tail: 900 + 100 >= 1000
      // − epsilon. Setting scrollTop does not fire `scroll` in happy-dom, so the
      // capture listener is fed explicitly.
      await act(async () => {
        viewport.scrollTop = 900
        viewport.dispatchEvent(new Event('scroll'))
      })

      // ── Away…
      await act(async () => {
        controller.setProject('beta')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      // …and the browser's `display: none` tears the scroll box down. happy-dom
      // does not model that, so the test does it — see the header note; without
      // this line the case would pass vacuously on the stale 900.
      viewport.scrollTop = 0

      // ── …and back.
      await act(async () => {
        controller.setProject('alpha')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })

      expect(alphaSurface(container).hasAttribute('hidden')).toBe(false)
      // The restore assigns `scrollHeight` (1000) and a real browser clamps to 900;
      // `>= 900` is true of either, and false of the 0 the unfixed code leaves.
      expect(viewport.scrollTop).toBeGreaterThanOrEqual(900)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }, 60_000)

  it('a deliberately scrolled-back surface returns to where the user was', async () => {
    const { controller } = await freshWorld()
    const { container, root, act } = await mountApp(controller)
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

      const surface = alphaSurface(container)
      expect(surface.hasAttribute('hidden')).toBe(false)
      expect(surface.querySelectorAll('.car-row').length).toBe(100)

      const viewport = viewportOf(surface)
      stubGeometry(viewport)

      // ── The user has deliberately scrolled back into history: 300 + 100 is far
      // short of 1000, so this capture is NOT at the bottom.
      await act(async () => {
        viewport.scrollTop = 300
        viewport.dispatchEvent(new Event('scroll'))
      })

      await act(async () => {
        controller.setProject('beta')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      viewport.scrollTop = 0 // models the browser's display:none box teardown

      await act(async () => {
        controller.setProject('alpha')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })

      // The mounted content is unchanged (the captured count still equals the
      // runtime's), so the exact position comes back.
      expect(viewport.scrollTop).toBe(300)
      // …and explicitly NOT the bottom, so this case can never be satisfied by the
      // bottom path that it 1 pins.
      expect(viewport.scrollTop).toBeLessThan(900)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }, 60_000)

  it('a switch made from another tab waits for the Chat panel to be revealed', async () => {
    const { controller } = await freshWorld()
    const { container, root, act } = await mountApp(controller)
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

      const surface = alphaSurface(container)
      expect(surface.hasAttribute('hidden')).toBe(false)
      expect(surface.querySelectorAll('.car-row').length).toBe(100)
      const viewport = viewportOf(surface)
      stubGeometry(viewport)
      const panel = tabPanel(container)

      // Following the tail, as in it 1.
      await act(async () => {
        viewport.scrollTop = 900
        viewport.dispatchEvent(new Event('scroll'))
      })

      await act(async () => {
        controller.setProject('beta')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      viewport.scrollTop = 0 // models the browser's display:none box teardown

      // The user is on some OTHER tab (Documents, Plan, …) when the switch happens,
      // so ProjectShell has the Chat panel hidden. It resets the tab back to Chat in
      // a PASSIVE effect — i.e. strictly AFTER the activating commit's layout
      // effects, which is where the restore lives.
      panel.setAttribute('hidden', '')
      expect(viewport.scrollHeight).toBe(0) // no layout box, exactly as in a browser

      await act(async () => {
        controller.setProject('alpha')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })

      // Nothing could have been applied yet — and nothing may have been SPENT either.
      expect(alphaSurface(container).hasAttribute('hidden')).toBe(false)
      expect(viewport.scrollTop).toBe(0)

      // ProjectShell's passive effect lands: Chat becomes the visible tab. The
      // restore re-checks at frame cadence (RESTORE_REVEAL_POLL_MS), so give it a
      // few frames' worth of real time rather than a bare microtask turn.
      await act(async () => {
        panel.removeAttribute('hidden')
        await new Promise((r) => setTimeout(r, 80))
      })

      expect(viewport.scrollHeight).toBe(1000) // the box is back
      expect(viewport.scrollTop).toBeGreaterThanOrEqual(900)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }, 60_000)

  it('a position whose window has been re-trimmed falls back to the bottom', async () => {
    const { controller } = await freshWorld()
    const { container, root, act } = await mountApp(controller)
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

      const surface = alphaSurface(container)
      expect(surface.querySelectorAll('.car-row').length).toBe(100)
      const viewport = viewportOf(surface)
      stubGeometry(viewport)

      // The user loads older, so the window is PINNED by id at message 100 and grows
      // to 200 rows. Switching away resets `olderAnchorId` (ChatApp trims a hidden
      // surface back to the trailing window), so the slice they were reading is not
      // the slice they come back to — the card's own case: "the message they were
      // reading may no longer be mounted, so an ID-anchored restore must fall back to
      // bottom rather than to an arbitrary offset".
      const loadOlder = surface.querySelector('.car-load-older')
      expect(loadOlder).not.toBeNull()
      await act(async () => {
        ;(loadOlder as HTMLButtonElement).click()
        await tick()
      })
      expect(surface.querySelectorAll('.car-row').length).toBe(200)
      expect(surface.textContent ?? '').toContain('alpha message 100')

      // Deliberately scrolled back inside that larger window.
      await act(async () => {
        viewport.scrollTop = 300
        viewport.dispatchEvent(new Event('scroll'))
      })

      await act(async () => {
        controller.setProject('beta')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      viewport.scrollTop = 0 // models the browser's display:none box teardown

      await act(async () => {
        controller.setProject('alpha')
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
      })

      // ── Positive controls: the window really WAS re-trimmed to the trailing 100,
      // so the message the offset was measured against is no longer mounted.
      const after = alphaSurface(container)
      expect(after.querySelectorAll('.car-row').length).toBe(100)
      expect(after.textContent ?? '').toContain('alpha message 299')
      expect(after.textContent ?? '').not.toContain('alpha message 100')

      // 300 is a live offset into a slice that no longer exists, so it is abandoned
      // for the floor rather than restored over messages the reader never chose.
      expect(viewport.scrollTop).not.toBe(300)
      expect(viewport.scrollTop).toBeGreaterThanOrEqual(900)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }, 60_000)
})
