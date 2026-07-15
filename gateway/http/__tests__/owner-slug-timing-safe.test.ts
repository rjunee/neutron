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
import ts from 'typescript'

import { ownerSlugMismatch } from '../auth-helpers.ts'

/**
 * AST BIND-ANALYSIS for `ownerSlugMismatch` usage in one surface source. Returns a
 * reason string if the surface would invoke a NON-canonical `ownerSlugMismatch`
 * (the timing-safe project_slug comparator), else `null`.
 *
 * A surface is clean iff, when it references the name at all, it has a canonical
 * NAMED import (`./auth-helpers.ts` or `./surface-kit.ts`) AND nothing shadows it:
 * no local function/var/param/binding-element named `ownerSlugMismatch`, no
 * `import * as ownerSlugMismatch`, no non-canonical named import, and no qualified
 * `x.ownerSlugMismatch(...)` call (which would bypass the direct canonical binding).
 */
function ownerSlugMismatchBindingOffense(source: string, fileName: string): string | null {
  const NAME = 'ownerSlugMismatch'
  const CANON = /^\.\/(?:auth-helpers|surface-kit)\.ts$/
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  let referenced = false
  let canonicalImport = false
  let shadow: string | null = null
  let qualifiedCall: string | null = null

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const spec = node.moduleSpecifier
      const mod = ts.isStringLiteral(spec) ? spec.text : ''
      const bindings = node.importClause.namedBindings
      if (ts.isNamespaceImport(bindings) && bindings.name.text === NAME) {
        shadow = `import * as ${NAME}`
        referenced = true
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.name.text === NAME) {
            referenced = true
            if (CANON.test(mod)) canonicalImport = true
            else shadow = `named import from non-canonical '${mod}'`
          }
        }
      }
    }
    // A local binding of the name (function / var / param / destructure element).
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === NAME
    ) {
      shadow = `local ${ts.SyntaxKind[node.kind]} binding`
      referenced = true
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === NAME) referenced = true
      // Dot form: `x.ownerSlugMismatch(...)`.
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === NAME) {
        qualifiedCall = `qualified call ${callee.getText(sf)}`
        referenced = true
      }
      // Bracket form: `x['ownerSlugMismatch'](...)` (string-literal element access).
      if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression) &&
        callee.argumentExpression.text === NAME
      ) {
        qualifiedCall = `element-access call ${callee.getText(sf)}`
        referenced = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (!referenced) return null
  if (qualifiedCall !== null) return qualifiedCall
  if (shadow !== null) return shadow
  if (!canonicalImport) return 'no canonical import of ownerSlugMismatch'
  return null
}

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

/** EVERY `gateway/http/*-surface.ts` (the O7 consolidation scope). Excludes
 *  `surface-kit.ts` itself (name ends `-kit.ts`, not `-surface.ts`) — the ONE
 *  place these helpers are allowed to be defined. */
function allSurfaceFiles(): string[] {
  return readdirSync(HTTP_DIR)
    .filter((name) => /-surface\.ts$/.test(name) && !name.endsWith('.test.ts'))
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

  it('AST: every surface invoking ownerSlugMismatch calls the CANONICAL import (no shadow/param/qualified bypass)', () => {
    // Source regexes cannot prove the INVOKED function is canonical — a surface can
    // shadow the import via a parameter, a `./shadow.ts` import, an
    // `import * as x` + `x.ownerSlugMismatch(...)`, or a local var. So bind-analyze
    // the AST (Codex): for each surface that references the name, require a canonical
    // named import AND reject every shadow form + every qualified call.
    const offenders: Array<{ file: string; why: string }> = []
    for (const name of allSurfaceFiles()) {
      const why = ownerSlugMismatchBindingOffense(readFileSync(join(HTTP_DIR, name), 'utf8'), name)
      if (why !== null) offenders.push({ file: name, why })
    }
    expect(offenders).toEqual([])
  })

  it('AST guard self-test: it FLAGS every shadow-bypass form and PASSES canonical usage', () => {
    const flag = (src: string): boolean => ownerSlugMismatchBindingOffense(src, 'x.ts') !== null
    // Every bypass an independent reviewer surfaced across the O7 rounds:
    expect(flag("import { ownerSlugMismatch } from './surface-kit.ts'\nfunction r(ownerSlugMismatch){return ownerSlugMismatch('a','b')}")).toBe(true) // param shadow
    expect(flag("import { ownerSlugMismatch } from './shadow.ts'\nownerSlugMismatch('a','b')")).toBe(true) // non-canonical import
    expect(
      flag("import { ownerSlugMismatch } from './surface-kit.ts'\nimport * as s from './shadow.ts'\ns.ownerSlugMismatch('a','b')"),
    ).toBe(true) // qualified call + unused canonical import
    expect(flag("import * as ownerSlugMismatch from './shadow.ts'\nownerSlugMismatch.cmp('a','b')")).toBe(true) // namespace shadow
    expect(
      flag("import { jsonError } from './surface-kit.ts'\nimport * as x from './shadow.ts'\nx['ownerSlugMismatch']('a','b')"),
    ).toBe(true) // element-access (bracket-string) call
    expect(
      flag("import { ownerSlugMismatch } from './surface-kit.ts'\nconst ownerSlugMismatch = (a: string, b: string) => a === b\nownerSlugMismatch('a','b')"),
    ).toBe(true) // local var shadow
    // Canonical direct usage + no usage both pass:
    expect(flag("import { jsonError, ownerSlugMismatch } from './surface-kit.ts'\nownerSlugMismatch('a','b')")).toBe(false)
    expect(flag("import { ownerSlugMismatch } from './auth-helpers.ts'\nownerSlugMismatch('a','b')")).toBe(false)
    expect(flag("import { jsonError } from './surface-kit.ts'\njsonError(1,'x','y')")).toBe(false)
  })

  it('NO gateway/http surface defines a LOCAL copy of a surface-kit helper (consolidation complete)', () => {
    // The O7 completeness invariant + drift guard: surface-kit.ts is the ONE place
    // these helpers are defined. A surface must never carry its own copy — that is
    // exactly the drift-prone duplication O7 eliminates, and a local
    // `ownerSlugMismatch` copy is the shadow-implementation security hole. A local
    // `function`/`const`/`let`/`var` declaration is unambiguous in source text; this
    // catches every current + future duplicate. (Genuine USE is enforced by tsc:
    // calling an unimported helper is a compile error, so a surface that uses one
    // MUST import it from the kit — there is nowhere else to get it.)
    const LOCAL_DEF =
      /\b(?:async\s+)?function\s+(?:resolveBearer|readJsonBody|jsonResponse|jsonOk|jsonError|ownerSlugMismatch)\b|\b(?:const|let|var)\s+(?:resolveBearer|readJsonBody|jsonResponse|jsonOk|jsonError|ownerSlugMismatch)\s*=/
    const offenders: string[] = []
    for (const name of allSurfaceFiles()) {
      if (LOCAL_DEF.test(readFileSync(join(HTTP_DIR, name), 'utf8'))) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('surface-kit re-exports the SAME timing-safe reference as auth-helpers (runtime identity, not a shadow)', async () => {
    // RUNTIME identity beats a source-regex: a shadow re-implementation in
    // surface-kit would be a DIFFERENT function object. `Object.is` proves the
    // re-export forwards the canonical timing-safe primitive verbatim — so every
    // surface importing it from the kit gets the exact auth-helpers implementation.
    const kit = await import('../surface-kit.ts')
    const helpers = await import('../auth-helpers.ts')
    expect(kit.ownerSlugMismatch).toBe(helpers.ownerSlugMismatch)
    expect(kit.ownerIdentityMismatch).toBe(helpers.ownerIdentityMismatch)
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
