/**
 * RA5 (invariant I2) — AST-based ban on raw GBrain op-name CALLS.
 *
 * The depcruise `memory-backend-swap-seam` rule bans IMPORTING gbrain internals,
 * but `McpClient` is a purely STRUCTURAL interface: a product module can declare
 * its OWN identically-shaped `{ call(name, args) }` type with zero gbrain import
 * and call `client.call('put_page', …)` — a stray backend op the import-edge
 * rule has no edge to reject. The RA5 spec (§(b), plan ~:1807) requires the raw
 * op NAMES/CALLS to be forbidden, not just import edges. This test is that ban.
 *
 * WHY AST, NOT REGEX: a `.call('op')` regex is trivially bypassable and gave
 * false assurance — `client['call']('put_page')` (bracket), `client.call?.(…)`
 * (optional chaining), `client.call /* gap *\/ (…)` (trivia between callee and
 * args) are all valid TS the regex misses. Parsing with the TypeScript compiler
 * API makes whitespace / comments / optional-chaining / bracket-vs-dot access
 * irrelevant BY CONSTRUCTION: we match the CallExpression shape, not source
 * text. The single source of truth for the banned op names is
 * `GBRAIN_MCP_OP_NAMES` (gbrain-mcp-ops.ts) — the scanner reads it directly, so
 * there is no second, drift-prone list.
 *
 * IMPORTANT — this is a SOURCE-scanning guard: it is INVISIBLE to tsc /
 * typecheck-all / depcruise / the matrix. It is only exercised by the full
 * `bash scripts/run-tests.sh` (which discovers every `*.test.ts` — confirmed in
 * its discovery set). The depcruise import ban stays too — belt-and-suspenders.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { GBRAIN_MCP_OP_NAMES } from '../gbrain-mcp-ops.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..') // gbrain-memory/__tests__ → gbrain-memory → worktree root

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** True when `callee` is a `.call` member access — dot, optional, or bracket. */
function isCallMemberAccess(callee: ts.Expression): boolean {
  // x.call(...) and x?.call(...) — the `?.` is on the access node; either way
  // it's a PropertyAccessExpression whose member name is `call`.
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'call'
  // x['call'](...) — computed member access with a string-literal key of `call`.
  if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression
    return ts.isStringLiteralLike(key) && key.text === 'call'
  }
  return false
}

/**
 * Every `<recv>.call('<op>', …)` site (dot / optional / optional-call / bracket
 * access, any receiver name) whose FIRST argument is a string literal in `ops`.
 * Parsed via the TS compiler API, so trivia / optional-chaining can't evade it.
 */
export function findRawOpCalls(
  fileName: string,
  src: string,
  ops: readonly string[],
): Array<{ line: number; op: string }> {
  const opSet = new Set<string>(ops)
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
  const hits: Array<{ line: number; op: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCallMemberAccess(node.expression)) {
      const arg0 = node.arguments[0]
      if (arg0 !== undefined && ts.isStringLiteralLike(arg0) && opSet.has(arg0.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(arg0.getStart(sf))
        hits.push({ line: line + 1, op: arg0.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

/**
 * Every string-literal FIRST arg of any `.call(...)` in a file, regardless of
 * membership — used by the anti-drift check to learn what op names the seam
 * actually calls (receiver-AGNOSTIC, so an aliased/renamed transport can't hide
 * an op from the ban-list, the leak the old `mcp.call` regex had).
 */
function findAllDotCallStringArgs(fileName: string, src: string): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCallMemberAccess(node.expression)) {
      const arg0 = node.arguments[0]
      if (arg0 !== undefined && ts.isStringLiteralLike(arg0)) out.push(arg0.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Repo-relative `.ts`/`.tsx` files (tracked; excludes node_modules + clones). */
function trackedTsFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter((l) => l.length > 0)
}

/** Read a tracked file; skip-with-reason on a race/IO error rather than crash. */
function readTracked(p: string): string | null {
  try {
    return readFileSync(join(ROOT, p), 'utf8')
  } catch (err) {
    console.warn(`[raw-op-seam-ban] skipping unreadable ${p}: ${(err as Error).message}`)
    return null
  }
}

/**
 * Product scope = everything OUTSIDE the legitimate raw-transport holders. The
 * exempt set mirrors the depcruise `memory-backend-swap-seam` rule's exempt
 * `from`s: gbrain-memory/ (the seam owner), connect/ (federation mirror), the
 * ONE composition swap point (+ its sync-state sink), and test files.
 */
function isExemptFromBan(p: string): boolean {
  if (p.startsWith('gbrain-memory/')) return true
  if (p.startsWith('connect/')) return true
  if (p === 'gateway/realmode-composer/build-gbrain-memory.ts') return true
  if (p === 'gateway/realmode-composer/gbrain-sync-state-store.ts') return true
  if (/(^|\/)__tests__\//.test(p)) return true
  if (/\.test\.[a-z]+$/.test(p)) return true
  if (/(^|\/)tests\//.test(p)) return true
  return false
}

describe('RA5 raw-op seam ban — AST scanner (unit)', () => {
  // Each fixture is a valid-TS bypass form Codex enumerated; the AST scanner
  // must flag every one, since text-level differences vanish after parsing.
  const bypasses: Array<{ label: string; src: string; op: string }> = [
    {
      label: 'plain dot call',
      src: `export const f = (c: { call: Function }) => c.call('put_page', { slug: 'x' })`,
      op: 'put_page',
    },
    {
      label: 'bracket-notation call',
      src: `export const f = (c: { call: Function }) => c['call']('put_page', {})`,
      op: 'put_page',
    },
    {
      label: 'optional-chaining call',
      src: `export const f = (c: { call?: Function }) => c.call?.('put_page', {})`,
      op: 'put_page',
    },
    {
      label: 'comment/whitespace gap between callee and args',
      src: `export const f = (c: { call: Function }) => c.call /* gap */ (\n  'put_page', {})`,
      op: 'put_page',
    },
    {
      label: 'differently-named receiver (transport)',
      src: `export const f = (transport: { call: Function }) => transport.call('get_page', {})`,
      op: 'get_page',
    },
    {
      label: 'own structural RawClient, no gbrain import (the headline bypass)',
      src: [
        `interface RawClient { call(name: string, args: Record<string, unknown>): Promise<unknown> }`,
        `export function stray(client: RawClient) { return client.call('add_link', { from: 'a' }) }`,
      ].join('\n'),
      op: 'add_link',
    },
    {
      label: 'call split across lines',
      src: `export const f = (c: { call: Function }) => c.call(\n  'get_links',\n  { slug: 's' },\n)`,
      op: 'get_links',
    },
  ]

  for (const { label, src, op } of bypasses) {
    test(`FLAGS bypass: ${label}`, () => {
      const hits = findRawOpCalls('fixture.ts', src, GBRAIN_MCP_OP_NAMES)
      expect(hits.map((h) => h.op)).toEqual([op])
    })
  }

  test('does NOT flag an op literal that appears only in a COMMENT (prose-safe)', () => {
    const src = [
      `// A stray would client.call('put_page', {...}) — but this is only a comment.`,
      `/* also client.call('add_link', {...}) */`,
      `export const x = 1`,
    ].join('\n')
    expect(findRawOpCalls('fixture.ts', src, GBRAIN_MCP_OP_NAMES)).toEqual([])
  })

  test('does NOT flag the interface method SIGNATURE `call(name: string, …)`', () => {
    const src = `export interface RawClient { call(name: string, args: unknown): Promise<unknown> }`
    expect(findRawOpCalls('fixture.ts', src, GBRAIN_MCP_OP_NAMES)).toEqual([])
  })

  test('does NOT flag a typed MemoryStore call (the permitted path)', () => {
    const src = `export const go = (s: { query: Function }) => s.query({ query: 'x', limit: 5 })`
    expect(findRawOpCalls('fixture.ts', src, GBRAIN_MCP_OP_NAMES)).toEqual([])
  })

  test('does NOT flag `.call` with a NON-op string (e.g. Function.prototype.call use)', () => {
    const src = `export const go = (fn: Function, self: unknown) => fn.call(self, 'search_ui_button')`
    expect(findRawOpCalls('fixture.ts', src, GBRAIN_MCP_OP_NAMES)).toEqual([])
  })
})

describe('RA5 raw-op seam ban — conformance (AST scan of the tree)', () => {
  test('no product-scope file names a raw GBrain op via .call()', () => {
    const violations: Array<{ file: string; line: number; op: string }> = []
    for (const p of trackedTsFiles()) {
      if (isExemptFromBan(p)) continue
      const src = readTracked(p)
      if (src === null) continue
      for (const h of findRawOpCalls(p, src, GBRAIN_MCP_OP_NAMES)) {
        violations.push({ file: p, line: h.line, op: h.op })
      }
    }
    expect(
      violations,
      `Product module(s) name a raw GBrain op — route through MemoryStore instead:\n` +
        violations.map((v) => `  ${v.file}:${v.line} → .call('${v.op}', …)`).join('\n'),
    ).toEqual([])
  })
})

describe('RA5 raw-op seam ban — anti-drift (ban-list stays complete)', () => {
  test('every op the production GBrain adapters call is in GBRAIN_MCP_OP_NAMES', () => {
    const known = new Set<string>(GBRAIN_MCP_OP_NAMES)
    const unknown: Array<{ file: string; op: string }> = []
    for (const p of trackedTsFiles()) {
      // Only the production adapters that hold a real transport (non-test
      // gbrain-memory sources). Receiver-AGNOSTIC: any `.call('<literal>')` here
      // is a backend op, so an aliased/renamed transport can't smuggle in an op
      // the ban-list never learns about (the leak the old `mcp.call` grep had).
      if (!p.startsWith('gbrain-memory/')) continue
      if (/(^|\/)__tests__\//.test(p)) continue
      const src = readTracked(p)
      if (src === null) continue
      for (const op of findAllDotCallStringArgs(p, src)) {
        if (!known.has(op)) unknown.push({ file: p, op })
      }
    }
    expect(
      unknown,
      `Seam calls an op missing from GBRAIN_MCP_OP_NAMES (add it so the ban covers it):\n` +
        unknown.map((u) => `  ${u.file} → .call('${u.op}', …)`).join('\n'),
    ).toEqual([])
  })
})
