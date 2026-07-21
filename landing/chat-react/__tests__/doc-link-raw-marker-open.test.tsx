/**
 * Regression for FIX #376 — a chat bubble that carries a RAW agent doc-link
 * (the canonical `docs:/<id>/<path>` marker, or the native
 * `neutron://docs/<id>/<path>` scheme) must still open the referenced doc in the
 * Documents tab when tapped.
 *
 * Before the fix, `rehype-sanitize` stripped the `docs:`/`neutron:` scheme href
 * BEFORE any click handler could read it, so the bubble rendered a DEAD link
 * (an `<a>` with no `href`) and a tap did NOTHING (issue #376, hit live
 * 2026-07-20 on the onboarding "first pass" message). The `app-ws` adapter
 * rewrites live web pushes to the web shape, but a RESUME replay
 * (`appChatRowToEnvelope`) re-emits the persisted body verbatim — channel-baked
 * at send time — so a non-web-baked doc-link reaches the web client raw.
 *
 * This test delivers the RAW `docs:/acme/brief.md` marker (what a resume replay
 * of an app-channel-baked row hands the client), clicks the rendered link, and
 * asserts the Documents tab activates + the doc opens. It FAILS on pre-fix code
 * (the link has no href, so the click is inert and `.cdoc` never mounts). An
 * external URL in the SAME message is untouched (keeps its `https:` href).
 *
 * Structure mirrors `doc-link-open.test.tsx` (the web-shape sibling).
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

describe('raw doc-link marker tap → Documents tab (FIX #376)', () => {
  it('opens the referenced doc when a RAW docs:/ marker link is clicked', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
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

    // A RESUME replay hands the client the RAW persisted body — the canonical
    // `docs:/<id>/<path>` marker, NOT the web-rewritten URL — alongside an
    // ordinary external link that must be untouched.
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'agent_message',
        message_id: 'm1',
        seq: 1,
        body: 'Drafted a plan — see [brief](docs:/acme/brief.md). Refs [docs](https://example.com/x).',
        ts: 3,
      })
      await tick()
    })

    // The raw marker was normalized to the web doc-link URL (pre-fix it was
    // stripped to a hrefless dead link) …
    const link = container.querySelector('a[href="/projects/acme/docs?path=brief.md"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    // … and the external link is untouched.
    const ext = container.querySelector('a[href="https://example.com/x"]')
    expect(ext).not.toBeNull()
    // Chat is still active (link not yet clicked).
    expect(container.querySelector('.cdoc')).toBeNull()

    // Tap the doc link → switch to Documents + open the doc.
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
