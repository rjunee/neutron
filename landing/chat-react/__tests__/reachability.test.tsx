/**
 * tests/reachability — CAN THE OWNER STILL DO IT, IN EVERY LAYOUT WE SHIP?
 *
 * Mounts the REAL app shell — `ProjectShell`, the component `main.tsx` renders,
 * with the real controller, the real chat session, the real tab resolver, the
 * real usage client — and, for each layout the product ships, asks every entry in
 * `SHELL_AFFORDANCES` one question: can the owner get at it.
 *
 * WHY THIS IS NOT ANOTHER COMPONENT TEST. The component tests next door mount a
 * PART with hand-written props and assert the part behaves. Every regression that
 * has reached the owner in a green build got through exactly that way: the part
 * was fine, and the product stopped reaching it. This mounts the HOST and asserts
 * reachability, which is the property those tests structurally cannot see.
 *
 * THE LAYOUT MATRIX IS THE POINT. The usage meter shipped absent from the wide
 * sidebar because the wide branch never passed `usage` — and no test had ever
 * rendered a wide layout, so every wide branch in the app was invisible to CI.
 * Here every affordance is probed at EVERY layout, and there is a second, harder
 * assertion on top: PARITY. An affordance reachable at one width and missing at
 * another fails, unless the inventory carries a written reason (`absentIn`). That
 * is what turns "we remembered to test the wide usage meter" into "a capability
 * cannot silently vanish from a layout again".
 *
 * WHAT A FAILURE SAYS. The `broken:` sentence from the inventory, naming what the
 * owner can no longer do. Not the selector, not the assertion.
 *
 * NO NETWORK, NO MODEL, NO CLOCK. The socket is a fake, the fetch is injected,
 * every response is a literal in this file. There is nothing here that can be
 * slow, rate-limited or offline, which is the property that lets this gate be
 * believed when it goes red.
 *
 * VERIFICATION DEPTH (honest): happy-dom, not a real browser. It sees the tree
 * React produced and the attributes on it. It does not see CSS, so an affordance
 * that renders and is then covered, clipped or `display:none`d by a stylesheet
 * still reads as reachable here. That gap is stated in
 * `docs/SYSTEM-OVERVIEW.md` § Reachability gate rather than papered over.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import { LAYOUTS, SHELL_AFFORDANCES, type LayoutName, type ShellAffordance } from './reachability-inventory.ts'

const TOPIC = 'app:owner'
const PROJECT = 'acme'
const ORIGIN = 'https://owner.example.com'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Controllable viewport. `ProjectShell` reads `(min-width: 1024px)` through
 *  `useMediaQuery`; happy-dom's native matcher reports a fixed ~1024px viewport,
 *  so a layout matrix needs a matcher we own. */
let desktop = false

beforeAll(() => {
  GlobalRegistrator.register({
    url: `${ORIGIN}/chat?client=react`,
    settings: { disableIframePageLoading: true },
  })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  window.matchMedia = ((q: string) => ({
    matches: q.includes('min-width: 1024px') ? desktop : false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
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

/** The tab set the resolver answers with — the shipped builtin shape.
 *
 *  `admin` is in here because the owner-facing INTEGRATIONS surface is an admin
 *  tab, and the shell routes it into the header menu rather than the tab band
 *  (`MENU_TARGETS`). Without it the menu holds nothing, `HeaderMenu` renders
 *  null, and every affordance behind it is invisible to this gate. */
const RESOLVED_TABS = [
  { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'chat' } },
  { key: 'work_board', label: 'Work', scope: 'project', source: 'builtin', order: 5, mount: { kind: 'builtin', target: 'workboard' } },
  { key: 'documents', label: 'Documents', scope: 'project', source: 'builtin', order: 10, mount: { kind: 'builtin', target: 'docs' } },
  { key: 'admin', label: 'Admin', scope: 'global', source: 'builtin', order: 20, mount: { kind: 'builtin', target: 'admin' } },
]

/** A MEASURED usage reading. The meter's job is to show a number when the server
 *  has one; handing it a real reading is what makes "the host stopped passing
 *  usage" detectable at all. */
const USAGE_READING = {
  available: true,
  session: 0.42,
  weekly: 0.11,
  measured_at: 1_700_000_000_000,
}

interface Mounted {
  root: HTMLElement
  typeDraft(): Promise<void>
  openAdmin(): Promise<void>
  unmount(): Promise<void>
}

/** Mount the real shell at one layout and let it settle. */
async function mountShell(layout: LayoutName): Promise<Mounted> {
  desktop = LAYOUTS[layout].desktop
  ;(window as unknown as { innerWidth: number }).innerWidth = LAYOUTS[layout].width

  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
  const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
  const { NeutronChatController } = await import('../controller.ts')
  const { useNeutronChat } = await import('../useNeutronChat.ts')
  const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
  const { ProjectShell } = await import('../ProjectShell.tsx')
  const React = await import('react')

  const sockets: Array<{
    open: () => void
    deliver: (o: unknown) => void
    onopen: (() => void) | null
    onmessage: ((ev: { data: unknown }) => void) | null
  }> = []
  const makeSocket = (): never => {
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

  // Everything the shell reads over HTTP, answered from literals. Anything the
  // shell asks for that is not listed 404s, exactly as a real older gateway would.
  const fetchImpl = async (url: string): Promise<Response> => {
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.endsWith(`/api/app/projects/${PROJECT}/tabs`)) {
      return json({ ok: true, scope: 'project', project_id: PROJECT, tabs: RESOLVED_TABS })
    }
    if (url.endsWith('/api/app/usage')) return json(USAGE_READING)
    // The Admin surface's own reads. Answered as a FRESH install would answer —
    // nothing connected — because that is the state the owner is in at the exact
    // moment they need the control this gate is looking for.
    if (url.endsWith('/api/app/github-auth')) return json({ status: 'not_connected' })
    if (url.endsWith('/api/cores/integrations')) return json({ ok: true, oauth: [], api_keys: [] })
    if (url.endsWith('/api/app/codex-auth')) return json({ status: 'not_connected' })
    if (url.endsWith('/api/app/credentials')) return json({ global: [] })
    if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
    return new Response('not found', { status: 404 })
  }

  const controller = new NeutronChatController({
    projectId: PROJECT,
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
    userId: 'owner',
    projectId: PROJECT,
    projects: [
      { id: PROJECT, label: 'Acme' },
      { id: 'beta', label: 'Beta' },
    ],
    origin: ORIGIN,
    deviceId: 'dev-test',
    token: 'dev:owner',
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
  await act(async () => {
    sockets[0]?.open()
    sockets[0]?.deliver({ v: 1, type: 'session_ready', user_id: 'owner', topic_id: TOPIC, ts: 0 })
    await tick()
  })
  // Two ticks: the tab resolver and the usage read are separate round trips.
  await act(async () => {
    await tick()
    await tick()
    await tick()
  })

  return {
    root: container,
    /** Type into the real composer the way a keyboard does, so React sees it. */
    async typeDraft(): Promise<void> {
      const input = container.querySelector('.car-input') as HTMLTextAreaElement | null
      if (input === null) return
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input) as object,
          'value',
        )?.set
        setter?.call(input, 'a message')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
      })
    },
    /**
     * Walk the REAL path to the Admin surface: open the header menu, choose the
     * Admin row. Not a direct render of the tab — the two steps are part of what
     * "the owner can reach it" means, and a menu that stopped listing Admin would
     * make everything on it unreachable while every component still rendered.
     */
    async openAdmin(): Promise<void> {
      const menuBtn = container.querySelector(
        '[data-testid="header-menu-button"]',
      ) as HTMLButtonElement | null
      if (menuBtn === null) return
      await act(async () => {
        menuBtn.click()
        await tick()
      })
      const item = container.querySelector(
        '[data-testid="header-menu-item-admin"]',
      ) as HTMLButtonElement | null
      if (item === null) return
      await act(async () => {
        item.click()
        await tick()
      })
      // The Admin surface reads its state over HTTP before it can render a
      // control; give those round trips a turn to land.
      await act(async () => {
        await tick()
        await tick()
      })
    },
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** Is this affordance expected to be absent at this layout, on purpose? */
function deliberatelyAbsent(a: ShellAffordance, layout: LayoutName): boolean {
  return (a.absentIn ?? []).some((x) => x.layout === layout)
}

/** Run every probe at one layout. Returns id → reachable. */
async function probeLayout(layout: LayoutName): Promise<Record<string, boolean>> {
  const mounted = await mountShell(layout)
  const out: Record<string, boolean> = {}
  try {
    for (const a of SHELL_AFFORDANCES.filter(
      (x) => x.withDraft !== true && x.inAdmin !== true,
    )) {
      out[a.id] = a.reachable(mounted.root)
    }
    await mounted.typeDraft()
    for (const a of SHELL_AFFORDANCES.filter((x) => x.withDraft === true)) {
      out[a.id] = a.reachable(mounted.root)
    }
    // LAST: opening Admin swaps the visible panel, so anything probed after it is
    // probed against a different surface.
    const admin = SHELL_AFFORDANCES.filter((x) => x.inAdmin === true)
    if (admin.length > 0) {
      await mounted.openAdmin()
      for (const a of admin) out[a.id] = a.reachable(mounted.root)
    }
  } finally {
    await mounted.unmount()
  }
  return out
}

// One mount per layout, reused by both the per-layout gate and the parity gate —
// mounting the whole shell is the expensive part and there is no reason to do it
// twice.
const results: Partial<Record<LayoutName, Record<string, boolean>>> = {}

describe('reachability — the app shell, in every layout we ship', () => {
  for (const layout of Object.keys(LAYOUTS) as LayoutName[]) {
    it(`the owner can still do everything at ${layout} (${LAYOUTS[layout].width}px)`, async () => {
      const reached = await probeLayout(layout)
      results[layout] = reached

      const lost = SHELL_AFFORDANCES.filter(
        (a) => !deliberatelyAbsent(a, layout) && reached[a.id] !== true,
      )
      // The failure text is the OWNER's sentence, not the selector's. It is the
      // asserted VALUE rather than a message argument so it lands in the diff of
      // any runner, and so a green run has literally nothing to print.
      const report =
        lost.length === 0
          ? ''
          : [
              `The ${layout} layout (${LAYOUTS[layout].width}px) can no longer do this:`,
              ...lost.map((a) => `  • ${a.broken}`),
            ].join('\n')
      expect(report).toBe('')
    }, 30_000)
  }

  it('no capability quietly disappears between layouts', () => {
    const layouts = Object.keys(LAYOUTS) as LayoutName[]
    for (const l of layouts) {
      if (results[l] === undefined) throw new Error(`layout ${l} never probed`)
    }
    // An affordance the owner has at one width and not another, with no written
    // reason, is the usage-meter failure recurring under a different name.
    const drifted = SHELL_AFFORDANCES.filter((a) => {
      const reachedIn = layouts.filter((l) => results[l]![a.id] === true)
      const missingIn = layouts.filter(
        (l) => results[l]![a.id] !== true && !deliberatelyAbsent(a, l),
      )
      return reachedIn.length > 0 && missingIn.length > 0
    })
    const report =
      drifted.length === 0
        ? ''
        : [
            'These work at some window sizes and not others, with no reason recorded in the inventory:',
            ...drifted.map(
              (a) =>
                `  • ${a.broken}\n    reachable at: ${layouts
                  .filter((l) => results[l]![a.id] === true)
                  .join(', ')} — missing at: ${layouts
                  .filter((l) => results[l]![a.id] !== true && !deliberatelyAbsent(a, l))
                  .join(', ')}`,
            ),
          ].join('\n')
    expect(report).toBe('')
  })
})
