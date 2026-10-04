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
 *     `sprint19-wiring-end-to-end.test.ts` notes — historical
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
  // Rate-limit/overload banner detector (the legacy harness port row #10): matches the host
  // string as a DETECTION CUE in CC's own "502 Bad Gateway from api.anthropic.com"
  // error line — it is NOT an LLM call / direct API probe.
  'runtime/adapters/claude-code/persistent/rate-limit-banner.ts',
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
// can introduce a literal direct endpoint unnoticed. Computed destinations are
// outside this textual guard; this is not a general network/data-flow analysis.
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

const NATIVE_RELAY_CONFIG = 'runtime/adapters/claude-code/persistent/native-request-relay.ts'

// The launcher only configures the official CLI's Unix transport. It has no
// provider-host exception and must not become a second HTTP client. These are
// bounded textual controls, not a general computed-destination analysis.
function fenceViolations(relPath: string, body: string): string[] {
  const source = stripComments(body)
  const patterns = relPath === NATIVE_RELAY_CONFIG ? [...FORBIDDEN_PATTERNS,
    /\b(?:fetch|XMLHttpRequest|axios|undici)\b|['"](?:node:)?https?['"]/,
    /['"`]ANTHROPIC_(?:BASE_URL)?['"`]|['"`]BASE_URL['"`]/,
  ] : FORBIDDEN_PATTERNS
  const violations = patterns.filter(pattern => pattern.test(source)).map(pattern => `forbidden /${pattern.source}/`)
  if (relPath === NATIVE_RELAY_CONFIG) {
    if (!/^\s*routed\.ANTHROPIC_UNIX_SOCKET = pin\.socketPath\s*$/m.test(source)) violations.push('missing pinned Unix socket assignment')
    if (!/^\s*routed\.ANTHROPIC_BASE_URL = NATIVE_RELAY_BASE_URL\s*$/m.test(source)
      || (source.match(/\bANTHROPIC_BASE_URL\b/g) ?? []).length !== 1) violations.push('base URL must only configure the shared native sentinel')
  }
  return violations
}

test('native Unix launcher is configuration only; direct and foreign uses still fail', () => {
  const body = readFileSync(join(process.cwd(), NATIVE_RELAY_CONFIG), 'utf8')
  expect(body).toContain('routed.ANTHROPIC_BASE_URL = NATIVE_RELAY_BASE_URL')
  expect(fenceViolations(NATIVE_RELAY_CONFIG, body)).toEqual([])
  expect(fenceViolations('runtime/foreign.ts', 'export const fixture = true')).toEqual([])
  // Positive control: another current file legitimately names the provider, but
  // still fails when scanned as ordinary code rather than its allow-listed path.
  const banner = readFileSync(join(process.cwd(), 'runtime/adapters/claude-code/persistent/rate-limit-banner.ts'), 'utf8')
  expect(fenceViolations('runtime/foreign.ts', banner).length).toBeGreaterThan(0)
  for (const [path, mutant] of [
    ['runtime/foreign.ts', "const endpoint = 'https://api.anthropic.com'"],
    [NATIVE_RELAY_CONFIG, body.replace('= NATIVE_RELAY_BASE_URL', "= 'https://api.anthropic.com'")],
    [NATIVE_RELAY_CONFIG, body.replace('routed.ANTHROPIC_UNIX_SOCKET = pin.socketPath', 'routed.ANTHROPIC_UNIX_SOCKET = foreign.socketPath')],
    [NATIVE_RELAY_CONFIG, body + "\nfetch('https://api.anthropic.com/v1/messages')\n"],
    [NATIVE_RELAY_CONFIG, body.replace('return { env: routed,', 'fetch(routed.ANTHROPIC_BASE_URL); return { env: routed,')],
    [NATIVE_RELAY_CONFIG, body + '\nconst endpoint = routed.ANTHROPIC_BASE_URL\n'],
    [NATIVE_RELAY_CONFIG, body + "\nconst endpoint = routed['ANTHROPIC_' + 'BASE_URL']\n"],
    [NATIVE_RELAY_CONFIG, body.replace('return { env: routed,', "const send = globalThis['fetch']; send(routed['ANTHROPIC_' + 'BASE_URL']); return { env: routed,")],
    [NATIVE_RELAY_CONFIG, body + "\nimport { request as send } from 'node:https'; send(endpoint)\n"],
    [NATIVE_RELAY_CONFIG, body + "\nimport { request as send } from 'node:http'; send(endpoint)\n"],
  ]) {
    expect(fenceViolations(path!, mutant!).length, path).toBeGreaterThan(0)
  }
})

test('no direct api.anthropic.com fetches in owner-facing LLM call sites', () => {
  const base = process.cwd()
  const violations: Array<{ file: string; rule: string }> = []
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
      for (const rule of fenceViolations(relPath, body)) violations.push({ file: relPath, rule })
    }
  }
  if (violations.length > 0) {
    const report = violations
      .map((v) => `  ${v.file}: ${v.rule}`)
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
