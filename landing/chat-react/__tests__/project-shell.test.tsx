/**
 * Component test for the web APP SHELL (rail/tab rework 2026-06-30). Renders
 * `ProjectShell` in happy-dom over a real chat-core `WebChatSession` (fake
 * socket) with an injected `fetchImpl` serving the tab resolver. Asserts:
 *   - PROJECT view: the bar renders the engine-resolved set (Chat + Plan +
 *     Documents + a Core tab), NO Tasks (removed) and NO Admin (global);
 *   - the persistent project rail renders alongside the tab content;
 *   - the Chat tab shows `ChatApp` and is active by default;
 *   - switching to a builtin tab reveals its real view; switching to a Core tab
 *     renders a sandboxed iframe at the resolved URL;
 *   - GENERAL view: the bar shows Chat + Admin (the global tabs), NOT chat-only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  // `disableIframePageLoading` stops happy-dom from making a real network fetch
  // for the Core-tab `<iframe src>` we assert on — we only check the attribute.
  GlobalRegistrator.register({
    url: 'https://sam.neutron.test/chat?client=react',
    settings: { disableIframePageLoading: true },
  })
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
const PROJECT = 'acme'
const tick = () => new Promise((r) => setTimeout(r, 0))
const ready = () => ({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })

const RESOLVED_TABS = [
  { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'chat' } },
  { key: 'work_board', label: 'Plan', scope: 'project', source: 'builtin', order: 5, mount: { kind: 'builtin', target: 'workboard' } },
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

    // The bar renders the engine-resolved set, not a hardcoded list — Plan (not
    // "Work Board"), no Tasks (removed), no Admin (global, not folded in).
    const tabButtons = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent ?? '')
    expect(tabButtons()).toEqual(['Chat', 'Plan', 'Documents', 'Analytics'])

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

  it('keeps the TabBar + Composer MOUNTED across a project switch while the tab set updates per-project', async () => {
    // Flicker fix (2026-07-01): switching projects must NOT unmount/remount the
    // tab bar or the composer/input. Only the keyed message viewport remounts
    // (the #162 crash fix). We assert this via DOM node IDENTITY: a React
    // reconcile-in-place reuses the SAME element object; a remount creates a new
    // one. Composer input + tab-bar `<nav>` stay identical across the switch;
    // the message viewport is a fresh node; and the tab labels reflect the new
    // project (per-project set, updated in place — not a shared static bar).
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const PROJECT_A = 'acme'
    const PROJECT_B = 'zen'
    // Project B has a DIFFERENT (smaller) tab set — Chat + Plan only — so a
    // successful switch is observable as the bar changing to exactly this set.
    const ZEN_TABS = [
      { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'chat' } },
      { key: 'work_board', label: 'Plan', scope: 'project', source: 'builtin', order: 5, mount: { kind: 'builtin', target: 'workboard' } },
    ]

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
      if (url.endsWith(`/api/app/projects/${PROJECT_A}/tabs`)) {
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: PROJECT_A, tabs: RESOLVED_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith(`/api/app/projects/${PROJECT_B}/tabs`)) {
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: PROJECT_B, tabs: ZEN_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const controller = new NeutronChatController({
      projectId: PROJECT_A,
      projects: [
        { id: PROJECT_A, label: 'Acme' },
        { id: PROJECT_B, label: 'Zen' },
      ],
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
      projectId: PROJECT_A,
      projects: [
        { id: PROJECT_A, label: 'Acme' },
        { id: PROJECT_B, label: 'Zen' },
      ],
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

    const tabLabels = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent ?? '')
    // Project A's full tab set is resolved.
    expect(tabLabels()).toEqual(['Chat', 'Plan', 'Documents', 'Analytics'])

    // Capture the LIVE DOM instances BEFORE the switch. If React remounts them,
    // these object references are replaced with fresh elements after the switch.
    const navBefore = container.querySelector('nav.car-tabs')
    const inputBefore = container.querySelector('.car-input')
    const viewportBefore = container.querySelector('.car-viewport')
    expect(navBefore).not.toBeNull()
    expect(inputBefore).not.toBeNull()
    expect(viewportBefore).not.toBeNull()

    // Switch into project B (a different per-project tab set).
    await act(async () => {
      controller.setProject(PROJECT_B)
      await tick()
      await tick()
    })

    const navAfter = container.querySelector('nav.car-tabs')
    const inputAfter = container.querySelector('.car-input')
    const viewportAfter = container.querySelector('.car-viewport')

    // The tab bar and composer input are the SAME element instances — reconciled
    // in place, never unmount/remount ⇒ no flicker.
    expect(navAfter).toBe(navBefore)
    expect(inputAfter).toBe(inputBefore)

    // But the message viewport IS a fresh node — the keyed remount that kills the
    // #162 stale-MessagePart crash is still in force.
    expect(viewportAfter).not.toBe(viewportBefore)

    // And the persistent tab bar now reflects project B's set (per-project data,
    // updated in place on the SAME <nav>) — proving it is NOT a shared static bar.
    expect(tabLabels()).toEqual(['Chat', 'Plan'])

    await act(async () => {
      root.unmount()
    })
  })

  it('ignores stale tab selections while the new project’s /tabs fetch is in flight (Codex P2)', async () => {
    // While the new project's tab set is still resolving we keep the PREVIOUS
    // project's tabs on-screen (no flicker) — but they must NOT be selectable,
    // or a slow/hung fetch would mount the old project's Documents/Core content
    // under the new projectId. Here project B's /tabs never resolves; clicking a
    // stale tab from project A must be a no-op (Chat stays visible).
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ProjectShell } = await import('../ProjectShell.tsx')
    const React = await import('react')

    const PROJECT_A = 'acme'
    const PROJECT_B = 'hang'

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
      if (url.endsWith(`/api/app/projects/${PROJECT_A}/tabs`)) {
        return new Response(
          JSON.stringify({ ok: true, scope: 'project', project_id: PROJECT_A, tabs: RESOLVED_TABS }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // Project B: the tab resolver HANGS (never resolves) — the stuck-loading case.
      if (url.endsWith(`/api/app/projects/${PROJECT_B}/tabs`)) {
        return new Promise<Response>(() => {})
      }
      return new Response('not found', { status: 404 })
    }

    const controller = new NeutronChatController({
      projectId: PROJECT_A,
      projects: [
        { id: PROJECT_A, label: 'Acme' },
        { id: PROJECT_B, label: 'Hang' },
      ],
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
      projectId: PROJECT_A,
      projects: [
        { id: PROJECT_A, label: 'Acme' },
        { id: PROJECT_B, label: 'Hang' },
      ],
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
    const tabLabels = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent ?? '')
    expect(tabLabels()).toEqual(['Chat', 'Plan', 'Documents', 'Analytics'])

    // Switch into project B — its /tabs hangs, so A's tabs stay on-screen (no
    // flicker/collapse), but the scope no longer matches the displayed set.
    await act(async () => {
      controller.setProject(PROJECT_B)
      await tick()
      await tick()
    })
    expect(tabLabels()).toEqual(['Chat', 'Plan', 'Documents', 'Analytics'])
    // Chat panel is visible (active), not a stale tab's content.
    const chatPanel = container.querySelector('.car-tabpanel') as HTMLElement
    expect(chatPanel.hasAttribute('hidden')).toBe(false)

    // Click the STALE "Documents" tab — the guard ignores it: no Documents view
    // mounts under project B, and the Chat panel stays visible.
    const docsBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find(
      (b) => b.textContent === 'Documents',
    ) as HTMLButtonElement
    await act(async () => {
      docsBtn.click()
      await tick()
    })
    expect(container.querySelector('.cdoc')).toBeNull()
    expect((container.querySelector('.car-tabpanel') as HTMLElement).hasAttribute('hidden')).toBe(false)

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
