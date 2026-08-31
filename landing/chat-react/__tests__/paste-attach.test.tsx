/**
 * Paste-to-attach on the web chat surface (happy-dom). The owner's flow is
 * screenshot → Cmd/Ctrl-V, which pastes with focus on the PAGE, not the
 * composer — so every dispatch here goes on `document.body`, the case a React
 * `onPaste` on `<main>` provably cannot see (body never propagates through a
 * descendant). These assert observable draft state: the pasted File must land
 * in the SAME `handleFiles` funnel a drop or the 📎 picker uses.
 *
 * The plain-text case is the one that protects the owner: a text paste must not
 * be `preventDefault()`ed and must not touch the draft — and it is proved
 * non-vacuous by pasting an image on the SAME mount right after, so a listener
 * that never registered cannot pass.
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

const png = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
const pasteEvent = (dt: DataTransfer) =>
  new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })

describe('paste-to-attach on the chat surface (happy-dom)', () => {
  /** Mount a live ChatApp over a fake socket + fake upload endpoint. */
  const mount = async (): Promise<{
    container: HTMLDivElement
    root: { unmount: () => void }
    draft: () => AttachmentDraft
  }> => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
    const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
    const { NeutronChatController } = await import('../controller.ts')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { ChatApp } = await import('../ChatApp.tsx')
    const React = await import('react')

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/app/upload') && method === 'POST') {
        return new Response(
          JSON.stringify({ ok: true, url: UPLOADED_URL, content_type: 'image/png', size_bytes: 4 }),
          { status: 200 },
        )
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
    return { container, root, draft: () => draftRef! }
  }

  /**
   * Paste ON THE BODY — the focus-on-page case. A body-dispatched event never
   * propagates through `<main>`, so only a document-level listener sees it.
   */
  const pasteOnBody = async (ev: ClipboardEvent): Promise<void> => {
    const { act } = await import('react')
    await act(async () => {
      document.body.dispatchEvent(ev)
      await tick()
      await tick()
    })
  }

  it('pasting an image on the page attaches it through the funnel; blank names get stable synthesized names; consecutive pastes never collide', async () => {
    const { act } = await import('react')
    const { container, root, draft } = await mount()

    // A blank-named clipboard image (the common screenshot shape).
    const dt1 = new DataTransfer()
    dt1.items.add(png(''))
    await pasteOnBody(pasteEvent(dt1))

    expect(draft().items.length).toBe(1)
    const generated = draft().items[0]!.name
    expect(generated).toMatch(/^pasted-\d+\.png$/)
    // It reached the REAL upload path (the same funnel a drop uses), and the
    // chip renders on the same preview surface with the synthesized name.
    expect(draft().hasReady).toBe(true)
    expect(container.textContent).toContain(generated)

    // One paste carrying TWO files with identical names → two separate items.
    const dt2 = new DataTransfer()
    dt2.items.add(png('image.png'))
    dt2.items.add(png('image.png'))
    await pasteOnBody(pasteEvent(dt2))

    const items = draft().items
    expect(items.length).toBe(3)
    expect(new Set(items.map((i) => i.id)).size).toBe(3)
    expect(items[1]!.name).toBe('image.png')
    expect(items[2]!.name).toBe('image.png')

    await act(async () => {
      root.unmount()
    })
  })

  it('a plain-text paste is untouched: not preventDefault()ed, draft unchanged — and the listener is provably live', async () => {
    const { act } = await import('react')
    const { root, draft } = await mount()

    const dtText = new DataTransfer()
    dtText.setData('text/plain', 'hello world')
    const evText = pasteEvent(dtText)
    await pasteOnBody(evText)

    expect(draft().items.length).toBe(0)
    expect(evText.defaultPrevented).toBe(false)

    // Non-vacuity: the SAME mount attaches an image right after, so the text
    // paste above was seen by a live, discriminating listener — not missed by
    // one that never registered.
    const dtImg = new DataTransfer()
    dtImg.items.add(png('shot.png'))
    await pasteOnBody(pasteEvent(dtImg))
    expect(draft().items.length).toBe(1)

    await act(async () => {
      root.unmount()
    })
  })

  it('a paste carrying BOTH text and an image attaches the image and leaves the text’s default insert alone', async () => {
    const { act } = await import('react')
    const { root, draft } = await mount()

    const dt = new DataTransfer()
    dt.setData('text/plain', 'caption')
    dt.items.add(png('shot.png'))
    const ev = pasteEvent(dt)
    await pasteOnBody(ev)

    expect(draft().items.length).toBe(1)
    // The text still inserts: we never defaulted the paste away.
    expect(ev.defaultPrevented).toBe(false)

    await act(async () => {
      root.unmount()
    })
  })

  it('a paste while the chat surface is hidden does not attach (kept-alive surfaces share one draft)', async () => {
    const { act } = await import('react')
    const { container, root, draft } = await mount()

    // Stand in for the hidden `.car-tabpanel` / `.car-conv[hidden]` ancestor.
    container.hidden = true
    const dtHidden = new DataTransfer()
    dtHidden.items.add(png('shot.png'))
    await pasteOnBody(pasteEvent(dtHidden))
    expect(draft().items.length).toBe(0)

    container.hidden = false
    const dtVisible = new DataTransfer()
    dtVisible.items.add(png('shot.png'))
    await pasteOnBody(pasteEvent(dtVisible))
    expect(draft().items.length).toBe(1)

    await act(async () => {
      root.unmount()
    })
  })
})
