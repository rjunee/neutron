/**
 * O8 — the single `drainToText` / `drainToOutcome` drain: three-adapter
 * equivalence + policy-flag mutation suite.
 *
 * The plan asks that the ONE drain iterate IDENTICALLY across substrate adapters
 * with different iterator shapes. We pin three faithful shapes:
 *
 *   1. `cc`    — backed by the REAL persistent-REPL `EventChannel` (push/pull,
 *                and — faithfully — NO finally→cancel hookup, which is exactly the
 *                property that makes an early `cancel()` on an unsettled turn
 *                poison the warm session).
 *   2. `gen`   — a native `async function*` generator (the gpt-5-5-api adapter's
 *                shape: it `yield`s each `Event`).
 *   3. `array` — a hand-rolled async iterator over an array, exposing `return()`
 *                (a third, minimal substrate shape).
 *
 * All three must drain to the SAME text, classify a 429 the SAME way, and treat
 * exhaustion the SAME way. Then we mutation-verify the two load-bearing policy
 * flags: flipping `treatErrorAs` or `keepAliveExempt` turns the relevant
 * assertion RED.
 */

import { describe, test, expect } from 'bun:test'

import { drainToText, drainToOutcome } from '../substrate-text.ts'
import { SubstrateCallError } from '../errors.ts'
import type { SessionHandle } from '../session-handle.ts'
import type { Event } from '../events.ts'
import { EventChannel } from '../adapters/claude-code/persistent/event-channel.ts'

type AdapterKind = 'cc' | 'gen' | 'array'
const ADAPTERS: readonly AdapterKind[] = ['cc', 'gen', 'array']

interface Spy {
  cancels: number
  returns: number
}

const completion = (): Event => ({
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 },
  substrate_instance_id: 'test-instance',
})

const SEQ_OK: Event[] = [
  { kind: 'token', text: 'Hello ' },
  { kind: 'thinking', text: '(pondering)' },
  { kind: 'token', text: 'world' },
  completion(),
]
const SEQ_429: Event[] = [
  { kind: 'token', text: 'partial' },
  { kind: 'error', message: 'HTTP 429: slow down', retryable: true, code: 'rate_limited', retry_after_ms: 4200 },
]
const SEQ_EXHAUST: Event[] = [{ kind: 'token', text: 'abc' }]

/**
 * Build a SessionHandle of the given adapter shape that yields `events` then
 * ends. `spy.cancels` counts EXPLICIT `handle.cancel()` calls; `spy.returns`
 * counts iterator `return()` calls (teardown). No shape wires `return()`→
 * `cancel()`, so the two counters isolate what the drain does on its own.
 */
function makeHandle(kind: AdapterKind, events: Event[], spy: Spy): SessionHandle {
  const cancel = async (): Promise<void> => {
    spy.cancels += 1
  }
  if (kind === 'cc') {
    const ch = new EventChannel()
    for (const ev of events) ch.push(ev)
    ch.close()
    // Wrap the channel iterator so we can count return() without a cancel hookup.
    const base = ch[Symbol.asyncIterator]()
    const events_: AsyncIterable<Event> = {
      [Symbol.asyncIterator]: () => ({
        next: () => base.next(),
        return: async (v?: unknown): Promise<IteratorResult<Event>> => {
          spy.returns += 1
          await base.return?.(v as Event)
          return { value: undefined, done: true }
        },
      }),
    }
    return { events: events_, respondToTool: async () => undefined, cancel, tool_resolution: 'internal' }
  }
  if (kind === 'gen') {
    async function* gen(): AsyncGenerator<Event> {
      for (const ev of events) yield ev
    }
    const g = gen()
    const events_: AsyncIterable<Event> = {
      [Symbol.asyncIterator]: () => ({
        next: () => g.next(),
        return: async (v?: unknown): Promise<IteratorResult<Event>> => {
          spy.returns += 1
          return g.return(v as never)
        },
      }),
    }
    return { events: events_, respondToTool: async () => undefined, cancel, tool_resolution: 'internal' }
  }
  // array
  let i = 0
  const events_: AsyncIterable<Event> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Event>> =>
        i < events.length ? { value: events[i++]!, done: false } : { value: undefined, done: true },
      return: async (): Promise<IteratorResult<Event>> => {
        spy.returns += 1
        return { value: undefined, done: true }
      },
    }),
  }
  return { events: events_, respondToTool: async () => undefined, cancel, tool_resolution: 'internal' }
}

const newSpy = (): Spy => ({ cancels: 0, returns: 0 })

describe('O8 drainToText — three-adapter equivalence', () => {
  test('same text out on a clean completion across all three adapters', async () => {
    const outs: string[] = []
    for (const kind of ADAPTERS) {
      const spy = newSpy()
      outs.push(await drainToText(makeHandle(kind, SEQ_OK, spy), { errorPrefix: 'x: ' }))
      // No explicit cancel on the happy path — teardown is iterator.return() only
      // (poison-safe: completion already settled the turn).
      expect(spy.cancels).toBe(0)
      expect(spy.returns).toBe(1)
    }
    expect(outs).toEqual(['Hello world', 'Hello world', 'Hello world'])
  })

  test('same 429 classification (SubstrateCallError code/retryable/retry_after_ms + prose) across all three', async () => {
    for (const kind of ADAPTERS) {
      const spy = newSpy()
      const err = (await drainToText(makeHandle(kind, SEQ_429, spy), { errorPrefix: 'cc-llm-call: ' }).catch(
        (e: unknown) => e,
      )) as SubstrateCallError
      expect(err).toBeInstanceOf(SubstrateCallError)
      expect(err.code).toBe('rate_limited')
      expect(err.retryable).toBe(true)
      expect(err.retry_after_ms).toBe(4200)
      expect(err.message).toBe('cc-llm-call: HTTP 429: slow down')
    }
  })

  test('same exhaustion behaviour (no completion → status exhausted) across all three', async () => {
    for (const kind of ADAPTERS) {
      const spy = newSpy()
      const outcome = await drainToOutcome(makeHandle(kind, SEQ_EXHAUST, spy))
      expect(outcome.status).toBe('exhausted')
      expect(outcome.text).toBe('abc')
    }
  })

  test('requireCompletion turns exhaustion into a throw, identically across all three', async () => {
    for (const kind of ADAPTERS) {
      const spy = newSpy()
      const err = (await drainToText(makeHandle(kind, SEQ_EXHAUST, spy), {
        errorPrefix: 'email_managed_core substrate ',
        requireCompletion: true,
        exhaustedMessage: 'stream ended without a completion event',
      }).catch((e: unknown) => e)) as SubstrateCallError
      expect(err).toBeInstanceOf(SubstrateCallError)
      expect(err.message).toBe('email_managed_core substrate stream ended without a completion event')
    }
  })

  test('onFirstToken fires exactly once on the first non-empty token, across all three', async () => {
    for (const kind of ADAPTERS) {
      const spy = newSpy()
      let firstTokens = 0
      await drainToText(makeHandle(kind, SEQ_OK, spy), { onFirstToken: () => (firstTokens += 1) })
      expect(firstTokens).toBe(1)
    }
  })
})

/** A handle that yields one token then HANGS (never settles) — for abort tests. */
function hangingHandle(spy: Spy): SessionHandle {
  const ch = new EventChannel()
  ch.push({ kind: 'token', text: 'partial' })
  // deliberately not closed → the iterator's next pull blocks forever.
  return {
    events: ch,
    respondToTool: async () => undefined,
    cancel: async () => {
      spy.cancels += 1
      ch.close()
    },
    tool_resolution: 'internal',
  }
}

describe('O8 — warm-CC poison invariant (drain to exhaustion, never early-cancel)', () => {
  test('the DEFAULT path never calls cancel() before a terminal event', async () => {
    for (const kind of ADAPTERS) {
      const spy = newSpy()
      await drainToText(makeHandle(kind, SEQ_OK, spy))
      expect(spy.cancels).toBe(0) // completion settled the turn; no mid-turn cancel
    }
  })

  test('keepAliveExempt=false aborts WITHOUT cancelling a live turn (no poison)', async () => {
    const spy = newSpy()
    const ac = new AbortController()
    const p = drainToOutcome(hangingHandle(spy), { signal: ac.signal, keepAliveExempt: false })
    await Promise.resolve()
    ac.abort()
    const outcome = await p
    expect(outcome.status).toBe('aborted')
    expect(outcome.text).toBe('partial')
    // The load-bearing guarantee: a default drain leaves the warm turn running.
    expect(spy.cancels).toBe(0)
  })

  test('MUTATION: keepAliveExempt=true DOES cancel the live turn on abort (watchdog divergence)', async () => {
    const spy = newSpy()
    const ac = new AbortController()
    const p = drainToOutcome(hangingHandle(spy), { signal: ac.signal, keepAliveExempt: true })
    await Promise.resolve()
    ac.abort()
    const outcome = await p
    expect(outcome.status).toBe('aborted')
    // Flip the flag → this count flips 1↔0, so the mutation is caught here + above.
    expect(spy.cancels).toBe(1)
  })
})

describe('O8 — treatErrorAs mutation', () => {
  test('treatErrorAs=throw (default) throws on a terminal error', async () => {
    const spy = newSpy()
    const thrown = await drainToText(makeHandle('gen', SEQ_429, spy), { errorPrefix: 'x: ' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(SubstrateCallError)
  })

  test('MUTATION: treatErrorAs=capture does NOT throw — returns the partial text', async () => {
    const spy = newSpy()
    const text = await drainToText(makeHandle('gen', SEQ_429, spy), { errorPrefix: 'x: ', treatErrorAs: 'capture' })
    // Flipping the flag flips throw↔return, so removing the flag handling reddens
    // exactly one of this pair.
    expect(text).toBe('partial')
  })

  test('drainToOutcome capture mode carries the SubstrateCallError on the outcome', async () => {
    const spy = newSpy()
    const outcome = await drainToOutcome(makeHandle('array', SEQ_429, spy), { errorPrefix: 'x: ' })
    expect(outcome.status).toBe('error')
    expect(outcome.error).toBeInstanceOf(SubstrateCallError)
    expect(outcome.error?.code).toBe('rate_limited')
    expect(outcome.text).toBe('partial')
  })
})

describe('O8 — pre-dispatch abort', () => {
  test('an already-aborted signal returns/throws without pulling an event', async () => {
    const spy = newSpy()
    const ac = new AbortController()
    ac.abort()
    const err = (await drainToText(makeHandle('gen', SEQ_OK, spy), {
      signal: ac.signal,
      abortBeforeDispatchMessage: 'x: aborted before dispatch',
      keepAliveExempt: true,
    }).catch((e: unknown) => e)) as SubstrateCallError
    expect(err).toBeInstanceOf(SubstrateCallError)
    expect(err.code).toBe('aborted')
    expect(err.message).toBe('x: aborted before dispatch')
    expect(spy.cancels).toBe(1) // keepAliveExempt cancels even the pre-dispatch abort
  })
})
