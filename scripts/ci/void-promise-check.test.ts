// F3 — unit tests for the bare `void <promise>` gate detector.
//
// The gate (scripts/ci/void-promise-check.mjs) bans fire-and-forget promise
// voids outside the wrapper. Detection is TYPE-DRIVEN: it flags `void <expr>`
// iff `<expr>` is promise-typed. These tests pin that precision — a promise
// VARIABLE must be flagged (the Codex-found bypass), while the unused-binding /
// no-op voids that share the keyword must not be. Fixtures `declare` their own
// types so the detector's in-memory program can resolve them.
import { describe, expect, test } from 'bun:test'
import {
  findBareVoidPromiseCalls,
  findPreSwallowedWraps,
  hasVoidExpression,
} from './void-promise-check.mjs'

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

  test('flags a bare void on a PromiseLike-typed variable', () => {
    const hits = findBareVoidPromiseCalls('declare const p: PromiseLike<void>\nvoid p')
    expect(hits.length).toBe(1)
  })

  // P2 #3 (Codex): the `any`-erasure boundary is INTENTIONAL. A `void <any>` is
  // out of scope (the checker can't prove it's a promise; flagging all
  // `void <any>` would false-positive). Lock the boundary so it stays deliberate.
  test('does NOT flag `void <any>` (type erasure is out of scope by design)', () => {
    expect(findBareVoidPromiseCalls('declare const p: any\nvoid p').length).toBe(0)
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

// Structural pre-swallow gate (Codex final): a `.catch`/two-arg-`.then`/
// internally-catching-IIFE BEFORE a fireAndForget/neutralize wrapper swallows
// the rejection so the wrapper never counts it. Ban it syntactically.
describe('findPreSwallowedWraps', () => {
  test('flags a .catch on the fireAndForget promise arg', () => {
    const hits = findPreSwallowedWraps("fireAndForget('n', p.catch(() => {}))")
    expect(hits.length).toBe(1)
    expect(hits[0]?.reason).toContain('.catch')
  })

  test('flags a .catch that is NOT the outermost call (…​.catch(…).finally(…))', () => {
    const hits = findPreSwallowedWraps("fireAndForget('n', p.catch(() => {}).finally(() => {}))")
    expect(hits.length).toBe(1)
  })

  test('flags a two-arg .then (onFulfilled, onRejected)', () => {
    const hits = findPreSwallowedWraps("fireAndForget('n', p.then(a, b))")
    expect(hits.length).toBe(1)
  })

  test('flags an internally-catching async IIFE', () => {
    const hits = findPreSwallowedWraps("fireAndForget('n', (async () => { try { await x() } catch {} })())")
    expect(hits.length).toBe(1)
    expect(hits[0]?.reason).toContain('IIFE')
  })

  test('does NOT check neutralizeAbandonedSettle (silent by design — a swallowing arg is its intended use)', () => {
    expect(findPreSwallowedWraps('neutralizeAbandonedSettle(p.catch(() => {}))').length).toBe(0)
  })

  test('PASSES the raw promise + onError form', () => {
    expect(findPreSwallowedWraps("fireAndForget('n', p, (err) => log(err))").length).toBe(0)
  })

  test('PASSES a .finally / one-arg .then (rejection passes through)', () => {
    expect(findPreSwallowedWraps("fireAndForget('n', p.finally(() => c()))").length).toBe(0)
    expect(findPreSwallowedWraps("fireAndForget('n', p.then((r) => use(r)))").length).toBe(0)
  })

  test('PASSES an IIFE that rethrows from its catch', () => {
    expect(
      findPreSwallowedWraps("fireAndForget('n', (async () => { try { await x() } catch (e) { throw e } })())")
        .length,
    ).toBe(0)
  })

  test('PASSES an IIFE whose catch does a side-effect THEN top-level rethrows', () => {
    expect(
      findPreSwallowedWraps(
        "fireAndForget('n', (async () => { try { await x() } catch (e) { log(e); throw e } })())",
      ).length,
    ).toBe(0)
  })

  // P1 #3 (Codex): a CONDITIONAL throw is NOT a safe rethrow — the other branch
  // swallows. Only a TOP-LEVEL unconditional throw counts.
  test('flags an IIFE whose catch throws only CONDITIONALLY (if (flag) throw e)', () => {
    expect(
      findPreSwallowedWraps(
        "fireAndForget('n', (async () => { try { await x() } catch (e) { if (flag) throw e } })())",
      ).length,
    ).toBe(1)
  })

  test('flags an IIFE whose catch throws only inside a nested block/loop', () => {
    expect(
      findPreSwallowedWraps(
        "fireAndForget('n', (async () => { try { await x() } catch (e) { for (const _ of []) throw e } })())",
      ).length,
    ).toBe(1)
  })

  test('PASSES a raw promise-returning call', () => {
    expect(findPreSwallowedWraps("fireAndForget('n', doWork())").length).toBe(0)
  })

  // Medium #2 (Codex): alias + namespace imports must be resolved, not just a
  // literal `fireAndForget` identifier.
  test('flags a pre-swallow through an ALIASED import', () => {
    const src =
      "import { fireAndForget as faf } from '@neutronai/logger/fire-and-forget.ts'\nfaf('n', p.catch(() => {}))"
    expect(findPreSwallowedWraps(src).length).toBe(1)
  })

  test('flags a pre-swallow through a NAMESPACE import', () => {
    const src =
      "import * as ff from '@neutronai/logger/fire-and-forget.ts'\nff.fireAndForget('n', p.catch(() => {}))"
    expect(findPreSwallowedWraps(src).length).toBe(1)
  })

  test('does NOT flag an aliased neutralizeAbandonedSettle (silent primitive, not checked)', () => {
    const src =
      "import { neutralizeAbandonedSettle as nas } from '@neutronai/logger/fire-and-forget.ts'\nnas(p.then(a, b))"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  test('PASSES aliased + namespace calls with the raw + onError form', () => {
    const aliased =
      "import { fireAndForget as faf } from '@neutronai/logger/fire-and-forget.ts'\nfaf('n', p, (e) => log(e))"
    const namespaced =
      "import * as ff from '@neutronai/logger/fire-and-forget.ts'\nff.fireAndForget('n', p, (e) => log(e))"
    expect(findPreSwallowedWraps(aliased).length).toBe(0)
    expect(findPreSwallowedWraps(namespaced).length).toBe(0)
  })

  test('does NOT treat `ns.fireAndForget` as a wrapper when ns is NOT the faf module', () => {
    const src = "import * as ff from './unrelated.ts'\nff.fireAndForget('n', p.catch(() => {}))"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  // Final edge (Codex): a pre-swallow laundered through a LOCAL one-hop binding.
  test('flags a swallow laundered through a local const', () => {
    expect(findPreSwallowedWraps("const s = p.catch(() => {})\nfireAndForget('n', s)").length).toBe(1)
  })

  test('flags a laundered two-arg .then through a local const', () => {
    expect(findPreSwallowedWraps("const s = p.then(a, b)\nfireAndForget('n', s)").length).toBe(1)
  })

  test('does NOT flag a laundered swallow for neutralizeAbandonedSettle (silent primitive)', () => {
    expect(findPreSwallowedWraps("const s = p.catch(() => {})\nneutralizeAbandonedSettle(s)").length).toBe(0)
  })

  test('PASSES a raw promise laundered through a local const', () => {
    expect(findPreSwallowedWraps("const s = p\nfireAndForget('n', s)").length).toBe(0)
  })

  test('PASSES a laundered .catch that unconditionally RETHROWS', () => {
    expect(
      findPreSwallowedWraps("const s = p.catch((e) => { throw e })\nfireAndForget('n', s)").length,
    ).toBe(0)
  })

  test('PASSES a laundered .finally (rejection passes through)', () => {
    expect(findPreSwallowedWraps("const s = p.finally(() => c())\nfireAndForget('n', s)").length).toBe(0)
  })

  // A const-alias CHAIN is decidable → fully resolved and FLAGGED.
  test('flags a swallow laundered through a TWO-hop const-alias chain', () => {
    const src = "const a = p.catch(() => {})\nconst s = a\nfireAndForget('n', s)"
    expect(findPreSwallowedWraps(src).length).toBe(1)
  })

  test('flags a const-alias chain declared out of order (const b = a; const a = …)', () => {
    const src = "const b = a\nconst a = p.catch(() => {})\nfireAndForget('n', b)"
    expect(findPreSwallowedWraps(src).length).toBe(1)
  })

  test('PASSES a multi-hop const chain of a RAW promise', () => {
    const src = "const a = p\nconst b = a\nfireAndForget('n', b)"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  // ── DOCUMENTED INHERENT BOUNDARY — locked as INTENTIONAL, not accidental ──
  // A syntactic gate cannot chase general dataflow; these are NOT flagged BY
  // DESIGN. The runtime wrapper + safety net are the actual guarantee.
  test('does NOT flag a REASSIGNED let alias (documented limit)', () => {
    const src = "let s = p.catch(() => {})\ns = q\nfireAndForget('n', s)"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  test('does NOT follow a NON-const (let) alias hop (documented limit)', () => {
    const src = "let a = p.catch(() => {})\nconst s = a\nfireAndForget('n', s)"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  test('does NOT flag a promise stored in / read from an object member (documented limit)', () => {
    const src = "const s = box.p\nfireAndForget('n', s)"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  test('does NOT flag a cycle in const aliases (guarded, documented limit)', () => {
    const src = "const a = b\nconst b = a\nfireAndForget('n', a)"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  test('does NOT descend into a laundered self-handling IIFE (documented limit)', () => {
    const src = "const s = (async () => { try { await x() } catch {} })()\nfireAndForget('n', s)"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  // Codex round 13: a swallow laundered into a local `const`, then handed to the
  // wrapper under a `.finally(cleanup)` chain — the receiver identifier must be
  // resolved during descent (the real mount-cores-scribe-fan-out.ts pattern).
  test('flags a swallowed const handed to the wrapper via a .finally() chain', () => {
    const src = "const p = work().catch(() => {})\nfireAndForget('n', p.finally(cleanup))"
    expect(findPreSwallowedWraps(src).length).toBe(1)
  })

  test('does NOT flag a RAW promise handed to the wrapper via a .finally() chain', () => {
    const src = "const p = work()\nfireAndForget('n', p.finally(cleanup))"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })

  test('does NOT flag a rethrowing const handed via a .finally() chain', () => {
    const src = "const p = work().catch((e) => { throw e })\nfireAndForget('n', p.finally(cleanup))"
    expect(findPreSwallowedWraps(src).length).toBe(0)
  })
})
