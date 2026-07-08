/**
 * Focused unit test for the `late<T>` two-phase holder seam (C3d).
 *
 * Pins the Verifier-amended deref-before-bind semantics EXACTLY:
 *   - deref-before-bind logs loudly + increments the per-seam counter + NO-OPs
 *     (returns undefined / skips `fn`) in PROD (NODE_ENV !== 'test');
 *   - deref-before-bind THROWS under NODE_ENV === 'test';
 *   - after `bind`, deref returns `fn(value)` and behaves like the old `?.`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { late, lateUnboundDerefCount, resetLateUnboundDerefCounts } from '../wiring/late.ts'

const savedNodeEnv = process.env['NODE_ENV']

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = savedNodeEnv
  resetLateUnboundDerefCounts()
})

describe('late<T> — two-phase holder seam (C3d)', () => {
  test('after bind, deref returns fn(value) and get()/isBound() reflect it', () => {
    const seam = late<{ send: (m: string) => string }>('after-bind')
    expect(seam.isBound()).toBe(false)
    expect(seam.get()).toBeUndefined()
    const adapter = { send: (m: string) => `sent:${m}` }
    seam.bind(adapter)
    expect(seam.isBound()).toBe(true)
    expect(seam.get()).toBe(adapter)
    expect(seam.deref((a) => a.send('hi'))).toBe('sent:hi')
    // Bound derefs never trip the counter.
    expect(lateUnboundDerefCount('after-bind')).toBe(0)
  })

  test('deref-before-bind in PROD: loud log + counter bump + NO-OP (no throw, returns undefined)', () => {
    process.env['NODE_ENV'] = 'production'
    const errors: string[] = []
    const seam = late<{ send: (m: string) => void }>('prod-noop', {
      onUnboundDeref: (name) => errors.push(name),
    })
    let ran = false
    // Mirrors a fire-and-forget `holder.x?.send(...)` before bind.
    const result = seam.deref((a) => {
      ran = true
      return a.send('boom')
    })
    // NO-OP: fn never ran, deref returned undefined, nothing threw.
    expect(ran).toBe(false)
    expect(result).toBeUndefined()
    // Loud observability fired via the injected sink.
    expect(errors).toEqual(['prod-noop'])
  })

  test('deref-before-bind with the DEFAULT sink increments the process counter', () => {
    process.env['NODE_ENV'] = 'production'
    const seam = late<{ n: number }>('default-counter')
    expect(lateUnboundDerefCount('default-counter')).toBe(0)
    seam.deref((v) => v.n)
    seam.deref((v) => v.n)
    expect(lateUnboundDerefCount('default-counter')).toBe(2)
  })

  test('deref-before-bind THROWS under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test'
    const seam = late<{ send: () => void }>('test-strict')
    expect(() => seam.deref((a) => a.send())).toThrow(/late<test-strict>\.deref called before bind/)
  })

  test('binding after an unbound deref recovers normal behaviour', () => {
    process.env['NODE_ENV'] = 'production'
    const seam = late<(x: number) => number>('recover')
    expect(seam.deref((fn) => fn(2))).toBeUndefined()
    seam.bind((x) => x * 10)
    expect(seam.deref((fn) => fn(2))).toBe(20)
  })

  test('deref preserves `?? fallback` composition (matches old `holder.x?.foo() ?? fb`)', () => {
    process.env['NODE_ENV'] = 'production'
    const seam = late<{ get: () => string | null }>('fallback')
    // Unbound → undefined ?? 'fb' === 'fb'
    expect(seam.deref((s) => s.get()) ?? 'fb').toBe('fb')
    seam.bind({ get: () => null })
    // Bound → null ?? 'fb' === 'fb' (inner null passes through, exactly like `?.`)
    expect(seam.deref((s) => s.get()) ?? 'fb').toBe('fb')
    seam.bind({ get: () => 'real' })
    expect(seam.deref((s) => s.get()) ?? 'fb').toBe('real')
  })
})
