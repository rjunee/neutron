/**
 * @neutronai/open — where a collaborator reaches THIS install (ISSUES #421).
 *
 * A Connect invite is a URL the owner hands to somebody else, so the instance
 * has to know its own externally-reachable origin. There is no way to derive
 * that: the process sees a bind address, not the DNS name, port-forward, or
 * tunnel a collaborator will actually dial. So the owner declares it with
 * `NEUTRON_CONNECT_PUBLIC_BASE_URL`.
 *
 * This is CONFIGURATION, not a feature toggle. It never decides WHETHER Connect
 * is served — the surface state gate (`connect/surface-gate.ts`) owns that, and
 * an install with an invite serves Connect whether or not this env is set. All
 * this decides is what text goes in the link. Unset, the fallback is the bind
 * address, which is correct for a LAN collaborator and obviously wrong for an
 * internet one — wrong in a way the owner can see and fix, rather than silently.
 */

export const CONNECT_BASE_URL_ENV = 'NEUTRON_CONNECT_PUBLIC_BASE_URL'
const ENV_KEY = CONNECT_BASE_URL_ENV

export interface ResolveConnectBaseUrlInput {
  env: NodeJS.ProcessEnv
  /** The address the gateway binds (`config.host` / `NEUTRON_HOST`). */
  bindHost: string
  /** The port the gateway listens on. */
  port: number
}

/**
 * Where the origin came from.
 *
 * `'configured'` — the owner declared it. `'fallback'` — nobody did, so it was
 * DERIVED from the bind address, which is a GUESS about how the outside world
 * reaches this box.
 *
 * The distinction exists because callers differ in how much a guess costs them.
 * A Connect invite with a guessed origin is wrong in a way the owner can SEE
 * (they hand out the link and it does not resolve) and fix. Handing that same
 * guess to Google as an OAuth redirect_uri fails much further away — as a
 * `redirect_uri_mismatch` on Google's own error page, minutes later, with
 * nothing pointing back at this env var. So the OAuth caller refuses to arm
 * itself on a fallback while Connect is content with one.
 */
export type ConnectBaseUrlSource = 'configured' | 'fallback'

export interface ResolvedConnectBaseUrl {
  base_url: string
  source: ConnectBaseUrlSource
}

/**
 * Resolve the origin AND report whether it was declared or guessed.
 *
 * A MALFORMED configured value reports `'fallback'`, deliberately: the owner
 * believes they set it, so silently substituting a guess is the worse of the two
 * failures, and a caller that cares about the difference should be able to tell.
 */
export function resolveConnectBaseUrlWithSource(
  input: ResolveConnectBaseUrlInput,
): ResolvedConnectBaseUrl {
  const configured = (input.env[ENV_KEY] ?? '').trim()
  if (configured.length > 0) {
    try {
      const url = new URL(configured)
      return { base_url: `${url.protocol}//${url.host}`, source: 'configured' }
    } catch {
      // A malformed value falls through to the bind-derived origin rather than
      // producing an invite link that cannot be parsed at all.
    }
  }
  const host = input.bindHost === '0.0.0.0' || input.bindHost === '::' ? '127.0.0.1' : input.bindHost
  const bracketed = host.includes(':') ? `[${host}]` : host
  return { base_url: `http://${bracketed}:${input.port}`, source: 'fallback' }
}

/** Normalized origin with no trailing slash. Unchanged behaviour — the
 *  source-reporting variant above is the same resolution, one field richer. */
export function resolveConnectBaseUrl(input: ResolveConnectBaseUrlInput): string {
  return resolveConnectBaseUrlWithSource(input).base_url
}

/** The bare host a collaborator dials — the invite-preview disclosure line. */
export function connectHostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
