/**
 * Component test for P-A — tapping an agent's doc link in chat switches to the
 * Documents tab and opens that doc.
 *
 * Renders `ProjectShell` in happy-dom over a real chat-core `WebChatSession`
 * (fake socket). An agent message arrives carrying the web doc-link URL the
 * app-ws adapter emits for a web client (`/projects/<id>/docs?path=<enc>`). The
 * test clicks the rendered link and asserts: (1) the Documents tab activates,
 * (2) `DocumentsTab` opens the referenced doc (its content renders).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
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
]

describe('doc-link tap → Documents tab (P-A)', () => {
  it('opens the referenced doc in the Documents tab when its chat link is clicked', async () => {
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

    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith(`/api/app/projects/${PROJECT}/tabs`)) {
        return json({ ok: true, scope: 'project', project_id: PROJECT, tabs: RESOLVED_TABS })
      }
      if (url.endsWith(`/api/app/projects/${PROJECT}/docs/tree`)) {
        return json({ ok: true, file_count: 1, tree: [
          { kind: 'file', path: 'brief.md', name: 'brief.md', size_bytes: 10, modified_at: 1, content_type: null, referenced_by_count: null, origin: null, children: [] },
        ] })
      }
      if (url.includes(`/api/app/projects/${PROJECT}/docs/file?path=brief.md`)) {
        return json({ ok: true, file: { path: 'brief.md', content: 'BRIEF-DOC-BODY', size_bytes: 14, modified_at: 1 } })
      }
      if (url.includes(`/api/app/projects/${PROJECT}/docs/comments`)) {
        return json({ ok: true, threads: [], next_cursor: null })
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
    await act(async () => {
      await tick()
      await tick()
    })

    // The agent references the drafted doc with the web doc-link URL (what the
    // app-ws adapter emits for a web client).
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'agent_message',
        message_id: 'm1',
        seq: 1,
        body: 'Done — see it in the Documents tab as [brief](/projects/acme/docs?path=brief.md).',
        ts: 3,
      })
      await tick()
    })

    // The link renders in the chat markdown.
    const link = container.querySelector('a[href="/projects/acme/docs?path=brief.md"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    // Chat is still the active tab (link not yet clicked).
    expect(container.querySelector('.cdoc')).toBeNull()

    // Tap the link → switch to Documents + open the doc.
    await act(async () => {
      link.click()
      await tick()
      await tick()
    })

    // The Documents tab is now active and the referenced doc opened.
    expect(container.querySelector('.cdoc')).not.toBeNull()
    expect(container.textContent).toContain('BRIEF-DOC-BODY')

    await act(async () => {
      root.unmount()
    })
  })
})
