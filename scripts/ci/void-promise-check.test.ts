// F3 — unit tests for the bare `void <promise>` gate detector.
//
// The gate (scripts/ci/void-promise-check.mjs) bans fire-and-forget promise
// voids outside the wrapper. Detection is TYPE-DRIVEN: it flags `void <expr>`
// iff `<expr>` is promise-typed. These tests pin that precision — a promise
// VARIABLE must be flagged (the Codex-found bypass), while the unused-binding /
// no-op voids that share the keyword must not be. Fixtures `declare` their own
// types so the detector's in-memory program can resolve them.
import { describe, expect, test } from 'bun:test'
import { findBareVoidPromiseCalls, hasVoidExpression } from './void-promise-check.mjs'

describe('findBareVoidPromiseCalls', () => {
  test('flags a bare void on a promise-returning call', () => {
    const hits = findBareVoidPromiseCalls('async function f(): Promise<void> {}\nvoid f()')
    expect(hits.length).toBe(1)
    expect(hits[0]?.text).toContain('void f()')
  })

  // Blocker #1 (Codex): a promise VARIABLE must NOT slip past the gate.
  test('flags a bare void on a promise-typed VARIABLE', () => {
    const hits = findBareVoidPromiseCalls('declare const p: Promise<void>\nvoid p')
    expect(hits.length).toBe(1)
  })

  test('flags a void on a chained call (…().catch(…)) — still a promise', () => {
    const hits = findBareVoidPromiseCalls(
      'declare const handle: { stop(): Promise<void> }\nvoid handle.stop().catch(() => {})',
    )
    expect(hits.length).toBe(1)
  })

  test('flags a void on a multi-line promise chain', () => {
    const src = ['declare const p: Promise<number>', 'void p', '  .then((r) => r)'].join('\n')
    const hits = findBareVoidPromiseCalls(src)
    expect(hits.length).toBe(1)
    expect(hits[0]?.line).toBe(2)
  })

  test('flags an immediately-invoked async IIFE void', () => {
    const hits = findBareVoidPromiseCalls('void (async () => {})()')
    expect(hits.length).toBe(1)
  })

  // Medium #3 (Codex): a promise-void in EXPRESSION position (callback body /
  // arrow concise body) must be flagged too — not just statements.
  test('flags a promise void in expression position (arrow concise body)', () => {
    const hits = findBareVoidPromiseCalls('declare const p: Promise<void>\nconst f = () => void p')
    expect(hits.length).toBe(1)
  })

  test('flags a promise void nested in a callback argument', () => {
    const hits = findBareVoidPromiseCalls(
      'declare const p: Promise<void>\ndeclare function setTimeout(cb: () => void, ms: number): void\nsetTimeout(() => void p, 0)',
    )
    expect(hits.length).toBe(1)
  })

  test('does NOT flag a NON-promise void in expression position', () => {
    expect(findBareVoidPromiseCalls('const f = () => void 0').length).toBe(0)
    expect(
      findBareVoidPromiseCalls('declare const n: number\nconst f = () => void n').length,
    ).toBe(0)
  })

  test('does NOT flag the wrapped form', () => {
    const hits = findBareVoidPromiseCalls(
      [
        'declare const p: Promise<void>',
        'declare function fireAndForget(n: string, x: unknown): void',
        "fireAndForget('site', p)",
      ].join('\n'),
    )
    expect(hits.length).toBe(0)
  })

  test('does NOT flag `void 0` / literal voids', () => {
    expect(findBareVoidPromiseCalls('void 0').length).toBe(0)
    expect(findBareVoidPromiseCalls('void "noop"').length).toBe(0)
  })

  test('does NOT flag the unused-binding void idiom (non-promise identifier / member)', () => {
    // `void _exhaustive`, `void driver`, `void this._deps` — not promises.
    expect(findBareVoidPromiseCalls('declare const _exhaustive: never\nvoid _exhaustive').length).toBe(0)
    expect(findBareVoidPromiseCalls('declare const driver: { id: number }\nvoid driver').length).toBe(0)
    expect(findBareVoidPromiseCalls('class C { _deps = 1; m() { void this._deps } }').length).toBe(0)
  })

  test('does NOT flag a void on a non-promise (sync) call', () => {
    expect(findBareVoidPromiseCalls('declare function g(): void\nvoid g()').length).toBe(0)
    expect(findBareVoidPromiseCalls('declare function n(): number\nvoid n()').length).toBe(0)
  })

  test('flags a promise void inside a comma expression, but not the non-promise arm', () => {
    // `void a()` (promise) is caught even nested; `void b()` (number) is not.
    const hits = findBareVoidPromiseCalls(
      'declare function a(): Promise<void>\ndeclare function b(): number\nconst y = (void a(), void b(), 1)',
    )
    expect(hits.length).toBe(1)
  })

  // P2 #3 (Codex): a `void` separated from its operand by a newline / comment
  // must still be seen (the AST walk handles it; these lock it in).
  test('flags a promise void split across a newline (void\\np)', () => {
    const hits = findBareVoidPromiseCalls('declare const p: Promise<void>\nvoid\np')
    expect(hits.length).toBe(1)
  })

  test('flags a promise void separated by an inline comment', () => {
    const hits = findBareVoidPromiseCalls('declare const p: Promise<void>\nvoid /* c */ p')
    expect(hits.length).toBe(1)
  })

  test('flags each promise-void statement independently, skipping the non-promises', () => {
    const src = [
      'declare function a(): Promise<void>',
      'declare function b(): Promise<void>',
      'declare const sync: number',
      'void a()',
      'void b().catch(() => {})',
      'void 0',
      'void sync',
    ].join('\n')
    expect(findBareVoidPromiseCalls(src).length).toBe(2)
  })
})

// P2 #3 (Codex): the CLI's cheap pre-pass must FORWARD any file that mentions
// the `void` keyword — including `void\np` / `void/*c*/p` — to the type-aware
// AST pass. The bug was a `"void "` (trailing-space) substring reject.
describe('hasVoidExpression (cheap pre-pass forwarding)', () => {
  test('forwards a void split across a newline', () => {
    expect(hasVoidExpression('x.ts', 'const p = Promise.resolve()\nvoid\np')).toBe(true)
  })

  test('forwards a void separated by an inline comment', () => {
    expect(hasVoidExpression('x.ts', 'const p = Promise.resolve()\nvoid /* c */ p')).toBe(true)
  })

  test('forwards `void 0` (the AST pass then classifies it out)', () => {
    expect(hasVoidExpression('x.ts', 'void 0')).toBe(true)
  })

  test('does NOT forward a file with no `void` keyword (avoids false match on "avoidance")', () => {
    expect(hasVoidExpression('x.ts', 'const avoidance = 1\nconst x = 2')).toBe(false)
  })
})
