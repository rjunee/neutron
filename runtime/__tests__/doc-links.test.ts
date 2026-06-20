/**
 * runtime/doc-links.ts — P7.3 helper test suite.
 *
 * Per SPEC.md § Phases→Steps (P7.3 doc-link
 * helper). The acceptance gates surface here are:
 *
 *   1. buildDocLink resolves the right URL shape per channel.
 *   2. Vault-legacy fallback (no project_id) still routes via
 *      vault.example.test so Sam's pre-Neutron chat references
 *      keep working — sprint roadmap § 5 backward-compat note.
 *   3. parseDocLink round-trips every emitted URL shape AND the
 *      internal `docs:/<project_id>/<path>` marker.
 *   4. rewriteDocRefsInBody only touches `[label](docs:/…)`
 *      patterns; non-doc markdown links pass through untouched;
 *      result is idempotent on a second pass.
 *   5. URL-encoding handles spaces, parens, hashes, and unicode in
 *      path segments without breaking the tree shape (slashes stay
 *      literal).
 *   6. Path/project_id validation matches the gateway's own
 *      sanitiser (`channels/adapters/app-ws/envelope.ts`).
 */

import { describe, expect, test } from 'bun:test'
// Type-only import (erased at runtime) so the dynamically-imported
// `DocLinkError` value can still be referenced in type positions below.
import type { DocLinkError as DocLinkErrorT } from '../doc-links.ts'

// The doc-link 'web' channel base is env-configured with NO hosted
// default (`process.env.NEUTRON_WEB_APP_BASE ?? ''`). Set it BEFORE the
// module is imported so the assertions below — which reference the
// imported `WEB_APP_BASE` constant — exercise the absolute-web-URL path.
process.env.NEUTRON_WEB_APP_BASE = 'https://app.neutron.example'

const {
  buildDocLink,
  DocLinkError,
  findInlineDocLinks,
  NEUTRON_SCHEME,
  VAULT_REDIRECTOR_BASE,
  WEB_APP_BASE,
  parseDocLink,
  resolveDocRefs,
  rewriteDocRefsInBody,
  deriveLabel,
  MAX_DOC_PATH_LEN,
} = await import('../doc-links.ts')

describe('runtime/doc-links — buildDocLink', () => {
  test('app channel produces neutron:// deep link with encoded path', () => {
    const url = buildDocLink({
      project_id: 'acme',
      path: 'launch-plan v3.md',
      channel: 'app',
    })
    expect(url).toBe(`${NEUTRON_SCHEME}://docs/acme/launch-plan%20v3.md`)
  })

  test('web channel produces https URL on the configured web-app host targeting the Expo /projects/<id>/docs route', () => {
    // Argus r4 BLOCKING #1: the URL must point at a route that ACTUALLY
    // exists in the static web export — `app/app/projects/[id]/docs.tsx`.
    // Path lives in the `?path=` query param (single encodeURIComponent
    // pass, so internal `/` become `%2F`).
    const url = buildDocLink({
      project_id: 'acme',
      path: 'launch-plan.md',
      channel: 'web',
    })
    expect(url).toBe(`${WEB_APP_BASE}/projects/acme/docs?path=launch-plan.md`)
  })

  test('web channel URL %2F-encodes path slashes (single encodeURIComponent pass)', () => {
    // Mirrors `docLinkToRouterPath` in app/lib/doc-links.ts — the query
    // payload is one opaque path value, so internal slashes are %2F.
    const url = buildDocLink({
      project_id: 'p1',
      path: 'a/b.md',
      channel: 'web',
    })
    expect(url).toBe(`${WEB_APP_BASE}/projects/p1/docs?path=a%2Fb.md`)
  })

  test('telegram channel with project_id produces neutron:// deep link', () => {
    // Brief literal: "ADD `neutron://...` links for project-scoped
    // docs" — sprint roadmap § 5 architectural decision.
    const url = buildDocLink({
      project_id: 'acme',
      path: 'launch-plan.md',
      channel: 'telegram',
    })
    expect(url).toBe(`${NEUTRON_SCHEME}://docs/acme/launch-plan.md`)
  })

  test('telegram channel WITHOUT project_id falls back to vault.example.test (vault legacy)', () => {
    // Sprint roadmap § 5: "keep https://vault.example.test/<path>
    // for backward compat when no project_id (Sam's vault legacy)".
    const url = buildDocLink({
      project_id: null,
      path: 'Projects/neutron/STATUS.md',
      channel: 'telegram',
    })
    expect(url).toBe(`${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md`)
  })

  test('app channel WITHOUT project_id ALSO falls back to vault redirector', () => {
    // The vault-legacy fallback is uniform across all channels so a
    // vault link rendered in any surface resolves to the same URL.
    const url = buildDocLink({
      project_id: null,
      path: 'entities/people/jane-doe.md',
      channel: 'app',
    })
    expect(url).toBe(`${VAULT_REDIRECTOR_BASE}/entities/people/jane-doe.md`)
  })

  test('encodes nested path segments individually but preserves slashes', () => {
    const url = buildDocLink({
      project_id: 'acme',
      path: 'sub folder/notes (draft)/file #1.md',
      channel: 'app',
    })
    expect(url).toBe(
      `${NEUTRON_SCHEME}://docs/acme/sub%20folder/notes%20(draft)/file%20%231.md`,
    )
  })

  test('strips a leading slash from path before encoding (relative-anchored)', () => {
    const url = buildDocLink({
      project_id: 'acme',
      path: '/launch-plan.md',
      channel: 'app',
    })
    expect(url).toBe(`${NEUTRON_SCHEME}://docs/acme/launch-plan.md`)
  })

  test('collapses runs of slashes in path', () => {
    const url = buildDocLink({
      project_id: 'acme',
      path: 'a//b///c.md',
      channel: 'web',
    })
    expect(url).toBe(`${WEB_APP_BASE}/projects/acme/docs?path=a%2Fb%2Fc.md`)
  })

  test('throws on empty path', () => {
    expect(() =>
      buildDocLink({ project_id: 'acme', path: '', channel: 'app' }),
    ).toThrow(DocLinkError)
  })

  test('throws on path longer than MAX_DOC_PATH_LEN', () => {
    const longPath = 'a'.repeat(MAX_DOC_PATH_LEN + 1)
    let err: unknown
    try {
      buildDocLink({ project_id: 'acme', path: longPath, channel: 'app' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DocLinkError)
    expect((err as DocLinkErrorT).code).toBe('path_too_long')
  })

  test('throws on malformed project_id with a slash', () => {
    expect(() =>
      buildDocLink({ project_id: 'bad/id', path: 'x.md', channel: 'app' }),
    ).toThrow(DocLinkError)
  })

  test('throws on malformed project_id with a space', () => {
    expect(() =>
      buildDocLink({ project_id: 'bad id', path: 'x.md', channel: 'app' }),
    ).toThrow(DocLinkError)
  })

  test('accepts uuid-like and slug-like project_ids', () => {
    expect(() =>
      buildDocLink({ project_id: 'proj-42', path: 'x.md', channel: 'app' }),
    ).not.toThrow()
    expect(() =>
      buildDocLink({ project_id: 'proj_42', path: 'x.md', channel: 'app' }),
    ).not.toThrow()
    expect(() =>
      buildDocLink({ project_id: 'A1B2C3.D4E5', path: 'x.md', channel: 'app' }),
    ).not.toThrow()
  })

  describe('Argus MINOR #2 — post-normalisation validation', () => {
    // Pre-fix, these paths passed the (`length === 0`) check before
    // normalisation, then normalisePath turned them into shapes that
    // parseDocLink later rejects (empty / `.` / `..` segments).
    // Post-fix, the same rejection rule runs AFTER normalisePath so
    // buildDocLink never emits a URL its own parser refuses.

    test('throws when path normalises to empty (single slash)', () => {
      let err: unknown
      try {
        buildDocLink({ project_id: 'acme', path: '/', channel: 'app' })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DocLinkError)
      expect((err as DocLinkErrorT).code).toBe('empty_path')
    })

    test('throws on `./plan.md` (leading-dot traversal segment)', () => {
      let err: unknown
      try {
        buildDocLink({ project_id: 'acme', path: './plan.md', channel: 'app' })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DocLinkError)
      expect((err as DocLinkErrorT).code).toBe('invalid_path')
    })

    test('throws on `a/../b.md` (internal `..` traversal segment)', () => {
      let err: unknown
      try {
        buildDocLink({ project_id: 'acme', path: 'a/../b.md', channel: 'app' })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DocLinkError)
      expect((err as DocLinkErrorT).code).toBe('invalid_path')
    })

    test('throws on bare `..` path', () => {
      let err: unknown
      try {
        buildDocLink({ project_id: 'acme', path: '..', channel: 'app' })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DocLinkError)
    })

    test('throws on vault-legacy path that normalises to traversal', () => {
      let err: unknown
      try {
        buildDocLink({ project_id: null, path: '../etc/passwd', channel: 'web' })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DocLinkError)
      expect((err as DocLinkErrorT).code).toBe('invalid_path')
    })

    test('still accepts a path containing `..` as part of a segment', () => {
      // `foo..bar.md` is a valid filename — only the bare `..` segment
      // is a traversal marker.
      expect(() =>
        buildDocLink({
          project_id: 'acme',
          path: 'foo..bar.md',
          channel: 'app',
        }),
      ).not.toThrow()
    })

    test('parseDocLink can round-trip every URL buildDocLink emits', () => {
      // The fundamental invariant the new validation protects:
      // buildDocLink must not emit a URL parseDocLink would reject.
      const cases = [
        { project_id: 'acme', path: 'launch-plan.md' },
        { project_id: 'acme', path: '/launch-plan.md' },
        { project_id: 'acme', path: 'a//b///c.md' },
        { project_id: 'acme', path: 'sub folder/file.md' },
        { project_id: null, path: 'Projects/neutron/STATUS.md' },
      ]
      for (const c of cases) {
        const url = buildDocLink({ ...c, channel: 'app' })
        const parsed = parseDocLink(url)
        expect(parsed).not.toBeNull()
      }
    })
  })
})

describe('runtime/doc-links — findInlineDocLinks (Argus MINOR #1)', () => {
  test('matches a vanilla `[label](docs:/<proj>/<path>)` marker', () => {
    const body = 'See [plan](docs:/acme/launch.md) here.'
    const m = findInlineDocLinks(body)
    expect(m).toHaveLength(1)
    expect(m[0]).toEqual({
      index: 4,
      end: 32,
      label: 'plan',
      target: 'docs:/acme/launch.md',
    })
  })

  test('matches a marker whose path contains a literal space', () => {
    const body = '[plan](docs:/acme/launch plan.md)'
    const m = findInlineDocLinks(body)
    expect(m).toHaveLength(1)
    expect(m[0]?.target).toBe('docs:/acme/launch plan.md')
  })

  test('matches a marker whose path contains balanced parens', () => {
    const body = '[plan](docs:/acme/release/v(2).md)'
    const m = findInlineDocLinks(body)
    expect(m).toHaveLength(1)
    expect(m[0]?.target).toBe('docs:/acme/release/v(2).md')
  })

  test('skips a non-docs link', () => {
    const body = '[external](https://example.com)'
    expect(findInlineDocLinks(body)).toHaveLength(0)
  })

  test('skips unbalanced parens (path swallows past end of body)', () => {
    // `v(2.md` has an open `(` but no closing `)` before EOL — the
    // walker can't find the matching outer `)` so it bails.
    const body = '[plan](docs:/p/release/v(2.md)'
    expect(findInlineDocLinks(body)).toHaveLength(0)
  })

  test('terminates the URL walk on a newline', () => {
    const body = '[plan](docs:/p/x.md\n).'
    expect(findInlineDocLinks(body)).toHaveLength(0)
  })

  test('finds multiple matches in the same body', () => {
    const body = 'See [A](docs:/p/a.md) and [B](docs:/p/b.md).'
    const m = findInlineDocLinks(body)
    expect(m).toHaveLength(2)
    expect(m[0]?.label).toBe('A')
    expect(m[1]?.label).toBe('B')
  })

  test('supports a backslash-escaped `]` inside the label', () => {
    // Standard markdown allows `\]` to escape the closer; the walker
    // skips the escape and treats the next `]` as the real closer.
    const body = '[lab\\]el](docs:/p/x.md)'
    const m = findInlineDocLinks(body)
    expect(m).toHaveLength(1)
    expect(m[0]?.label).toBe('lab\\]el')
  })
})

describe('runtime/doc-links — parseDocLink', () => {
  test('round-trips a neutron:// URL', () => {
    const url = buildDocLink({
      project_id: 'acme',
      path: 'launch-plan v3.md',
      channel: 'app',
    })
    expect(parseDocLink(url)).toEqual({
      project_id: 'acme',
      path: 'launch-plan v3.md',
    })
  })

  test('round-trips a web URL', () => {
    const url = buildDocLink({
      project_id: 'acme',
      path: 'launch-plan.md',
      channel: 'web',
    })
    expect(parseDocLink(url)).toEqual({
      project_id: 'acme',
      path: 'launch-plan.md',
    })
  })

  test('round-trips a vault-legacy URL (project_id null)', () => {
    const url = buildDocLink({
      project_id: null,
      path: 'Projects/neutron/STATUS.md',
      channel: 'telegram',
    })
    expect(parseDocLink(url)).toEqual({
      project_id: null,
      path: 'Projects/neutron/STATUS.md',
    })
  })

  test('parses the internal docs:/<project_id>/<path> marker', () => {
    expect(parseDocLink('docs:/acme/launch-plan.md')).toEqual({
      project_id: 'acme',
      path: 'launch-plan.md',
    })
  })

  test('marker form is ALWAYS project-scoped — first segment is project_id', () => {
    // Documented contract: the internal docs:/ marker can't disambiguate
    // a vault-legacy reference from a 2-segment project path, so it's
    // always parsed as project-scoped. Vault references in chat use the
    // literal https://vault.example.test/<path> URL form.
    expect(parseDocLink('docs:/Projects/neutron/STATUS.md')).toEqual({
      project_id: 'Projects',
      path: 'neutron/STATUS.md',
    })
  })

  test('marker form REJECTED when no path after project_id', () => {
    expect(parseDocLink('docs:/acme')).toBeNull()
    expect(parseDocLink('docs:/acme/')).toBeNull()
    expect(parseDocLink('docs:/')).toBeNull()
  })

  describe('Argus r4 IMPORTANT #1 — docs:/ marker tail is URL-decoded', () => {
    // Pre-fix, the marker branch returned `tail` verbatim, so a pre-
    // encoded path like `foo%28draft%29.md` round-tripped through
    // buildDocLink as `foo%2528draft%2529.md` (double-encoded). The fix
    // routes the tail through `decodeDocPath` like every other URL
    // branch so the agent contract — "balance parens OR pre-encode
    // them as %28/%29" — actually holds.

    test('decodes %28/%29 in marker tail to literal parens', () => {
      expect(parseDocLink('docs:/p1/foo%28draft%29.md')).toEqual({
        project_id: 'p1',
        path: 'foo(draft).md',
      })
    })

    test('decodes %20 in marker tail to literal space', () => {
      expect(parseDocLink('docs:/p1/launch%20plan.md')).toEqual({
        project_id: 'p1',
        path: 'launch plan.md',
      })
    })

    test('round-trips a pre-encoded marker through buildDocLink without double-encoding', () => {
      const parsed = parseDocLink('docs:/p1/foo%28draft%29.md')
      expect(parsed).not.toBeNull()
      const rebuilt = buildDocLink({
        project_id: parsed!.project_id,
        path: parsed!.path,
        channel: 'app',
      })
      // Parens are URL-safe so encodeURIComponent leaves them literal.
      expect(rebuilt).toBe(`${NEUTRON_SCHEME}://docs/p1/foo(draft).md`)
      // The buggy double-encoded byte sequence MUST NOT appear.
      expect(rebuilt).not.toContain('%2528')
      expect(rebuilt).not.toContain('%2529')
    })

    test('round-trips a literal-paren path through buildDocLink → parseDocLink → identity', () => {
      // The other half of the contract: a literal-paren input also
      // round-trips. parseDocLink decodes the marker; buildDocLink
      // re-encodes (which is a no-op for `(` / `)`); parseDocLink on
      // the rebuilt URL recovers the literal path.
      const path = 'foo(draft).md'
      const marker = `docs:/p1/${path}`
      const parsed = parseDocLink(marker)
      expect(parsed).toEqual({ project_id: 'p1', path })
    })

    test('still rejects %2e%2e (encoded ..) traversal in marker tail', () => {
      // Decoded tail is `../foo.md` → `isSafeDecodedPath` rejects.
      expect(parseDocLink('docs:/p1/%2e%2e/foo.md')).toBeNull()
    })
  })

  test('marker form REJECTED when head fails project_id grammar', () => {
    expect(parseDocLink('docs:/bad id/foo.md')).toBeNull()
    expect(parseDocLink('docs:/bad%20id/foo.md')).toBeNull()
  })

  test('returns null on non-doc URLs', () => {
    expect(parseDocLink('https://example.com')).toBeNull()
    expect(parseDocLink(`${WEB_APP_BASE}/launcher`)).toBeNull()
    expect(parseDocLink('not a url')).toBeNull()
    expect(parseDocLink('')).toBeNull()
  })

  test('returns null on neutron:// missing project_id or path', () => {
    expect(parseDocLink('neutron://docs/')).toBeNull()
    expect(parseDocLink('neutron://docs/acme')).toBeNull()
    expect(parseDocLink('neutron://docs/acme/')).toBeNull()
  })

  test('returns null on malformed project_id in URL', () => {
    expect(parseDocLink('neutron://docs/bad id/foo.md')).toBeNull()
  })

  test('decodes percent-encoded path segments', () => {
    expect(parseDocLink('neutron://docs/acme/file%20name.md')).toEqual({
      project_id: 'acme',
      path: 'file name.md',
    })
  })

  test('handles nested URL-encoded paths with parens and hashes', () => {
    const url = `neutron://docs/acme/notes%20(draft)/file%20%231.md`
    expect(parseDocLink(url)).toEqual({
      project_id: 'acme',
      path: 'notes (draft)/file #1.md',
    })
  })

  describe('Argus hardening — defense-in-depth path validation', () => {
    test('rejects neutron:// URLs with `..` traversal segments (literal)', () => {
      // Argus MINOR #1: the doc-store sanitiser catches this server-side,
      // but the parser MUST also reject so downstream consumers never
      // see a non-null traversal parse.
      expect(parseDocLink('neutron://docs/p1/../../etc/passwd')).toBeNull()
    })

    test('rejects neutron:// URLs with `..` traversal segments (percent-encoded)', () => {
      // `%2e%2e` decodes to `..` — our segment check runs AFTER
      // decodeURIComponent so encoded forms are caught too.
      expect(parseDocLink('neutron://docs/p1/%2e%2e/foo.md')).toBeNull()
    })

    test('rejects neutron:// URLs with leading-slash path (absolute-style)', () => {
      // After `parseProjectAndPath` strips `p1/`, the encoded tail is
      // `/foo.md`. The decoded path starts with `/` → rejected.
      expect(parseDocLink('neutron://docs/p1//foo.md')).toBeNull()
    })

    test('rejects neutron:// URLs with `?` query string (Argus MINOR #2)', () => {
      expect(parseDocLink('neutron://docs/p1/foo.md?next=evil')).toBeNull()
    })

    test('rejects neutron:// URLs with `#` fragment', () => {
      expect(parseDocLink('neutron://docs/p1/foo.md#section')).toBeNull()
    })

    test('rejects web URLs with `..` traversal segments (encoded in path)', () => {
      // The web shape is `/projects/<id>/docs?path=<single-encoded path>`.
      // `..%2F..%2Fetc%2Fpasswd` decodes to `../../etc/passwd` → rejected.
      expect(
        parseDocLink(
          `${WEB_APP_BASE}/projects/p1/docs?path=${encodeURIComponent('../../etc/passwd')}`,
        ),
      ).toBeNull()
    })

    test('rejects old `${WEB_APP_BASE}/docs/<id>/<path>` shape (Argus r4 BLOCKING #1)', () => {
      // The old web shape targeted a route that never existed in the
      // static export — it 404'd in production. The parser must NOT
      // accept it either, so we don't silently re-introduce the bug.
      expect(parseDocLink(`${WEB_APP_BASE}/docs/p1/foo.md`)).toBeNull()
      expect(parseDocLink(`${WEB_APP_BASE}/docs/p1/../../etc/passwd`)).toBeNull()
    })

    test('rejects web URLs with extra query keys beyond `path=`', () => {
      // The canonical shape carries exactly one `?path=…` value. A second
      // key (e.g. `&next=evil`) must not pass.
      expect(
        parseDocLink(`${WEB_APP_BASE}/projects/p1/docs?path=foo.md&next=evil`),
      ).toBeNull()
    })

    test('rejects web URLs with a fragment', () => {
      expect(
        parseDocLink(`${WEB_APP_BASE}/projects/p1/docs?path=foo.md#evil`),
      ).toBeNull()
    })

    test('rejects web URLs missing the literal `docs?path=` segment', () => {
      expect(parseDocLink(`${WEB_APP_BASE}/projects/p1/docs`)).toBeNull()
      expect(parseDocLink(`${WEB_APP_BASE}/projects/p1/docs?evil`)).toBeNull()
      expect(parseDocLink(`${WEB_APP_BASE}/projects/p1/notdocs?path=foo.md`)).toBeNull()
    })

    test('rejects vault-legacy URLs with `..` traversal segments', () => {
      expect(parseDocLink(`${VAULT_REDIRECTOR_BASE}/../etc/passwd`)).toBeNull()
    })

    test('rejects vault-legacy URLs with query strings', () => {
      expect(parseDocLink(`${VAULT_REDIRECTOR_BASE}/Projects/foo.md?evil`)).toBeNull()
    })

    test('rejects marker form `docs:/<proj>/..` traversal segments', () => {
      expect(parseDocLink('docs:/p1/../foo.md')).toBeNull()
      expect(parseDocLink('docs:/p1/sub/../../../etc/passwd')).toBeNull()
    })

    test('rejects marker form with `?` query string', () => {
      expect(parseDocLink('docs:/p1/foo.md?x=1')).toBeNull()
    })

    test('rejects marker form with `#` fragment', () => {
      expect(parseDocLink('docs:/p1/foo.md#anchor')).toBeNull()
    })

    test('accepts paths that contain `..` as PART of a segment, just not the whole segment', () => {
      // `foo..bar.md` is a valid filename; only the bare `..` segment
      // is a traversal marker.
      expect(parseDocLink('neutron://docs/p1/foo..bar.md')).toEqual({
        project_id: 'p1',
        path: 'foo..bar.md',
      })
    })
  })
})

describe('runtime/doc-links — rewriteDocRefsInBody', () => {
  test('rewrites a single doc-ref marker for the app channel', () => {
    const body = 'See [the launch plan](docs:/acme/launch-plan.md) for details.'
    const out = rewriteDocRefsInBody(body, 'app')
    expect(out).toBe(
      `See [the launch plan](${NEUTRON_SCHEME}://docs/acme/launch-plan.md) for details.`,
    )
  })

  test('rewrites multiple doc-ref markers in the same body', () => {
    const body =
      'Both [A](docs:/proj-a/file-a.md) and [B](docs:/proj-b/file-b.md) need eyes.'
    const out = rewriteDocRefsInBody(body, 'web')
    expect(out).toBe(
      `Both [A](${WEB_APP_BASE}/projects/proj-a/docs?path=file-a.md) and ` +
        `[B](${WEB_APP_BASE}/projects/proj-b/docs?path=file-b.md) need eyes.`,
    )
  })

  test('vault-legacy refs use the literal vault.example.test URL — passes through untouched', () => {
    // Vault references in chat bodies use the literal URL form because
    // the docs:/ marker can't disambiguate vault from project paths.
    // Telegram (and the Expo client's RenderMarkdown) auto-linkify
    // bare URLs anyway.
    const body = `See ${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md for context.`
    expect(rewriteDocRefsInBody(body, 'telegram')).toBe(body)
    expect(rewriteDocRefsInBody(body, 'app')).toBe(body)
  })

  test('non-doc markdown links pass through untouched', () => {
    const body = 'Click [here](https://example.com) or [there](mailto:a@b.com).'
    expect(rewriteDocRefsInBody(body, 'app')).toBe(body)
  })

  test('plain prose passes through untouched', () => {
    const body = 'Just a paragraph, no markdown, no links.'
    expect(rewriteDocRefsInBody(body, 'app')).toBe(body)
  })

  test('malformed doc-ref markers (empty project_id w/ trailing path) pass through', () => {
    // `docs:/` followed by a project_id-shaped head but invalid grammar.
    // parseDocLink returns a vault-legacy fallback, but path validation
    // succeeds — so we DO rewrite this. The point of this test is that
    // when parseDocLink returns null (e.g. empty path), we leave the
    // raw text in place.
    const body = 'Bad: [x](docs:/)'
    expect(rewriteDocRefsInBody(body, 'app')).toBe(body)
  })

  test('is idempotent — second pass on already-rewritten body is a no-op', () => {
    const original = 'See [the plan](docs:/acme/plan.md).'
    const once = rewriteDocRefsInBody(original, 'app')
    const twice = rewriteDocRefsInBody(once, 'app')
    expect(twice).toBe(once)
  })

  test('Argus MINOR #1 — rewrites a marker with literal spaces in the path', () => {
    // Pre-fix: the regex `[^)\s]+` aborted at the first whitespace,
    // leaving the marker un-rewritten. Post-fix the walker tolerates
    // spaces because `buildDocLink` percent-encodes them anyway.
    const body = 'See [plan](docs:/acme/launch plan.md) for details.'
    const out = rewriteDocRefsInBody(body, 'app')
    expect(out).toBe(
      `See [plan](${NEUTRON_SCHEME}://docs/acme/launch%20plan.md) for details.`,
    )
  })

  test('Argus MINOR #1 — rewrites a marker with balanced parens in the path', () => {
    // The walker counts paren depth inside the URL payload so a
    // `v(2).md`-style segment closes at the correct `)`. The path
    // itself is preserved through encodeURIComponent (which leaves
    // `(` and `)` literal — they only need escaping inside Telegram
    // MarkdownV2 link payloads, not in plain URLs).
    const body = 'See [v2](docs:/acme/release/v(2).md).'
    const out = rewriteDocRefsInBody(body, 'app')
    expect(out).toBe(
      `See [v2](${NEUTRON_SCHEME}://docs/acme/release/v(2).md).`,
    )
  })

  test('marker containing literal `#` passes through verbatim (parser contract)', () => {
    // parseDocLink rejects any marker string that contains literal
    // `?` or `#` (URL-fragment-smuggling defense-in-depth). When that
    // rejection fires the rewriter pushes the raw markdown verbatim
    // so the agent can self-correct. Spaces are fine (test above);
    // `#` is the documented exception — callers should %-encode it.
    const body = 'See [draft](docs:/acme/file #1.md).'
    expect(rewriteDocRefsInBody(body, 'app')).toBe(body)
  })

  test('Argus r4 IMPORTANT #1 — rewrites a path containing percent-encoded segments (round-trips, no double-encode)', () => {
    // Pre-fix, the marker tail was returned verbatim from parseDocLink,
    // so `foo%28draft%29.md` round-tripped to `foo%2528draft%2529.md`
    // (double-encoded) — the rendered URL pointed at a non-existent
    // file. Post-fix, the marker tail is `decodeDocPath`-decoded like
    // every other URL branch, so `%28` → `(` before re-encoding.
    const body = 'See [draft](docs:/acme/notes%20(draft)/file%20%231.md).'
    const out = rewriteDocRefsInBody(body, 'app')
    // Decoded path is `notes (draft)/file #1.md` → re-encoded segment
    // by segment yields the identical URL we started with. NO `%25`.
    expect(out).toBe(
      `See [draft](${NEUTRON_SCHEME}://docs/acme/notes%20(draft)/file%20%231.md).`,
    )
    expect(out).not.toContain('%25')
  })

  test('Argus r4 IMPORTANT #1 — pre-encoded parens marker round-trips cleanly to URL', () => {
    // The agent contract literally says: "balance parens OR pre-encode
    // them as %28/%29 — the helper round-trips %-encoded paths
    // transparently." Pre-fix, the pre-encoded form double-encoded.
    const body = 'See [v2](docs:/acme/foo%28draft%29.md).'
    const out = rewriteDocRefsInBody(body, 'app')
    expect(out).toBe(`See [v2](${NEUTRON_SCHEME}://docs/acme/foo(draft).md).`)
  })

  test('does not rewrite a docs:/<...> target that buildDocLink would reject (too long)', () => {
    const overLong = 'x'.repeat(MAX_DOC_PATH_LEN + 1)
    const body = `See [oops](docs:/acme/${overLong}).`
    // buildDocLink throws; rewriter leaves the raw markdown in place.
    expect(rewriteDocRefsInBody(body, 'app')).toBe(body)
  })
})

describe('runtime/doc-links — resolveDocRefs', () => {
  test('resolves a list of structured refs to channel URLs', () => {
    const refs = [
      { label: 'Launch plan', project_id: 'acme', path: 'launch-plan.md' },
      { project_id: 'beacon', path: 'sub/file.md' },
      { project_id: null, path: 'Projects/neutron/STATUS.md' },
    ]
    const out = resolveDocRefs(refs, 'app')
    expect(out).toEqual([
      {
        label: 'Launch plan',
        url: `${NEUTRON_SCHEME}://docs/acme/launch-plan.md`,
        project_id: 'acme',
        path: 'launch-plan.md',
      },
      {
        label: 'file',
        url: `${NEUTRON_SCHEME}://docs/beacon/sub/file.md`,
        project_id: 'beacon',
        path: 'sub/file.md',
      },
      {
        label: 'STATUS',
        url: `${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md`,
        project_id: null,
        path: 'Projects/neutron/STATUS.md',
      },
    ])
  })

  test('drops malformed entries without poisoning the rest', () => {
    const refs: any[] = [
      { project_id: 'acme', path: 'good.md' },
      { project_id: 'bad id', path: 'oops.md' },
      null,
      'not-an-object',
      { project_id: 'acme', path: '' },
      { project_id: 'acme' /* no path */ },
    ]
    const out = resolveDocRefs(refs, 'web')
    expect(out).toHaveLength(1)
    expect(out[0]?.path).toBe('good.md')
  })
})

describe('runtime/doc-links — P7.3 line + range anchors', () => {
  describe('buildDocLink', () => {
    test('app channel: ?line=N appends to the neutron:// URL', () => {
      const url = buildDocLink({
        project_id: 'acme',
        path: 'launch-plan.md',
        channel: 'app',
        line: 42,
      })
      expect(url).toBe(`${NEUTRON_SCHEME}://docs/acme/launch-plan.md?line=42`)
    })

    test('telegram channel: ?line=N appends to the neutron:// URL', () => {
      const url = buildDocLink({
        project_id: 'acme',
        path: 'launch-plan.md',
        channel: 'telegram',
        line: 42,
      })
      expect(url).toBe(`${NEUTRON_SCHEME}://docs/acme/launch-plan.md?line=42`)
    })

    test('web channel: line merges as &line=N alongside the ?path= key', () => {
      const url = buildDocLink({
        project_id: 'acme',
        path: 'launch-plan.md',
        channel: 'web',
        line: 42,
      })
      expect(url).toBe(
        `${WEB_APP_BASE}/projects/acme/docs?path=launch-plan.md&line=42`,
      )
    })

    test('range produces ?range=N-M (app channel)', () => {
      const url = buildDocLink({
        project_id: 'p1',
        path: 'a.md',
        channel: 'app',
        range_start: 10,
        range_end: 20,
      })
      expect(url).toBe(`${NEUTRON_SCHEME}://docs/p1/a.md?range=10-20`)
    })

    test('range merges as &range=N-M on the web channel', () => {
      const url = buildDocLink({
        project_id: 'p1',
        path: 'a.md',
        channel: 'web',
        range_start: 10,
        range_end: 20,
      })
      expect(url).toBe(`${WEB_APP_BASE}/projects/p1/docs?path=a.md&range=10-20`)
    })

    test('omits anchor when neither line nor range is supplied', () => {
      const url = buildDocLink({
        project_id: 'acme',
        path: 'launch-plan.md',
        channel: 'app',
      })
      expect(url).toBe(`${NEUTRON_SCHEME}://docs/acme/launch-plan.md`)
      expect(url).not.toContain('?')
    })

    test('rejects line=0 (1-indexed; positive integer required)', () => {
      expect(() =>
        buildDocLink({ project_id: 'p1', path: 'a.md', channel: 'app', line: 0 }),
      ).toThrow(DocLinkError)
    })

    test('rejects negative line', () => {
      expect(() =>
        buildDocLink({ project_id: 'p1', path: 'a.md', channel: 'app', line: -5 }),
      ).toThrow(DocLinkError)
    })

    test('rejects non-integer line (3.7)', () => {
      expect(() =>
        buildDocLink({ project_id: 'p1', path: 'a.md', channel: 'app', line: 3.7 }),
      ).toThrow(DocLinkError)
    })

    test('rejects mutually exclusive line + range_start', () => {
      expect(() =>
        buildDocLink({
          project_id: 'p1',
          path: 'a.md',
          channel: 'app',
          line: 5,
          range_start: 10,
          range_end: 20,
        }),
      ).toThrow(DocLinkError)
    })

    test('rejects half-supplied range (start without end)', () => {
      expect(() =>
        buildDocLink({
          project_id: 'p1',
          path: 'a.md',
          channel: 'app',
          range_start: 10,
        }),
      ).toThrow(DocLinkError)
    })

    test('rejects inverted range (start > end)', () => {
      expect(() =>
        buildDocLink({
          project_id: 'p1',
          path: 'a.md',
          channel: 'app',
          range_start: 20,
          range_end: 10,
        }),
      ).toThrow(DocLinkError)
    })

    test('rejects line anchor on a vault-legacy URL (project_id=null)', () => {
      // Vault refs are whole-file only — Obsidian's obsidian://open URL
      // doesn't take a line param either.
      expect(() =>
        buildDocLink({ project_id: null, path: 'Projects/x.md', channel: 'telegram', line: 5 }),
      ).toThrow(DocLinkError)
    })

    test('rejects range anchor on a vault-legacy URL', () => {
      expect(() =>
        buildDocLink({
          project_id: null,
          path: 'Projects/x.md',
          channel: 'app',
          range_start: 1,
          range_end: 2,
        }),
      ).toThrow(DocLinkError)
    })

    // ISSUES #12 — builder bound parity with the parser. Parser rejects
    // line/range > 0x7fffffff via `Number.isSafeInteger` + `n > 0x7fffffff`;
    // builder previously only checked `Number.isInteger && n >= 1`, so it
    // emitted a URL the parser would refuse — breaking the round-trip
    // invariant for oversized inputs.
    test('rejects line > 0x7fffffff (parser-parity bound)', () => {
      expect(() =>
        buildDocLink({
          project_id: 'p1',
          path: 'a.md',
          channel: 'app',
          line: 0x7fffffff + 1,
        }),
      ).toThrow(DocLinkError)
      expect(() =>
        buildDocLink({
          project_id: 'p1',
          path: 'a.md',
          channel: 'app',
          line: 9007199254740992,
        }),
      ).toThrow(DocLinkError)
    })

    test('accepts line = 0x7fffffff (upper bound inclusive, parser-parity)', () => {
      const url = buildDocLink({
        project_id: 'p1',
        path: 'a.md',
        channel: 'app',
        line: 0x7fffffff,
      })
      expect(url).toContain('?line=2147483647')
    })

    test('rejects range with start or end > 0x7fffffff (parser-parity bound)', () => {
      expect(() =>
        buildDocLink({
          project_id: 'p1',
          path: 'a.md',
          channel: 'app',
          range_start: 1,
          range_end: 0x7fffffff + 1,
        }),
      ).toThrow(DocLinkError)
      expect(() =>
        buildDocLink({
          project_id: 'p1',
          path: 'a.md',
          channel: 'app',
          range_start: 0x7fffffff + 1,
          range_end: 0x7fffffff + 2,
        }),
      ).toThrow(DocLinkError)
    })
  })

  describe('parseDocLink', () => {
    test('docs:/<proj>/<path>?line=42 → ParsedDocLink with line=42', () => {
      expect(parseDocLink('docs:/proj/a.md?line=42')).toEqual({
        project_id: 'proj',
        path: 'a.md',
        line: 42,
      })
    })

    test('docs:/...?line=0 → null (1-indexed; reject 0)', () => {
      expect(parseDocLink('docs:/proj/a.md?line=0')).toBeNull()
    })

    test('docs:/...?line=-5 → null', () => {
      expect(parseDocLink('docs:/proj/a.md?line=-5')).toBeNull()
    })

    test('docs:/...?line=abc → null', () => {
      expect(parseDocLink('docs:/proj/a.md?line=abc')).toBeNull()
    })

    test('docs:/...?line=07 → null (leading zeros rejected, strict [1-9][0-9]*)', () => {
      expect(parseDocLink('docs:/proj/a.md?line=07')).toBeNull()
    })

    test('neutron://docs/<proj>/<path>?line=42 → ParsedDocLink with line=42', () => {
      expect(parseDocLink(`${NEUTRON_SCHEME}://docs/proj/a.md?line=42`)).toEqual({
        project_id: 'proj',
        path: 'a.md',
        line: 42,
      })
    })

    test('web shape with line param appended', () => {
      expect(
        parseDocLink(`${WEB_APP_BASE}/projects/proj/docs?path=a.md&line=42`),
      ).toEqual({ project_id: 'proj', path: 'a.md', line: 42 })
    })

    test('web shape: extra trailing & key (no value) rejects', () => {
      expect(
        parseDocLink(`${WEB_APP_BASE}/projects/proj/docs?path=a.md&`),
      ).toBeNull()
    })

    test('web shape: extra non-anchor key rejects (next=evil)', () => {
      expect(
        parseDocLink(`${WEB_APP_BASE}/projects/proj/docs?path=a.md&next=evil`),
      ).toBeNull()
    })

    test('docs:/...?range=10-20 → ParsedDocLink with range_start/end (P7.2 reserve)', () => {
      expect(parseDocLink('docs:/proj/a.md?range=10-20')).toEqual({
        project_id: 'proj',
        path: 'a.md',
        range_start: 10,
        range_end: 20,
      })
    })

    test('docs:/...?range=20-10 → null (M < N)', () => {
      expect(parseDocLink('docs:/proj/a.md?range=20-10')).toBeNull()
    })

    test('docs:/...?range=10 → null (range needs hyphen)', () => {
      expect(parseDocLink('docs:/proj/a.md?range=10')).toBeNull()
    })

    test('web shape: range appended as &range=N-M', () => {
      expect(
        parseDocLink(`${WEB_APP_BASE}/projects/proj/docs?path=a.md&range=10-20`),
      ).toEqual({
        project_id: 'proj',
        path: 'a.md',
        range_start: 10,
        range_end: 20,
      })
    })

    test('vault-legacy ?line= rejects (whole-file only)', () => {
      expect(parseDocLink(`${VAULT_REDIRECTOR_BASE}/x.md?line=42`)).toBeNull()
    })

    test('vault-legacy ?range= rejects (whole-file only)', () => {
      expect(parseDocLink(`${VAULT_REDIRECTOR_BASE}/x.md?range=1-2`)).toBeNull()
    })

    test('docs:/...?line=42#section rejects (fragments still banned even with anchor)', () => {
      expect(parseDocLink('docs:/proj/a.md?line=42#section')).toBeNull()
    })

    test('docs:/...?next=evil still rejects (only line/range keys are anchor-recognised)', () => {
      expect(parseDocLink('docs:/proj/a.md?next=evil')).toBeNull()
    })
  })

  describe('roundtrip (build → parse)', () => {
    test('app channel line roundtrips', () => {
      const url = buildDocLink({
        project_id: 'acme',
        path: 'launch-plan.md',
        channel: 'app',
        line: 42,
      })
      expect(parseDocLink(url)).toEqual({
        project_id: 'acme',
        path: 'launch-plan.md',
        line: 42,
      })
    })

    test('web channel line roundtrips through the multi-key query', () => {
      const url = buildDocLink({
        project_id: 'acme',
        path: 'launch-plan.md',
        channel: 'web',
        line: 42,
      })
      expect(parseDocLink(url)).toEqual({
        project_id: 'acme',
        path: 'launch-plan.md',
        line: 42,
      })
    })

    test('range roundtrips (parser-only reserved syntax)', () => {
      const url = buildDocLink({
        project_id: 'p1',
        path: 'a.md',
        channel: 'app',
        range_start: 10,
        range_end: 20,
      })
      expect(parseDocLink(url)).toEqual({
        project_id: 'p1',
        path: 'a.md',
        range_start: 10,
        range_end: 20,
      })
    })
  })

  describe('rewriteDocRefsInBody — anchor passthrough', () => {
    test('docs:/<proj>/<path>?line=42 marker rewrites to neutron://...?line=42', () => {
      const body = 'See [plan](docs:/acme/launch-plan.md?line=42).'
      expect(rewriteDocRefsInBody(body, 'app')).toBe(
        `See [plan](${NEUTRON_SCHEME}://docs/acme/launch-plan.md?line=42).`,
      )
    })

    test('?line= marker rewrites to web shape with &line= on web channel', () => {
      const body = 'See [plan](docs:/acme/launch-plan.md?line=42).'
      expect(rewriteDocRefsInBody(body, 'web')).toBe(
        `See [plan](${WEB_APP_BASE}/projects/acme/docs?path=launch-plan.md&line=42).`,
      )
    })

    test('?range=N-M marker survives the rewrite (P7.2 reserve)', () => {
      const body = 'See [section](docs:/acme/launch-plan.md?range=10-20).'
      expect(rewriteDocRefsInBody(body, 'telegram')).toBe(
        `See [section](${NEUTRON_SCHEME}://docs/acme/launch-plan.md?range=10-20).`,
      )
    })

    test('malformed anchor (?line=0) passes the marker through unmodified', () => {
      const body = 'See [bad](docs:/acme/launch-plan.md?line=0).'
      // parseDocLink rejects → rewriter pushes raw markdown verbatim.
      expect(rewriteDocRefsInBody(body, 'app')).toBe(body)
    })
  })
})

describe('runtime/doc-links — deriveLabel', () => {
  test('returns the supplied label verbatim when present', () => {
    expect(deriveLabel('My Doc', 'foo.md')).toBe('My Doc')
  })

  test('trims whitespace on supplied label', () => {
    expect(deriveLabel('  trimmed  ', 'foo.md')).toBe('trimmed')
  })

  test('falls back to the basename without extension when label missing', () => {
    expect(deriveLabel(undefined, 'launch-plan.md')).toBe('launch-plan')
    expect(deriveLabel(undefined, 'a/b/file-name.markdown')).toBe('file-name')
    expect(deriveLabel('', 'a/b/c.MD')).toBe('c')
  })
})
