/**
 * Architectural fence-post — guards the CC-subprocess substrate rule.
 *
 * Sprint cc-substrate-migration-3-sites (2026-05-31). Per memory
 * `feedback_cc_subprocess_substrate.md`: owner-facing LLM call sites
 * MUST dispatch through the CC subprocess substrate (the `claude`
 * binary owns wire-level auth + OAuth refresh + system-prompt
 * signature). Direct HTTPS POSTs to `https://api.anthropic.com/v1/messages`
 * are FORBIDDEN in owner-facing code.
 *
 * This test greps the gateway + runtime + onboarding source trees for
 * the forbidden patterns. A future regression that adds a direct fetch
 * to the Anthropic Messages API fails this test at CI time instead of
 * having to be caught in code review.
 *
 * Allow-list rationale: a small set of files legitimately reference
 * `api.anthropic.com` because they are auth-tier *probes* (not LLM call
 * sites) or documentation that names what was removed:
 *
 *   - `auth/max-oauth.ts` + tests — single 1-token probe to validate a
 *     Max OAuth paste token's auth tier. Not an LLM call; cannot be
 *     replaced by spawning `claude` because the goal IS to ask Anthropic
 *     "does this token exist and what tier is it" without committing to
 *     a model dispatch.
 *   - `identity/oauth/install-token-handoff.ts` + tests + `max-handoff.ts` +
 *     `main.ts` — same probe-shape for OAuth callbacks.
 *   - `tests/integration/sprint23-paste-token-handoff.test.ts` + the
 *     `sprint19-realmode-composer-end-to-end.test.ts` notes — historical
 *     test fixtures that mock the probe path.
 *   - `runtime/adapters/claude-code/cli-transport.ts` — file-header
 *     comment documenting that direct fetches were REMOVED in favour of
 *     spawning the `claude` binary.
 *   - Any file under `__tests__/` — test scaffolding may reference the
 *     URL for mock-fetch setup.
 *
 * Everything else MUST be substrate-dispatched.
 */

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOTS = ['gateway', 'runtime', 'onboarding'] as const

const ALLOW_LIST: ReadonlyArray<string> = [
  // CC adapter header documents the removed direct HTTPS path.
  'runtime/adapters/claude-code/cli-transport.ts',
]

const ALLOW_DIR_PREFIXES: ReadonlyArray<string> = [
  // Test scaffolding may legitimately mock fetch against the URL.
  '__tests__/',
  '/tests/',
]

// Narrow patterns — the architectural fence is "the URL host is named
// only in legitimate places". Broader patterns like `/Authorization:\s*Bearer/`
// false-positive on HTTP server error messages telling clients what
// auth-header shape to send; broader patterns like `/anthropic-version/`
// false-positive on the auth-probe header in `auth/max-oauth.ts` (already
// allow-listed). The URL substring is the actionable signal — no file
// can dispatch a direct fetch without naming the host.
const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /api\.anthropic\.com/,
  /fetch\([^)]*\/v1\/messages/,
]

/**
 * Recursively walk a directory, yielding `.ts` files that aren't tests
 * or generated. Skips `node_modules`, `.git`, and `dist`.
 */
function* walkTsFiles(dir: string, base: string): Generator<string, void, void> {
  let entries: ReadonlyArray<string>
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const abs = join(dir, name)
    let s: import('node:fs').Stats
    try {
      s = statSync(abs)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      yield* walkTsFiles(abs, base)
      continue
    }
    if (!s.isFile()) continue
    if (!name.endsWith('.ts')) continue
    const rel = relative(base, abs).split(sep).join('/')
    yield rel
  }
}

/**
 * True when the file is allow-listed (a known legitimate reference to
 * api.anthropic.com — auth probe, header comment, or test scaffolding).
 */
function isAllowed(relPath: string): boolean {
  if (ALLOW_LIST.includes(relPath)) return true
  for (const prefix of ALLOW_DIR_PREFIXES) {
    if (relPath.includes(prefix)) return true
  }
  if (relPath.endsWith('.test.ts')) return true
  // Auth-probe paths — explicitly NOT LLM call sites.
  if (relPath.startsWith('auth/max-oauth')) return true
  if (relPath.startsWith('identity/oauth/')) return true
  if (relPath.startsWith('identity/main.ts')) return true
  return false
}

/**
 * Strip line + block comments so a docstring describing the forbidden
 * pattern doesn't false-positive. Crude but sufficient — we don't need a
 * real TS parser for this purpose.
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '')
  out = out
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      if (idx === -1) return line
      // Preserve a `//` that appears inside a string literal — common
      // case is a URL like `'https://api.test'`. Heuristic: if there's
      // an unmatched `"` or `'` before the `//`, treat the `//` as
      // string content.
      const before = line.slice(0, idx)
      const singleQuotes = (before.match(/'/g) ?? []).length
      const doubleQuotes = (before.match(/"/g) ?? []).length
      const backticks = (before.match(/`/g) ?? []).length
      if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) {
        return line
      }
      return line.slice(0, idx)
    })
    .join('\n')
  return out
}

test('no direct api.anthropic.com fetches in owner-facing LLM call sites', () => {
  const base = process.cwd()
  const violations: Array<{ file: string; pattern: string; line: string }> = []
  for (const root of ROOTS) {
    const rootDir = join(base, root)
    for (const relPath of walkTsFiles(rootDir, base)) {
      if (isAllowed(relPath)) continue
      let body: string
      try {
        body = readFileSync(join(base, relPath), 'utf8')
      } catch {
        continue
      }
      const stripped = stripComments(body)
      for (const pat of FORBIDDEN_PATTERNS) {
        const m = stripped.match(pat)
        if (m === null) continue
        const idx = stripped.search(pat)
        const lineStart = stripped.lastIndexOf('\n', idx) + 1
        const lineEnd = stripped.indexOf('\n', idx)
        const line = stripped.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
        violations.push({ file: relPath, pattern: pat.source, line: line.trim().slice(0, 200) })
      }
    }
  }
  if (violations.length > 0) {
    const report = violations
      .map((v) => `  ${v.file}: matched /${v.pattern}/ in: ${v.line}`)
      .join('\n')
    throw new Error(
      `Architectural fence-post FAILED: ${violations.length} direct-anthropic-api violations found.\n` +
        `Owner-facing LLM calls MUST dispatch through buildLlmCallSubstrate (the CC subprocess substrate).\n` +
        `If a new file legitimately needs to probe api.anthropic.com (auth-tier check, NOT an LLM call),\n` +
        `add it to ALLOW_LIST or ALLOW_DIR_PREFIXES in this test. See memory feedback_cc_subprocess_substrate.md.\n\n` +
        report,
    )
  }
  expect(violations.length).toBe(0)
})
