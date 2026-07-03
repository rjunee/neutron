/**
 * Component test for the web APP SHELL (rail/tab rework 2026-06-30). Renders
 * `ProjectShell` in happy-dom over a real chat-core `WebChatSession` (fake
 * socket) with an injected `fetchImpl` serving the tab resolver. Asserts:
 *   - PROJECT view: the bar renders the engine-resolved set (Chat + Work +
 *     Documents + a Core tab), NO Tasks (removed) and NO Admin (global);
 *   - the persistent project rail renders alongside the tab content;
 *   - the Chat tab shows `ChatApp` and is active by default;
 *   - switching to a builtin tab reveals its real view; switching to a Core tab
 *     renders a sandboxed iframe at the resolved URL;
 *   - GENERAL view: the bar shows Chat + Admin (the global tabs), NOT chat-only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Controllable media matcher. happy-dom's native matchMedia reports a ~1024px
// viewport (so `(min-width:1024px)` would spuriously match and drop the desktop
// Work tab). We install a deterministic stub instead: default = NON-desktop
// (`(min-width:1024px)` → false), so the legacy tab-bar tests keep Work as a tab
// (its ≥1024 slide-out is exercised by the dedicated desktop test below).
let mediaMatches: (query: string) => boolean = () => false

beforeAll(() => {
  // `disableIframePageLoading` stops happy-dom from making a real network fetch
  // for the Core-tab `<iframe src>` we assert on — we only check the attribute.
  GlobalRegistrator.register({
    url: 'https://sam.neutron.test/chat?client=react',
    settings: { disableIframePageLoading: true },
  })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  // Install the controllable stub UNCONDITIONALLY (overriding happy-dom's native
  // matchMedia) so `useMediaQuery` reads our `mediaMatches` matcher.
  window.matchMedia = ((q: string) => ({
    matches: mediaMatches(q),
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
beforeEach(() => {
  // Reset to NON-desktop between tests; the desktop test opts in explicitly.
  mediaMatches = () => false
})

const TOPIC = 'app:sam'
const PROJECT = 'acme'
const tick = () => new Promise((r) => setTimeout(r, 0))
const ready = () => ({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })

const RESOLVED_TABS = [
  { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'chat' } },
  { key: 'work_board', label: 'Work', scope: 'project', source: 'builtin', order: 5, mount: { kind: 'builtin', target: 'workboard' } },
  { key: 'documents', label: 'Documents', scope: 'project', source: 'builtin', order: 10, mount: { kind: 'builtin', target: 'docs' } },
  {
    key: 'core:analytics',
    label: 'Analytics',
    scope: 'project',
    source: 'core',
    core_slug: 'analytics',
    order: 100,
    mount: { kind: 'webview', target: 'https://core.example/analytics/acme' },
  },
]

const GLOBAL_TABS = [
  { key: 'admin', label: 'Admin', scope: 'global', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'admin' } },
]

describe('ProjectShell render (happy-dom)', () => {
  it('renders the resolved tab set, shows ChatApp on Chat, and switches tabs', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send: (d: string) => void; close: () => void }> = []
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

    // Injected fetch serving ONLY the tab resolver; everything else 404s.
    const fetchCalls: string[] = []
    const fetchImpl = async (url: string): Promise<Response> => {
      fetchCalls.push(url)
      if (url.endsWith(`/api/app/projects/${PROJECT}/tabs`)) {
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: PROJECT, tabs: RESOLVED_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
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
      userId: 'sam',
      projectId: PROJECT,
      projects: [{ id: PROJECT, label: 'Acme' }],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
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
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })
    // Let the tab-resolver fetch settle.
    await act(async () => {
      await tick()
      await tick()
    })

    // The resolver was hit for the active project's tabs.
    expect(fetchCalls.some((u) => u.endsWith(`/api/app/projects/${PROJECT}/tabs`))).toBe(true)

    // The bar renders the engine-resolved set, not a hardcoded list — Work (not
    // "Work Board"), no Tasks (removed), no Admin (global, not folded in).
    const tabButtons = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent ?? '')
    expect(tabButtons()).toEqual(['Chat', 'Work', 'Documents', 'Analytics'])

    // The persistent project rail renders alongside the tab content.
    expect(container.querySelector('.car-rail')).not.toBeNull()

    // Chat is active by default → ChatApp is rendered (composer Send button).
    expect(container.textContent).toContain('Send')
    const chatPanel = container.querySelector('.car-tabpanel') as HTMLElement
    expect(chatPanel.hasAttribute('hidden')).toBe(false)

    // Switch to Documents → the real Documents view mounts (PR-5), Chat panel
    // hidden (but mounted). The injected fetch only serves /tabs, so the docs
    // tree 404s and the viewer shows its empty prompt — proving the Documents
    // tab now renders DocumentsTab instead of the PR-4 placeholder.
    const docsBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find(
      (b) => b.textContent === 'Documents',
    ) as HTMLButtonElement
    await act(async () => {
      docsBtn.click()
      await tick()
    })
    expect(container.querySelector('.cdoc')).not.toBeNull()
    expect(container.textContent).toContain('Select a document to read.')
    expect((container.querySelector('.car-tabpanel') as HTMLElement).hasAttribute('hidden')).toBe(true)

    // Switch to the Core tab → a sandboxed iframe at the resolved URL.
    const coreBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find(
      (b) => b.textContent === 'Analytics',
    ) as HTMLButtonElement
    await act(async () => {
      coreBtn.click()
      await tick()
    })
    const frame = container.querySelector('iframe.car-tab-frame') as HTMLIFrameElement
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('src')).toBe('https://core.example/analytics/acme')

    await act(async () => {
      root.unmount()
    })
  })

  it('keeps the tab bar mounted but DISABLES stale non-Chat tabs while a scope switch resolves', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChatVm } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send: (d: string) => void; close: () => void }> = []
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

    const BETA = 'beta'
    const BETA_TABS = [
      { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'chat' } },
      { key: 'work_board', label: 'Work', scope: 'project', source: 'builtin', order: 5, mount: { kind: 'builtin', target: 'workboard' } },
    ]
    // GATE the beta resolver: it stays pending until we release it, so we can
    // observe the in-flight (resolving) window deterministically.
    let releaseBeta: () => void = () => {}
    const betaPending = new Promise<void>((res) => {
      releaseBeta = res
    })
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith(`/api/app/projects/${PROJECT}/tabs`)) {
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: PROJECT, tabs: RESOLVED_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith(`/api/app/projects/${BETA}/tabs`)) {
        await betaPending
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: BETA, tabs: BETA_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const controller = new NeutronChatController({
      projectId: PROJECT,
      projects: [{ id: PROJECT, label: 'Acme' }, { id: BETA, label: 'Beta' }],
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
      projectId: PROJECT,
      projects: [{ id: PROJECT, label: 'Acme' }, { id: BETA, label: 'Beta' }],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }

    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const vm = useNeutronChatVm(controller)
      return <ProjectShell vm={vm} controller={controller} config={config} draft={draft} fetchImpl={fetchImpl} />
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
      await tick()
    })
    const tabBtns = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[]
    const labels = () => tabBtns().map((b) => b.textContent ?? '')
    // Acme's full set resolved, all enabled.
    expect(labels()).toEqual(['Chat', 'Work', 'Documents', 'Analytics'])
    expect(tabBtns().every((b) => !b.disabled)).toBe(true)

    // Switch to beta; its resolver is gated → we're now IN-FLIGHT.
    await act(async () => {
      controller.setProject(BETA)
      await tick()
    })
    // Reconcile-in-place: the bar is NOT collapsed to Chat-only — acme's
    // descriptors stay mounted (no flicker) — BUT every non-Chat tab is now
    // DISABLED so a stale button can't mount a wrong-scope panel mid-switch.
    expect(labels()).toEqual(['Chat', 'Work', 'Documents', 'Analytics'])
    const byLabel = (l: string) => tabBtns().find((b) => b.textContent === l)!
    expect(byLabel('Chat').disabled).toBe(false)
    expect(byLabel('Work').disabled).toBe(true)
    expect(byLabel('Documents').disabled).toBe(true)
    expect(byLabel('Analytics').disabled).toBe(true)
    // Clicking a disabled stale tab is a no-op: Chat stays the visible panel.
    await act(async () => {
      byLabel('Analytics').click()
      await tick()
    })
    expect((container.querySelector('.car-tabpanel') as HTMLElement).hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('iframe.car-tab-frame')).toBeNull()

    // Release the resolver → beta's set swaps in, all enabled again.
    await act(async () => {
      releaseBeta()
      await tick()
      await tick()
    })
    expect(labels()).toEqual(['Chat', 'Work'])
    expect(tabBtns().every((b) => !b.disabled)).toBe(true)

    await act(async () => {
      root.unmount()
    })
  })

  it('shows Chat + Admin (global tabs) for the General / no-project view', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send: (d: string) => void; close: () => void }> = []
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

    // General ⇒ the shell resolves the GLOBAL tabs (Admin), never the
    // per-project resolver.
    let projectResolverHits = 0
    const fetchImpl = async (url: string): Promise<Response> => {
      if (/\/api\/app\/projects\/[^/]+\/tabs$/.test(url)) projectResolverHits++
      if (url.endsWith('/api/app/tabs')) {
        return new Response(
          JSON.stringify({ ok: true, scope: 'global', tabs: GLOBAL_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const controller = new NeutronChatController({
      projectId: null,
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
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
      await tick()
    })

    // General shows the global tab set (Chat + Admin) in the SAME content pane;
    // the per-project resolver is never hit, and the persistent rail renders.
    const tabButtons = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent ?? '')
    expect(tabButtons()).toEqual(['Chat', 'Admin'])
    expect(projectResolverHits).toBe(0)
    expect(container.querySelector('.car-rail')).not.toBeNull()
    expect(container.textContent).toContain('Send')

    // Admin tab switches to the integrations surface (Chat panel hidden).
    const adminBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find(
      (b) => b.textContent === 'Admin',
    ) as HTMLButtonElement
    await act(async () => {
      adminBtn.click()
      await tick()
    })
    expect((container.querySelector('.car-tabpanel') as HTMLElement).hasAttribute('hidden')).toBe(true)

    await act(async () => {
      root.unmount()
    })
  })
})

describe('WorkspaceSeat — seated tabs identity anchor (M1 UX redesign)', () => {
  const mount = async (
    projectId: string | null,
    projects: import('../config.ts').ProjectTab[],
  ): Promise<{ container: HTMLElement; cleanup: () => Promise<void> }> => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const makeSocket = () =>
      ({ onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => {} }) as never
    const controller = new NeutronChatController({
      projectId,
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
      projectId,
      projects,
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
    }
    // Serve an empty tab set so the shell settles to the guaranteed Chat tab.
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: true, tabs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
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
      await tick()
      await tick()
    })
    return {
      container,
      cleanup: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  it('General scope seats 💬 General', async () => {
    const { container, cleanup } = await mount(null, [])
    const seat = container.querySelector('.car-wsseat') as HTMLElement
    expect(seat).not.toBeNull()
    expect(seat.querySelector('.car-wsseat-emoji')!.textContent).toBe('💬')
    expect(seat.querySelector('.car-wsseat-name')!.textContent).toBe('General')
    await cleanup()
  })

  it('project scope seats the active project emoji + name', async () => {
    const { container, cleanup } = await mount('acme', [{ id: 'acme', label: 'Acme', emoji: '🧪' }])
    const seat = container.querySelector('.car-wsseat') as HTMLElement
    expect(seat.querySelector('.car-wsseat-emoji')!.textContent).toBe('🧪')
    expect(seat.querySelector('.car-wsseat-name')!.textContent).toBe('Acme')
    await cleanup()
  })
})

describe('ProjectShell desktop Work slide-out (≥1024px)', () => {
  it('drops the Work TAB and mounts the edge-handle pane instead', async () => {
    // Opt into the desktop viewport for THIS test only.
    mediaMatches = (q) => q.includes('min-width: 1024px')

    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send: (d: string) => void; close: () => void }> = []
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

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith(`/api/app/projects/${PROJECT}/tabs`)) {
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: PROJECT, tabs: RESOLVED_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // The pane's WorkBoardTab list 404s — chrome is independent of board data.
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
      userId: 'sam',
      projectId: PROJECT,
      projects: [{ id: PROJECT, label: 'Acme' }],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
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
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })
    await act(async () => {
      await tick()
      await tick()
    })

    // The tab bar shows Chat + Documents + Analytics — NO Work tab (it became the
    // slide-out pane on desktop).
    const tabButtons = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent ?? '')
    expect(tabButtons()).toEqual(['Chat', 'Documents', 'Analytics'])

    // The pane + its edge-handle are mounted; the handle is the only open control.
    const handle = container.querySelector('.car-plans-handle') as HTMLButtonElement
    expect(handle).not.toBeNull()
    expect(handle.getAttribute('aria-label')).toBe('Show work')
    expect(container.querySelector('.car-plans')).not.toBeNull()
    // Closed by default → the shell grid isn't expanded.
    expect((container.querySelector('.car-stage') as HTMLElement).className).not.toContain(
      'car-stage-pane-open',
    )

    // Clicking the handle opens the pane → the chat stage grid expands.
    await act(async () => {
      handle.click()
      await tick()
    })
    expect(handle.getAttribute('aria-label')).toBe('Hide work')
    expect((container.querySelector('.car-stage') as HTMLElement).className).toContain(
      'car-stage-pane-open',
    )

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('does NOT mount the pane while a scope switch is still resolving (Codex P2)', async () => {
    mediaMatches = (q) => q.includes('min-width: 1024px')

    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const sockets: Array<{ open: () => void; deliver: (o: unknown) => void; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send: (d: string) => void; close: () => void }> = []
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

    // GATE the tab resolver so the shell sits in the `resolving` (tabsScope ===
    // null) window deterministically — the pane must NOT mount there even though
    // the outgoing `tabs` still carries a Work descriptor.
    let releaseTabs: () => void = () => {}
    const tabsPending = new Promise<void>((res) => {
      releaseTabs = res
    })
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith(`/api/app/projects/${PROJECT}/tabs`)) {
        await tabsPending
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: PROJECT, tabs: RESOLVED_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
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
      userId: 'sam',
      projectId: PROJECT,
      projects: [{ id: PROJECT, label: 'Acme' }],
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:sam',
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
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
    })

    // Resolving (gated fetch still pending) → NO pane, NO handle.
    expect(container.querySelector('.car-plans-handle')).toBeNull()
    expect(container.querySelector('.car-plans')).toBeNull()

    // Release the resolver → the pane mounts for the now-resolved scope.
    await act(async () => {
      releaseTabs()
      await tick()
      await tick()
    })
    expect(container.querySelector('.car-plans-handle')).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
