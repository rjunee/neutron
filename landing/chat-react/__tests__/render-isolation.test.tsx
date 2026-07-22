/**
 * Task 6 (chat text input feels laggy vs Telegram) — render-isolation guard.
 *
 * ROOT CAUSE (planner render-count probes vs REAL @assistant-ui/react 0.14.23):
 * `controller.ts` `computeVm()` rebuilt FRESH `RenderMessage` objects + a fresh
 * `messages` array on EVERY `publish()` (20 call sites — including PER STREAMING
 * TOKEN). assistant-ui caches its message→ThreadMessage conversion by message
 * OBJECT identity and memoizes each row on it; a fresh identity every publish
 * busted both, forcing EVERY row to re-convert + re-render (a full react-markdown
 * re-parse of the whole transcript) per token/frame — the main-thread stall Ryan
 * feels as laggy typing.
 *
 * THE FIX pins identity so unrelated churn produces zero row work:
 *   T1 — controller identity invariants (pure): an unrelated publish keeps the
 *        SAME `messages` array; a streaming token changes ONLY the stream bubble;
 *        a per-row change (reaction) changes ONLY that row.
 *   T2 — end-to-end render isolation over the REAL useChatRuntime + controller:
 *        an unrelated frame re-renders ZERO durable rows; N streaming tokens
 *        re-render O(changed-bubble), NOT O(transcript).
 *   T3 — the extracted context hooks return render-stable values.
 *   T4 — `Markdown` is `React.memo`'d and its output is stable across re-render.
 *
 * jsdom/happy-dom runs React synchronously; these assertions pin the INVARIANTS
 * (object identity + render counts) the browser lag depends on, which is exactly
 * what the fix changes — reverting any part of the fix fails a case here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { InMemoryStore, WebChatSession } from '@neutronai/chat-core'
import type { SocketLike } from '@neutronai/chat-core'

import { NeutronChatController } from '../controller.ts'
import type { RenderMessage } from '../controller.ts'

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

class FakeSocket implements SocketLike {
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false
  send(data: string): void {
    if (this.closed) throw new Error('closed')
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.()
  }
  deliver(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

function setup(projectId: string | null = null) {
  const sockets: FakeSocket[] = []
  const controller = new NeutronChatController({
    projectId,
    createSession: (sinks) =>
      new WebChatSession({
        url: 'wss://t/ws/app/chat',
        topic_id: TOPIC,
        store: new InMemoryStore(),
        createSocket: () => {
          const s = new FakeSocket()
          sockets.push(s)
          return s
        },
        onChange: sinks.onChange,
        onStatus: sinks.onStatus,
        onFrame: sinks.onFrame,
      }),
  })
  return { controller, sockets }
}

/** Deliver `n` durable agent messages (m1..mn), await their async persist. The
 *  session (and its socket) is created lazily on `start()`, so the socket is
 *  read from `sockets` AFTER start. */
async function hydrate(controller: NeutronChatController, sockets: FakeSocket[], n: number): Promise<void> {
  controller.start()
  const socket = sockets[0]!
  socket.open()
  socket.deliver(ready())
  await tick()
  for (let i = 1; i <= n; i++) {
    socket.deliver({ v: 1, type: 'agent_message', message_id: `m${i}`, seq: i, body: `body ${i}`, ts: i })
  }
  await tick()
  await tick()
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — controller identity invariants (pure; no DOM)
// ─────────────────────────────────────────────────────────────────────────────
describe('T1 — computeVm identity stability', () => {
  it('an unrelated publish keeps the SAME messages array + every row identity', async () => {
    const { controller, sockets } = setup()
    await hydrate(controller, sockets, 6)
    const vm1 = controller.getViewModel()
    expect(vm1.messages.length).toBe(6)

    // Unrelated publish: a projects_changed frame mutates the rail, not the
    // transcript — it must recompute the VM WITHOUT changing any message identity.
    sockets[0]!.deliver({
      v: 1,
      type: 'projects_changed',
      projects: [{ id: 'p1', label: 'Proj One' }],
      ts: 99,
    })
    const vm2 = controller.getViewModel()
    // The publish happened (projects changed) …
    expect(vm2.projects.length).toBe(1)
    // … but the WHOLE messages array is reference-reused.
    expect(vm2.messages).toBe(vm1.messages)
    for (let i = 0; i < vm1.messages.length; i++) {
      expect(vm2.messages[i]).toBe(vm1.messages[i])
    }
  })

  it('a streaming token changes the array + stream bubble, but reuses every durable row', async () => {
    const { controller, sockets } = setup()
    await hydrate(controller, sockets, 6)
    const vm1 = controller.getViewModel()
    const durable1 = vm1.messages.slice(0, 6)

    // First token for a brand-new streaming message → a stream bubble appends.
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'ms', body_delta: 'Hel', ts: 100 })
    const vm2 = controller.getViewModel()
    // The array identity changed (a row appended) …
    expect(vm2.messages).not.toBe(vm1.messages)
    expect(vm2.messages.length).toBe(7)
    // … but every durable row object is reference-reused.
    for (let i = 0; i < 6; i++) expect(vm2.messages[i]).toBe(durable1[i])
    const streamBubble2 = vm2.messages[6]
    expect(streamBubble2?.streaming).toBe(true)

    // Second token to the SAME stream → its text changes → ONLY the stream
    // bubble gets a new identity; durable rows still reused.
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'ms', body_delta: 'lo', ts: 101 })
    const vm3 = controller.getViewModel()
    expect(vm3.messages.length).toBe(7)
    for (let i = 0; i < 6; i++) expect(vm3.messages[i]).toBe(durable1[i])
    expect(vm3.messages[6]).not.toBe(streamBubble2)
    expect(vm3.messages[6]?.text).toBe('Hello')
  })

  it('a per-row change (reaction) changes EXACTLY that row, siblings reused', async () => {
    const { controller, sockets } = setup()
    await hydrate(controller, sockets, 6)
    const vm1 = controller.getViewModel()
    const rows1 = vm1.messages.slice()
    // Row index 2 is message m3 (hydrated in order).
    const target1 = vm1.messages[2]
    expect(target1?.messageId).toBe('m3')

    sockets[0]!.deliver({
      v: 1,
      type: 'reaction_update',
      message_id: 'm3',
      seq: 3,
      rev: 1,
      reactions: [{ emoji: '👍', device_id: 'devB' }],
      ts: 200,
    })
    await tick()
    const vm2 = controller.getViewModel()
    // Exactly the reacted row changed identity …
    expect(vm2.messages[2]).not.toBe(target1)
    expect(vm2.messages[2]?.reactions.length).toBe(1)
    // … and every OTHER row is reference-reused.
    for (let i = 0; i < rows1.length; i++) {
      if (i === 2) continue
      expect(vm2.messages[i]).toBe(rows1[i])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2 — end-to-end render isolation over the REAL runtime
// ─────────────────────────────────────────────────────────────────────────────

// Module-scoped render counters incremented in the counting components' render
// bodies. With assistant-ui's per-message-identity row memo, a bailed-out row's
// function is never called — so a delta of 0 proves the row did not re-render.
const rowRenders = new Map<string, number>()
function bumpRow(id: string): void {
  rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1)
}
function totalRowRenders(): number {
  let n = 0
  for (const v of rowRenders.values()) n += v
  return n
}

describe('T2 — end-to-end render isolation (real useChatRuntime + controller)', () => {
  it('unrelated frame → 0 row re-renders; N streaming tokens → O(changed-bubble) not O(N)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act, useState, useEffect } = await import('react')
    const { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, useMessage, useMessagePartText } =
      await import('@assistant-ui/react')
    const { useNeutronChat } = await import('../useNeutronChat.ts')
    const React = await import('react')

    const { controller, sockets } = setup()

    function CountingText(): React.JSX.Element {
      const message = useMessage()
      const part = useMessagePartText()
      bumpRow(message.id)
      return <span className="ri-text">{part.text}</span>
    }
    const PARTS = { Text: CountingText } as const
    function CountingMessage(): React.JSX.Element {
      const message = useMessage()
      bumpRow(message.id)
      return (
        <MessagePrimitive.Root>
          <MessagePrimitive.Parts components={PARTS} />
        </MessagePrimitive.Root>
      )
    }
    const MESSAGE_COMPONENTS = { UserMessage: CountingMessage, AssistantMessage: CountingMessage } as const

    let bumpHost: (n: number) => void = () => {}
    function Harness(): React.JSX.Element {
      const [, setN] = useState(0)
      bumpHost = setN
      const { runtime } = useNeutronChat(controller, 'https://sam.neutron.test')
      useEffect(() => {}, [])
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root>
            <ThreadPrimitive.Viewport>
              <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      )
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    const N = 20
    await act(async () => {
      controller.start()
      sockets[0]!.open()
      sockets[0]!.deliver(ready())
      await tick()
      for (let i = 1; i <= N; i++) {
        sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: `m${i}`, seq: i, body: `body ${i}`, ts: i })
      }
      await tick()
      await tick()
    })
    // All N durable rows mounted + rendered.
    expect(rowRenders.size).toBeGreaterThanOrEqual(N)

    // ── Unrelated frame → ZERO row re-renders ────────────────────────────────
    rowRenders.clear()
    await act(async () => {
      sockets[0]!.deliver({
        v: 1,
        type: 'projects_changed',
        projects: [{ id: 'p1', label: 'One' }],
        ts: 500,
      })
      // Also bump the host itself to prove a parent re-render alone re-renders
      // no rows (assistant-ui memoizes rows on the stable message identities).
      bumpHost(1)
      await tick()
    })
    expect(totalRowRenders()).toBe(0)

    // ── 3 streaming tokens → bounded, NOT O(N) ───────────────────────────────
    rowRenders.clear()
    await act(async () => {
      await controller.send('go')
      await tick()
    })
    // The user send + optimistic assistant affordance may touch a couple rows;
    // measure ONLY the streaming window below.
    rowRenders.clear()
    const streamId = 'stream:mstream'
    for (let t = 0; t < 3; t++) {
      await act(async () => {
        sockets[0]!.deliver({
          v: 1,
          type: 'agent_message_partial',
          message_id: 'mstream',
          body_delta: `tok${t} `,
          ts: 600 + t,
        })
        await tick()
      })
    }
    // No durable row (m1..m20) re-rendered during streaming.
    for (let i = 1; i <= N; i++) {
      expect(rowRenders.get(`m${i}`) ?? 0).toBe(0)
    }
    // Total re-render work is bounded by a small constant, not the transcript
    // length: the churn is confined to the single streaming bubble.
    expect(totalRowRenders()).toBeLessThanOrEqual(3 * 5)
    expect(totalRowRenders()).toBeLessThan(N)
    // The streaming bubble itself DID render (the fix isolates, not freezes).
    expect(rowRenders.get(streamId) ?? 0).toBeGreaterThan(0)

    await act(async () => {
      root.unmount()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3 — context-hook identity stability
// ─────────────────────────────────────────────────────────────────────────────
describe('T3 — useUploadsCtx / useDocLinkCtx identity', () => {
  it('returns reference-equal values across host re-renders with unchanged inputs; new identity on change', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act, useState, useEffect } = await import('react')
    const { useUploadsCtx, useDocLinkCtx } = await import('../ChatApp.tsx')
    const React = await import('react')

    const uploads: unknown[] = []
    const docLinks: unknown[] = []
    let bump: (n: number) => void = () => {}
    let setOrigin: (o: string) => void = () => {}
    const stableOnOpen = (_p: string, _path: string): void => {}

    function Probe(): React.JSX.Element {
      const [, setN] = useState(0)
      const [origin, _setOrigin] = useState('https://a.test')
      bump = setN
      setOrigin = _setOrigin
      const up = useUploadsCtx({ token: 'tok', origin: 'https://a.test' })
      const dl = useDocLinkCtx(origin, stableOnOpen)
      useEffect(() => {
        uploads.push(up)
        docLinks.push(dl)
      })
      return React.createElement('div')
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Probe />)
    })
    // Two unrelated host re-renders — inputs unchanged.
    await act(async () => {
      bump(1)
    })
    await act(async () => {
      bump(2)
    })
    expect(uploads.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < uploads.length; i++) expect(uploads[i]).toBe(uploads[0])
    for (let i = 1; i < docLinks.length; i++) expect(docLinks[i]).toBe(docLinks[0])

    // Change an input (origin) → the doc-link ctx gets a NEW identity.
    const before = docLinks[docLinks.length - 1]
    await act(async () => {
      setOrigin('https://b.test')
    })
    expect(docLinks[docLinks.length - 1]).not.toBe(before)

    await act(async () => {
      root.unmount()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4 — Markdown is React.memo'd + output stable
// ─────────────────────────────────────────────────────────────────────────────
describe('T4 — Markdown memoization', () => {
  it('is wrapped in React.memo', async () => {
    const { Markdown } = await import('../Markdown.tsx')
    expect((Markdown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })

  it('renders markdown and keeps output stable across a parent re-render', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act, useState } = await import('react')
    const { Markdown } = await import('../Markdown.tsx')
    const React = await import('react')

    let bump: (n: number) => void = () => {}
    function Host(): React.JSX.Element {
      const [, setN] = useState(0)
      bump = setN
      return <Markdown text="**bold** text" />
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Host />)
    })
    const md = container.querySelector('.car-md')
    expect(md).not.toBeNull()
    expect(md?.querySelector('strong')?.textContent).toBe('bold')
    const htmlBefore = md?.innerHTML
    // A parent re-render with the SAME text must not change the rendered DOM.
    await act(async () => {
      bump(1)
    })
    expect(container.querySelector('.car-md')?.innerHTML).toBe(htmlBefore)

    await act(async () => {
      root.unmount()
    })
  })
})
