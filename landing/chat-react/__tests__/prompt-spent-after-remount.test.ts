/**
 * ISSUES #419 — the WEB half: a reload must not resurrect a spent button.
 *
 * The native surface kept spent-ness in a `useState`; this surface kept it in a
 * controller-instance `Map`. Same defect, same consequence: reload the page (or
 * let the controller `reset`) and an already-answered prompt drew a live,
 * tappable button that the server would refuse to honour. A reply row's TTL is
 * ten years, so it never ages out on its own.
 *
 * A reload is modelled the way it actually happens: a NEW controller over a NEW
 * session, sharing the DURABLE local store the old one wrote to. The optimistic
 * `Map` does not survive that; the server's `chosen_value` on the message does.
 *
 * Both surfaces resolve this through the SAME `spentChoiceValue` rule in
 * `@neutronai/chat-core` — the `isColdStartAck` precedent: a predicate that
 * matters to both clients lives in shared code so there cannot be two divergent
 * answers to "is this button spent?".
 *
 * GENERAL scope (`projectId: null`) — where the reported Retry bubbles lived.
 */

import { describe, expect, it } from 'bun:test'
import { InMemoryStore, WebChatSession } from '@neutronai/chat-core'
import type { SocketLike, Store } from '@neutronai/chat-core'

import { NeutronChatController } from '../controller.ts'

const TOPIC = 'app:sam'
const RETRY_TURN_VALUE = '__retry_turn__'
const PROMPT_ID = 'prompt-419'
const MESSAGE_ID = 'agent-419'

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

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))
const ready = (): unknown => ({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })

/** The "that one took too long / tap Retry" bubble, in its wire shape. */
const retryBubble = (): Record<string, unknown> => ({
  v: 1,
  type: 'agent_message',
  message_id: MESSAGE_ID,
  seq: 1,
  ts: 1,
  body: 'That one took too long.',
  prompt_id: PROMPT_ID,
  allow_freeform: true,
  options: [{ label: 'Retry', body: 'Retry', value: RETRY_TURN_VALUE }],
})

/**
 * The frame the gateway fans the instant it claims the tap. Field-for-field the
 * shape asserted against a real server in
 * `gateway/__tests__/app-ws-prompt-spent-server-state.test.ts`.
 */
const promptResolved = (): Record<string, unknown> => ({
  v: 1,
  type: 'prompt_resolved',
  message_id: MESSAGE_ID,
  prompt_id: PROMPT_ID,
  chosen_value: RETRY_TURN_VALUE,
  seq: 1,
  ts: 2,
})

/** Mount a controller over `store` — a fresh one each call, as a reload gives. */
function mount(store: Store): { controller: NeutronChatController; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  let id = 0
  const controller = new NeutronChatController({
    projectId: null,
    createSession: (sinks) =>
      new WebChatSession({
        url: 'wss://t/ws/app/chat',
        topic_id: TOPIC,
        store,
        createSocket: () => {
          const s = new FakeSocket()
          sockets.push(s)
          return s
        },
        onChange: sinks.onChange,
        onStatus: sinks.onStatus,
        onFrame: sinks.onFrame,
        generateId: () => `cmid-${++id}`,
        now: (() => {
          let t = 0
          return () => ++t
        })(),
      }),
  })
  controller.start()
  sockets[0]!.open()
  sockets[0]!.deliver(ready())
  return { controller, sockets }
}

function promptRow(controller: NeutronChatController): { chosenValue: string | null } | undefined {
  return controller.getViewModel().messages.find((m) => m.promptId === PROMPT_ID)
}

describe('ISSUES #419 — the web surface derives spent-ness from server state', () => {
  it('a RELOAD after the server records the answer draws the prompt SPENT', async () => {
    const store = new InMemoryStore()
    const first = mount(store)
    first.sockets[0]!.deliver(retryBubble())
    await tick()
    // Live while genuinely unanswered.
    expect(promptRow(first.controller)?.chosenValue).toBeNull()

    // The owner clicks Retry: the frame goes out and the row collapses.
    const row = first.controller.getViewModel().messages.find((m) => m.promptId === PROMPT_ID)!
    first.controller.onChoose(row.id, row.promptId, RETRY_TURN_VALUE)
    expect(
      first.sockets[0]!.sent.map((s) => JSON.parse(s) as Record<string, unknown>),
    ).toContainEqual({
      v: 1,
      type: 'button_choice',
      prompt_id: PROMPT_ID,
      choice_value: RETRY_TURN_VALUE,
    })
    expect(promptRow(first.controller)?.chosenValue).toBe(RETRY_TURN_VALUE)

    // The server claims the tap and says so.
    first.sockets[0]!.deliver(promptResolved())
    await tick()
    first.controller.stop()

    // THE RELOAD: a new controller + session over the same durable store. The
    // optimistic Map is gone — this is where the old code redrew a live button.
    const second = mount(store)
    await tick()
    expect(promptRow(second.controller)?.chosenValue).toBe(RETRY_TURN_VALUE)
    second.controller.stop()
  })

  it('CONTROL — the optimistic Map alone does NOT survive the reload', async () => {
    // The defect, reproduced: click, reload WITHOUT the server's record, and the
    // button is live again. Here so the test above cannot pass for an unrelated
    // reason — it removes the server's record and shows the row goes back to live.
    const store = new InMemoryStore()
    const first = mount(store)
    first.sockets[0]!.deliver(retryBubble())
    await tick()
    const row = first.controller.getViewModel().messages.find((m) => m.promptId === PROMPT_ID)!
    first.controller.onChoose(row.id, row.promptId, RETRY_TURN_VALUE)
    expect(promptRow(first.controller)?.chosenValue).toBe(RETRY_TURN_VALUE)
    first.controller.stop()

    const second = mount(store)
    await tick()
    expect(promptRow(second.controller)?.chosenValue).toBeNull()
    second.controller.stop()
  })

  it('a COLD OPEN whose replay carries the answer draws it SPENT', async () => {
    // A different browser / cleared storage: no local row and no live
    // `prompt_resolved` to catch, so the replayed message is the only carrier.
    const { controller, sockets } = mount(new InMemoryStore())
    sockets[0]!.deliver({ ...retryBubble(), chosen_value: RETRY_TURN_VALUE })
    await tick()
    expect(promptRow(controller)?.chosenValue).toBe(RETRY_TURN_VALUE)
    controller.stop()
  })
})
