/**
 * landing/chat-react — in-app DOC-LINK navigation parser (P-A).
 *
 * The live agent references a drafted doc with the canonical marker
 * `[friendly-name](docs:/<project_id>/<path>)`. The app-ws adapter rewrites
 * that marker, for a `platform=web` client, into the web doc-link URL
 * (`runtime/doc-links.ts:buildDocLink`, `web` channel):
 *
 *     <WEB_APP_BASE>/projects/<project_id>/docs?path=<encodeURIComponent path>
 *
 * `WEB_APP_BASE` (`NEUTRON_WEB_APP_BASE`) is empty on a default self-host, so
 * the href the chat markdown renders is the ROOT-RELATIVE
 * `/projects/<id>/docs?path=…`. This module recognises that href client-side so
 * a tap can switch to the Documents tab + open the doc IN-APP instead of
 * opening a dead new tab.
 *
 * Kept dependency-free (no import from `@neutronai/runtime`) so the browser
 * bundle stays free of a Node/`process.env` dependency — the same convention
 * `docs-client.ts` follows by mirroring gateway wire types rather than importing
 * across the workspace boundary. The parse is intentionally narrow: it matches
 * only the web doc-link shape, at the page origin (or root-relative), and
 * rejects anything else (external links, `neutron://` native links, traversal).
 */

export interface DocLinkTarget {
  projectId: string
  /** Path relative to the project's docs root (the DocumentsTab open path). */
  path: string
}

/** Same project_id character class the gateway + runtime doc-links enforce. */
const PROJECT_ID_RE = /^[A-Za-z0-9_.-]+$/

/**
 * A project_id is safe to interpolate into a `/projects/<id>/docs` URL iff it
 * matches the char class AND is not a path-traversal segment. The char class
 * ([A-Za-z0-9_.-]) also matches `.` and `..`, which would yield a traversing
 * `/projects/../docs` URL — reject those explicitly (the path segment gets the
 * same `.`/`..` guard below).
 */
function isSafeProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id) && id !== '.' && id !== '..'
}

/**
 * Parse a chat-message anchor href into a doc-link target, or `null` when it
 * isn't an in-app project doc link.
 *
 * Accepts:
 *   - root-relative `/projects/<id>/docs?path=<enc>[&line=…|&range=…]`
 *   - absolute SAME-ORIGIN `<origin>/projects/<id>/docs?path=<enc>…`
 *
 * Rejects a different origin, a custom scheme (`neutron://…` native links),
 * a missing/oversized/traversal path, or a malformed shape — the caller then
 * lets the browser handle the click normally.
 */
export function parseWebDocLinkHref(href: string, origin: string): DocLinkTarget | null {
  if (typeof href !== 'string' || href.length === 0) return null
  let rest = href
  // Protocol-relative URL (`//host/…`) → a DIFFERENT host; never same-app. Reject
  // up front so a lookalike like `//evil.example/projects/acme/docs?path=x.md`
  // isn't parsed as an in-app link (a legit doc link is single-slash rooted).
  if (rest.startsWith('//')) return null
  // Absolute URL (has a scheme) → keep only same-origin ones, stripped to a
  // root-relative path. A `neutron://…` native link or a foreign host fails
  // this and returns null (let the browser handle it).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rest)) {
    const o = origin.replace(/\/+$/, '')
    if (o.length === 0 || !rest.startsWith(`${o}/`)) return null
    rest = rest.slice(o.length)
  }
  // Match `…/projects/<id>/docs?<query>`. A leading path segment is tolerated so
  // a WEB_APP_BASE with a path prefix (`https://host/app/projects/…`) still
  // resolves after the origin strip (`/app/projects/…`). The `/projects/` must
  // be `/`-delimited, so `/xprojects/…` can't match.
  const m = rest.match(/\/projects\/([A-Za-z0-9_.-]+)\/docs\?(.*)$/)
  if (m === null) return null
  const projectId = m[1] as string
  if (!isSafeProjectId(projectId)) return null
  const query = m[2] as string
  // The path is the FIRST query key (`path=…`); an optional `&line=`/`&range=`
  // anchor may follow and is ignored (the viewer opens the whole doc).
  const amp = query.indexOf('&')
  const first = amp < 0 ? query : query.slice(0, amp)
  if (!first.startsWith('path=')) return null
  const enc = first.slice('path='.length)
  if (enc.length === 0) return null
  let path: string
  try {
    path = decodeURIComponent(enc)
  } catch {
    return null
  }
  if (path.length === 0 || path.startsWith('/')) return null
  for (const seg of path.split('/')) {
    if (seg === '.' || seg === '..') return null
  }
  return { projectId, path }
}

/**
 * Normalize a RAW agent doc-link href into the web root-relative doc-link URL
 * (`/projects/<id>/docs?path=<enc>`) the app can intercept — or `null` when the
 * href isn't a doc link (leave it untouched).
 *
 * WHY this exists: `rehype-sanitize` strips a `docs:`/`neutron:` scheme href
 * BEFORE any click handler can read it, so a chat bubble carrying either of the
 * two NON-web doc-link shapes renders as a DEAD link (`<a>` with no href) — a
 * click does nothing (issue #376). The `app-ws` adapter rewrites live web-client
 * pushes to the web shape, but the RESUME replay (`appChatRowToEnvelope`) emits
 * the persisted body verbatim, and that body is channel-baked at send time — so
 * a non-web-baked doc-link reaches the web client raw. This normalizer runs in a
 * rehype plugin BEFORE sanitize (see `Markdown.tsx`), converting the raw shape
 * to the same-origin web URL the existing tap-interception + SPA-boot handler
 * already open in the Documents tab.
 *
 * Recognizes the two project-doc shapes (`wire-types/doc-links.ts:buildDocLink`):
 *   - canonical agent marker  `docs:/<project_id>/<path>`
 *   - native deep-link scheme `neutron://docs/<project_id>/<encoded path>`
 * A web-shape href, a vault-legacy `http(s)` redirector URL, or any external URL
 * returns `null` (untouched — sanitize keeps those, and they open normally).
 *
 * KNOWN LIMITATION: the legacy NON-project-scoped marker form (`docs:/<path>`
 * with no `<project_id>` segment — `wire-types/doc-links.ts`) is intentionally
 * NOT webified: without a project id there is no `/projects/<id>/docs` URL to
 * build. In practice that form is baked to an absolute VAULT_REDIRECTOR `http(s)`
 * URL at send time (which passes through as an external link), so it does not
 * reach the client as a raw `docs:` scheme; it was not part of the #376 incident.
 */
export function webifyDocLinkHref(href: string): string | null {
  if (typeof href !== 'string' || href.length === 0) return null
  // `docs:/<project_id>/<path>` (canonical marker) or
  // `neutron://docs/<project_id>/<encoded path>` (native scheme).
  const m =
    href.match(/^docs:\/([A-Za-z0-9_.-]+)\/(.+)$/) ??
    href.match(/^neutron:\/\/docs\/([A-Za-z0-9_.-]+)\/(.+)$/)
  if (m === null) return null
  const projectId = m[1] as string
  if (!isSafeProjectId(projectId)) return null
  // Drop any `#fragment` / `?query` anchor tail — the viewer opens the whole doc
  // (parity with `parseWebDocLinkHref`, which ignores `&line=`/`&range=`).
  const raw = (m[2] as string).replace(/[?#].*$/, '')
  // The native shape percent-encodes each path SEGMENT (slashes stay literal);
  // the marker shape is raw. Decode to a plain path, then re-encode as one
  // `path=` value the web parser (`parseWebDocLinkHref`) decodes back.
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    path = raw
  }
  if (path.length === 0 || path.startsWith('/')) return null
  for (const seg of path.split('/')) {
    if (seg === '.' || seg === '..') return null
  }
  return `/projects/${projectId}/docs?path=${encodeURIComponent(path)}`
}

/**
 * Parse the current browser LOCATION (a hard-loaded / bookmarked / shared doc
 * deep-link URL) into a doc-link target, or `null` when the URL isn't a project
 * doc link. The SPA calls this ONCE on boot: when the gateway's SPA catch-all
 * served the shell for a `/projects/<id>/docs?path=…` URL, this recovers the
 * `{projectId, path}` so `ProjectShell` can switch to that project's Documents
 * tab and open the doc — the same effect a tap would have had, but for a real
 * navigable URL. Reuses {@link parseWebDocLinkHref} (same origin + traversal
 * guards); `origin` is the page origin so an absolute self-host URL still
 * resolves.
 */
export function initialDocLinkFromLocation(
  pathname: string,
  search: string,
  origin: string,
): DocLinkTarget | null {
  return parseWebDocLinkHref(`${pathname}${search}`, origin)
}
