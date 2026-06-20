/**
 * @neutronai/research-core — web-fetch wrapper.
 *
 * Per docs/plans/research-core-tier1-brief.md § 5.
 *
 * Honors the Core's `network:browse` capability declaration — the
 * wrapper refuses calls when the manifest doesn't carry it. Enforces:
 *
 *   - Unconditional rejects (regardless of allow-list): RFC-1918,
 *     loopback, link-local (incl. cloud metadata at 169.254.169.254),
 *     `file://` / `ftp://` / `data:` / `javascript:` / chrome-extension://.
 *   - Per-Core allow-list: hostname must match an entry in the
 *     allow-list suffix table.
 *   - Redirect-follow safety: if a fetch redirects to a domain outside
 *     the allow-list (or to a blocked destination), the redirect is
 *     refused.
 *   - Size cap: 5 MB body default.
 *   - Timeout: 30 s default.
 *   - Content-type sniffing: refuses non-text/* + non-application/json
 *     (no executable downloads).
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { BROWSE_CAPABILITY } from './manifest.ts'
import {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_WEB_FETCH_ALLOWLIST,
  HOSTNAME_BLOCKLIST,
} from './web-fetch-allowlist.ts'

export class BlockedDestinationError extends Error {
  readonly code: string
  readonly url: string
  constructor(url: string, reason: string) {
    super(`web-fetch refused ${url}: ${reason}`)
    this.name = 'BlockedDestinationError'
    // Tag SSRF-class refusals with a stable structured code so callers /
    // ops dashboards can distinguish DNS-resolved-to-internal-IP rejects
    // (ISSUES #21) from generic content-type / size / allowlist refusals.
    this.code = reason.startsWith('ssrf_blocked:') ? 'ssrf_blocked' : reason
    this.url = url
  }
}

export class WebFetchCapabilityDeniedError extends Error {
  readonly code = 'capability_denied' as const
  constructor() {
    super(`web-fetch requires capability '${BROWSE_CAPABILITY}' to be declared in the Core's manifest`)
    this.name = 'WebFetchCapabilityDeniedError'
  }
}

export interface WebFetchInput {
  url: string
  /** Max bytes accepted on the body (default 5 MB). */
  max_bytes?: number
  /** Request timeout in ms (default 30 s). */
  timeout_ms?: number
  /** Per-call allow-list override (defaults to module default). */
  allowlist?: readonly string[]
}

export interface WebFetchResult {
  url: string
  /** Final canonical URL after redirects (or the input URL if no redirects). */
  final_url: string
  status: number
  content_type: string | null
  body_text: string
  bytes: number
}

const UNCONDITIONAL_SCHEME_REJECTS = new Set([
  'file:',
  'ftp:',
  'data:',
  'javascript:',
  'chrome-extension:',
  'gopher:',
])

// Pre-compiled IP-shape detectors. Match IPv4 / IPv6 hostnames in RFC-1918
// + loopback + link-local + CGNAT ranges. Hostname is the raw `URL.hostname`
// — Node strips IPv6 brackets so we test the bracket-less form.
const IPV4_RFC1918_LOOPBACK_LINKLOCAL = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  // Carrier-grade NAT
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // 0.0.0.0
  /^0\.0\.0\.0$/,
]

const IPV6_LOOPBACK_LINKLOCAL_ULA = [
  /^::1$/,
  /^::$/,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
]

export function isUnconditionallyBlocked(url: URL): { blocked: boolean; reason: string } {
  if (UNCONDITIONAL_SCHEME_REJECTS.has(url.protocol)) {
    return { blocked: true, reason: `scheme '${url.protocol}' is unconditionally blocked` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { blocked: true, reason: `scheme '${url.protocol}' is not allowed (only http/https)` }
  }
  const host = url.hostname.toLowerCase()
  for (const re of HOSTNAME_BLOCKLIST) {
    if (re.test(host)) return { blocked: true, reason: `hostname ${host} matches DNS-rebinding blocklist` }
  }
  const ipCheck = isBlockedIp(host)
  if (ipCheck.blocked) return ipCheck
  return { blocked: false, reason: '' }
}

/**
 * Predicate: is `host` a bracket-less IP literal that falls in the
 * unconditional reject list (RFC-1918, loopback, link-local, CGNAT,
 * ULA)? Returns `{ blocked: false }` for hostnames that aren't IP
 * shapes — those need DNS resolution first (see {@link assertHostResolvesPublic}).
 *
 * Extracted from {@link isUnconditionallyBlocked} so the post-DNS-resolve
 * SSRF check (ISSUES #21) can re-apply the same predicate to each
 * resolved A/AAAA record without re-running the scheme / blocklist
 * checks.
 */
export function isBlockedIp(host: string): { blocked: boolean; reason: string } {
  const h = host.toLowerCase()
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) wraps an IPv4 address inside an
  // IPv6 literal. Node's TCP stack happily connects to the underlying
  // IPv4 — so `::ffff:127.0.0.1` reaches loopback and
  // `::ffff:169.254.169.254` reaches the AWS metadata service. The IPv6
  // regex set below doesn't catch these (they don't start with `fe80:`
  // / `fc__:` / `fd__:`) and the IPv4 set doesn't either (the host
  // string carries the `::ffff:` prefix). Strip the prefix and re-check
  // the unwrapped IPv4 against the IPv4 reject ranges before the
  // regular IPv6 matchers run. Also handle the rare `::ffff:0:a.b.c.d`
  // form (RFC 4291 § 2.5.5.1 IPv4-translated, used by NAT64 / DNS64).
  const v4mapped = h.match(/^::ffff:(?:0:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4mapped !== null && v4mapped[1] !== undefined) {
    const inner = v4mapped[1]
    for (const re of IPV4_RFC1918_LOOPBACK_LINKLOCAL) {
      if (re.test(inner)) {
        return {
          blocked: true,
          reason: `host ${h} is IPv4-mapped IPv6 wrapping RFC-1918 / loopback / link-local IPv4 ${inner}`,
        }
      }
    }
  }
  for (const re of IPV4_RFC1918_LOOPBACK_LINKLOCAL) {
    if (re.test(h)) {
      return { blocked: true, reason: `host ${h} is RFC-1918 / loopback / link-local IPv4` }
    }
  }
  for (const re of IPV6_LOOPBACK_LINKLOCAL_ULA) {
    if (re.test(h)) {
      return { blocked: true, reason: `host ${h} is loopback / link-local / ULA IPv6` }
    }
  }
  return { blocked: false, reason: '' }
}

export function isAllowlisted(
  host: string,
  allowlist: readonly string[] = DEFAULT_WEB_FETCH_ALLOWLIST,
): boolean {
  const h = host.toLowerCase()
  for (const entry of allowlist) {
    const e = entry.toLowerCase()
    if (h === e) return true
    if (h.endsWith('.' + e)) return true
  }
  return false
}

export function manifestDeclaresBrowse(manifest: NeutronManifest): boolean {
  return manifest.capabilities.includes(BROWSE_CAPABILITY)
}

const ALLOWED_CONTENT_TYPES = [
  /^text\//i,
  /^application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript|x-www-form-urlencoded)/i,
]

function isAllowedContentType(ct: string | null): boolean {
  if (ct === null) return true // many endpoints omit; allow with caveat
  return ALLOWED_CONTENT_TYPES.some((re) => re.test(ct))
}

/**
 * Pluggable DNS resolver. ISSUES #21 requires resolving hostnames to
 * IPs and rejecting if any resolved address falls in the RFC-1918 /
 * loopback / link-local / ULA reject ranges. Tests override this to
 * simulate poisoned A records without touching the real resolver.
 *
 * Mirrors a subset of `dns.promises.lookup`'s signature: returns at
 * least one resolved record. `family` is informational; the SSRF check
 * runs against the literal `address` string.
 */
export type DnsLookupFn = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>

export interface WebFetchDeps {
  manifest: NeutronManifest
  /** Override `fetch` for tests (any function matching the Fetch signature). */
  fetcher?: typeof fetch
  /**
   * Override DNS resolution for tests (ISSUES #21). Defaults to
   * `dns.promises.lookup(host, { all: true })`. Throws on resolution
   * failure; the caller treats a thrown lookup as `ssrf_blocked` because
   * an unresolvable host can't be safely fetched anyway.
   */
  lookup?: DnsLookupFn
}

const defaultLookup: DnsLookupFn = async (host) => {
  const records = await dnsLookup(host, { all: true })
  return records.map((r) => ({ address: r.address, family: r.family }))
}

/**
 * Fetch a URL with the Research Core's safety checks. Throws on:
 *
 *   - Manifest missing `network:browse` capability → `WebFetchCapabilityDeniedError`
 *   - Scheme / hostname unconditionally blocked → `BlockedDestinationError`
 *   - Hostname not in allow-list → `BlockedDestinationError`
 *   - Redirect to a blocked destination → `BlockedDestinationError`
 *   - Content-type not allowed → `BlockedDestinationError`
 *   - Body exceeds size cap → `BlockedDestinationError`
 *   - Timeout exceeded → `Error('web-fetch timeout')`
 *
 * Returns the fetched body, status, and the final-canonical-URL post-
 * redirect. The body is decoded as UTF-8 text — binary downloads are
 * refused via the content-type check.
 */
export async function webFetch(
  input: WebFetchInput,
  deps: WebFetchDeps,
): Promise<WebFetchResult> {
  if (!manifestDeclaresBrowse(deps.manifest)) {
    throw new WebFetchCapabilityDeniedError()
  }
  const max_bytes = input.max_bytes ?? DEFAULT_FETCH_MAX_BYTES
  const timeout_ms = input.timeout_ms ?? DEFAULT_FETCH_TIMEOUT_MS
  const allowlist = input.allowlist ?? DEFAULT_WEB_FETCH_ALLOWLIST
  const fetcher = deps.fetcher ?? fetch
  const lookup = deps.lookup ?? defaultLookup

  const initial = new URL(input.url)
  const block = isUnconditionallyBlocked(initial)
  if (block.blocked) {
    throw new BlockedDestinationError(input.url, block.reason)
  }
  if (!isAllowlisted(initial.hostname, allowlist)) {
    throw new BlockedDestinationError(
      input.url,
      `hostname ${initial.hostname} is not in the allow-list`,
    )
  }
  // ISSUES #21 — SSRF DNS-resolution check. The allowlist alone is a
  // string match; an attacker who controls (or can poison) a resolver
  // for an allowlisted domain can flip its A record to 169.254.169.254
  // (AWS metadata) / 10.x / 127.x and the unconditional check above
  // sees only the public-looking hostname. Resolving here and applying
  // the same `isBlockedIp` predicate to every A/AAAA record closes
  // that gap pre-connection.
  //
  // ISSUE #25 — DNS-rebind TOCTOU pin. The pre-flight lookup approves
  // an IP; we then REWRITE the URL host to that IP for the actual TCP
  // connect, and pin SNI + cert validation to the original hostname
  // via Bun's `tls.serverName` + `tls.checkServerIdentity` extensions.
  // The pinned URL contains the literal IP — Bun does NOT re-resolve
  // IP-literal hosts, so there's no second DNS round for an adversarial
  // rebinder to race.
  //
  // Why URL-rewrite instead of undici `dispatcher`: the canonical
  // undici approach (`fetch(url, { dispatcher: new Agent({connect:{lookup}}) })`)
  // is silently a no-op under Bun. Bun substitutes its own fetch
  // implementation and ignores the `dispatcher` option; Bun's bundled
  // `undici.Agent` is a stub class whose `close` / `destroy` / `dispatch`
  // methods are `undefined`. Even `import { fetch } from 'undici'` returns
  // Bun's wrapper. The Bun-native equivalent below uses options that
  // ARE honored (verified in Bun 1.3.9):
  //   - URL-rewrite: pinned IP is in the URL string, so the connect
  //     dials it directly without a second DNS lookup.
  //   - `tls.serverName`: sends the original hostname as SNI so
  //     virtual-hosted servers serve the expected site.
  //   - `tls.checkServerIdentity`: Node's standard validator runs
  //     against the original hostname (which is what Bun passes in
  //     as the first arg when `serverName` is set), so cert
  //     hostname-vs-SAN validation rejects mismatched certs.
  //   - Explicit `Host` header: keeps HTTP/1.1 virtual-host routing
  //     correct (the URL's host is now the IP).
  let display_url = initial   // canonical URL — for log/display + Location resolution
  const initialPin = await resolveAndAssertPublic(initial, lookup, input.url)
  let pinned = applyPin(initial, initialPin)

  try {
    // Manual redirect-follow loop so we can re-check destinations.
    let response: Response | null = null
    for (let hop = 0; hop < 5; hop++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout_ms)
      try {
        const init: RequestInit & { tls?: PinnedTlsOptions; headers?: Record<string, string> } = {
          redirect: 'manual',
          signal: controller.signal,
          ...pinned.init,
        }
        response = await fetcher(pinned.url, init)
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') {
          throw new Error(`web-fetch timeout after ${timeout_ms}ms for ${display_url.toString()}`)
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
      const status = response.status
      if (status >= 300 && status < 400) {
        const loc = response.headers.get('location')
        if (loc === null) {
          // Weird redirect without location; consume any body before
          // breaking so we don't leak the open socket.
          try { await response.body?.cancel() } catch { /* ignore */ }
          break
        }
        // Resolve the Location header against the DISPLAY URL
        // (original hostname), NOT the pinned URL — otherwise a
        // relative redirect `/bar` would resolve to `https://<ip>/bar`
        // instead of `https://example.com/bar` and the per-hop pin
        // would re-pin against the IP literal instead of re-resolving
        // example.com.
        const next = new URL(loc, display_url)
        // Drop the redirect response's body BEFORE re-validating so an
        // in-flight stream isn't held open across the next-hop SSRF /
        // allowlist throw paths.
        try { await response.body?.cancel() } catch { /* ignore */ }
        const block2 = isUnconditionallyBlocked(next)
        if (block2.blocked) {
          throw new BlockedDestinationError(next.toString(), `redirect rejected: ${block2.reason}`)
        }
        if (!isAllowlisted(next.hostname, allowlist)) {
          throw new BlockedDestinationError(
            next.toString(),
            `redirect rejected: hostname ${next.hostname} is not in the allow-list`,
          )
        }
        // ISSUES #21 — re-apply DNS-resolution SSRF check on every
        // redirect hop. Skipping here would leave open a "trampoline":
        // allowlisted.com 302 → allowlisted2.com whose A record points at
        // 169.254.169.254.
        // ISSUE #25 — each redirect hop also rebuilds the pinned URL +
        // TLS-pin init off the new pre-flight result so the new TCP
        // connect dials the freshly-approved IP (not whatever DNS would
        // resolve to at connect-time).
        const nextPin = await resolveAndAssertPublic(next, lookup, next.toString())
        pinned = applyPin(next, nextPin)
        display_url = next
        continue
      }
      break
    }
    if (response === null) {
      throw new Error('web-fetch: no response after redirect loop')
    }

    const content_type = response.headers.get('content-type')
    if (!isAllowedContentType(content_type)) {
      // Drop the open socket before bailing — leaving the body
      // unconsumed leaks the underlying TLS connection back to the
      // pool half-open.
      try { await response.body?.cancel() } catch { /* ignore */ }
      throw new BlockedDestinationError(
        display_url.toString(),
        `content-type '${content_type}' not allowed (only text/* + application/json-shape)`,
      )
    }
    // ISSUES #22 — Content-Length pre-check + streaming cap. The prior
    // implementation `await response.text()`'d the FULL body before
    // checking the size, which lets a malicious or malformed server OOM
    // the gateway with a 500 MB response even when max_bytes is 5 MB.
    // The two-stage cap below (a) rejects upfront when the server
    // announces a body larger than the cap, and (b) accumulates the
    // body chunk-by-chunk so an adversary lying about Content-Length
    // (or omitting it) still hits the cap as soon as the on-the-wire
    // byte count crosses max_bytes — the underlying socket is closed
    // immediately via `reader.cancel()` so we never buffer more than
    // ~max_bytes worth of plaintext in memory.
    const announced = response.headers.get('content-length')
    if (announced !== null) {
      const announced_n = Number(announced)
      if (Number.isFinite(announced_n) && announced_n > max_bytes) {
        // Drop the open socket before bailing so we don't leak the
        // underlying connection / TLS context.
        try { await response.body?.cancel() } catch { /* ignore */ }
        throw new BlockedDestinationError(
          display_url.toString(),
          `body size ${announced_n} (Content-Length) exceeds cap ${max_bytes}`,
        )
      }
    }
    const { body_text, bytes } = await readBodyUpTo(response, max_bytes, display_url)
    return {
      url: input.url,
      final_url: display_url.toString(),
      status: response.status,
      content_type,
      body_text,
      bytes,
    }
  } finally {
    // No per-hop dispatcher state to drain under the Bun-native
    // pin pattern — the URL-rewrite + tls option shape has no
    // long-lived per-request resource. Body cancels above cover
    // the early-exit paths so the underlying socket isn't held
    // open half-read.
  }
}

/**
 * ISSUES #21 — resolve `url.hostname` via the injected `lookup` and
 * reject if any returned IP falls in the unconditional reject set
 * (RFC-1918, loopback, link-local, ULA). Lookup failures are surfaced
 * as `ssrf_blocked:lookup-failed` rather than letting the underlying
 * fetch error leak — a resolver that won't answer can't be safely
 * fetched.
 *
 * ISSUE #25 — returns the FIRST publicly-resolved record so the caller
 * can rewrite the URL host to that IP literal (Bun-native pin via
 * `applyPin` below), closing the sub-ms TOCTOU window where a rebinder
 * could flip the second DNS resolution (at fetch's connect-time) to
 * RFC-1918. Returns `null` for IP literals — those skip the resolver
 * and the pin (the literal host is the only address there is to
 * connect to, and `isUnconditionallyBlocked` already screened it).
 * Note that ALL resolved records are validated against `isBlockedIp`
 * even though only the first is pinned — if any returned address is
 * RFC-1918, the caller's allowlisted hostname was poisoned and the
 * whole fetch is refused, regardless of which record the runtime would
 * have happened to pick first.
 */
export type PinnedResolvedIp = { address: string; family: 4 | 6 }

export async function resolveAndAssertPublic(
  url: URL,
  lookup: DnsLookupFn,
  display_url: string,
): Promise<PinnedResolvedIp | null> {
  const host = url.hostname.toLowerCase()
  // Bracket-stripped Node URL.hostname for v6 hosts; if the literal
  // already passed `isUnconditionallyBlocked`, nothing left to check.
  if (looksLikeIpLiteral(host)) return null
  let records: ReadonlyArray<{ address: string; family: number }>
  try {
    records = await lookup(host)
  } catch (err) {
    throw new BlockedDestinationError(
      display_url,
      `ssrf_blocked: DNS lookup for ${host} failed (${(err as Error).message ?? 'unknown'})`,
    )
  }
  if (records.length === 0) {
    throw new BlockedDestinationError(
      display_url,
      `ssrf_blocked: DNS lookup for ${host} returned no records`,
    )
  }
  let pinned: PinnedResolvedIp | null = null
  for (const r of records) {
    const ipCheck = isBlockedIp(r.address)
    if (ipCheck.blocked) {
      throw new BlockedDestinationError(
        display_url,
        `ssrf_blocked: ${host} resolved to ${r.address} (${ipCheck.reason})`,
      )
    }
    if (pinned === null) {
      pinned = { address: r.address, family: r.family === 6 ? 6 : 4 }
    }
  }
  // Unreachable in practice: `records.length === 0` would have thrown
  // above, so the loop ran at least once and `pinned` is non-null. The
  // explicit guard keeps TypeScript narrowing happy without `!`.
  if (pinned === null) {
    throw new BlockedDestinationError(
      display_url,
      `ssrf_blocked: DNS lookup for ${host} returned no usable records`,
    )
  }
  return pinned
}

/**
 * ISSUE #25 — Bun-native DNS-rebind pin shape: the pinned URL string
 * (with the IP literal in the host position) plus the init fragment
 * that pins SNI + cert validation + Host header back to the original
 * hostname. Merge `init` into the `fetch` init at call time. For
 * IP-literal source URLs (null pin) returns the URL unchanged + no
 * init additions.
 */
export interface PinnedTlsOptions {
  serverName: string
  checkServerIdentity: (hostname: string, cert: PeerCertificate) => Error | undefined
}

export interface PinnedFetchTarget {
  url: string
  init: {
    headers?: Record<string, string>
    tls?: PinnedTlsOptions
  }
}

/**
 * ISSUE #25 — build the pinned URL + TLS-pin init for one fetch hop.
 *
 * The pre-flight `resolveAndAssertPublic` has already approved an IP
 * for this hostname. We close the connect-time TOCTOU window by
 * REWRITING the URL host to that IP literal — Bun does not re-resolve
 * IP-literal hostnames, so there's no second DNS lookup for an
 * adversarial rebinder to race against.
 *
 * For HTTPS we also set:
 *   - `tls.serverName = <original-hostname>` — sends the right SNI so
 *     virtual-hosted servers serve the expected site.
 *   - `tls.checkServerIdentity = node-tls's standard validator` — Bun
 *     passes the `serverName` value as the `hostname` argument to this
 *     callback when `serverName` is set, so the standard validator
 *     runs against the original hostname and rejects mismatched
 *     certs. Without this override, Bun's default validation runs
 *     against `URL.hostname` — which is now the IP literal — and
 *     accepts any cert whose SAN happens to include that IP (e.g.
 *     Cloudflare's wildcard universal cert includes `1.1.1.1` as an
 *     IP SAN, defeating the spirit of the pin).
 *
 * For all schemes we also set an explicit `Host` header to the
 * original `URL.host` (hostname[:port]) — HTTP/1.1 virtual-host
 * routing on the destination needs this; without it, the server sees
 * `Host: <ip>` and serves the wrong site (or 404s).
 *
 * Exported for unit-testing the pin-construction contract (URL is
 * rewritten with the IP; tls options pin SNI + cert validation; Host
 * header pins the original hostname).
 */
export function applyPin(url: URL, pinned: PinnedResolvedIp | null): PinnedFetchTarget {
  if (pinned === null) {
    // IP-literal source — there's no DNS to pin; pass through.
    return { url: url.toString(), init: {} }
  }
  const original_hostname = url.hostname
  const original_host = url.host // hostname[:port]
  // Bracket IPv6 in URL form per RFC 3986; IPv4 unchanged.
  const ipHostForm = pinned.family === 6 ? `[${pinned.address}]` : pinned.address
  const rewritten = new URL(url.toString())
  // `URL.host` setter accepts `ip[:port]` — preserve explicit port if any.
  rewritten.host = url.port !== '' ? `${ipHostForm}:${url.port}` : ipHostForm
  const init: PinnedFetchTarget['init'] = {
    headers: { Host: original_host },
  }
  if (url.protocol === 'https:') {
    init.tls = {
      serverName: original_hostname,
      // Standard tls.checkServerIdentity validates the cert against
      // the hostname argument — and Bun passes `serverName` here when
      // it's set, so validation runs against the original hostname.
      checkServerIdentity,
    }
  }
  return { url: rewritten.toString(), init }
}

function looksLikeIpLiteral(host: string): boolean {
  // IPv4 dotted-quad: 4 numeric octets.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  // IPv6: at least one `:` and only hex/colons/dots.
  if (host.includes(':') && /^[0-9a-f:.]+$/i.test(host)) return true
  return false
}

/**
 * ISSUES #22 — streaming body read with a hard byte cap. Reads chunks
 * off `response.body`, accumulates them, and cancels the underlying
 * socket as soon as the running total crosses `max_bytes`. Returns
 * both the decoded text and the raw on-the-wire byte count so callers
 * keep the existing `WebFetchResult.bytes` field semantics.
 *
 * Backstop for older runtimes / mocked fetchers that return a
 * `Response` without a streaming body — those fall back to
 * `response.text()` followed by the same cap check so behaviour stays
 * consistent.
 */
async function readBodyUpTo(
  response: Response,
  max_bytes: number,
  current_url: URL,
): Promise<{ body_text: string; bytes: number }> {
  const body = response.body
  if (body === null || typeof body.getReader !== 'function') {
    const body_text = await response.text()
    const bytes = new TextEncoder().encode(body_text).length
    if (bytes > max_bytes) {
      throw new BlockedDestinationError(
        current_url.toString(),
        `body size ${bytes} exceeds cap ${max_bytes}`,
      )
    }
    return { body_text, bytes }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined && value.byteLength > 0) {
        total += value.byteLength
        if (total > max_bytes) {
          try { await reader.cancel() } catch { /* ignore */ }
          throw new BlockedDestinationError(
            current_url.toString(),
            `body size ${total} exceeds cap ${max_bytes} (streamed)`,
          )
        }
        chunks.push(value)
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released on cancel */ }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  const body_text = new TextDecoder('utf-8').decode(merged)
  return { body_text, bytes: total }
}
