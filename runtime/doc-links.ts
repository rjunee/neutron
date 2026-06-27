/**
 * @neutronai/runtime — doc-link helper (P7.3).
 *
 * Per SPEC.md § Phases→Steps (P7.3 — "Doc links in
 * chat (Telegram + app) open the in-app editor at the correct location.
 * Replaces the vault.example.test redirect") and
 * docs/engineering-plan.md § B.P7 ("Read surface — linked from Telegram
 * + app chat").
 *
 * The canonical doc-link scheme used in agent output is
 *
 *     [Label](docs:/<project_id>/<path>)
 *
 * and the helper converts that internal marker into channel-appropriate
 * URLs at render time. The conversion table:
 *
 *   channel = 'app'      → neutron://docs/<project_id>/<encoded path>
 *   channel = 'web'      → <WEB_APP_BASE>/projects/<project_id>/docs?path=<encoded path>
 *                           (WEB_APP_BASE is env-configured; when unset the
 *                            shape is the relative `/projects/<id>/docs?path=…`)
 *   channel = 'telegram' → neutron://docs/<project_id>/<encoded path>
 *                           (project-scoped; brief literal — sprint roadmap § 5
 *                            architectural decision: "ADD `neutron://…` links for
 *                            project-scoped docs" on Telegram)
 *
 * Backward compat for legacy (non-project-scoped) vault references —
 * when the marker is `docs:/<path>` (no `<project_id>` segment), the link
 * resolves to `<VAULT_REDIRECTOR_BASE>/<path>` on Telegram and to the
 * same vault URL on web/app. That keeps existing whole-vault chat
 * references working through the cutover (per
 * `docs/plans/project-folder-convention.md` link-contract section). The
 * redirector base is configurable via the `VAULT_REDIRECTOR_BASE` env.
 *
 * The module is pure. It has no I/O, no React, no Telegram client, no
 * fetch. Both the Telegram adapter (channels/adapters/telegram/) and
 * the Expo WebSocket adapter (channels/adapters/app-ws/) call into it
 * at message-render time, and the Expo client mirrors the same helper
 * in `app/lib/doc-links.ts` for the inverse parse on inbound deep
 * links. Mirroring is intentional (the app workspace is dep-isolated
 * from `@neutronai/channels` and `@neutronai/runtime` per the existing
 * `app/lib/ws-envelope.ts` parity convention).
 */

/**
 * Render targets for a doc-link. The channel name reflects the
 * surface where the URL will be rendered — `app` for the Expo client
 * (custom-scheme deep link), `web` for the future React Native Web
 * build (https URL at the configured web-app host), `telegram` for the
 * bot message body.
 */
export type DocLinkChannel = 'app' | 'web' | 'telegram'

/**
 * Web base for the app surface (doc-link 'web' channel). P7.3 reserves
 * this. Env-configured via `NEUTRON_WEB_APP_BASE` with NO hosted
 * default — self-hosted operators set it to their own web-app host
 * (e.g. `https://app.example.test`). When unset it is the empty string,
 * which makes the web doc-link a RELATIVE `/projects/<id>/docs?path=…`
 * URL. `buildDocLink` (web channel) and `parseDocLink` (its
 * `webPrefix = WEB_APP_BASE + '/projects/'` matcher) both read this
 * constant, so the build↔parse round-trip stays consistent for
 * whatever value it resolves to (empty or set).
 *
 * Trailing slashes are stripped so `WEB_APP_BASE + '/projects/'` never
 * produces a double slash for an operator who sets the host with a
 * trailing `/`. Matches the normalization in
 * `onboarding/interview/final-handoff-config.ts`.
 */
export function webAppBase(): string {
  return (process.env.NEUTRON_WEB_APP_BASE ?? '').replace(/\/+$/, '')
}
// Back-compat const (boot-time snapshot). `buildDocLink`/`parseDocLink` read
// `webAppBase()` at CALL time so the env is honored if set after import and so
// tests are not order-fragile (the boot-frozen const silently ignored a later
// env set — the 2026-06-27 doc-links-parity cross-test-pollution incident).
export const WEB_APP_BASE = webAppBase()

/**
 * Vault read-redirector base for legacy (non-project-scoped) doc
 * references. Configurable via the `VAULT_REDIRECTOR_BASE` env var; the
 * default is a placeholder that self-hosted installs override.
 */
export const VAULT_REDIRECTOR_BASE =
  process.env.VAULT_REDIRECTOR_BASE ?? 'https://vault.example.test'

/** Expo deep-link scheme registered in `app/app.json` (P5.0). */
export const NEUTRON_SCHEME = 'neutron'

/** Conservative cap; aligns with `gateway/http/app-docs-surface.ts`. */
export const MAX_DOC_PATH_LEN = 1024

/** Mirrors `channels/adapters/app-ws/envelope.ts:MAX_PROJECT_ID_LEN`. */
export const MAX_PROJECT_ID_LEN = 128

/**
 * The same character class used by the gateway's project_id sanitiser
 * (`channels/adapters/app-ws/envelope.ts:sanitizeProjectId`). Kept in
 * lock-step so a project_id that round-trips through the WS surface
 * also round-trips through `buildDocLink` / `parseDocLink`.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Parsed marker — emitted by `parseDocLink` and consumed by `buildDocLink`.
 * `project_id === null` means "vault legacy" (no project scope; Sam's
 * pre-Neutron vault references; resolves via `vault.example.test`).
 *
 * P7.3 line anchors:
 *   - `line` is the 1-indexed line number from `?line=N` on the canonical
 *     project-scoped shapes (`neutron://docs/...`, the web shape
 *     `<WEB_APP_BASE>/projects/...`, and the marker form
 *     `docs:/<project_id>/<path>`). Vault-legacy URLs
 *     do NOT accept anchors — Obsidian's `obsidian://open` URL doesn't
 *     take a line param either, so vault refs stay whole-file.
 *   - `range_start` / `range_end` are the 1-indexed inclusive bounds from
 *     an optional `?range=N-M` query. The parser RESERVES this syntax for
 *     P7.2's inline-comment side-pane (which renders a transient highlight
 *     on landing); rendering is not wired in P7.3, so the only behaviour
 *     the parser guarantees this sprint is `M >= N` with both positive
 *     integers — anything else returns `null` (malformed marker).
 *   - When both `?line=` and `?range=` are present on the same URL, the
 *     parser rejects (`null`) — they're mutually exclusive shapes.
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
   * Project-scoped identifier. `null` or `undefined` triggers the
   * vault-legacy fallback (`vault.example.test` redirect).
   */
  project_id?: string | null
  /** Path relative to the project's `docs/` root (or the vault root). */
  path: string
  channel: DocLinkChannel
  /**
   * P7.3 — optional 1-indexed line anchor. Appended to the URL as
   * `?line=<n>` on project-scoped shapes (`neutron://...` and the web
   * shape, where it merges as `&line=<n>` alongside the `?path=` key).
   * Ignored for vault-legacy URLs (vault refs stay whole-file).
   * Validation: must be a finite integer ≥ 1; non-integer / ≤ 0 throws.
   * Mutually exclusive with `range_start` + `range_end`.
   */
  line?: number
  /**
   * P7.3 — optional 1-indexed range. RESERVED for P7.2's inline-comment
   * side-pane consumer. The builder appends `?range=<start>-<end>` on
   * project-scoped shapes; rendering is unimplemented in P7.3. Validation:
   * both must be finite integers with `1 ≤ start ≤ end`. Mutually
   * exclusive with `line`.
   */
  range_start?: number
  range_end?: number
}

/**
 * Build the channel-appropriate URL for a doc reference.
 *
 * Throws `DocLinkError` when:
 *   - path is empty or longer than `MAX_DOC_PATH_LEN`
 *   - project_id is present but malformed (fails `PROJECT_ID_RE` or too long)
 *
 * Channel choice maps to:
 *   - 'app'      → neutron://docs/<project_id>/<encoded path>
 *   - 'web'      → <WEB_APP_BASE>/projects/<project_id>/docs?path=<encoded path>
 *   - 'telegram' → neutron://docs/<project_id>/<encoded path> (project)
 *                  https://vault.example.test/<path>       (no project_id)
 *
 * Argus r4 BLOCKING #1: the web URL targets the existing Expo route
 * `app/app/projects/[id]/docs.tsx`. The previous shape
 * `${WEB_APP_BASE}/docs/<project_id>/<path>` 404'd on the static web
 * export because no such route existed. The new shape mirrors
 * `docLinkToRouterPath` in `app/lib/doc-links.ts` so the static web
 * build resolves the link directly (no rewrites / SPA fallback
 * required).
 *
 * Vault-legacy fallback (`project_id === null | undefined`) ALWAYS resolves
 * to the `vault.example.test` redirector — the brief literally says
 * "keep `https://vault.example.test/<path>` for backward compat when
 * no project_id (Sam's vault legacy)" and Sam's pre-Neutron vault
 * lives at that hostname; Expo and Web users get the same URL.
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
  // exclusion BEFORE the channel switch so a bad anchor produces a
  // consistent `invalid_anchor` error across every channel branch.
  // `null`/`undefined` are absent; anything else must be a positive
  // integer (line) or a valid `[start, end]` pair (range).
  const anchor = validateAnchor(input)

  const normalised = normalisePath(path)
  // Argus MINOR #2: re-validate AFTER normalisation. The pre-normalise
  // length check accepts `/`, `./plan.md`, `a/../b.md` — all of which
  // produce URLs that `parseDocLink` then rejects (empty path,
  // `.`/`..` traversal segments, leading slash). Re-running the same
  // rejection rule here closes the gap so `buildDocLink` cannot emit
  // a URL that its own parser would later refuse.
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
    // Vault legacy — all three channels resolve via the redirector.
    // Vault refs DO NOT accept line/range anchors (Obsidian's
    // obsidian://open URL doesn't take a line param). A caller that
    // supplied one is treated as a malformed input, not silently dropped.
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
      // Argus r4 BLOCKING #1: target the existing Expo route at
      // `app/app/projects/[id]/docs.tsx`. The web build has no
      // `/docs/<id>/<path>` route (no SPA rewrite, no +not-found
      // fallback) so the old shape 404'd on a static export.
      //
      // P7.3 — the web shape already carries `?path=` so the anchor
      // appends as `&line=<n>` (or `&range=<n>-<m>`) instead of `?…`.
      // `appendToWebQuery` rewrites the leading `?` of the anchor
      // string accordingly so the multi-key URL is well-formed.
      return `${webAppBase()}/projects/${project_id}/docs?path=${encodeURIComponent(normalised)}${appendToWebQuery(anchor)}`
    case 'telegram':
      // Per sprint roadmap § 5 architectural decision: ADD `neutron://…`
      // links for project-scoped docs on Telegram.
      return `${NEUTRON_SCHEME}://docs/${project_id}/${encoded}${anchor}`
    default: {
      const exhaustive: never = channel
      throw new DocLinkError('invalid_channel', `unknown channel '${exhaustive as string}'`)
    }
  }
}

/**
 * Build the trailing anchor query (incl. leading `?`) from the optional
 * `line` / `range_start` / `range_end` fields on `BuildDocLinkInput`.
 * Returns `''` when no anchor is requested. Throws `DocLinkError` with
 * code `invalid_anchor` on malformed inputs (non-integer, ≤ 0, mixed
 * line+range, range with start > end).
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
    // ISSUES #12 — bound parity with the parser (`parseAnchorInt`,
    // line ~502: `n > 0x7fffffff` is rejected). Without this clamp the
    // builder happily emits a URL the parser refuses, breaking the
    // round-trip invariant for oversized integers (`9007199254740992`,
    // `1e100`, …).
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
    // ISSUES #12 — same parser-parity bound on range endpoints.
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
 * The web shape already opens its query string with `?path=<…>`. An
 * anchor produced by `validateAnchor` begins with `?` because it's
 * designed for the marker / neutron:// shapes; this helper rewrites the
 * leading `?` to `&` so the web shape's multi-key query stays well
 * formed.
 */
function appendToWebQuery(anchor: string): string {
  if (anchor.length === 0) return ''
  return `&${anchor.slice(1)}`
}

/**
 * Reverse of `buildDocLink`. Accepts any of the canonical URL shapes
 * the helper emits AND the internal `docs:/<project_id>/<path>` marker
 * the agent writes in markdown. Returns `null` if the URL doesn't
 * match a known shape.
 *
 * Recognised shapes:
 *   - neutron://docs/<project_id>/<encoded path>
 *   - <WEB_APP_BASE>/projects/<project_id>/docs?path=<encoded path>
 *   - https://vault.example.test/<encoded path>            (vault legacy)
 *   - docs:/<project_id>/<path>                               (marker, project)
 *
 * The internal marker form is ALWAYS project-scoped — the first segment
 * after `docs:/` is the `project_id`, the rest is the path. There is
 * deliberately NO vault-legacy variant of the marker (a `docs:/foo/bar`
 * shape can't unambiguously distinguish project_id="foo" / path="bar"
 * from a 2-segment vault path). Vault references in chat MUST use the
 * literal `https://vault.example.test/<path>` URL, which the parser
 * still recognises here.
 *
 * Path is decoded from URL-encoding for the URL shapes and returned
 * verbatim for the marker shape (no encoding in the marker).
 */
export function parseDocLink(url: string): ParsedDocLink | null {
  if (typeof url !== 'string' || url.length === 0) return null

  // Web shape is the ONLY canonical shape that legitimately carries a
  // query string (`?path=<encoded>`). Match it before the global
  // `?`/`#` rejection so the rejection can still guard the other
  // shapes against query-string smuggling.
  const webPrefix = `${webAppBase()}/projects/`
  if (url.startsWith(webPrefix)) {
    return parseWebShape(url.slice(webPrefix.length))
  }

  // P7.3 — strip an optional `?line=N` / `?range=N-M` anchor BEFORE the
  // global `?`/`#` rejection so the project-scoped shapes can carry it.
  // `splitAnchor` returns `{url: <without query>, anchor: <line|range
  // payload>}` for recognised anchors and `null` for malformed ones.
  // Vault-legacy URLs reject anchors entirely below (whole-file only).
  const anchored = splitAnchor(url)
  if (anchored === null) return null

  // Defense-in-depth: reject any REMAINING query-string / fragment
  // additions (after `splitAnchor` consumed a valid `?line=` / `?range=`)
  // so a malicious agent emit can't smuggle `?next=evil` past the parser.
  if (anchored.url.includes('?') || anchored.url.includes('#')) return null

  // neutron://docs/<project_id>/<path>
  const neutronPrefix = `${NEUTRON_SCHEME}://docs/`
  if (anchored.url.startsWith(neutronPrefix)) {
    const rest = anchored.url.slice(neutronPrefix.length)
    const base = parseProjectAndPath(rest)
    if (base === null) return null
    return applyAnchor(base, anchored.anchor)
  }

  // https://vault.example.test/<path>  (vault legacy; no project_id)
  // Vault-legacy URLs MUST NOT carry an anchor — Obsidian's
  // `obsidian://open` URL doesn't take a line param, so a vault URL
  // with `?line=…` is structurally malformed and rejected here. (The
  // same rejection is enforced builder-side in `validateAnchor`.)
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
    // Argus r4 IMPORTANT #1: route the marker tail through
    // `decodeDocPath` like the other URL branches so a pre-encoded
    // marker (`docs:/p/foo%28draft%29.md`) round-trips through
    // buildDocLink without double-encoding the `%` byte. Inline-link
    // helper contract: the agent may emit balanced parens literally OR
    // percent-encode them — both forms must yield the same parsed
    // path. Decoding here is the canonicalisation step.
    const path = decodeDocPath(rawTail)
    if (path === null) return null
    return applyAnchor({ project_id: head, path }, anchored.anchor)
  }

  return null
}

/**
 * Parsed anchor payload from a `?line=N` or `?range=N-M` query. `null`
 * = absent. The discriminant lets `applyAnchor` decide which
 * `ParsedDocLink` fields to populate.
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
 * returning the base URL + the parsed anchor payload.
 *
 *   - No query string at all → `{url, anchor: null}`.
 *   - Recognised anchor that parses cleanly → `{url: <stripped>, anchor: <parsed>}`.
 *   - Malformed anchor (`?line=abc`, `?range=20-10`, `?line=0`,
 *     `?line=42&extra=x`) → `null` so the caller rejects the URL.
 *
 * The web shape `<WEB_APP_BASE>/projects/<id>/docs?path=<…>`
 * carries its own primary query and is handled separately by
 * `parseWebShape`; this helper is only invoked for the other three
 * shapes.
 */
function splitAnchor(url: string): AnchoredUrl | null {
  const q = url.indexOf('?')
  if (q < 0) return { url, anchor: null }
  const base = url.slice(0, q)
  const query = url.slice(q + 1)
  // No fragments anywhere — we still reject `#` even when an anchor is
  // present so a malicious `?line=42#evil` doesn't slip past the
  // anchor-aware branch.
  if (query.includes('#') || base.includes('#')) return null
  const anchor = parseAnchorQuery(query)
  if (anchor === null) return null
  return { url: base, anchor }
}

/**
 * Parse a query payload (no leading `?`). Recognises a SINGLE `line=<N>`
 * or `range=<N>-<M>` key — extra keys, mixed shapes, or non-numeric
 * values reject. Mirrors the parser-side enforcement of the builder's
 * mutual-exclusion contract in `validateAnchor`.
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
  // Reject leading `+`/`-`, leading zeros (`07`), whitespace, anything
  // non-digit. Strictly `[1-9][0-9]*`.
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
 * Parse the web shape's URL tail (everything after
 * `${WEB_APP_BASE}/projects/`). Expected layout:
 *
 *     <project_id>/docs?path=<single-encodeURIComponent path>
 *
 * Slashes inside the path are `%2F` (single encodeURIComponent), so
 * the query payload is one opaque segment. Anything beyond a single
 * `path=…` value (extra query keys, fragments, missing literal `docs`
 * segment) is rejected so a malicious URL can't smuggle past the
 * parser. Mirrors the Expo client's `docLinkToRouterPath` shape.
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
  // No fragments at all — anchor-aware parsing still rejects `#`.
  if (queryPayload.includes('#')) return null

  // P7.3 — the path is the first query key. A second key MAY be
  // `line=<N>` or `range=<N>-<M>` (the anchor extension); ANY OTHER
  // second key rejects so a malicious `?path=…&next=evil` can't slip
  // through. Mirrors the marker / neutron:// branches' `splitAnchor`.
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
  // Path payload itself must be a single opaque value (no nested
  // `?`/`&`/`#`). The anchor-key split above already handled the
  // outer `&`, so this check guards against `path=a?b` smuggling.
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
 * Single inline `[label](docs:/<path>)` match emitted by
 * `findInlineDocLinks`. Used by `rewriteDocRefsInBody` here and by the
 * Telegram adapter (which needs to interleave MarkdownV2 escape spans
 * around each match).
 */
export interface InlineDocLinkMatch {
  /** UTF-16 index of the `[` opener in the source body. */
  index: number
  /** UTF-16 index one past the `)` closer (`body.slice(end-1, end) === ')'`). */
  end: number
  /** Label text (raw, between `[` and `]`). */
  label: string
  /** Full target inside the `(...)`, including the `docs:/` prefix. */
  target: string
}

/**
 * Walk a markdown body and return every `[label](docs:/<...>)` inline
 * link match. Argus MINOR #1: the previous regex `[^)\s]+` rejected
 * any path containing spaces (e.g. `docs:/proj/launch plan.md`) — a
 * shape buildDocLink handles fine via `encodeURIComponent`. The walker
 * here is whitespace-tolerant and counts paren depth inside the URL
 * payload so balanced-paren paths (`docs:/proj/v(2).md`) round-trip.
 *
 * Path conventions: paths with un-balanced parens, newlines, or `\]`
 * in the label are still rejected — the agent contract is "balance
 * parens OR pre-encode them as %28/%29". The doc-link helper round-
 * trips %-encoded paths transparently.
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
    // Walk URL with paren-depth so a balanced `(...)` inside the path
    // (e.g. `v(2).md`) doesn't short-circuit at the inner `)`. Newlines
    // terminate the search; depth must hit zero before EOL.
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
 * Rewrite every `[label](docs:/<project_id>/<path>)` reference in a
 * markdown body so the resolved URL targets the supplied channel.
 *
 * Non-doc-link markdown links pass through untouched, as does any
 * other markdown / plain text. The function is idempotent on a body
 * that has already been rewritten — `neutron://`, `https://app.…`,
 * and `https://obs.doe.…` link targets aren't `docs:/` markers and
 * therefore won't be touched on a second pass.
 *
 * Malformed markers (bad project_id, empty path) pass through verbatim
 * so we don't drop information silently — the user sees the raw text
 * and the writer (agent) can self-correct.
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
        // P7.3 — thread the optional `line` / `range_*` anchor fields
        // through buildDocLink so a `docs:/<proj>/<path>?line=42`
        // marker rewrites to `neutron://docs/<proj>/<path>?line=42`
        // (or `&line=42` on the web shape). Without this, the anchor
        // silently disappears at adapter-render time.
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
 * Doc-ref descriptor that may be passed alongside an OutgoingMessage
 * via `adapter_options.doc_refs`. Each entry resolves to a single
 * doc URL via `buildDocLink`. Used when the agent wants to surface a
 * "linked docs" affordance separately from the inline markdown body
 * (mirrors the existing `citations` slot but for in-project docs).
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
 * Resolve a list of `DocRef` descriptors against a channel. Skips
 * entries that fail validation (so a bad ref doesn't taint the rest).
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
      // Drop malformed entries; surface healthy ones.
      continue
    }
  }
  return out
}

/**
 * Derive a fallback label from the path's final segment when the
 * caller didn't supply one. Strips a leading dot or path components
 * and the `.md` / `.markdown` extension so the result is human-
 * readable.
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
 * Normalise a path:
 *   - drops a leading slash so the result is always relative,
 *   - collapses runs of `/`,
 *   - rejects nothing (callers may have already validated against
 *     `..` traversal and absolute paths via DocStore).
 *
 * The helper does NOT do containment / traversal checking — that's
 * `gateway/http/doc-store.ts`'s job. We only canonicalise the leading
 * slash so a marker like `docs:/myproj/foo` and `docs:/myproj//foo`
 * and `docs:/myproj/./foo` (after `./` removal) all produce a single
 * canonical URL shape.
 */
function normalisePath(path: string): string {
  let p = path.trim()
  if (p.startsWith('/')) p = p.slice(1)
  // Collapse runs of slashes.
  p = p.replace(/\/{2,}/g, '/')
  return p
}

/**
 * Percent-encode each path segment via `encodeURIComponent`, then
 * re-join with `/`. Slashes stay literal so the tree shape survives;
 * spaces, parens, hashes, query chars all get safely encoded.
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
 * Defense-in-depth path validator. Rejects absolute paths (leading `/`)
 * and any `..` / `.` traversal segments. Encoded forms (e.g. `%2e%2e`)
 * are caught because callers run this AFTER `decodeURIComponent`. The
 * gateway's `doc-store.ts` runs its own posix.normalize-based check
 * server-side; this layer rejects in the parser so a malformed URL
 * never produces a non-null `ParsedDocLink`.
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
 * Discriminated error class so consumers (adapters, gateway HTTP) can
 * map specific failure codes to user-facing messages without parsing
 * `.message`.
 */
export class DocLinkError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'DocLinkError'
  }
}
