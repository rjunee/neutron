import { describe, expect, test } from 'bun:test'

import {
  deliverReply,
  REPLY_HANDOFF_RETRY_MS,
  replyToolResultText,
  type ReplyDeliveryDeps,
} from '../reply-delivery.ts'

function harness(responses: Array<Response | Error>, times: number[]) {
  const requests: RequestInit[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  let call = 0
  const deps: ReplyDeliveryDeps = {
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {})
      const response = responses[call++]
      if (response instanceof Error) throw response
      if (response === undefined) throw new Error('fixture exhausted')
      return response
    }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms) },
    now: () => times.shift() ?? Number.MAX_SAFE_INTEGER,
    log: (line) => { logs.push(line) },
  }
  return { deps, requests, sleeps, logs }
}

describe('reply delivery across a gateway hand-off', () => {
  test('a deploy-time closed socket is retried and the successor receives the reply', async () => {
    const h = harness(
      [new Error('closed socket'), new Response('accepted', { status: 200 })],
      [0, 10, 20],
    )

    const outcome = await deliverReply(
      'http://127.0.0.1:1234/reply',
      'secret',
      { session_id: 's', text: 'answer', turn_id: 'i:1' },
      h.deps,
      100,
    )

    expect(outcome).toEqual({ kind: 'delivered', responseText: 'accepted' })
    expect(h.requests).toHaveLength(2)
    expect(h.sleeps).toEqual([REPLY_HANDOFF_RETRY_MS])
    expect(h.requests[1]?.body).toBe(JSON.stringify({ session_id: 's', text: 'answer', turn_id: 'i:1' }))
  })

  test('a successor rejection is transient during adoption, then delivery succeeds', async () => {
    const h = harness(
      [new Response('unauthorized', { status: 401 }), new Response('accepted', { status: 200 })],
      [0, 10, 20],
    )

    expect(await deliverReply('http://127.0.0.1:1234/reply', 'secret', {}, h.deps, 100)).toEqual({
      kind: 'delivered',
      responseText: 'accepted',
    })
    expect(h.sleeps).toEqual([REPLY_HANDOFF_RETRY_MS])
  })

  test('a peer still rejected after the hand-off window is classified as gone', async () => {
    const h = harness([new Response('unauthorized', { status: 401 })], [0, 100])

    expect(await deliverReply('http://127.0.0.1:1234/reply', 'secret', {}, h.deps, 100)).toEqual({
      kind: 'peer-gone',
    })
    expect(h.sleeps).toEqual([])
  })

  test('an unavailable sink at the deadline stays unknown rather than becoming peer-gone', async () => {
    const h = harness([new Error('closed socket')], [0, 100])

    expect(await deliverReply('http://127.0.0.1:1234/reply', 'secret', {}, h.deps, 100)).toEqual({
      kind: 'delivery-unknown',
    })
    expect(h.sleeps).toEqual([])
  })

  test('terminal tool results tell the agent to stop, never expose a connection error', () => {
    expect(replyToolResultText({ kind: 'delivered', responseText: 'accepted' })).toBe('delivered')
    expect(replyToolResultText({ kind: 'peer-gone' })).toBe(
      'The receiving turn no longer exists. Do not call reply again; end this turn now.',
    )
    expect(replyToolResultText({ kind: 'delivery-unknown' })).toBe(
      'Reply delivery could not be confirmed during a gateway restart. Do not call reply again; end this turn now.',
    )
  })
})
