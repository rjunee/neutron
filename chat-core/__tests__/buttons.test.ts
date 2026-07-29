/**
 * P1b (onboarding / quick-reply buttons) — chat-core coverage:
 *   - normalizeInbound preserves the agent-message button metadata
 *     (options / prompt_id / allow_freeform / kind / upload_affordance) and
 *     drops nothing on a plain user message (back-compat);
 *   - the metadata survives applyInbound → store → list (so the render layer
 *     can read it off ChatMessage);
 *   - WebChatSession.sendButtonChoice puts a `button_choice` frame on the wire.
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { SyncEngine } from '../sync-engine.ts'
import { normalizeInbound } from '../types.ts'
import { WebChatSession } from '../web-session.ts'
import type { SocketLike } from '../ws-client.ts'

const TOPIC = 'app:sam'

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
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((e) => e['type'] === type)
  }
}

describe('normalizeInbound — onboarding button metadata', () => {
  it('preserves options/prompt_id/allow_freeform/kind/upload_affordance on an agent_message', () => {
    const env = {
      v: 1,
      type: 'agent_message',
      message_id: 'm1',
      seq: 3,
      ts: 9,
      body: 'Choose an avatar',
      prompt_id: 'p1',
      allow_freeform: true,
      kind: 'image-gallery',
      upload_affordance: { source: 'chatgpt' },
      options: [
        { label: 'A', body: 'A', value: 'a', image_url: 'https://x/a.png', decoration: { style: 'primary' } },
        { label: 'Skip', body: 'Skip', value: 'skip' },
      ],
    }
    const msg = normalizeInbound(env)
    expect(msg).not.toBeNull()
    expect(msg?.role).toBe('agent')
    expect(msg?.options?.length).toBe(2)
    expect(msg?.options?.[0]).toEqual({
      label: 'A',
      body: 'A',
      value: 'a',
      image_url: 'https://x/a.png',
      decoration: { style: 'primary' },
    })
    expect(msg?.options?.[1]).toEqual({ label: 'Skip', body: 'Skip', value: 'skip' })
    expect(msg?.prompt_id).toBe('p1')
    expect(msg?.allow_freeform).toBe(true)
    expect(msg?.kind).toBe('image-gallery')
    expect(msg?.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  it('defaults a missing option body to its label and drops malformed options', () => {
    const msg = normalizeInbound({
      v: 1,
      type: 'agent_message',
      message_id: 'm2',
      body: 'Pick',
      ts: 1,
      kind: 'buttons',
      options: [{ label: 'Yes', value: 'yes' }, { label: 'no-value' }, 42, null],
    })
    expect(msg?.options).toEqual([{ label: 'Yes', body: 'Yes', value: 'yes' }])
    expect(msg?.kind).toBe('buttons')
  })

  it('omits button metadata for a plain user_message (back-compat)', () => {
    const msg = normalizeInbound({ v: 1, type: 'user_message', message_id: 'u1', body: 'hi', ts: 1 })
    expect(msg?.options).toBeUndefined()
    expect(msg?.prompt_id).toBeUndefined()
    expect(msg?.allow_freeform).toBeUndefined()
    expect(msg?.kind).toBeUndefined()
    expect(msg?.upload_affordance).toBeUndefined()
  })
})

describe('SyncEngine — button metadata survives apply → store', () => {
  it('carries options/prompt_id/kind onto the stored ChatMessage', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    const env = normalizeInbound({
      v: 1,
      type: 'agent_message',
      message_id: 'm1',
      seq: 1,
      ts: 1,
      body: 'Pick one',
      prompt_id: 'p1',
      allow_freeform: false,
      kind: 'buttons',
      options: [
        { label: 'Yes', body: 'Yes', value: 'yes' },
        { label: 'No', body: 'No', value: 'no' },
      ],
    })
    expect(env).not.toBeNull()
    await engine.applyInbound(TOPIC, env!)
    const [msg] = await store.list(TOPIC)
    expect(msg?.options?.map((o) => o.value)).toEqual(['yes', 'no'])
    expect(msg?.prompt_id).toBe('p1')
    expect(msg?.allow_freeform).toBe(false)
    expect(msg?.kind).toBe('buttons')

    // A metadata-less re-delivery (e.g. a receipt re-upsert) must not drop the
    // options that were already applied.
    await engine.applyInbound(
      TOPIC,
      normalizeInbound({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, ts: 1, body: 'Pick one' })!,
    )
    const [again] = await store.list(TOPIC)
    expect(again?.options?.map((o) => o.value)).toEqual(['yes', 'no'])
  })
})

describe('WebChatSession.sendButtonChoice', () => {
  it('posts a button_choice frame carrying value + prompt_id', () => {
    const sockets: FakeSocket[] = []
    const session = new WebChatSession({
      url: 'wss://t/ws/app/chat',
      topic_id: TOPIC,
      store: new InMemoryStore(),
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    session.start()
    sockets[0]!.open()
    const ok = session.sendButtonChoice('p1', 'yes')
    expect(ok).toBe(true)
    expect(sockets[0]!.frames('button_choice')).toContainEqual({
      v: 1,
      type: 'button_choice',
      prompt_id: 'p1',
      choice_value: 'yes',
    })
  })

  it('includes freeform_text when provided and rejects empty ids', () => {
    const sockets: FakeSocket[] = []
    const session = new WebChatSession({
      url: 'wss://t/ws/app/chat',
      topic_id: TOPIC,
      store: new InMemoryStore(),
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    session.start()
    sockets[0]!.open()
    expect(session.sendButtonChoice('', 'yes')).toBe(false)
    expect(session.sendButtonChoice('p1', '')).toBe(false)
    session.sendButtonChoice('p1', 'other', 'a custom answer')
    expect(sockets[0]!.frames('button_choice')).toContainEqual({
      v: 1,
      type: 'button_choice',
      prompt_id: 'p1',
      choice_value: 'other',
      freeform_text: 'a custom answer',
    })
  })
})
