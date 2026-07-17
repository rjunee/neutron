/**
 * D3 (2026-07) — relocated from the dissolved `chat-bridge.test.ts` to sit
 * with its module `gateway/http/chat-sender-registry.ts` (extracted in K11a1;
 * its test had lingered in the chat-bridge suite).
 */

import { describe, expect, test } from 'bun:test'
import { InMemoryWebChatSenderRegistry } from '../chat-sender-registry.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'

describe('InMemoryWebChatSenderRegistry', () => {
  test('register + send delivers to the registered callback', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const sent: ChatOutbound[] = []
    reg.register('web:u-1', (e) => sent.push(e))
    const ok = reg.send('web:u-1', { type: 'agent_message', body: 'hi' })
    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    const first = sent[0]
    if (first === undefined || first.type !== 'agent_message') throw new Error('expected agent_message')
    expect(first.body).toBe('hi')
  })
  test('send returns false when no sender is registered', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    expect(reg.send('web:u-missing', { type: 'agent_message', body: 'hi' })).toBe(false)
  })
  test('register replaces a stale sender on reconnect', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const first: ChatOutbound[] = []
    const second: ChatOutbound[] = []
    reg.register('web:u-1', (e) => first.push(e))
    reg.register('web:u-1', (e) => second.push(e))
    reg.send('web:u-1', { type: 'agent_message', body: 'hi' })
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })
  test('unregister removes the sender when ref matches', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const sendFn = (): void => {}
    reg.register('web:u-1', sendFn)
    reg.unregister('web:u-1', sendFn)
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'hi' })).toBe(false)
  })
  test('unregister is a no-op when a different sender is currently registered (identity-aware — Argus Sprint 18 r1 BLOCKING)', () => {
    // Replay-loser / old-socket scenario: tap A registers, tap B replaces
    // (concurrent reconnect or race-loser overwrite), then tap A's
    // catch-path or close-fire calls unregister. The new winner B's
    // sender must survive.
    const reg = new InMemoryWebChatSenderRegistry()
    const sentA: ChatOutbound[] = []
    const sentB: ChatOutbound[] = []
    const sendA = (e: ChatOutbound): void => {
      sentA.push(e)
    }
    const sendB = (e: ChatOutbound): void => {
      sentB.push(e)
    }
    reg.register('web:u-1', sendA)
    reg.register('web:u-1', sendB) // newer registration wins
    // Old/loser tries to unregister with its own send ref — must be a
    // no-op so the winner B keeps its routing.
    reg.unregister('web:u-1', sendA)
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'hi' })).toBe(true)
    expect(sentB).toHaveLength(1)
    expect(sentA).toHaveLength(0)
  })
  test('unregister with stale ref after current sender already gone is a no-op', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const sendA = (): void => {}
    reg.register('web:u-1', sendA)
    reg.unregister('web:u-1', sendA)
    // Calling unregister again with the same stale ref is harmless.
    reg.unregister('web:u-1', sendA)
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'x' })).toBe(false)
  })
  test('send PROPAGATES a throwing sender — MUST NOT swallow (T10; INVARIANTS #36/#70)', () => {
    // LOAD-BEARING guarantee: when the per-socket sender throws (closed WS),
    // send() RE-THROWS so the onboarding engine's `sendButtonPrompt` converts it
    // to `InterviewError('send_failed')`, leaves the row's `delivered_at` NULL,
    // and reconnect re-emit recovers the user. Catching here silently downgrades
    // a delivery failure to a wrongly-stamped `delivered` row (the T10 silent-drop
    // class). This assertion DISCRIMINATES where deliver.test cannot: wrapping
    // `sender(event)` in a swallowing try/catch in the source — whether it then
    // returns true OR false — makes this expectation FAIL (mutation-kill), while
    // deliver's best-effort push already swallows the throw so its
    // `delivered_live:false` assertion stays green under the try/catch→false form.
    const reg = new InMemoryWebChatSenderRegistry()
    reg.register('web:u-1', () => {
      throw new Error('closed ws')
    })
    expect(() => reg.send('web:u-1', { type: 'agent_message', body: 'hi' })).toThrow('closed ws')
  })
})
