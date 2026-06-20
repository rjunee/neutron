/**
 * Cross-surface timing-safe project_slug comparison check (ISSUE #34).
 *
 * Argus r1 P2 finding on PR #280: every per-instance HTTP surface was
 * comparing the resolved bearer's `project_slug` against the gateway's
 * `project_slug` with plain `!==`, which short-circuits on the first
 * byte mismatch. A skilled attacker holding a HS256 bearer for instance
 * A could feed it into instance B's gateway and time the 403 response
 * to learn the prefix of B's slug.
 *
 * Defense-in-depth fix: every surface routes the comparison through
 * `ownerSlugMismatch()` from `gateway/http/auth-helpers.ts`, which
 * wraps `node:crypto`'s `timingSafeEqual`.
 *
 * This test is the cross-surface invariant: source-grep each file in
 * `gateway/http/` whose name matches `app-*-surface.ts`,
 * `admin-*-surface.ts`, or `chat-bridge.ts`, and assert that no
 * `project_slug !==` or `project_slug ===` patterns survive. Any future
 * surface that adds a plain equality check fails this test.
 *
 * Also asserts a smoke test of the helper itself: equal-string returns
 * false (match), prefix-but-shorter returns true (length differs),
 * differing-but-equal-length returns true.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ownerSlugMismatch } from '../auth-helpers.ts'

const HTTP_DIR = join(import.meta.dir, '..')

/**
 * Files in scope for the cross-surface invariant. Picks up:
 *   - every `app-*-surface.ts`
 *   - every `admin-*-surface.ts`
 *   - `chat-bridge.ts` (per-instance ws upgrade auth)
 *   - `cores-oauth-surface.ts` (per-instance OAuth grant surface)
 *
 * A new surface added under `gateway/http/` that follows the naming
 * convention is automatically picked up by `readdirSync`; the test
 * fails the first time a `project_slug !==` or `project_slug ===` slips
 * back in.
 */
function inScopeSurfaces(): string[] {
  return readdirSync(HTTP_DIR)
    .filter((name) => {
      if (!name.endsWith('.ts')) return false
      if (name.endsWith('.test.ts')) return false
      if (/^app-.+-surface\.ts$/.test(name)) return true
      if (/^admin-.+-surface\.ts$/.test(name)) return true
      if (name === 'chat-bridge.ts') return true
      if (name === 'cores-oauth-surface.ts') return true
      return false
    })
    .sort()
}

describe('project_slug timing-safe comparison (ISSUE #34)', () => {
  it('inScopeSurfaces() finds the expected files', () => {
    const surfaces = inScopeSurfaces()
    // Sanity: every named file from the brief is present.
    expect(surfaces).toContain('app-admin-surface.ts')
    expect(surfaces).toContain('app-docs-surface.ts')
    expect(surfaces).toContain('app-upload-surface.ts')
    expect(surfaces).toContain('app-reminders-surface.ts')
    expect(surfaces).toContain('app-tasks-surface.ts')
    expect(surfaces).toContain('admin-personality-surface.ts')
    expect(surfaces).toContain('chat-bridge.ts')
    expect(surfaces).toContain('cores-oauth-surface.ts')
    // Sanity: at least 8 files in scope (defensive — picks up future
    // surfaces that follow the naming convention).
    expect(surfaces.length).toBeGreaterThanOrEqual(8)
  })

  it('no surface uses plain !== or === on project_slug', () => {
    const offenders: { file: string; line: number; text: string }[] = []
    for (const name of inScopeSurfaces()) {
      const body = readFileSync(join(HTTP_DIR, name), 'utf8')
      const lines = body.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (line === undefined) continue
        // Strip line comments + block-comment lines so doc comments
        // mentioning the old pattern as legacy context don't trip the
        // grep. Source code itself never gets a comment marker.
        const trimmed = line.trim()
        if (trimmed.startsWith('//')) continue
        if (trimmed.startsWith('*')) continue
        if (/project_slug\s*(?:!==|===)/.test(line)) {
          offenders.push({ file: name, line: i + 1, text: line.trim() })
        }
      }
    }
    if (offenders.length > 0) {
      const pretty = offenders
        .map((o) => `  ${o.file}:${o.line} — ${o.text}`)
        .join('\n')
      throw new Error(
        `Surfaces still use plain !==/=== on project_slug. Route via ownerSlugMismatch() from gateway/http/auth-helpers.ts:\n${pretty}`,
      )
    }
    expect(offenders).toHaveLength(0)
  })

  it('every surface that compares project_slug imports ownerSlugMismatch', () => {
    // A surface that calls `ownerSlugMismatch(` must have an import
    // for it. Catches a "shadow re-implementation" copy-paste regression
    // where someone adds a local copy of the helper that diverges from
    // the canonical implementation.
    const missing: string[] = []
    for (const name of inScopeSurfaces()) {
      const body = readFileSync(join(HTTP_DIR, name), 'utf8')
      if (!body.includes('ownerSlugMismatch(')) continue
      const importLine = /from ['"]\.\/auth-helpers\.ts['"]/.test(body)
      if (!importLine) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  it('ownerSlugMismatch returns false on exact match', () => {
    expect(ownerSlugMismatch('alpha', 'alpha')).toBe(false)
    expect(ownerSlugMismatch('casey', 'casey')).toBe(false)
    // Empty strings are equal — degenerate but the helper handles it.
    expect(ownerSlugMismatch('', '')).toBe(false)
  })

  it('ownerSlugMismatch returns true on differing-length inputs', () => {
    // Length differential short-circuits before timingSafeEqual; the
    // helper accepts this length-as-side-channel because slug grammar
    // narrowly caps length and timingSafeEqual demands equal buffers.
    expect(ownerSlugMismatch('alpha', 'alphabet')).toBe(true)
    expect(ownerSlugMismatch('alphabet', 'alpha')).toBe(true)
    expect(ownerSlugMismatch('', 'a')).toBe(true)
  })

  it('ownerSlugMismatch returns true on same-length-different inputs', () => {
    expect(ownerSlugMismatch('alpha', 'beta1')).toBe(true)
    expect(ownerSlugMismatch('test1', 'test2')).toBe(true)
    // Common-prefix-but-different-tail is the exact attack shape the
    // helper closes: plain `!==` would short-circuit on the 5th byte.
    expect(ownerSlugMismatch('casey', 'alins')).toBe(true)
  })
})
