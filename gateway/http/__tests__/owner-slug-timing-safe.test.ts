/**
 * Cross-surface timing-safe project_slug comparison check (ISSUE #34).
 *
 * Argus r1 P2 finding on PR #280: every per-instance auth surface was
 * comparing the resolved bearer's `project_slug` against the gateway's
 * `project_slug` with plain `!==` / `===`, which short-circuits on the first
 * byte mismatch. A skilled attacker holding a signed bearer/token for instance
 * A could feed it into instance B's gateway and time the 403/401 response to
 * learn the prefix of B's slug.
 *
 * Defense-in-depth fix: every surface routes the comparison through a
 * constant-time byte-equality primitive.
 *   - The `gateway/http/` per-instance HTTP surfaces (`app-*-surface.ts`,
 *     `admin-*-surface.ts`, `cores-oauth-surface.ts`) route through
 *     `ownerSlugMismatch()` from `gateway/http/auth-helpers.ts`.
 *   - The per-instance TOKEN/COOKIE/BEARER auth surfaces route through
 *     `constantTimeEqual()` from `runtime/constant-time-equal.ts` directly:
 *       · `landing/auth-gate.ts` — the `?start=<token>` + session-cookie HTTP
 *         gate. This is the LIVE per-instance start-token/cookie slug
 *         validation surface. (It replaced `gateway/http/chat-bridge.ts`'s
 *         `validateStartToken`, which K11b0 deleted — the `/ws/chat` bridge was
 *         fully dead in production; onboarding + chat unified on `/ws/app/chat`.)
 *       · `channels/adapters/app-ws/auth.ts` — the `/ws/app/chat` HS256 bearer
 *         resolver's `project_slug` cross-check.
 *
 * Both surface groups share ONE constant-time primitive: `ownerSlugMismatch`
 * wraps `runtime/constant-time-equal.ts:constantTimeEqual`.
 *
 * K11b0 note: `gateway/http/chat-bridge.ts` is NO LONGER an auth surface (its
 * dead WS-upgrade token validation was excised), so it is no longer scanned
 * here. Its live replacement — `landing/auth-gate.ts` — used plain `===` on the
 * slug (a PRE-EXISTING gap: auth-gate never adopted the timing-safe compare; the
 * requirement had only ever been enforced on the dead bridge). K11b0 closed that
 * gap by routing auth-gate + the app-ws bearer resolver through `constantTimeEqual`.
 *
 * This test is the cross-surface invariant: source-scan each surface and assert
 * no plain `===` / `!==` slug comparison survives. Any future surface that adds
 * a plain equality check on a slug fails this test.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ownerSlugMismatch } from '../auth-helpers.ts'

const HTTP_DIR = join(import.meta.dir, '..')
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * `gateway/http/` per-instance HTTP surfaces in scope. Picks up:
 *   - every `app-*-surface.ts`
 *   - every `admin-*-surface.ts`
 *   - `cores-oauth-surface.ts` (per-instance OAuth grant surface)
 *
 * A new surface added under `gateway/http/` that follows the naming
 * convention is automatically picked up by `readdirSync`; the test fails the
 * first time a `project_slug !==` / `project_slug ===` slips back in.
 */
function inScopeSurfaces(): string[] {
  return readdirSync(HTTP_DIR)
    .filter((name) => {
      if (!name.endsWith('.ts')) return false
      if (name.endsWith('.test.ts')) return false
      if (/^app-.+-surface\.ts$/.test(name)) return true
      if (/^admin-.+-surface\.ts$/.test(name)) return true
      if (name === 'cores-oauth-surface.ts') return true
      return false
    })
    .sort()
}

/**
 * The per-instance TOKEN / COOKIE / BEARER auth surfaces (outside
 * `gateway/http/`) that validate a caller-supplied slug against the gateway
 * slug. These use `constantTimeEqual` directly (they live in bands that import
 * the runtime primitive, not the gateway `auth-helpers`).
 */
const TOKEN_AUTH_SURFACES: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'landing/auth-gate.ts', path: join(REPO_ROOT, 'landing', 'auth-gate.ts') },
  {
    label: 'channels/adapters/app-ws/auth.ts',
    path: join(REPO_ROOT, 'channels', 'adapters', 'app-ws', 'auth.ts'),
  },
]

/** Strip whole-line comments so a doc comment naming the legacy pattern as
 *  context (e.g. `// the previous strict \`x === opts.project_slug\``) never
 *  trips the scan. Source code itself never carries a comment marker. */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * A PLAIN-equality slug comparison the timing-safe invariant forbids:
 *   - `SLUG_RHS` — a `*_slug` / `*Slug` identifier on the RIGHT of `===` / `!==`
 *     (`claimSlug === opts.project_slug`, `current === claimSlug`,
 *     `tokenProjectSlug !== project_slug`, `cookieSlug === opts.project_slug`).
 *     This shape covers every real slug-vs-slug comparison.
 *   - `PROJECT_SLUG_LHS` — the literal `project_slug` on the LEFT of `===` /
 *     `!==` against a non-nullish operand (defense for the `X.project_slug !== Y`
 *     shape). `null` / `undefined` / string-literal guards are excluded, so
 *     `cookieSlug !== null`, `tokenProjectSlug !== undefined`, and
 *     `typeof x !== 'string'` are NOT flagged.
 */
const SLUG_RHS = /(?:===|!==)\s*(?:opts\.)?[A-Za-z_][\w.]*[Ss]lug\b/
const PROJECT_SLUG_LHS =
  /(?<![\w.])project_slug\s*(?:===|!==)(?!\s*(?:null\b|undefined\b|['"`]))/

function scanPlainSlugEquality(body: string): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || isCommentLine(line)) continue
    if (SLUG_RHS.test(line) || PROJECT_SLUG_LHS.test(line)) {
      offenders.push({ line: i + 1, text: line.trim() })
    }
  }
  return offenders
}

describe('project_slug timing-safe comparison (ISSUE #34)', () => {
  it('inScopeSurfaces() finds the expected gateway/http surfaces', () => {
    const surfaces = inScopeSurfaces()
    expect(surfaces).toContain('app-admin-surface.ts')
    expect(surfaces).toContain('app-docs-surface.ts')
    expect(surfaces).toContain('app-upload-surface.ts')
    expect(surfaces).toContain('app-reminders-surface.ts')
    expect(surfaces).toContain('app-tasks-surface.ts')
    expect(surfaces).toContain('admin-personality-surface.ts')
    expect(surfaces).toContain('cores-oauth-surface.ts')
    // chat-bridge.ts is NO LONGER an auth surface (K11b0 excised its dead WS
    // token validation) — it must not be scanned as one.
    expect(surfaces).not.toContain('chat-bridge.ts')
    // At least 7 files in scope (defensive — picks up future surfaces).
    expect(surfaces.length).toBeGreaterThanOrEqual(7)
  })

  it('no gateway/http surface uses plain !== or === on project_slug', () => {
    const offenders: { file: string; line: number; text: string }[] = []
    for (const name of inScopeSurfaces()) {
      const body = readFileSync(join(HTTP_DIR, name), 'utf8')
      const lines = body.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (line === undefined || isCommentLine(line)) continue
        if (/project_slug\s*(?:!==|===)/.test(line)) {
          offenders.push({ file: name, line: i + 1, text: line.trim() })
        }
      }
    }
    if (offenders.length > 0) {
      const pretty = offenders.map((o) => `  ${o.file}:${o.line} — ${o.text}`).join('\n')
      throw new Error(
        `Surfaces still use plain !==/=== on project_slug. Route via ownerSlugMismatch() from gateway/http/auth-helpers.ts:\n${pretty}`,
      )
    }
    expect(offenders).toHaveLength(0)
  })

  it('every gateway/http surface that compares project_slug imports ownerSlugMismatch', () => {
    // A surface that calls `ownerSlugMismatch(` must IMPORT it — either directly
    // from `./auth-helpers.ts`, or via `./surface-kit.ts` which RE-EXPORTS the
    // exact same timing-safe primitive from auth-helpers (O7 consolidation).
    // Catches a "shadow re-implementation" copy-paste regression.
    const missing: string[] = []
    for (const name of inScopeSurfaces()) {
      const body = readFileSync(join(HTTP_DIR, name), 'utf8')
      if (!body.includes('ownerSlugMismatch(')) continue
      const importLine =
        /from ['"]\.\/auth-helpers\.ts['"]/.test(body) || /from ['"]\.\/surface-kit\.ts['"]/.test(body)
      if (!importLine) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  it('surface-kit RE-EXPORTS the timing-safe ownerSlugMismatch straight from auth-helpers (no shadow impl)', () => {
    // The O7 consolidation seam: surfaces routing `ownerSlugMismatch` through
    // surface-kit must get the CANONICAL timing-safe primitive, not a local
    // re-implementation. Pin that surface-kit re-exports it directly from
    // auth-helpers — so a future shadow copy in surface-kit fails this guard.
    const kit = readFileSync(join(HTTP_DIR, 'surface-kit.ts'), 'utf8')
    // A single `export { … ownerSlugMismatch … } from './auth-helpers.ts'` block.
    const reexport = /export\s*\{[^}]*\bownerSlugMismatch\b[^}]*\}\s*from\s*['"]\.\/auth-helpers\.ts['"]/s.test(kit)
    expect(reexport).toBe(true)
    // And surface-kit must NOT define its own `function ownerSlugMismatch`.
    expect(/function\s+ownerSlugMismatch\b/.test(kit)).toBe(false)
  })

  it('the token/cookie/bearer auth surfaces use constantTimeEqual, not plain slug equality', () => {
    // The LIVE per-instance start-token/cookie/bearer slug validation. These
    // replaced the dead chat-bridge WS auth; the invariant lives here now.
    for (const { label, path } of TOKEN_AUTH_SURFACES) {
      const body = readFileSync(path, 'utf8')
      // Positive: routes slug equality through the shared constant-time primitive.
      expect(
        body.includes('constantTimeEqual'),
        `${label} must import + use constantTimeEqual for slug comparison`,
      ).toBe(true)
      // L5 (2026-07) — cross-workspace imports moved from relative paths to
      // `@neutronai/<pkg>/...` specifiers; accept either form so this
      // doesn't re-trip on the next specifier-style sweep.
      expect(
        /from ['"](?:(?:\.\.\/)+runtime|@neutronai\/runtime)\/constant-time-equal\.ts['"]/.test(
          body,
        ),
        `${label} must import constantTimeEqual from runtime/constant-time-equal.ts`,
      ).toBe(true)
      // Negative: no plain ===/!== slug comparison survives.
      const offenders = scanPlainSlugEquality(body)
      if (offenders.length > 0) {
        const pretty = offenders.map((o) => `  ${label}:${o.line} — ${o.text}`).join('\n')
        throw new Error(
          `${label} still uses plain !==/=== on a slug. Route via constantTimeEqual():\n${pretty}`,
        )
      }
      expect(offenders).toHaveLength(0)
    }
  })

  it('ownerSlugMismatch returns false on exact match', () => {
    expect(ownerSlugMismatch('alpha', 'alpha')).toBe(false)
    expect(ownerSlugMismatch('casey', 'casey')).toBe(false)
    // Empty strings are equal — degenerate but the helper handles it.
    expect(ownerSlugMismatch('', '')).toBe(false)
  })

  it('ownerSlugMismatch returns true on differing-length inputs', () => {
    // Length differential short-circuits before timingSafeEqual; the helper
    // accepts this length-as-side-channel because slug grammar narrowly caps
    // length and timingSafeEqual demands equal buffers.
    expect(ownerSlugMismatch('alpha', 'alphabet')).toBe(true)
    expect(ownerSlugMismatch('alphabet', 'alpha')).toBe(true)
    expect(ownerSlugMismatch('', 'a')).toBe(true)
  })

  it('ownerSlugMismatch returns true on same-length-different inputs', () => {
    expect(ownerSlugMismatch('alpha', 'beta1')).toBe(true)
    expect(ownerSlugMismatch('test1', 'test2')).toBe(true)
    // Common-prefix-but-different-tail is the exact attack shape the helper
    // closes: plain `!==` would short-circuit on the 5th byte.
    expect(ownerSlugMismatch('casey', 'alins')).toBe(true)
  })
})
