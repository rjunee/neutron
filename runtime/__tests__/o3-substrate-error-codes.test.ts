/**
 * O3 — typed substrate error-code taxonomy tests.
 *
 * Pins (a) the registered code table (completeness + the "Care" retryable
 * invariants), (b) the NeutronError / SubstrateCallError shape, and (c) that
 * `collectTokensToString` surfaces a typed `SubstrateCallError` carrying the
 * event's `code` while preserving the EXACT `cc-llm-call: <prose>` message the
 * prose-reading classifiers still depend on.
 */

import { describe, test, expect } from 'bun:test'

import {
  NeutronError,
  SubstrateCallError,
  SUBSTRATE_ERROR_CODES,
} from '../errors.ts'
import type { SubstrateErrorClass } from '../events.ts'
import { collectTokensToString } from '../collect-tokens.ts'
import type { SessionHandle } from '../session-handle.ts'
import type { Event } from '../events.ts'

const ALL_CLASSES: readonly SubstrateErrorClass[] = [
  'binary_not_found',
  'channel_wedged',
  'turn_timeout',
  'auth_invalid',
  'http_status',
  'rate_limited',
  'aborted',
  'no_credentials',
  'all_cooldown',
  'oauth_refresh',
]

describe('SUBSTRATE_ERROR_CODES — registered code table', () => {
  test('has exactly one entry per SubstrateErrorClass (the runtime enumeration)', () => {
    expect(Object.keys(SUBSTRATE_ERROR_CODES).sort()).toEqual([...ALL_CLASSES].sort())
  })

  test('honours the O3 Care invariants: binary_not_found non-retryable, all_cooldown retryable', () => {
    expect(SUBSTRATE_ERROR_CODES.binary_not_found.retryable).toBe(false)
    expect(SUBSTRATE_ERROR_CODES.all_cooldown.retryable).toBe(true)
    // turn_timeout stays retryable on the same credential; channel_wedged does not.
    expect(SUBSTRATE_ERROR_CODES.turn_timeout.retryable).toBe(true)
    expect(SUBSTRATE_ERROR_CODES.channel_wedged.retryable).toBe(false)
  })

  test('every entry carries a non-empty description', () => {
    for (const cls of ALL_CLASSES) {
      expect(SUBSTRATE_ERROR_CODES[cls].description.length).toBeGreaterThan(0)
    }
  })
})

describe('NeutronError / SubstrateCallError shape', () => {
  test('NeutronError carries code + retryable + optional cause; is an Error', () => {
    const cause = new Error('root')
    const err = new NeutronError('some_code', 'boom', { retryable: true, cause })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('some_code')
    expect(err.retryable).toBe(true)
    expect(err.cause).toBe(cause)
    expect(err.message).toBe('boom')
  })

  test('SubstrateCallError narrows code to the taxonomy + carries retry_after_ms', () => {
    const err = new SubstrateCallError('cc-llm-call: HTTP 429: slow down', {
      code: 'rate_limited',
      retryable: true,
      retry_after_ms: 5_000,
    })
    expect(err).toBeInstanceOf(NeutronError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SubstrateCallError')
    expect(err.code).toBe('rate_limited')
    expect(err.retryable).toBe(true)
    expect(err.retry_after_ms).toBe(5_000)
  })

  test('an unstamped (legacy) event maps to the `unknown` sentinel code', () => {
    const err = new SubstrateCallError('cc-llm-call: whatever', { retryable: false })
    expect(err.code).toBe('unknown')
    expect(err.retry_after_ms).toBeUndefined()
  })
})

/** A one-shot SessionHandle whose iterator yields the supplied events in order. */
function fakeHandle(events: Event[]): SessionHandle {
  return {
    events: (async function* () {
      for (const ev of events) yield ev
    })(),
    respondToTool: async () => undefined,
    cancel: async () => undefined,
    tool_resolution: 'internal',
  }
}

describe('collectTokensToString — typed error surfacing', () => {
  test('throws a SubstrateCallError carrying the event code + retry hint, message preserved verbatim', async () => {
    const handle = fakeHandle([
      { kind: 'token', text: 'partial ' },
      {
        kind: 'error',
        message: 'persistent-repl: turn timeout',
        retryable: true,
        code: 'turn_timeout',
      },
    ])
    let thrown: unknown
    try {
      await collectTokensToString(handle)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(SubstrateCallError)
    const e = thrown as SubstrateCallError
    // Message prose stays EXACTLY the pre-O3 `cc-llm-call: <prose>` wording so
    // the prose-reading freeze-timeout / 429 classifiers keep matching.
    expect(e.message).toBe('cc-llm-call: persistent-repl: turn timeout')
    expect(e.code).toBe('turn_timeout')
    expect(e.retryable).toBe(true)
  })

  test('propagates retry_after_ms from the error event', async () => {
    const handle = fakeHandle([
      { kind: 'error', message: 'HTTP 429: slow down', retryable: true, code: 'rate_limited', retry_after_ms: 1234 },
    ])
    const e = (await collectTokensToString(handle).catch((x: unknown) => x)) as SubstrateCallError
    expect(e).toBeInstanceOf(SubstrateCallError)
    expect(e.retry_after_ms).toBe(1234)
    expect(e.code).toBe('rate_limited')
  })

  test('an unstamped error event still throws (code=unknown), message preserved', async () => {
    const handle = fakeHandle([{ kind: 'error', message: 'boom', retryable: false }])
    const e = (await collectTokensToString(handle).catch((x: unknown) => x)) as SubstrateCallError
    expect(e).toBeInstanceOf(SubstrateCallError)
    expect(e.message).toBe('cc-llm-call: boom')
    expect(e.code).toBe('unknown')
  })
})

describe('collectTokensToString — abort paths carry the typed `aborted` class', () => {
  test('pre-fired signal → SubstrateCallError{code:aborted}, message preserved', async () => {
    const ac = new AbortController()
    ac.abort()
    const handle = fakeHandle([{ kind: 'token', text: 'never-seen' }])
    const e = (await collectTokensToString(handle, ac.signal).catch((x: unknown) => x)) as SubstrateCallError
    expect(e).toBeInstanceOf(SubstrateCallError)
    expect(e.code).toBe('aborted')
    expect(e.retryable).toBe(false)
    expect(e.message).toBe('cc-llm-call: aborted before dispatch')
  })

  test('pre-fired signal with a REJECTING cancel() → still throws the typed aborted error (the cancel failure must NOT escape)', async () => {
    // The typed `aborted` error is the contract on an aborted signal, regardless
    // of whether cancel() itself succeeds. A cancel() that rejects must be
    // swallowed so its arbitrary rejection never masks the typed error.
    // Mutation-check: removing the `.catch(() => undefined)` on the pre-fired path
    // makes this reject with `cancel failed` instead — turning this test red.
    const ac = new AbortController()
    ac.abort()
    const handle: SessionHandle = {
      events: (async function* () {
        yield { kind: 'token', text: 'never-seen' }
      })(),
      respondToTool: async () => undefined,
      cancel: () => Promise.reject(new Error('cancel failed')),
      tool_resolution: 'internal',
    }
    const e = (await collectTokensToString(handle, ac.signal).catch((x: unknown) => x)) as SubstrateCallError
    expect(e).toBeInstanceOf(SubstrateCallError)
    expect(e.code).toBe('aborted')
    expect(e.message).toBe('cc-llm-call: aborted before dispatch')
    expect((e as Error).message).not.toContain('cancel failed')
  })

  test('mid-stream abort → SubstrateCallError{code:aborted}', async () => {
    const ac = new AbortController()
    let cancelCalled = false
    // Yields one token, then waits for cancel() to close the source.
    const handle: SessionHandle = {
      events: (async function* () {
        yield { kind: 'token', text: 'partial' }
        await new Promise<void>((resolve) => {
          const tick = setInterval(() => {
            if (cancelCalled) {
              clearInterval(tick)
              resolve()
            }
          }, 1)
        })
      })(),
      respondToTool: async () => undefined,
      cancel: async () => {
        cancelCalled = true
      },
      tool_resolution: 'internal',
    }
    const consumer = collectTokensToString(handle, ac.signal)
    await Promise.resolve()
    ac.abort()
    const e = (await consumer.catch((x: unknown) => x)) as SubstrateCallError
    expect(e).toBeInstanceOf(SubstrateCallError)
    expect(e.code).toBe('aborted')
    expect(e.message).toBe('cc-llm-call: aborted')
  })

  test('iterator closes AFTER cancel (no terminal event) → still SubstrateCallError{code:aborted}', async () => {
    const ac = new AbortController()
    let cancelCalled = false
    // Fire abort BEFORE the first token, then end the iterator naturally (as
    // cancel() would) with NO completion/error event — the close-after-cancel
    // path (`if (aborted)` after the loop) must still throw the typed abort.
    const handle: SessionHandle = {
      events: (async function* () {
        await new Promise<void>((resolve) => {
          const tick = setInterval(() => {
            if (cancelCalled) {
              clearInterval(tick)
              resolve()
            }
          }, 1)
        })
        // Iterator ends naturally after cancel — no terminal event.
      })(),
      respondToTool: async () => undefined,
      cancel: async () => {
        cancelCalled = true
      },
      tool_resolution: 'internal',
    }
    const consumer = collectTokensToString(handle, ac.signal)
    await Promise.resolve()
    ac.abort()
    const e = (await consumer.catch((x: unknown) => x)) as SubstrateCallError
    expect(e).toBeInstanceOf(SubstrateCallError)
    expect(e.code).toBe('aborted')
    expect(e.message).toBe('cc-llm-call: aborted')
  })
})
