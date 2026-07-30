/**
 * @neutronai/chat-core — the send queue must work on a runtime WITHOUT WebCrypto.
 *
 * THE REGRESSION THIS LOCKS. `SendQueue`'s default id generator called
 * `crypto.randomUUID()` directly. React Native 0.81 does not install a global
 * `crypto`, and Expo SDK 54's WinterCG shim installs `TextDecoder`/`URL`/
 * `structuredClone` but not WebCrypto — so on device that call was a
 * `TypeError`, thrown from `enqueue()` BEFORE the optimistic row was written.
 * Mobile chat therefore had no bubble, no outbound frame, no server row and no
 * log for every message the owner ever typed; production confirmed it (zero
 * user rows with a non-browser `client_msg_id`, ever).
 *
 * Every test in this file deletes `globalThis.crypto` for its duration, which
 * is the only faithful model of the device runtime — the rest of the suite runs
 * under Bun, where WebCrypto exists and this bug is invisible.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { SendQueue } from '../send-queue.ts'
import { InMemoryStore } from '../store.ts'
import { randomId } from '../ids.ts'

const realCrypto = globalThis.crypto

/** Model the device: no global `crypto` at all. */
function removeWebCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    configurable: true,
    writable: true,
  })
}

function restoreWebCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', {
    value: realCrypto,
    configurable: true,
    writable: true,
  })
}

describe('SendQueue on a runtime without WebCrypto (the device)', () => {
  beforeEach(removeWebCrypto)
  afterEach(restoreWebCrypto)

  it('enqueues a message and writes the optimistic row', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store)

    const msg = await queue.enqueue({ topic_id: 'app:harness-owner', body: 'does this leave the phone?' })

    expect(msg.client_msg_id.length).toBeGreaterThan(0)
    expect(msg.status).toBe('queued')
    // The optimistic row must be READABLE — that row is the bubble the owner
    // sees before any server round-trip.
    const stored = await store.getByClientMsgId('app:harness-owner', msg.client_msg_id)
    expect(stored).not.toBeNull()
    expect(stored?.body).toBe('does this leave the phone?')
  })

  it('flushes the queued message to the transport', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store)
    await queue.enqueue({ topic_id: 'app:harness-owner', body: 'ping' })

    const sent: unknown[] = []
    const flushed = await queue.flush((env) => {
      sent.push(env)
    }, 'app:harness-owner')

    expect(flushed).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect((sent[0] as { type: string }).type).toBe('user_message')
  })

  it('mints distinct ids across many enqueues (the fallback must not collide)', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store)
    const ids = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const msg = await queue.enqueue({ topic_id: 'app:harness-owner', body: `m${i}` })
      ids.add(msg.client_msg_id)
    }
    expect(ids.size).toBe(500)
  })

  it('`randomId()` never throws and never returns an empty string', () => {
    for (let i = 0; i < 50; i++) {
      const id = randomId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(8)
    }
  })

  it('`randomId()` survives a crypto object that exposes randomUUID but throws', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: (): string => {
          throw new Error('not available in this runtime')
        },
      },
      configurable: true,
      writable: true,
    })
    expect(randomId().length).toBeGreaterThan(8)
  })
})

describe('SendQueue with WebCrypto present (the browser) still works', () => {
  it('uses the real generator and produces unique ids', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store)
    const a = await queue.enqueue({ topic_id: 'app:harness-owner', body: 'a' })
    const b = await queue.enqueue({ topic_id: 'app:harness-owner', body: 'b' })
    expect(a.client_msg_id).not.toBe(b.client_msg_id)
  })
})
