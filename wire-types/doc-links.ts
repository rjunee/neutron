/**
 * @neutronai/wire-types — doc-link build/parse helper (L6).
 *
 * The canonical `docs:/<project_id>/<path>` marker ⇄ channel-URL algorithm,
 * extracted verbatim from `runtime/doc-links.ts` into this node-free bottom
 * band. Before L6 it was a BYTE-TWIN duplicated in `app/lib/doc-links.ts`
 * (deleted in L6) so the Expo bundle could avoid `@neutronai/runtime`'s
 * transitive node-only deps. Now there is ONE source: `runtime/doc-links.ts`
 * is a thin re-export shim, and the Expo app + telegram + gateway all call
 * into this module.
 *
 * ── The ONE asymmetric mapping preserved explicitly: the web-app base env ──
 * The 'web' channel base was the ONLY difference between the two old twins:
 * the runtime read `NEUTRON_WEB_APP_BASE`, the Expo mirror read
 * `EXPO_PUBLIC_NEUTRON_WEB_APP_BASE` (only `EXPO_PUBLIC_`-prefixed vars are
 * inlined into the Expo bundle at build time). {@link webAppBase} resolves
 * BOTH — `NEUTRON_WEB_APP_BASE` (server) first, else the `EXPO_PUBLIC_` form
 * (client) — so the single shared algorithm honours whichever the running
 * surface provides. Every other line is identical between the old twins.
 *
 * The module is pure. It has no I/O, no React, no Telegram client, no fetch —
 * `process.env` reads are globals, not a `node:*` import, so this stays a
 * node-free contract-band leaf.
 *
 * The canonical doc-link scheme used in agent output is
 *
 *     [Label](docs:/<project_id>/<path>)
 *
 * and the helper converts that internal marker into channel-appropriate URLs
 * at render time:
 *
 *   channel = 'app'      → neutron://docs/<project_id>/<encoded path>
 *   channel = 'web'      → <WEB_APP_BASE>/projects/<project_id>/docs?path=<encoded path>
 *   channel = 'telegram' → neutron://docs/<project_id>/<encoded path>
 *
 * Backward compat for legacy (non-project-scoped) vault references — when the
 * marker is `docs:/<path>` (no `<project_id>`), the link resolves to
 * `<VAULT_REDIRECTOR_BASE>/<path>`.
 */

/**
 * Render targets for a doc-link. `app` = the Expo client (custom-scheme deep
 * link), `web` = the React Native Web build (https URL at the configured
 * web-app host), `telegram` = the bot message body.
 */
export type DocLinkChannel = 'app' | 'web' | 'telegram'

/**
 * Read ONE env var as a DIRECT `process.env.<NAME>` member expression wrapped
 * in try/catch. Two hard constraints force this exact shape (Codex L6 review,
 * rounds 1+2):
 *
 *   1. The read MUST be a literal `process.env.EXPO_PUBLIC_*` member expression
 *      so `babel-preset-expo` can STATICALLY INLINE it into the Expo bundle at
 *      build time (it inlines literal member accesses, NOT computed
 *      `process.env[name]`). So each var is read at its own call site below,
 *      never through a generic `readEnv(name)` helper.
 *   2. Browser-safety is done with try/catch, NOT a runtime `typeof process`
 *      gate. A gate like `hasProcess ? process.env.EXPO_PUBLIC_… : undefined`
 *      becomes `hasProcess ? "<inlined literal>" : undefined` after babel — so
 *      in ANY bundle without a runtime `process` the inlined value is gated
 *      OFF and the surface silently loses its configured web base. try/catch
 *      instead USES the inlined literal directly (no runtime `process`
 *      dependency) and only swallows the `ReferenceError` a processless
 *      browser throws on the member read.
 *
 * All reads are LAZY (per call) and NOTHING is read at module top-level, so
 * importing this module / the leaf barrel never throws in a browser bundle.
 */

/**
 * Web base for the app surface (doc-link 'web' channel). Env-configured with
 * NO hosted default. Resolves `NEUTRON_WEB_APP_BASE` (Node/server) first, then
 * `EXPO_PUBLIC_NEUTRON_WEB_APP_BASE` (Expo bundle) — the ONE asymmetric
 * mapping the L6 unification preserves (see the module header). When neither
 * is set (including the processless browser) it is the empty string, which
 * makes the web doc-link a RELATIVE `/projects/<id>/docs?path=…` URL.
 *
 * Resolved LAZILY on every call. `buildDocLink` (web channel) + `parseDocLink`
 * (its `webPrefix` matcher) both call this, so build↔parse round-trips stay
 * consistent. Trailing slashes are stripped so `webAppBase() + '/projects/'`
 * never produces a double slash.
 */
export function webAppBase(): string {
  // Server takes precedence over the Expo-inlined value (original `??` order).
  let server: string | undefined
  try {
    server = process.env.NEUTRON_WEB_APP_BASE
  } catch {
    /* processless browser bundle — no NEUTRON_WEB_APP_BASE */
  }
  let expo: string | undefined
  try {
    expo = process.env.EXPO_PUBLIC_NEUTRON_WEB_APP_BASE
  } catch {
    /* processless browser bundle — no EXPO_PUBLIC_NEUTRON_WEB_APP_BASE */
  }
  return (server ?? expo ?? '').replace(/\/+$/, '')
}

/**
 * Vault read-redirector base for legacy (non-project-scoped) doc references.
 * Configurable via the `VAULT_REDIRECTOR_BASE` env var; the default is a
 * placeholder that self-hosted installs override. Resolved LAZILY (try/catch
 * around the direct member read) so it's browser-safe and no `process` read
 * happens at module init.
 */
export function vaultRedirectorBase(): string {
  let base: string | undefined
  try {
    base = process.env.VAULT_REDIRECTOR_BASE
  } catch {
    /* processless browser bundle */
  }
  return base ?? 'https://vault.example.test'
}

/**
 * Back-compat SNAPSHOT consts. `WEB_APP_BASE` + `VAULT_REDIRECTOR_BASE` are
 * consumed as STRING VALUES across the codebase — `@neutronai/runtime`
 * re-exports both, `contracts/handoff-config.ts` derives `MOBILE_APP_URL` from
 * `WEB_APP_BASE`, and the doc-link test suites interpolate them into expected
 * URLs — so they cannot become functions without a repo-wide churn. They are
 * initialised via the try/catch-guarded resolvers above, so this module-init
 * read is BROWSER-SAFE: importing the module / the leaf barrel NEVER throws
 * even in a processless bundle (it snapshots to '' / the placeholder there).
 * `buildDocLink`/`parseDocLink` recompute `webAppBase()` per call regardless,
 * so the live web base is honored even if set after import.
 */
export const WEB_APP_BASE = webAppBase()
export const VAULT_REDIRECTOR_BASE = vaultRedirectorBase()

/** Expo deep-link scheme registered in `app/app.json`. */
export const NEUTRON_SCHEME = 'neutron'

/** Conservative cap; aligns with `gateway/http/app-docs-surface.ts`. */
export const MAX_DOC_PATH_LEN = 1024

/** Mirrors `channels/adapters/app-ws/envelope.ts:MAX_PROJECT_ID_LEN`. */
export const MAX_PROJECT_ID_LEN = 128

/**
 * The same character class used by the gateway's project_id sanitiser
 * (`channels/adapters/app-ws/envelope.ts:sanitizeProjectId`). Kept in
 * lock-step so a project_id that round-trips through the WS surface also
 * round-trips through `buildDocLink` / `parseDocLink`.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Parsed marker — emitted by `parseDocLink` and consumed by `buildDocLink`.
 * `project_id === null` means "vault legacy" (no project scope).
 *
 * P7.3 line anchors:
 *   - `line` is the 1-indexed line number from `?line=N`.
 *   - `range_start` / `range_end` are the 1-indexed inclusive bounds from an
 *     optional `?range=N-M` query (RESERVED for P7.2's inline-comment
 *     side-pane; the parser only guarantees `M >= N`).
 *   - `?line=` and `?range=` are mutually exclusive.
 */
export interface ParsedDocLink {
  project_id: string | null
  path: string
  /** 1-indexed line anchor from `?line=N`. Undefined when absent. */
  line?: number
  /** 1-indexed inclusive range start from `?range=N-M`. Undefined when absent. */
  range_start?: number
  /** 1-indexed inclusive range end from `?range=N-M`. Undefined when absent. */
  range_end?: number
}

export interface BuildDocLinkInput {
  /**
   * Project-scoped identifier. `null` or `undefined` triggers the vault-legacy
   * fallback.
   */
  project_id?: string | null
  /** Path relative to the project's `docs/` root (or the vault root). */
  path: string
  channel: DocLinkChannel
  /**
   * P7.3 — optional 1-indexed line anchor. Appended as `?line=<n>` on
   * project-scoped shapes. Ignored for vault-legacy URLs. Must be a finite
   * integer ≥ 1; non-integer / ≤ 0 throws. Mutually exclusive with `range_*`.
   */
  line?: number
  /**
   * P7.3 — optional 1-indexed range. Both must be finite integers with
   * `1 ≤ start ≤ end`. Mutually exclusive with `line`.
   */
  range_start?: number
  range_end?: number
}

/**
 * Build the channel-appropriate URL for a doc reference.
 *
 * Throws `DocLinkError` when the path is empty/too long, the project_id is
 * malformed, or an anchor is invalid.
 */
export function buildDocLink(input: BuildDocLinkInput): string {
  const { channel } = input
  const path = input.path
  if (typeof path !== 'string' || path.length === 0) {
    throw new DocLinkError('empty_path', 'doc-link path must be a non-empty string')
  }
  if (path.length > MAX_DOC_PATH_LEN) {
    throw new DocLinkError(
      'path_too_long',
      `doc-link path must be ≤ ${MAX_DOC_PATH_LEN} chars (got ${path.length})`,
    )
  }
  const project_id = input.project_id ?? null
  if (project_id !== null) {
    if (typeof project_id !== 'string' || project_id.length === 0) {
      throw new DocLinkError('invalid_project_id', 'project_id must be a non-empty string')
    }
    if (project_id.length > MAX_PROJECT_ID_LEN) {
      throw new DocLinkError(
        'invalid_project_id',
        `project_id must be ≤ ${MAX_PROJECT_ID_LEN} chars`,
      )
    }
    if (!PROJECT_ID_RE.test(project_id)) {
      throw new DocLinkError(
        'invalid_project_id',
        `project_id must match ${PROJECT_ID_RE.source}`,
      )
    }
  }

  // P7.3 — validate the optional line / range anchors AND assert mutual
  // exclusion BEFORE the channel switch so a bad anchor produces a consistent
  // `invalid_anchor` error across every channel branch.
  const anchor = validateAnchor(input)

  const normalised = normalisePath(path)
  // Re-validate AFTER normalisation: `/`, `./plan.md`, `a/../b.md` pass the
  // pre-normalise length check but produce URLs `parseDocLink` then rejects.
  if (normalised.length === 0) {
    throw new DocLinkError(
      'empty_path',
      `path '${path}' normalises to an empty string`,
    )
  }
  if (!isSafeDecodedPath(normalised)) {
    throw new DocLinkError(
      'invalid_path',
      `path '${path}' contains a traversal segment ('.' / '..') or absolute prefix`,
    )
  }
  const encoded = encodeDocPath(normalised)

  if (project_id === null) {
    // Vault legacy — all three channels resolve via the redirector. Vault refs
    // DO NOT accept line/range anchors.
    if (anchor !== '') {
      throw new DocLinkError(
        'invalid_anchor',
        'vault-legacy URLs do not accept line / range anchors',
      )
    }
    return `${VAULT_REDIRECTOR_BASE}/${encoded}`
  }

  switch (channel) {
    case 'app':
      return `${NEUTRON_SCHEME}://docs/${project_id}/${encoded}${anchor}`
    case 'web':
      // The web shape already carries `?path=` so the anchor appends as
      // `&line=<n>` (or `&range=<n>-<m>`); `appendToWebQuery` rewrites the
      // leading `?` of the anchor string accordingly.
      return `${webAppBase()}/projects/${project_id}/docs?path=${encodeURIComponent(normalised)}${appendToWebQuery(anchor)}`
    case 'telegram':
      return `${NEUTRON_SCHEME}://docs/${project_id}/${encoded}${anchor}`
    default: {
      const exhaustive: never = channel
      throw new DocLinkError('invalid_channel', `unknown channel '${exhaustive as string}'`)
    }
  }
}

/**
 * Build the trailing anchor query (incl. leading `?`) from the optional
 * `line` / `range_start` / `range_end` fields. Returns `''` when no anchor is
 * requested. Throws `DocLinkError('invalid_anchor')` on malformed inputs.
 */
function validateAnchor(input: BuildDocLinkInput): string {
  const hasLine = input.line !== undefined && input.line !== null
  const hasRangeStart = input.range_start !== undefined && input.range_start !== null
  const hasRangeEnd = input.range_end !== undefined && input.range_end !== null
  if (hasLine && (hasRangeStart || hasRangeEnd)) {
    throw new DocLinkError(
      'invalid_anchor',
      '`line` and `range_*` are mutually exclusive on a single doc-link',
    )
  }
  if (hasLine) {
    const n = input.line!
    if (!Number.isInteger(n) || n < 1 || n > 0x7fffffff) {
      throw new DocLinkError(
        'invalid_anchor',
        `line must be a positive integer ≤ ${0x7fffffff} (got ${String(n)})`,
      )
    }
    return `?line=${n}`
  }
  if (hasRangeStart !== hasRangeEnd) {
    throw new DocLinkError(
      'invalid_anchor',
      'range_start + range_end must be supplied together',
    )
  }
  if (hasRangeStart && hasRangeEnd) {
    const s = input.range_start!
    const e = input.range_end!
    if (
      !Number.isInteger(s) || s < 1 || s > 0x7fffffff ||
      !Number.isInteger(e) || e < 1 || e > 0x7fffffff
    ) {
      throw new DocLinkError(
        'invalid_anchor',
        `range_start/range_end must be positive integers ≤ ${0x7fffffff} (got ${String(s)}-${String(e)})`,
      )
    }
    if (s > e) {
      throw new DocLinkError(
        'invalid_anchor',
        `range_start (${s}) must be ≤ range_end (${e})`,
      )
    }
    return `?range=${s}-${e}`
  }
  return ''
}

/**
 * The web shape already opens its query with `?path=<…>`. An anchor produced
 * by `validateAnchor` begins with `?`; this helper rewrites that leading `?`
 * to `&` so the web shape's multi-key query stays well formed.
 */
function appendToWebQuery(anchor: string): string {
  if (anchor.length === 0) return ''
  return `&${anchor.slice(1)}`
}

/**
 * Reverse of `buildDocLink`. Accepts any canonical URL shape the helper emits
 * AND the internal `docs:/<project_id>/<path>` marker the agent writes in
 * markdown. Returns `null` if the URL doesn't match a known shape.
 */
export function parseDocLink(url: string): ParsedDocLink | null {
  if (typeof url !== 'string' || url.length === 0) return null

  // Web shape is the ONLY canonical shape that legitimately carries a query
  // string (`?path=<encoded>`). Match it before the global `?`/`#` rejection.
  const webPrefix = `${webAppBase()}/projects/`
  if (url.startsWith(webPrefix)) {
    return parseWebShape(url.slice(webPrefix.length))
  }

  // Strip an optional `?line=N` / `?range=N-M` anchor BEFORE the global
  // `?`/`#` rejection so the project-scoped shapes can carry it.
  const anchored = splitAnchor(url)
  if (anchored === null) return null

  // Defense-in-depth: reject any REMAINING query-string / fragment additions.
  if (anchored.url.includes('?') || anchored.url.includes('#')) return null

  // neutron://docs/<project_id>/<path>
  const neutronPrefix = `${NEUTRON_SCHEME}://docs/`
  if (anchored.url.startsWith(neutronPrefix)) {
    const rest = anchored.url.slice(neutronPrefix.length)
    const base = parseProjectAndPath(rest)
    if (base === null) return null
    return applyAnchor(base, anchored.anchor)
  }

  // https://vault.example.test/<path>  (vault legacy; no project_id). Vault
  // URLs MUST NOT carry an anchor.
  const vaultPrefix = `${VAULT_REDIRECTOR_BASE}/`
  if (anchored.url.startsWith(vaultPrefix)) {
    if (anchored.anchor !== null) return null
    const encoded = anchored.url.slice(vaultPrefix.length)
    const path = decodeDocPath(encoded)
    if (path === null) return null
    return { project_id: null, path }
  }

  // docs:/<project_id>/<path>  (marker, ALWAYS project-scoped)
  if (anchored.url.startsWith('docs:/')) {
    const rest = anchored.url.slice('docs:/'.length)
    if (rest.length === 0) return null
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    const head = rest.slice(0, slash)
    const rawTail = rest.slice(slash + 1)
    if (!PROJECT_ID_RE.test(head)) return null
    if (head.length > MAX_PROJECT_ID_LEN) return null
    if (rawTail.length === 0 || rawTail.length > MAX_DOC_PATH_LEN) return null
    // Route the marker tail through `decodeDocPath` like the other URL
    // branches so a pre-encoded marker round-trips without double-encoding.
    const path = decodeDocPath(rawTail)
    if (path === null) return null
    return applyAnchor({ project_id: head, path }, anchored.anchor)
  }

  return null
}

/**
 * Parsed anchor payload from a `?line=N` or `?range=N-M` query. `null` =
 * absent.
 */
type ParsedAnchor =
  | { kind: 'line'; line: number }
  | { kind: 'range'; range_start: number; range_end: number }

interface AnchoredUrl {
  /** URL with the recognised anchor query stripped off. */
  url: string
  /** Parsed anchor payload, or `null` when no anchor was present. */
  anchor: ParsedAnchor | null
}

/**
 * Strip a trailing `?line=<N>` or `?range=<N>-<M>` anchor from `url`,
 * returning the base URL + the parsed anchor payload. Malformed anchors → `null`.
 */
function splitAnchor(url: string): AnchoredUrl | null {
  const q = url.indexOf('?')
  if (q < 0) return { url, anchor: null }
  const base = url.slice(0, q)
  const query = url.slice(q + 1)
  if (query.includes('#') || base.includes('#')) return null
  const anchor = parseAnchorQuery(query)
  if (anchor === null) return null
  return { url: base, anchor }
}

/**
 * Parse a query payload (no leading `?`). Recognises a SINGLE `line=<N>` or
 * `range=<N>-<M>` key — extra keys, mixed shapes, or non-numeric values reject.
 */
function parseAnchorQuery(query: string): ParsedAnchor | null {
  if (query.length === 0) return null
  if (query.includes('&')) return null
  const eq = query.indexOf('=')
  if (eq <= 0) return null
  const key = query.slice(0, eq)
  const value = query.slice(eq + 1)
  if (key === 'line') {
    const n = parseAnchorInt(value)
    if (n === null) return null
    return { kind: 'line', line: n }
  }
  if (key === 'range') {
    const dash = value.indexOf('-')
    if (dash <= 0) return null
    const s = parseAnchorInt(value.slice(0, dash))
    const e = parseAnchorInt(value.slice(dash + 1))
    if (s === null || e === null) return null
    if (s > e) return null
    return { kind: 'range', range_start: s, range_end: e }
  }
  return null
}

function parseAnchorInt(raw: string): number | null {
  if (raw.length === 0) return null
  // Strictly `[1-9][0-9]*` — reject leading `+`/`-`, leading zeros, whitespace.
  if (!/^[1-9][0-9]*$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) return null
  if (n < 1 || n > 0x7fffffff) return null
  return n
}

function applyAnchor(base: ParsedDocLink, anchor: ParsedAnchor | null): ParsedDocLink {
  if (anchor === null) return base
  if (anchor.kind === 'line') return { ...base, line: anchor.line }
  return { ...base, range_start: anchor.range_start, range_end: anchor.range_end }
}

/**
 * Parse the web shape's URL tail (everything after `${WEB_APP_BASE}/projects/`).
 * Expected layout: `<project_id>/docs?path=<single-encodeURIComponent path>`.
 */
function parseWebShape(rest: string): ParsedDocLink | null {
  if (rest.length === 0) return null
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const project_id = rest.slice(0, slash)
  if (!PROJECT_ID_RE.test(project_id)) return null
  if (project_id.length > MAX_PROJECT_ID_LEN) return null
  const tail = rest.slice(slash + 1)
  const docsQueryPrefix = 'docs?path='
  if (!tail.startsWith(docsQueryPrefix)) return null
  const queryPayload = tail.slice(docsQueryPrefix.length)
  if (queryPayload.length === 0) return null
  if (queryPayload.includes('#')) return null

  // The path is the first query key. A second key MAY be `line=<N>` or
  // `range=<N>-<M>`; ANY OTHER second key rejects.
  let encodedPath: string
  let anchor: ParsedAnchor | null = null
  const amp = queryPayload.indexOf('&')
  if (amp < 0) {
    encodedPath = queryPayload
  } else {
    encodedPath = queryPayload.slice(0, amp)
    const trailing = queryPayload.slice(amp + 1)
    if (trailing.length === 0) return null
    anchor = parseAnchorQuery(trailing)
    if (anchor === null) return null
  }
  if (encodedPath.length === 0) return null
  if (encodedPath.includes('?') || encodedPath.includes('&') || encodedPath.includes('#')) {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(encodedPath)
  } catch {
    return null
  }
  if (decoded.length === 0 || decoded.length > MAX_DOC_PATH_LEN) return null
  if (!isSafeDecodedPath(decoded)) return null
  return applyAnchor({ project_id, path: decoded }, anchor)
}

function parseProjectAndPath(rest: string): ParsedDocLink | null {
  if (rest.length === 0) return null
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const project_id = rest.slice(0, slash)
  if (!PROJECT_ID_RE.test(project_id)) return null
  if (project_id.length > MAX_PROJECT_ID_LEN) return null
  const encoded = rest.slice(slash + 1)
  if (encoded.length === 0) return null
  const path = decodeDocPath(encoded)
  if (path === null) return null
  return { project_id, path }
}

/**
 * Single inline `[label](docs:/<path>)` match emitted by `findInlineDocLinks`.
 */
export interface InlineDocLinkMatch {
  /** UTF-16 index of the `[` opener in the source body. */
  index: number
  /** UTF-16 index one past the `)` closer. */
  end: number
  /** Label text (raw, between `[` and `]`). */
  label: string
  /** Full target inside the `(...)`, including the `docs:/` prefix. */
  target: string
}

/**
 * Walk a markdown body and return every `[label](docs:/<...>)` inline link
 * match. Whitespace-tolerant and paren-depth-aware so balanced-paren paths
 * (`docs:/proj/v(2).md`) round-trip.
 */
export function findInlineDocLinks(body: string): InlineDocLinkMatch[] {
  if (typeof body !== 'string' || body.length === 0) return []
  const out: InlineDocLinkMatch[] = []
  const len = body.length
  let i = 0
  while (i < len) {
    if (body.charCodeAt(i) !== 0x5b /* [ */) {
      i++
      continue
    }
    const open = i
    // Find unescaped `]` on the same line.
    let j = open + 1
    let closeBracket = -1
    while (j < len) {
      const c = body.charCodeAt(j)
      if (c === 0x0a /* \n */) break
      if (c === 0x5c /* \ */ && j + 1 < len) {
        j += 2
        continue
      }
      if (c === 0x5d /* ] */) {
        closeBracket = j
        break
      }
      j++
    }
    if (closeBracket < 0) {
      i = open + 1
      continue
    }
    // Expect `(docs:/` immediately after `]`.
    const parenStart = closeBracket + 1
    if (body.slice(parenStart, parenStart + 7) !== '(docs:/') {
      i = open + 1
      continue
    }
    // Walk URL with paren-depth so a balanced `(...)` inside the path doesn't
    // short-circuit at the inner `)`.
    let k = parenStart + 1 // index of 'd' in 'docs:/'
    let depth = 1
    let closeParen = -1
    while (k < len) {
      const c = body.charCodeAt(k)
      if (c === 0x0a /* \n */) break
      if (c === 0x28 /* ( */) depth++
      else if (c === 0x29 /* ) */) {
        depth--
        if (depth === 0) {
          closeParen = k
          break
        }
      }
      k++
    }
    if (closeParen < 0) {
      i = open + 1
      continue
    }
    out.push({
      index: open,
      end: closeParen + 1,
      label: body.slice(open + 1, closeBracket),
      target: body.slice(parenStart + 1, closeParen),
    })
    i = closeParen + 1
  }
  return out
}

/**
 * Rewrite every `[label](docs:/<project_id>/<path>)` reference in a markdown
 * body so the resolved URL targets the supplied channel. Non-doc-link markdown
 * passes through untouched; the function is idempotent on already-rewritten
 * bodies. Malformed markers pass through verbatim.
 */
export function rewriteDocRefsInBody(body: string, channel: DocLinkChannel): string {
  if (typeof body !== 'string' || body.length === 0) return body
  const matches = findInlineDocLinks(body)
  if (matches.length === 0) return body
  const out: string[] = []
  let cursor = 0
  for (const m of matches) {
    if (m.index > cursor) out.push(body.slice(cursor, m.index))
    const parsed = parseDocLink(m.target)
    if (parsed === null) {
      out.push(body.slice(m.index, m.end))
    } else {
      try {
        const buildInput: BuildDocLinkInput = {
          project_id: parsed.project_id,
          path: parsed.path,
          channel,
        }
        if (parsed.line !== undefined) buildInput.line = parsed.line
        if (parsed.range_start !== undefined) buildInput.range_start = parsed.range_start
        if (parsed.range_end !== undefined) buildInput.range_end = parsed.range_end
        const url = buildDocLink(buildInput)
        out.push(`[${m.label}](${url})`)
      } catch {
        out.push(body.slice(m.index, m.end))
      }
    }
    cursor = m.end
  }
  if (cursor < body.length) out.push(body.slice(cursor))
  return out.join('')
}

/**
 * Doc-ref descriptor that may be passed alongside an OutgoingMessage via
 * `adapter_options.doc_refs`. Each entry resolves to a single doc URL via
 * `buildDocLink`.
 */
export interface DocRef {
  /** Optional human-readable label; defaults to a derived basename. */
  label?: string
  /** `null` or `undefined` triggers the vault-legacy fallback. */
  project_id?: string | null
  /** Path relative to the project's `docs/` root (or vault root). */
  path: string
}

export interface ResolvedDocRef {
  label: string
  url: string
  project_id: string | null
  path: string
}

/**
 * Resolve a list of `DocRef` descriptors against a channel. Skips entries that
 * fail validation (so a bad ref doesn't taint the rest).
 */
export function resolveDocRefs(
  refs: ReadonlyArray<DocRef>,
  channel: DocLinkChannel,
): ResolvedDocRef[] {
  const out: ResolvedDocRef[] = []
  for (const r of refs) {
    if (r === null || typeof r !== 'object') continue
    if (typeof r.path !== 'string') continue
    try {
      const project_id = r.project_id ?? null
      const url = buildDocLink({ project_id, path: r.path, channel })
      const label = deriveLabel(r.label, r.path)
      out.push({ label, url, project_id, path: r.path })
    } catch {
      continue
    }
  }
  return out
}

/**
 * Derive a fallback label from the path's final segment when the caller didn't
 * supply one.
 */
export function deriveLabel(supplied: string | undefined, path: string): string {
  if (typeof supplied === 'string' && supplied.trim().length > 0) {
    return supplied.trim()
  }
  const normalised = normalisePath(path)
  const last = normalised.split('/').pop() ?? normalised
  return last.replace(/\.(md|markdown)$/i, '')
}

/**
 * Normalise a path: drop a leading slash, collapse runs of `/`. Does NOT do
 * containment / traversal checking — that's `gateway/http/doc-store.ts`'s job.
 */
function normalisePath(path: string): string {
  let p = path.trim()
  if (p.startsWith('/')) p = p.slice(1)
  p = p.replace(/\/{2,}/g, '/')
  return p
}

/**
 * Percent-encode each path segment via `encodeURIComponent`, then re-join with
 * `/`. Slashes stay literal so the tree shape survives.
 */
function encodeDocPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

function decodeDocPath(encoded: string): string | null {
  try {
    const decoded = encoded
      .split('/')
      .map((seg) => decodeURIComponent(seg))
      .join('/')
    if (decoded.length === 0 || decoded.length > MAX_DOC_PATH_LEN) return null
    if (!isSafeDecodedPath(decoded)) return null
    return decoded
  } catch {
    return null
  }
}

/**
 * Defense-in-depth path validator. Rejects absolute paths (leading `/`) and
 * any `..` / `.` traversal segments. Encoded forms are caught because callers
 * run this AFTER `decodeURIComponent`.
 */
function isSafeDecodedPath(decoded: string): boolean {
  if (decoded.startsWith('/')) return false
  const segments = decoded.split('/')
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return false
  }
  return true
}

/**
 * Discriminated error class so consumers can map failure codes to user-facing
 * messages without parsing `.message`.
 */
export class DocLinkError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'DocLinkError'
  }
}
