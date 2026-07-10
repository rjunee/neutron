/**
 * RA5 (invariant I2) — SOURCE-TEXT ban on raw GBrain op-name CALLS.
 *
 * The depcruise `memory-backend-swap-seam` rule bans IMPORTING gbrain internals,
 * but `McpClient` is a purely STRUCTURAL interface: a product module can declare
 * its OWN identically-shaped `{ call(name, args) }` type with zero gbrain import
 * and call `client.call('put_page', …)` — a stray backend op the import-edge
 * rule has no edge to reject. The RA5 spec (§(b), plan ~:1807) requires the raw
 * op NAMES/CALLS to be forbidden, not just import edges. This test is that ban.
 *
 * IMPORTANT — this is a SOURCE-TEXT guard: it reads files and scans literals, so
 * it is INVISIBLE to tsc / typecheck-all / depcruise / the matrix. It is only
 * exercised by the full `bash scripts/run-tests.sh` (which discovers every
 * `*.test.ts`). The depcruise import ban stays too — belt-and-suspenders.
 *
 * Three concerns:
 *   1. UNIT — the pure scanner flags a structural-bypass fixture (own RawClient,
 *      no gbrain import) and does NOT flag an op literal that appears only in a
 *      comment (the false-positive the L-phase guardrail warns about).
 *   2. CONFORMANCE — no product-scope file (everything outside the exempt seam
 *      holders) names a raw op via `.call('<op>', …)`.
 *   3. ANTI-DRIFT — every op the production GBrain adapters actually pass to
 *      `mcp.call(…)` is a member of the single-source `GBRAIN_MCP_OP_NAMES`, so
 *      the ban-list can't silently fall behind the real seam.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GBRAIN_MCP_OP_NAMES } from '../gbrain-mcp-ops.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..') // gbrain-memory/__tests__ → gbrain-memory → worktree root

/**
 * Blank out `//` line comments and `/* *\/` block comments (replaced with
 * spaces, newlines preserved so line numbers survive) while leaving CODE and
 * STRING LITERALS intact — the op name we hunt for IS a string-literal argument
 * (`.call('put_page')`), so strings must be kept. String-aware only so a `//`
 * or `/*` INSIDE a string doesn't get mistaken for a comment start. Mirrors the
 * (documented, accepted) limitations of scripts/ci/extract-comment-prose.awk:
 * template-literal interpolations are treated as opaque string content.
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let state: 'code' | 'line' | 'block' | 'str' = 'code'
  let quote = ''
  while (i < n) {
    const c = src[i]!
    const c2 = i + 1 < n ? src[i + 1]! : ''
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        out += '  '
        i += 2
        state = 'line'
      } else if (c === '/' && c2 === '*') {
        out += '  '
        i += 2
        state = 'block'
      } else if (c === "'" || c === '"' || c === '`') {
        state = 'str'
        quote = c
        out += c
        i += 1
      } else {
        out += c
        i += 1
      }
    } else if (state === 'line') {
      if (c === '\n') {
        out += '\n'
        state = 'code'
      } else {
        out += ' '
      }
      i += 1
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        out += '  '
        i += 2
        state = 'code'
      } else {
        out += c === '\n' ? '\n' : ' '
        i += 1
      }
    } else {
      // state === 'str'
      if (c === '\\') {
        out += c
        if (i + 1 < n) out += src[i + 1]!
        i += 2
      } else if (c === quote) {
        out += c
        state = 'code'
        i += 1
      } else {
        out += c
        i += 1
      }
    }
  }
  return out
}

/** Line number (1-based) of a match index within `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/**
 * Find `.call('<op>', …)` sites whose first argument is one of `ops`, in the
 * CODE view (comments stripped). Whole-text scan so a call split across lines
 * (`.call(\n  'put_page')`) can't evade it.
 */
export function findRawOpCalls(
  src: string,
  ops: readonly string[],
): Array<{ line: number; op: string }> {
  const code = stripComments(src)
  const re = new RegExp(String.raw`\.call\(\s*['"](${ops.join('|')})['"]`, 'g')
  const hits: Array<{ line: number; op: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) hits.push({ line: lineOf(code, m.index), op: m[1]! })
  return hits
}

/** Ops actually passed to a raw `mcp.call('<op>', …)` in the CODE view. */
function findSeamMcpOps(src: string): string[] {
  const code = stripComments(src)
  const re = /\bmcp\.call\(\s*['"]([a-z_]+)['"]/g
  const ops: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) ops.push(m[1]!)
  return ops
}

/** Repo-relative `.ts`/`.tsx` files (tracked; excludes node_modules + clones). */
function trackedTsFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter((l) => l.length > 0)
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

describe('RA5 raw-op seam ban — pure scanner (unit)', () => {
  test('FLAGS the structural bypass depcruise misses (own RawClient, no gbrain import)', () => {
    // The exact bypass Codex called out: a product-style module declares its own
    // structural transport type and calls a raw op with ZERO gbrain import.
    const fixture = [
      `interface RawClient {`,
      `  call(name: string, args: Record<string, unknown>): Promise<unknown>`,
      `}`,
      `export function stray(client: RawClient) {`,
      `  return client.call('put_page', { slug: 'x', content: 'y' })`,
      `}`,
    ].join('\n')
    const hits = findRawOpCalls(fixture, GBRAIN_MCP_OP_NAMES)
    expect(hits.map((h) => h.op)).toEqual(['put_page'])
    // The interface's `call(name: …)` declaration must NOT be mistaken for a call.
    expect(hits.length).toBe(1)
  })

  test('does NOT flag an op literal that appears only in a COMMENT (prose-safe)', () => {
    const fixture = [
      `// A stray would client.call('put_page', {...}) — but this is only a comment.`,
      `/* also blocked: client.call('add_link', {...}) */`,
      `export const x = 1`,
    ].join('\n')
    expect(findRawOpCalls(fixture, GBRAIN_MCP_OP_NAMES)).toEqual([])
  })

  test('does NOT flag a typed MemoryStore call (the permitted path)', () => {
    const fixture = `export const go = (s: { query: Function }) => s.query({ query: 'x', limit: 5 })`
    expect(findRawOpCalls(fixture, GBRAIN_MCP_OP_NAMES)).toEqual([])
  })

  test('catches a call split across lines (cannot evade by wrapping)', () => {
    const fixture = `client.call(\n  'get_links',\n  { slug: 's' },\n)`
    expect(findRawOpCalls(fixture, GBRAIN_MCP_OP_NAMES).map((h) => h.op)).toEqual(['get_links'])
  })
})

describe('RA5 raw-op seam ban — conformance (source-text scan of the tree)', () => {
  test('no product-scope file names a raw GBrain op via .call()', () => {
    const violations: Array<{ file: string; line: number; op: string }> = []
    for (const p of trackedTsFiles()) {
      if (isExemptFromBan(p)) continue
      const src = readFileSync(join(ROOT, p), 'utf8')
      for (const h of findRawOpCalls(src, GBRAIN_MCP_OP_NAMES)) {
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
      // Only the production adapters that hold a real McpClient (non-test
      // gbrain-memory sources). Those pass op names via `this.mcp.call(…)`.
      if (!p.startsWith('gbrain-memory/')) continue
      if (/(^|\/)__tests__\//.test(p)) continue
      const src = readFileSync(join(ROOT, p), 'utf8')
      for (const op of findSeamMcpOps(src)) {
        if (!known.has(op)) unknown.push({ file: p, op })
      }
    }
    expect(
      unknown,
      `Seam calls an op missing from GBRAIN_MCP_OP_NAMES (add it so the ban covers it):\n` +
        unknown.map((u) => `  ${u.file} → mcp.call('${u.op}', …)`).join('\n'),
    ).toEqual([])
  })
})
