/**
 * Paste-to-attach on the web chat surface (happy-dom). The owner's flow is
 * screenshot → Cmd/Ctrl-V, which pastes with focus on the PAGE, not the
 * composer — so most dispatches here go on `document.body`, the case a React
 * `onPaste` on `<main>` provably cannot see (body never propagates through a
 * descendant). One test dispatches on the composer input instead, covering the
 * focus-in-the-composer half of the card and pinning the "attaches exactly
 * once" property the library's own paste path could otherwise break. These
 * assert observable draft state: the pasted File must land in the SAME
 * `handleFiles` funnel a drop or the 📎 picker uses.
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
const blob = (name: string, type: string) => new File([new Uint8Array([1, 2, 3, 4])], name, { type })
const pasteEvent = (dt: DataTransfer) =>
  new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })

/**
 * A clipboard that populates ONLY `files` — the engines the `items` loop cannot
 * serve. happy-dom derives `files` FROM `items`, so its real `DataTransfer` can
 * never produce this shape and the fallback branch would otherwise go unrun.
 */
const filesOnlyClipboard = (files: readonly File[], types: readonly string[]): DataTransfer =>
  ({ items: [], files, types }) as unknown as DataTransfer

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
  const pasteOn = async (target: EventTarget, ev: ClipboardEvent): Promise<void> => {
    const { act } = await import('react')
    await act(async () => {
      target.dispatchEvent(ev)
      await tick()
      await tick()
    })
  }
  const pasteOnBody = (ev: ClipboardEvent): Promise<void> => pasteOn(document.body, ev)

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

    // A SECOND blank-named paste right after: the synthesized name must be a
    // fresh one, not a reused constant (two chips a user can tell apart).
    const dt2 = new DataTransfer()
    dt2.items.add(png(''))
    await pasteOnBody(pasteEvent(dt2))
    expect(draft().items.length).toBe(2)
    const generated2 = draft().items[1]!.name
    expect(generated2).toMatch(/^pasted-\d+\.png$/)
    expect(generated2).not.toBe(generated)
    expect(container.textContent).toContain(generated2)

    // One paste carrying TWO files, both under the engines' generic screenshot
    // name → two separate items with two DISTINCT labels (card req 5).
    const dt3 = new DataTransfer()
    dt3.items.add(png('image.png'))
    dt3.items.add(png('image.png'))
    await pasteOnBody(pasteEvent(dt3))

    const items = draft().items
    expect(items.length).toBe(4)
    expect(new Set(items.map((i) => i.id)).size).toBe(4)
    expect(new Set(items.map((i) => i.name)).size).toBe(4)
    expect(items[2]!.name).toMatch(/^pasted-\d+\.png$/)
    expect(items[3]!.name).toMatch(/^pasted-\d+\.png$/)

    // A name a real file carries is NOT rewritten.
    const dt4 = new DataTransfer()
    dt4.items.add(png('diagram.png'))
    await pasteOnBody(pasteEvent(dt4))
    expect(draft().items[4]!.name).toBe('diagram.png')

    // The synthesized extension comes off the MIME subtype, with a structured
    // suffix dropped: `image/svg+xml` is `.svg`, never `.svgxml`.
    const dt5 = new DataTransfer()
    dt5.items.add(blob('', 'image/svg+xml'))
    await pasteOnBody(pasteEvent(dt5))
    expect(draft().items[5]!.name).toMatch(/^pasted-\d+\.svg$/)

    await act(async () => {
      root.unmount()
    })
  })

  it('pasting with focus IN the composer attaches exactly once (req 1; the library’s own paste path stays pinned off)', async () => {
    const { act } = await import('react')
    const { container, root, draft } = await mount()

    const input = container.querySelector('.car-input')
    expect(input).not.toBeNull()
    ;(input as HTMLTextAreaElement).focus()

    const dt = new DataTransfer()
    dt.items.add(png('shot.png'))
    await pasteOn(input!, pasteEvent(dt))

    // Exactly ONE item: the surface funnel attached it, and assistant-ui's
    // built-in paste-to-attachment did not add a second along the way.
    expect(draft().items.length).toBe(1)
    expect(draft().items[0]!.name).toBe('shot.png')

    await act(async () => {
      root.unmount()
    })
  })

  it('an image-only paste IS defaulted away (nothing may smear a placeholder into the composer)', async () => {
    const { act } = await import('react')
    const { root, draft } = await mount()

    const dt = new DataTransfer()
    dt.items.add(png('shot.png'))
    const ev = pasteEvent(dt)
    await pasteOnBody(ev)

    expect(draft().items.length).toBe(1)
    expect(ev.defaultPrevented).toBe(true)

    await act(async () => {
      root.unmount()
    })
  })

  it('a clipboard that populates only `files` (no `items`) still attaches', async () => {
    const { act } = await import('react')
    const { root, draft } = await mount()

    const ev = pasteEvent(filesOnlyClipboard([png('shot.png')], ['Files']))
    await pasteOnBody(ev)

    expect(draft().items.length).toBe(1)
    expect(draft().items[0]!.name).toBe('shot.png')
    expect(ev.defaultPrevented).toBe(true)

    // …and the same shape carrying a NON-image file is ignored outright.
    const evDoc = pasteEvent(filesOnlyClipboard([blob('notes.pdf', 'application/pdf')], ['Files']))
    await pasteOnBody(evDoc)
    expect(draft().items.length).toBe(1)
    expect(evDoc.defaultPrevented).toBe(false)

    await act(async () => {
      root.unmount()
    })
  })

  it('pasting a NON-image file is left entirely alone — no chip, no import banner, no preventDefault', async () => {
    const { act } = await import('react')
    const { container, root, draft } = await mount()

    const dtDeck = new DataTransfer()
    dtDeck.items.add(
      blob('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    )
    const evDeck = pasteEvent(dtDeck)
    await pasteOnBody(evDeck)

    expect(draft().items.length).toBe(0)
    expect(evDeck.defaultPrevented).toBe(false)

    // A copied export ZIP must NOT raise the import-affordance rejection from a
    // stray Cmd-V (drag-and-drop is where a ZIP legitimately arrives).
    const dtZip = new DataTransfer()
    dtZip.items.add(blob('conversations.zip', 'application/zip'))
    const evZip = pasteEvent(dtZip)
    await pasteOnBody(evZip)

    expect(draft().items.length).toBe(0)
    expect(evZip.defaultPrevented).toBe(false)
    expect(container.textContent ?? '').not.toContain('No history import is in progress')

    // Non-vacuity: the listener is live on this same mount.
    const dtImg = new DataTransfer()
    dtImg.items.add(png('shot.png'))
    await pasteOnBody(pasteEvent(dtImg))
    expect(draft().items.length).toBe(1)

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

    // Copying out of a web page ships the caption as `text/html`, with NO
    // `text/plain` flavour. That is still text riding along, so the image
    // attaches and the markup still inserts — a `text/plain`-only predicate
    // cancelled this paste and silently dropped the caption.
    const dtHtml = new DataTransfer()
    dtHtml.setData('text/html', '<b>caption</b>')
    dtHtml.items.add(png('shot2.png'))
    const evHtml = pasteEvent(dtHtml)
    await pasteOnBody(evHtml)

    expect(draft().items.length).toBe(2)
    expect(evHtml.defaultPrevented).toBe(false)

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
