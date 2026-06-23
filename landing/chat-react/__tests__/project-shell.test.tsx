/**
 * Component test for the web project TAB SHELL (WAVE 3 PR-4). Renders
 * `ProjectShell` in happy-dom over a real chat-core `WebChatSession` (fake
 * socket) with an injected `fetchImpl` serving the tab resolver. Asserts:
 *   - the bar renders the engine-resolved tab set (Chat + Documents + Tasks +
 *     a Core tab), not a hardcoded list;
 *   - the Chat tab shows the existing `ChatApp` and is active by default;
 *   - switching to a builtin tab reveals its "coming soon" placeholder;
 *   - switching to a Core tab renders a sandboxed iframe at the resolved URL.
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
  { key: 'documents', label: 'Documents', scope: 'project', source: 'builtin', order: 10, mount: { kind: 'builtin', target: 'docs' } },
  { key: 'tasks', label: 'Tasks', scope: 'project', source: 'builtin', order: 20, mount: { kind: 'builtin', target: 'tasks' } },
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

    // The bar renders the engine-resolved set, not a hardcoded list.
    const tabButtons = () =>
      Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent ?? '')
    expect(tabButtons()).toEqual(['Chat', 'Documents', 'Tasks', 'Analytics'])

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

  it('stays chat-only (no tab strip) for the General / no-project view', async () => {
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

    // No project ⇒ the shell must NOT hit the resolver at all.
    let resolverHits = 0
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes('/tabs')) resolverHits++
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

    // No tab strip, no resolver call — just the chat.
    expect(container.querySelectorAll('button[role="tab"]')).toHaveLength(0)
    expect(resolverHits).toBe(0)
    expect(container.textContent).toContain('Send')

    await act(async () => {
      root.unmount()
    })
  })
})
