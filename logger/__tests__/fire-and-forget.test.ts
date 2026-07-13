// F3 — fireAndForget wrapper + process-level safety net.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  describeRejection,
  fireAndForget,
  fireAndForgetRejectionCount,
  installProcessSafetyNet,
  isProcessSafetyNetInstalled,
  neutralizeAbandonedSettle,
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

  // P1 #2 (Codex): the wrapper must accept ANY thenable — incl. a standards
  // `PromiseLike` with NO `.catch` — since the lint flags any callable-`then`.
  test('accepts a bare thenable (no .catch): rejects → logs+counts, no sync throw', async () => {
    const bareThenable: PromiseLike<never> = {
      then(_onFulfilled, onRejected) {
        onRejected?.(new Error('thenable-boom'))
        return undefined as never
      },
    }
    // A bare `bareThenable.catch(...)` would throw TypeError; the wrapper must not.
    expect(() => fireAndForget('unit.thenable', bareThenable)).not.toThrow()
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(1)
    expect(errorLines.find((l) => l.includes('name=unit.thenable'))).toBeDefined()
  })

  test('a PromiseLike<void> typechecks as an argument', () => {
    // Compile-time assertion: this must not be a tsc error.
    const pl: PromiseLike<void> = Promise.resolve()
    fireAndForget('unit.promiselike', pl)
    expect(true).toBe(true)
  })

  // Structural fix (Codex final): onError replaces the pre-wrapper .catch — the
  // wrapper ALWAYS counts+logs, THEN calls onError with the rejection.
  test('onError runs with the rejection AND the count + structured log still fire', async () => {
    let seen: unknown
    fireAndForget('unit.onerror', Promise.reject(new Error('boom')), (err) => {
      seen = err
    })
    await flush()
    expect((seen as Error).message).toBe('boom') // onError got the rejection
    expect(fireAndForgetRejectionCount()).toBe(1) // counted
    expect(errorLines.find((l) => l.includes('name=unit.onerror'))).toBeDefined() // logged
  })

  test('onError runs AFTER the count + structured log (order)', async () => {
    let countAtOnError = -1
    let loggedAtOnError = false
    fireAndForget('unit.order', Promise.reject(new Error('boom')), () => {
      countAtOnError = fireAndForgetRejectionCount()
      loggedAtOnError = errorLines.some((l) => l.includes('name=unit.order'))
    })
    await flush()
    expect(countAtOnError).toBe(1) // count already bumped before onError
    expect(loggedAtOnError).toBe(true) // structured log already emitted before onError
  })

  test('a throwing onError does NOT break the safety path (no unhandled rejection)', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const reason = new Error('boom')
      expect(() =>
        fireAndForget('unit.throwing-onerror', Promise.reject(reason), () => {
          throw new Error('onError blew up')
        }),
      ).not.toThrow()
      await flush()
      await flush()
      expect(seen).not.toContain(reason)
      expect(fireAndForgetRejectionCount()).toBe(1) // still counted despite onError throwing
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  // P1 #1 (Codex): an ASYNC onError returns a promise; if it REJECTS, the wrapper
  // must swallow it too — a `try/catch` around a sync call can't. No unhandled
  // rejection; count/log still fire.
  test('an async-rejecting onError does NOT create an unhandled rejection (count/log still fire)', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      fireAndForget('unit.async-onerror', Promise.reject(new Error('boom')), async () => {
        throw new Error('async-handler-rejected')
      })
      await flush()
      await flush()
      const leaked = seen.some(
        (r) => r instanceof Error && r.message === 'async-handler-rejected',
      )
      expect(leaked).toBe(false) // the async onError's rejection was contained
      expect(fireAndForgetRejectionCount()).toBe(1)
      expect(errorLines.find((l) => l.includes('name=unit.async-onerror'))).toBeDefined()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('counts each rejection independently', async () => {
    fireAndForget('unit.a', Promise.reject(new Error('a')))
    fireAndForget('unit.b', Promise.reject('b-string'))
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(2)
  })

  // Blocker #2 (Codex): a rejection swallowed BEFORE the wrapper is invisible —
  // migrated sites must hand the wrapper the ORIGINAL rejecting promise.
  test('a pre-swallowed promise is INVISIBLE; the raw rejecting promise is counted', async () => {
    // Anti-pattern the site audit removed: `.catch(() => {})` ahead of the
    // wrapper → the wrapper sees a RESOLVED promise → no log, no count.
    fireAndForget('unit.preswallowed', Promise.reject(new Error('boom')).catch(() => {}))
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(0)
    expect(errorLines.find((l) => l.includes('rejected'))).toBeUndefined()

    // Migrated form: the raw rejecting promise reaches the wrapper → counted+logged.
    fireAndForget('unit.raw', Promise.reject(new Error('boom')))
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(1)
    expect(errorLines.find((l) => l.includes('name=unit.raw'))).toBeDefined()
  })

  // P1 #1 (Codex): the rethrow-after-handler form used at reflection.runDetection,
  // scribe, composer, etc. — the .catch adds context THEN re-raises, so the
  // wrapper still counts+logs it (the failure is NOT pre-swallowed).
  test('a .catch that logs-then-rethrows still reaches the wrapper (counted)', async () => {
    let sideEffectRan = false
    fireAndForget(
      'unit.rethrow',
      Promise.reject(new Error('underlying')).catch((e) => {
        sideEffectRan = true // e.g. console.warn / cache-delete / job-mark
        throw e
      }),
    )
    await flush()
    expect(sideEffectRan).toBe(true)
    expect(fireAndForgetRejectionCount()).toBe(1)
    expect(errorLines.find((l) => l.includes('name=unit.rethrow'))).toBeDefined()
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

describe('neutralizeAbandonedSettle', () => {
  test('swallows an abandoned rejection with NO log and NO count', async () => {
    neutralizeAbandonedSettle(Promise.reject(new Error('abandoned')))
    await flush()
    expect(fireAndForgetRejectionCount()).toBe(0)
    expect(errorLines.find((l) => l.includes('rejected'))).toBeUndefined()
  })

  test('prevents an unhandled rejection for the abandoned promise', async () => {
    const seen: unknown[] = []
    const onUnhandled = (r: unknown) => seen.push(r)
    process.on('unhandledRejection', onUnhandled)
    try {
      const reason = new Error('late-settle')
      neutralizeAbandonedSettle(Promise.reject(reason))
      await flush()
      await flush()
      expect(seen).not.toContain(reason)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('no-ops on null / undefined', () => {
    expect(() => {
      neutralizeAbandonedSettle(null)
      neutralizeAbandonedSettle(undefined)
    }).not.toThrow()
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
    let crashed: unknown
    installProcessSafetyNet({ onUncaught: (err) => (crashed = err) })
    // The last-installed uncaughtException listener is ours.
    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => void
    const boom = new Error('fatal')
    handler(boom)
    expect(crashed).toBe(boom)
    expect(errorLines.find((l) => l.includes('uncaught_exception'))).toBeDefined()
  })

  test('unhandledRejection handler LOGS then calls onUncaught (log-then-crash)', () => {
    let crashed: unknown
    installProcessSafetyNet({ onUncaught: (err) => (crashed = err) })
    const handler = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void
    const reason = new Error('stray')
    handler(reason)
    const line = errorLines.find((l) => l.includes('unhandled_rejection'))
    expect(line).toBeDefined()
    expect(line).toContain('stray')
    expect(crashed).toBe(reason) // fatal default preserved (log-then-crash)
  })

  // Blocker boundary: a throwing log sink must NOT skip the log-then-crash
  // policy — `onUncaught` is guaranteed via `finally`.
  test('uncaughtException calls onUncaught even when logging throws', () => {
    let crashed: unknown
    console.error = () => {
      throw new Error('log sink down')
    }
    installProcessSafetyNet({ onUncaught: (err) => (crashed = err) })
    const handler = process.listeners('uncaughtException').at(-1) as (e: Error) => void
    const boom = new Error('fatal-with-broken-log')
    expect(() => handler(boom)).not.toThrow() // handler never propagates the log failure
    expect(crashed).toBe(boom) // crash policy still ran
  })

  test('unhandledRejection calls onUncaught even when logging throws', () => {
    let crashed: unknown
    console.error = () => {
      throw new Error('log sink down')
    }
    installProcessSafetyNet({ onUncaught: (err) => (crashed = err) })
    const handler = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void
    const reason = new Error('stray-with-broken-log')
    expect(() => handler(reason)).not.toThrow() // handler never propagates the log failure
    expect(crashed).toBe(reason) // crash policy still ran
  })

  // Real-process proof (not just a listener call): with the net installed and
  // NODE_ENV unset, an ACTUAL unhandled rejection must EXIT NONZERO (the fatal
  // default is preserved) after emitting the structured log.
  test('a real unhandled rejection exits nonzero with the net installed', () => {
    const fafPath = fileURLToPath(new URL('../fire-and-forget.ts', import.meta.url))
    const script = [
      `const m = await import(${JSON.stringify(fafPath)})`,
      'm.installProcessSafetyNet()',
      "Promise.reject(new Error('child-unhandled-boom'))",
      'await new Promise((r) => setTimeout(r, 2000))',
    ].join('\n')
    const env = { ...process.env }
    delete env['NODE_ENV'] // must NOT be 'test' or the crash is suppressed
    const res = spawnSync('bun', ['-e', script], { env, encoding: 'utf8', timeout: 15000 })
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}${res.stderr}`).toContain('unhandled_rejection')
    expect(`${res.stdout}${res.stderr}`).toContain('child-unhandled-boom')
  })
})
