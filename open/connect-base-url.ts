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

const ENV_KEY = 'NEUTRON_CONNECT_PUBLIC_BASE_URL'

export interface ResolveConnectBaseUrlInput {
  env: NodeJS.ProcessEnv
  /** The address the gateway binds (`config.host` / `NEUTRON_HOST`). */
  bindHost: string
  /** The port the gateway listens on. */
  port: number
}

/** Normalized origin with no trailing slash. */
export function resolveConnectBaseUrl(input: ResolveConnectBaseUrlInput): string {
  const configured = (input.env[ENV_KEY] ?? '').trim()
  if (configured.length > 0) {
    try {
      const url = new URL(configured)
      return `${url.protocol}//${url.host}`
    } catch {
      // A malformed value falls through to the bind-derived origin rather than
      // producing an invite link that cannot be parsed at all.
    }
  }
  const host = input.bindHost === '0.0.0.0' || input.bindHost === '::' ? '127.0.0.1' : input.bindHost
  const bracketed = host.includes(':') ? `[${host}]` : host
  return `http://${bracketed}:${input.port}`
}

/** The bare host a collaborator dials — the invite-preview disclosure line. */
export function connectHostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
