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
  if (!PROJECT_ID_RE.test(projectId)) return null
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
