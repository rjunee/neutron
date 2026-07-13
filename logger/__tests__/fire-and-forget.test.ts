// F3 — fireAndForget wrapper + process-level safety net.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  describeRejection,
  fireAndForget,
  fireAndForgetRejectionCount,
  installProcessSafetyNet,
  isProcessSafetyNetInstalled,
  resetFireAndForgetCountForTests,
  resetProcessSafetyNetForTests,
} from '../fire-and-forget.ts'

// Capture the default sink (error → console.error) so we can assert the log.
let errorLines: string[] = []
const realConsoleError = console.error
beforeEach(() => {
  errorLines = []
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map((a) => String(a)).join(' '))
  }
  resetFireAndForgetCountForTests()
  resetProcessSafetyNetForTests()
})
afterEach(() => {
  console.error = realConsoleError
  resetFireAndForgetCountForTests()
  resetProcessSafetyNetForTests()
})

/** Let all attached microtasks (the wrapper's `.catch`) run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('fireAndForget', () => {
  test('logs + counts on rejection and does NOT rethrow', async () => {
    fireAndForget('unit.reject', Promise.reject(new Error('boom')))
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(1)
    const line = errorLines.find((l) => l.includes('rejected'))
    expect(line).toBeDefined()
    expect(line).toContain('name=unit.reject')
    expect(line).toContain('boom')
  })

  test('a rejecting promise passed to it never becomes an unhandled rejection', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const reason = new Error('would-be-unhandled')
      fireAndForget('unit.unhandled', Promise.reject(reason))
      await flush()
      await flush()
      expect(seen).not.toContain(reason)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('does not log or count for a resolving promise', async () => {
    fireAndForget('unit.ok', Promise.resolve(42))
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(0)
    expect(errorLines.find((l) => l.includes('rejected'))).toBeUndefined()
  })

  test('no-ops on null / undefined (the void-maybe-promise idiom)', async () => {
    fireAndForget('unit.null', null)
    fireAndForget('unit.undef', undefined)
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(0)
  })

  test('counts each rejection independently', async () => {
    fireAndForget('unit.a', Promise.reject(new Error('a')))
    fireAndForget('unit.b', Promise.reject('b-string'))
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(2)
  })

  // Blocker boundary: the wrapper's OWN log path must not turn an observability
  // failure into the unhandled rejection it promises to prevent.
  test('a throwing log sink is contained — no unhandled rejection, fallback attempted', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    // Primary sink (logger → console.error) throws on its first call; the
    // fallback console.error is captured on the second.
    let calls = 0
    const fallbackCaptured: string[] = []
    console.error = (...args: unknown[]) => {
      calls += 1
      if (calls === 1) throw new Error('sink failed')
      fallbackCaptured.push(args.map((a) => String(a)).join(' '))
    }
    try {
      const reason = new Error('original')
      fireAndForget('unit.throwing-sink', Promise.reject(reason))
      await flush()
      await flush()
      expect(seen).not.toContain(reason) // wrapper's .catch never rejected
      expect(fireAndForgetRejectionCount()).toBe(1) // counter independent of sink
      expect(fallbackCaptured.find((l) => l.includes('log sink threw'))).toBeDefined()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('even a fully broken sink (primary AND fallback throw) never rejects', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    console.error = () => {
      throw new Error('everything is broken')
    }
    try {
      const reason = new Error('original')
      fireAndForget('unit.broken-sink', Promise.reject(reason))
      await flush()
      await flush()
      expect(seen).not.toContain(reason)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('describeRejection', () => {
  test('renders an Error via its stack', () => {
    const out = describeRejection(new Error('kaboom'))
    expect(out).toContain('kaboom')
  })
  test('stringifies a non-Error', () => {
    expect(describeRejection('plain')).toBe('plain')
    expect(describeRejection(7)).toBe('7')
  })
})

describe('installProcessSafetyNet', () => {
  const countListeners = (ev: 'unhandledRejection' | 'uncaughtException') =>
    process.listeners(ev).length

  test('installs one unhandledRejection + one uncaughtException handler', () => {
    const beforeR = countListeners('unhandledRejection')
    const beforeE = countListeners('uncaughtException')
    expect(isProcessSafetyNetInstalled()).toBe(false)
    installProcessSafetyNet({ onUncaught: () => {} })
    expect(isProcessSafetyNetInstalled()).toBe(true)
    expect(countListeners('unhandledRejection')).toBe(beforeR + 1)
    expect(countListeners('uncaughtException')).toBe(beforeE + 1)
  })

  test('is idempotent — a second install adds no listener', () => {
    installProcessSafetyNet({ onUncaught: () => {} })
    const afterFirstR = countListeners('unhandledRejection')
    const afterFirstE = countListeners('uncaughtException')
    installProcessSafetyNet({ onUncaught: () => {} })
    expect(countListeners('unhandledRejection')).toBe(afterFirstR)
    expect(countListeners('uncaughtException')).toBe(afterFirstE)
  })

  test('reset removes the handlers so the guard can be re-armed', () => {
    const beforeR = countListeners('unhandledRejection')
    installProcessSafetyNet({ onUncaught: () => {} })
    resetProcessSafetyNetForTests()
    expect(isProcessSafetyNetInstalled()).toBe(false)
    expect(countListeners('unhandledRejection')).toBe(beforeR)
  })

  test('uncaughtException handler LOGS then calls onUncaught (log-then-crash)', () => {
    let crashed: Error | undefined
    installProcessSafetyNet({ onUncaught: (err) => (crashed = err) })
    // The last-installed uncaughtException listener is ours.
    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => void
    const boom = new Error('fatal')
    handler(boom)
    expect(crashed).toBe(boom)
    expect(errorLines.find((l) => l.includes('uncaught_exception'))).toBeDefined()
  })

  test('unhandledRejection handler LOGS and does not exit', () => {
    installProcessSafetyNet({ onUncaught: () => {} })
    const handler = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void
    handler(new Error('stray'))
    const line = errorLines.find((l) => l.includes('unhandled_rejection'))
    expect(line).toBeDefined()
    expect(line).toContain('stray')
  })

  // Blocker boundary: a throwing log sink must NOT skip the log-then-crash
  // policy — `onUncaught` is guaranteed via `finally`.
  test('uncaughtException calls onUncaught even when logging throws', () => {
    let crashed: Error | undefined
    console.error = () => {
      throw new Error('log sink down')
    }
    installProcessSafetyNet({ onUncaught: (err) => (crashed = err) })
    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => void
    const boom = new Error('fatal-with-broken-log')
    expect(() => handler(boom)).not.toThrow() // handler never propagates the log failure
    expect(crashed).toBe(boom) // crash policy still ran
  })

  test('unhandledRejection handler survives a throwing log sink', () => {
    console.error = () => {
      throw new Error('log sink down')
    }
    installProcessSafetyNet({ onUncaught: () => {} })
    const handler = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void
    expect(() => handler(new Error('stray'))).not.toThrow()
  })
})
