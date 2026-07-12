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
})
