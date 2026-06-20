/**
 * @neutronai/runtime — return_url validator.
 *
 * Lifted from `identity/oauth/` at C2 (OSS-split boundary closure): the
 * validator is pure URL parsing + allowlist checks with zero identity
 * deps, and the Open gateway surface (`gateway/http/app-admin-surface.ts`)
 * consumes it — so it lives Open-side; the Managed identity service
 * imports it from here (Managed→Open is the legal direction).
 *
 * 2026-05-27 returning-user resume sprint. Each instance gateway's
 * HTTP auth-gate 302s tokenless browser GETs to
 * `<identity>/oauth/google/start?via=web&return_url=<original-url>`.
 * Identity persists the return_url across the OAuth round-trip and 302s
 * the user back to it with a fresh `?start=<token>` appended after the
 * callback completes.
 *
 * To prevent open-redirect abuse the return_url MUST be validated
 * server-side against an allowlist of platform-owned hosts. Mirrors the
 * existing `classifyReturnUrlBinding` allowlist used by the Max OAuth
 * gate (`identity/oauth/max-handoff.ts`):
 *
 *   - `*.<NEUTRON_BASE_DOMAIN>` — the operator's instance base domain.
 *     When `NEUTRON_BASE_DOMAIN` is unset there is NO hosted-domain
 *     default; only localhost + operator-configured extra hosts apply.
 *   - `localhost` / `127.0.0.1` (dev)
 *   - Operator-configured extra hosts via `NEUTRON_RETURN_URL_EXTRA_HOSTS`
 *     (comma-separated; each entry matches as either an exact hostname
 *     or a `.<suffix>` wildcard).
 *
 * Validation rejects:
 *   - Non-http(s) URLs (file://, javascript:, etc.)
 *   - URLs whose host doesn't match the allowlist
 *   - Malformed URLs (URL constructor throws)
 *
 * The validator is intentionally SCHEME-strict: an HTTP-only dev
 * environment can configure `NEUTRON_RETURN_URL_EXTRA_HOSTS=localhost:3000`
 * and the regex check at the per-protocol step rejects the URL if any
 * scheme other than `http` / `https` slips through.
 */

const ALLOWED_RETURN_HOSTS_LOCALHOST = ['localhost', '127.0.0.1']

/**
 * The operator's instance base domain (e.g. an instance reachable at
 * `app.<base>` / `auth.<base>`). Sourced from `NEUTRON_BASE_DOMAIN`.
 * When unset there is NO hosted-domain default: the validator falls back
 * to localhost + operator-configured extra hosts only, so a fresh
 * self-hosted box never silently allows any external host.
 */
function baseDomainSuffixHost(): string {
  const raw = (process.env['NEUTRON_BASE_DOMAIN'] ?? '').trim().toLowerCase()
  return raw.replace(/^\.+/, '').replace(/\.+$/, '')
}

/**
 * Result of validating a single return URL string. `ok: true` means the
 * URL is safe to thread through the OAuth round-trip + emit as a 302
 * Location header. `ok: false` carries a short reason the caller logs
 * + surfaces in the HTTP 400 body.
 */
export type ReturnUrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'malformed' | 'bad-scheme' | 'host-not-allowed' }

export interface ValidateReturnUrlOptions {
  /** Operator-configured extra hosts (comma-separated env). Empty array
   *  by default. */
  extraHosts?: ReadonlyArray<string>
}

/**
 * Validate a return URL against the platform allowlist. Returns a
 * tagged union so the caller can map each rejection reason directly
 * to an HTTP response without try/catch.
 *
 * Allowlist:
 *   - `*.<NEUTRON_BASE_DOMAIN>` (all subdomains of the operator's base
 *     domain) — only when `NEUTRON_BASE_DOMAIN` is set; no default.
 *   - `localhost` / `127.0.0.1` (dev)
 *   - Each `extraHosts` entry — exact-match if no leading dot,
 *     suffix-match if the entry starts with `.`.
 */
export function validateReturnUrl(
  raw: string,
  opts: ValidateReturnUrlOptions = {},
): ReturnUrlValidationResult {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'bad-scheme' }
  }
  const host = parsed.hostname.toLowerCase()
  if (ALLOWED_RETURN_HOSTS_LOCALHOST.includes(host)) return { ok: true, url: parsed }
  const baseDomain = baseDomainSuffixHost()
  if (baseDomain.length > 0) {
    // Match any subdomain of the operator's base domain (`*.<base>`).
    if (host === baseDomain || host.endsWith(`.${baseDomain}`)) {
      return { ok: true, url: parsed }
    }
  }
  for (const entry of opts.extraHosts ?? []) {
    const e = entry.toLowerCase().trim()
    if (e.length === 0) continue
    if (e.startsWith('.')) {
      if (host.endsWith(e)) return { ok: true, url: parsed }
    } else if (host === e) {
      return { ok: true, url: parsed }
    }
  }
  return { ok: false, reason: 'host-not-allowed' }
}

/**
 * Parse a comma-separated env list of extra hosts. Used to support
 * staging deploys whose return URL host isn't a subdomain of
 * `NEUTRON_BASE_DOMAIN` (e.g. `chat.staging.<custom>`).
 *
 * The env var is the SAME shape `NEUTRON_MAX_OAUTH_RETURN_HOSTS`
 * already uses for the Max OAuth gate. The auth-gate sprint introduces
 * a parallel `NEUTRON_RETURN_URL_EXTRA_HOSTS` so the two settings can
 * diverge if operators want narrower defaults for the OAuth-start gate
 * vs the Max OAuth gate. Both env vars default to empty → only the
 * regex + localhost allowlist applies.
 */
export function parseExtraHostsEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env['NEUTRON_RETURN_URL_EXTRA_HOSTS'] ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * M2.5 — extra allowlisted return-URL hosts for the Open connect
 * sign-in handoff (the per-provider connect sign-in start endpoint).
 *
 * The connect start carries an OPEN self-hoster's OWN gateway callback
 * (their connect auth callback URL) as
 * `return_url`. That host is by definition NOT a subdomain of
 * `NEUTRON_BASE_DOMAIN`, so the
 * base allowlist (+ `NEUTRON_RETURN_URL_EXTRA_HOSTS`) would reject it with a
 * 400 before the provider redirect. Operators who run the Managed identity
 * service stuff the self-hosters' callback domains here (comma-separated,
 * exact host or `.<suffix>` wildcard — same matching as `extraHosts`).
 *
 * The connect start handler unions THIS list with the general
 * `parseExtraHostsEnv` result, so a host allowlisted for the auth-gate's
 * `return_url` still works on the connect path too.
 *
 * TRADE-OFF (documented in the PR + AS_BUILT): this is a static operator-
 * managed allowlist. Sprint C replaces it with a real Open-client
 * registration flow (the self-hoster registers their callback domain at
 * install time and the identity service learns it dynamically). Until then
 * the env is the only gate, so it MUST be curated by the operator — never
 * left wildcard-open.
 */
export function parseConnectReturnHostsEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env['NEUTRON_EXTRA_CONNECT_RETURN_URLS'] ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Build the final post-OAuth redirect URL by appending `?start=<token>`
 * (preserving any existing query string) to a validated return URL.
 * Used by `completeAuth` when threading `return_url` through to the
 * final 302.
 */
export function appendStartTokenToReturnUrl(
  return_url: URL,
  start_token: string,
): string {
  // `URL` instances are mutable — clone to avoid surprising the caller.
  const u = new URL(return_url.toString())
  // Replace any pre-existing `?start=…` (the auth-gate stripped it on
  // the outbound 302 anyway, but defense-in-depth).
  u.searchParams.set('start', start_token)
  return u.toString()
}
