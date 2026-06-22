/**
 * Integration smoke for the attachment compose + render flow (happy-dom),
 * backed by a real chat-core WebChatSession over a fake socket and a fake
 * fetch standing in for the /api/app/upload surface. Asserts that staging an
 * image uploads it (bearer-authed), the Send affordance dispatches it through
 * WebChatSession.send({attachments}), and the resulting bubble renders the
 * image via the AUTHED renderer (a bearer GET → object URL), not a bare <img>.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { AttachmentDraft } from '../useAttachmentDraft.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
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
const UPLOADED_URL = '/api/app/upload/sam/abc.png'

describe('attachment compose + authed render (happy-dom)', () => {
  it('uploads a staged image, sends it, and renders it via the authed GET', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutron/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    let postedAuth = ''
    let getCount = 0
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      // POST is the relative endpoint; the render-side GET uses the
      // origin-absolutized URL (the message adapter absolutizes attachments).
      if (url.endsWith('/api/app/upload') && method === 'POST') {
        postedAuth = String((init?.headers as Record<string, string>)['authorization'])
        return new Response(
          JSON.stringify({ ok: true, url: UPLOADED_URL, content_type: 'image/png', size_bytes: 4 }),
          { status: 200 },
        )
      }
      if (url.includes('/api/app/upload/') && method === 'GET') {
        getCount += 1
        return new Response(new Blob([new Uint8Array([1, 2, 3, 4])]), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const sockets: Array<{
      open: () => void
      deliver: (o: unknown) => void
      onopen: (() => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      send: (d: string) => void
      close: () => void
    }> = []
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

    const controller = new NeutronChatController({
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

    let draftRef: AttachmentDraft | null = null
    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token, fetchImpl: fakeFetch })
      draftRef = draft
      const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatApp vm={vm} controller={controller} config={config} draft={draft} fetchImpl={fakeFetch} />
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

    // The compose affordance is present (file picker, images only, multiple).
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(fileInput).not.toBeNull()
    expect(fileInput!.accept).toContain('image/png')
    expect(fileInput!.multiple).toBe(true)

    // Stage an image → it uploads (bearer-authed) and a chip appears.
    await act(async () => {
      draftRef!.addFiles([new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', { type: 'image/png' })])
      await tick()
      await tick()
    })
    expect(postedAuth).toBe('Bearer dev:sam')
    expect(container.textContent).toContain('pic.png')
    expect(draftRef!.hasReady).toBe(true)

    // Click Send (attachment-only path) → the bubble + authed image render.
    const sendBtn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Send',
    ) as HTMLButtonElement | undefined
    expect(sendBtn).toBeDefined()
    expect(sendBtn!.disabled).toBe(false)
    await act(async () => {
      sendBtn!.click()
      await tick()
      await tick()
    })

    // The optimistic user message persisted and its image rendered through the
    // authed GET (object URL), not a plain <img src="/api/app/upload/…">.
    expect(getCount).toBeGreaterThan(0)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src') ?? '').not.toContain('/api/app/upload/')
    // Draft cleared after the send hand-off.
    expect(draftRef!.items.length).toBe(0)

    await act(async () => {
      root.unmount()
    })
  })
})
