/**
 * @neutronai/app — Expo-side mirror of `runtime/doc-links.ts` (P7.3).
 *
 * The Expo workspace is dependency-isolated from `@neutronai/runtime`
 * (which imports node-only modules transitively). Duplicating the
 * doc-link helper here keeps the Expo bundle pure-JS while staying
 * source-of-truth aligned. ANY change here MUST mirror
 * `runtime/doc-links.ts` — there's a parity test in
 * `gateway/__tests__/doc-links-parity.test.ts` that asserts the two
 * implementations produce identical URLs for a canonical fixture set.
 *
 * Used by:
 *   - The deep-link handler in `app/_layout.tsx` that parses incoming
 *     `neutron://docs/<project_id>/<path>` URLs and routes them to
 *     `/projects/<project_id>/docs?path=<path>`.
 *   - (Future) Inline rendering of doc-ref pills in chat bubbles when
 *     `agent_message.doc_refs` is present — the chat surface taps
 *     into Linking.openURL(ref.url) to fire the same deep-link path.
 *
 * Argus r4 BLOCKING #1: the `web` channel emits
 * `<WEB_APP_BASE>/projects/<project_id>/docs?path=<encoded>`
 * because the static web export only defines `app/app/projects/[id]/
 * docs.tsx` — the old `/docs/<project_id>/<path>` shape 404'd. New
 * shape matches `docLinkToRouterPath` 1-for-1.
 */

export type DocLinkChannel = 'app' | 'web' | 'telegram';

export const NEUTRON_SCHEME = 'neutron';
// Env-configured web-app host (Expo client) with NO hosted default.
// Self-hosted operators set `EXPO_PUBLIC_NEUTRON_WEB_APP_BASE` to their
// own web-app host; when unset it is '' and the web doc-link becomes a
// relative `/projects/<id>/docs?path=…` URL. Mirrors runtime/doc-links.ts
// (which reads `NEUTRON_WEB_APP_BASE`). buildDocLink ↔ parseDocLink stay
// consistent for whatever value this resolves to. Trailing slashes are
// stripped so `WEB_APP_BASE + '/projects/'` never produces a double slash,
// matching runtime/doc-links.ts + onboarding/interview/final-handoff-config.ts.
export const WEB_APP_BASE = (
  process.env.EXPO_PUBLIC_NEUTRON_WEB_APP_BASE ?? ''
).replace(/\/+$/, '');
// Configurable via the VAULT_REDIRECTOR_BASE env var; the default is a
// placeholder that self-hosted installs override. Mirrors runtime/doc-links.ts.
export const VAULT_REDIRECTOR_BASE =
  process.env.VAULT_REDIRECTOR_BASE ?? 'https://vault.example.test';

export const MAX_DOC_PATH_LEN = 1024;
export const MAX_PROJECT_ID_LEN = 128;

const PROJECT_ID_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * P7.3 line anchors — `line` is 1-indexed; `range_start`/`range_end`
 * are reserved for P7.2's inline-comment side-pane (parser shape only,
 * no rendering this sprint). Mutually exclusive with `line`. Vault-
 * legacy URLs do NOT accept anchors. Mirror of `runtime/doc-links.ts`.
 */
export interface ParsedDocLink {
  project_id: string | null;
  path: string;
  line?: number;
  range_start?: number;
  range_end?: number;
}

export interface BuildDocLinkInput {
  project_id?: string | null;
  path: string;
  channel: DocLinkChannel;
  line?: number;
  range_start?: number;
  range_end?: number;
}

export class DocLinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DocLinkError';
  }
}

export function buildDocLink(input: BuildDocLinkInput): string {
  const { channel } = input;
  const path = input.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new DocLinkError('empty_path', 'doc-link path must be a non-empty string');
  }
  if (path.length > MAX_DOC_PATH_LEN) {
    throw new DocLinkError('path_too_long', `doc-link path must be ≤ ${MAX_DOC_PATH_LEN} chars`);
  }
  const project_id = input.project_id ?? null;
  if (project_id !== null) {
    if (typeof project_id !== 'string' || project_id.length === 0) {
      throw new DocLinkError('invalid_project_id', 'project_id must be a non-empty string');
    }
    if (project_id.length > MAX_PROJECT_ID_LEN) {
      throw new DocLinkError('invalid_project_id', `project_id must be ≤ ${MAX_PROJECT_ID_LEN} chars`);
    }
    if (!PROJECT_ID_RE.test(project_id)) {
      throw new DocLinkError('invalid_project_id', `project_id must match ${PROJECT_ID_RE.source}`);
    }
  }

  // P7.3 — validate optional line / range anchors (mirror of
  // `runtime/doc-links.ts:validateAnchor`).
  const anchor = validateAnchor(input);

  const normalised = normalisePath(path);
  // Argus MINOR #2 (P7.3): re-validate after normalisation. Inputs
  // like `/`, `./plan.md`, `a/../b.md` pass the pre-normalise length
  // check but produce URLs `parseDocLink` would reject. Re-running
  // the same rejection rule here keeps buildDocLink ↔ parseDocLink
  // round-tripping cleanly. Mirror of `runtime/doc-links.ts`.
  if (normalised.length === 0) {
    throw new DocLinkError('empty_path', `path '${path}' normalises to an empty string`);
  }
  if (!isSafeDecodedPath(normalised)) {
    throw new DocLinkError(
      'invalid_path',
      `path '${path}' contains a traversal segment ('.' / '..') or absolute prefix`,
    );
  }
  const encoded = encodeDocPath(normalised);

  if (project_id === null) {
    // Vault-legacy URLs reject line/range anchors (Obsidian's
    // obsidian://open URL doesn't take a line param). Mirror of
    // `runtime/doc-links.ts`.
    if (anchor !== '') {
      throw new DocLinkError(
        'invalid_anchor',
        'vault-legacy URLs do not accept line / range anchors',
      );
    }
    return `${VAULT_REDIRECTOR_BASE}/${encoded}`;
  }
  switch (channel) {
    case 'app':
      return `${NEUTRON_SCHEME}://docs/${project_id}/${encoded}${anchor}`;
    case 'web':
      // Argus r4 BLOCKING #1: target the existing Expo route
      // `app/app/projects/[id]/docs.tsx`. The static web export has
      // no `/docs/<id>/<path>` route, so the previous shape 404'd
      // when a user tapped an inline doc-link.
      //
      // P7.3 — the web shape already carries `?path=`, so the anchor
      // appends as `&line=<n>` (or `&range=<n>-<m>`) instead of
      // `?line=…`. Mirror of `runtime/doc-links.ts`.
      return `${WEB_APP_BASE}/projects/${project_id}/docs?path=${encodeURIComponent(normalised)}${appendToWebQuery(anchor)}`;
    case 'telegram':
      return `${NEUTRON_SCHEME}://docs/${project_id}/${encoded}${anchor}`;
    default: {
      const exhaustive: never = channel;
      throw new DocLinkError('invalid_channel', `unknown channel '${exhaustive as string}'`);
    }
  }
}

/**
 * Build the trailing anchor query (incl. leading `?`) from the optional
 * `line` / `range_*` fields. Mirror of `runtime/doc-links.ts:validateAnchor`.
 */
function validateAnchor(input: BuildDocLinkInput): string {
  const hasLine = input.line !== undefined && input.line !== null;
  const hasRangeStart = input.range_start !== undefined && input.range_start !== null;
  const hasRangeEnd = input.range_end !== undefined && input.range_end !== null;
  if (hasLine && (hasRangeStart || hasRangeEnd)) {
    throw new DocLinkError(
      'invalid_anchor',
      '`line` and `range_*` are mutually exclusive on a single doc-link',
    );
  }
  if (hasLine) {
    const n = input.line!;
    // ISSUES #12 — Expo mirror of `runtime/doc-links.ts` bound. Parser
    // rejects > 0x7fffffff; builder must too so the round-trip
    // invariant holds across both call sites.
    if (!Number.isInteger(n) || n < 1 || n > 0x7fffffff) {
      throw new DocLinkError(
        'invalid_anchor',
        `line must be a positive integer ≤ ${0x7fffffff} (got ${String(n)})`,
      );
    }
    return `?line=${n}`;
  }
  if (hasRangeStart !== hasRangeEnd) {
    throw new DocLinkError(
      'invalid_anchor',
      'range_start + range_end must be supplied together',
    );
  }
  if (hasRangeStart && hasRangeEnd) {
    const s = input.range_start!;
    const e = input.range_end!;
    // ISSUES #12 — bound parity on range endpoints.
    if (
      !Number.isInteger(s) || s < 1 || s > 0x7fffffff ||
      !Number.isInteger(e) || e < 1 || e > 0x7fffffff
    ) {
      throw new DocLinkError(
        'invalid_anchor',
        `range_start/range_end must be positive integers ≤ ${0x7fffffff} (got ${String(s)}-${String(e)})`,
      );
    }
    if (s > e) {
      throw new DocLinkError(
        'invalid_anchor',
        `range_start (${s}) must be ≤ range_end (${e})`,
      );
    }
    return `?range=${s}-${e}`;
  }
  return '';
}

/**
 * Rewrite the leading `?` of an anchor string to `&` so the web shape's
 * multi-key query stays well-formed. Mirror of `runtime/doc-links.ts`.
 */
function appendToWebQuery(anchor: string): string {
  if (anchor.length === 0) return '';
  return `&${anchor.slice(1)}`;
}

/**
 * Reverse of `buildDocLink`. Accepts:
 *   - neutron://docs/<project_id>/<encoded path>
 *   - <WEB_APP_BASE>/projects/<project_id>/docs?path=<encoded path>
 *   - https://vault.example.test/<encoded path>      (vault legacy)
 *   - docs:/<project_id>/<path>                          (marker, ALWAYS project-scoped)
 *
 * The marker form is documented as project-scoped only — vault refs use the
 * literal `vault.example.test` URL.
 */
export function parseDocLink(url: string): ParsedDocLink | null {
  if (typeof url !== 'string' || url.length === 0) return null;

  // Web shape is the ONLY canonical shape that legitimately carries a
  // query string. Match it before the global `?`/`#` rejection so the
  // rejection can still guard every other shape against smuggling.
  const webPrefix = `${WEB_APP_BASE}/projects/`;
  if (url.startsWith(webPrefix)) {
    return parseWebShape(url.slice(webPrefix.length));
  }

  // P7.3 — strip an optional `?line=N` / `?range=N-M` anchor before the
  // global `?`/`#` rejection so the project-scoped shapes carry it.
  // Mirror of `runtime/doc-links.ts:splitAnchor`.
  const anchored = splitAnchor(url);
  if (anchored === null) return null;
  if (anchored.url.includes('?') || anchored.url.includes('#')) return null;

  const neutronPrefix = `${NEUTRON_SCHEME}://docs/`;
  if (anchored.url.startsWith(neutronPrefix)) {
    const base = parseProjectAndPath(anchored.url.slice(neutronPrefix.length));
    if (base === null) return null;
    return applyAnchor(base, anchored.anchor);
  }
  const vaultPrefix = `${VAULT_REDIRECTOR_BASE}/`;
  if (anchored.url.startsWith(vaultPrefix)) {
    // Vault refs reject anchors — Obsidian's obsidian://open URL
    // doesn't take a line param.
    if (anchored.anchor !== null) return null;
    const encoded = anchored.url.slice(vaultPrefix.length);
    const path = decodeDocPath(encoded);
    if (path === null) return null;
    return { project_id: null, path };
  }
  if (anchored.url.startsWith('docs:/')) {
    const rest = anchored.url.slice('docs:/'.length);
    if (rest.length === 0) return null;
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const head = rest.slice(0, slash);
    const rawTail = rest.slice(slash + 1);
    if (!PROJECT_ID_RE.test(head)) return null;
    if (head.length > MAX_PROJECT_ID_LEN) return null;
    if (rawTail.length === 0 || rawTail.length > MAX_DOC_PATH_LEN) return null;
    // Argus r4 IMPORTANT #1: decode the marker tail like the other URL
    // branches so a pre-encoded marker (`docs:/p/foo%28draft%29.md`)
    // round-trips through buildDocLink without double-encoding. Mirror
    // of `runtime/doc-links.ts`.
    const path = decodeDocPath(rawTail);
    if (path === null) return null;
    return applyAnchor({ project_id: head, path }, anchored.anchor);
  }
  return null;
}

/** P7.3 — parsed `?line=` / `?range=` anchor payload. */
type ParsedAnchor =
  | { kind: 'line'; line: number }
  | { kind: 'range'; range_start: number; range_end: number };

interface AnchoredUrl {
  url: string;
  anchor: ParsedAnchor | null;
}

function splitAnchor(url: string): AnchoredUrl | null {
  const q = url.indexOf('?');
  if (q < 0) return { url, anchor: null };
  const base = url.slice(0, q);
  const query = url.slice(q + 1);
  if (query.includes('#') || base.includes('#')) return null;
  const anchor = parseAnchorQuery(query);
  if (anchor === null) return null;
  return { url: base, anchor };
}

function parseAnchorQuery(query: string): ParsedAnchor | null {
  if (query.length === 0) return null;
  if (query.includes('&')) return null;
  const eq = query.indexOf('=');
  if (eq <= 0) return null;
  const key = query.slice(0, eq);
  const value = query.slice(eq + 1);
  if (key === 'line') {
    const n = parseAnchorInt(value);
    if (n === null) return null;
    return { kind: 'line', line: n };
  }
  if (key === 'range') {
    const dash = value.indexOf('-');
    if (dash <= 0) return null;
    const s = parseAnchorInt(value.slice(0, dash));
    const e = parseAnchorInt(value.slice(dash + 1));
    if (s === null || e === null) return null;
    if (s > e) return null;
    return { kind: 'range', range_start: s, range_end: e };
  }
  return null;
}

function parseAnchorInt(raw: string): number | null {
  if (raw.length === 0) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  if (n < 1 || n > 0x7fffffff) return null;
  return n;
}

function applyAnchor(base: ParsedDocLink, anchor: ParsedAnchor | null): ParsedDocLink {
  if (anchor === null) return base;
  if (anchor.kind === 'line') return { ...base, line: anchor.line };
  return { ...base, range_start: anchor.range_start, range_end: anchor.range_end };
}

/**
 * Parse the web shape's URL tail (after `${WEB_APP_BASE}/projects/`).
 * Expected layout: `<project_id>/docs?path=<encodeURIComponent(path)>`.
 * Slashes inside the path are `%2F`-encoded; the query payload is one
 * opaque value. Mirrors the runtime helper. Rejects anything beyond a
 * single `path=…` query (extra keys, fragments, missing literal `docs`).
 */
function parseWebShape(rest: string): ParsedDocLink | null {
  if (rest.length === 0) return null;
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const project_id = rest.slice(0, slash);
  if (!PROJECT_ID_RE.test(project_id)) return null;
  if (project_id.length > MAX_PROJECT_ID_LEN) return null;
  const tail = rest.slice(slash + 1);
  const docsQueryPrefix = 'docs?path=';
  if (!tail.startsWith(docsQueryPrefix)) return null;
  const queryPayload = tail.slice(docsQueryPrefix.length);
  if (queryPayload.length === 0) return null;
  if (queryPayload.includes('#')) return null;

  // P7.3 — `?path=` is the first key; an optional second key may be
  // `line=<N>` or `range=<N>-<M>`. Anything else rejects. Mirror of
  // `runtime/doc-links.ts:parseWebShape`.
  let encodedPath: string;
  let anchor: ParsedAnchor | null = null;
  const amp = queryPayload.indexOf('&');
  if (amp < 0) {
    encodedPath = queryPayload;
  } else {
    encodedPath = queryPayload.slice(0, amp);
    const trailing = queryPayload.slice(amp + 1);
    if (trailing.length === 0) return null;
    anchor = parseAnchorQuery(trailing);
    if (anchor === null) return null;
  }
  if (encodedPath.length === 0) return null;
  if (encodedPath.includes('?') || encodedPath.includes('&') || encodedPath.includes('#')) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > MAX_DOC_PATH_LEN) return null;
  if (!isSafeDecodedPath(decoded)) return null;
  return applyAnchor({ project_id, path: decoded }, anchor);
}

function parseProjectAndPath(rest: string): ParsedDocLink | null {
  if (rest.length === 0) return null;
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const project_id = rest.slice(0, slash);
  if (!PROJECT_ID_RE.test(project_id)) return null;
  if (project_id.length > MAX_PROJECT_ID_LEN) return null;
  const encoded = rest.slice(slash + 1);
  if (encoded.length === 0) return null;
  const path = decodeDocPath(encoded);
  if (path === null) return null;
  return { project_id, path };
}

function normalisePath(path: string): string {
  let p = path.trim();
  if (p.startsWith('/')) p = p.slice(1);
  p = p.replace(/\/{2,}/g, '/');
  return p;
}

function encodeDocPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function decodeDocPath(encoded: string): string | null {
  try {
    const decoded = encoded
      .split('/')
      .map((seg) => decodeURIComponent(seg))
      .join('/');
    if (decoded.length === 0 || decoded.length > MAX_DOC_PATH_LEN) return null;
    if (!isSafeDecodedPath(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Defense-in-depth path validator. Rejects absolute paths (leading `/`)
 * and any `..` / `.` traversal segments. Encoded forms (e.g. `%2e%2e`)
 * are caught because callers run this AFTER `decodeURIComponent`.
 * Mirror of `runtime/doc-links.ts:isSafeDecodedPath`.
 */
function isSafeDecodedPath(decoded: string): boolean {
  if (decoded.startsWith('/')) return false;
  const segments = decoded.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return false;
  }
  return true;
}

/**
 * Map a parsed doc-link to the in-app router target. Project-scoped
 * links route to `/projects/<project_id>/docs?path=<encoded path>`.
 * Vault-legacy links (`project_id === null`) have no in-app target
 * for v1; the caller falls back to `Linking.openURL` on the
 * original URL (which lands at `vault.example.test`).
 *
 * P7.3 — when the parsed link carries a `line` anchor, append
 * `&line=<n>` so the docs route's `useLocalSearchParams` reads it
 * and the viewer scrolls to that position after the body loads.
 *
 * P7.3 range UI consumer — when the parsed link carries a
 * `range_start` + `range_end` anchor, append `&range=<n>-<m>` so the
 * docs route's `useLocalSearchParams` reads it and the viewer scrolls
 * to the first line of the range AND paints the multi-line highlight
 * overlay across lines N..M. `line` and `range` are mutually
 * exclusive (the parser rejects same-URL pairings); on the off-chance
 * both arrive here, `line` wins for symmetry with the parser's
 * precedence guard.
 */
export function docLinkToRouterPath(parsed: ParsedDocLink): string | null {
  if (parsed.project_id === null) return null;
  const encodedPath = encodeURIComponent(parsed.path);
  let target = `/projects/${parsed.project_id}/docs?path=${encodedPath}`;
  if (parsed.line !== undefined) {
    target += `&line=${parsed.line}`;
  } else if (parsed.range_start !== undefined && parsed.range_end !== undefined) {
    target += `&range=${parsed.range_start}-${parsed.range_end}`;
  }
  return target;
}
