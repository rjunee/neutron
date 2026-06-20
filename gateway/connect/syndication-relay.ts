/**
 * Syndication relay / issuer pointer (M2.6 Ph0 — Neutron Connect).
 *
 * Before this module the issuer (JWKS) host and the open-mode workspace
 * ingress base-URL each defaulted to an implicit subdomain authority
 * baked into the resolvers. That hard-wires a single hosted domain into every
 * self-host / connect deployment.
 *
 * `NEUTRON_SYNDICATION_RELAY_URL` is the ONE coherent client-side relay/issuer
 * pointer a connect or self-host box sets (research § 5.4). When set, the JWKS
 * URL and the open-workspace base-URL template are derived from it, so a
 * path-based relay (e.g. `https://connect.myorg.example`) is
 * fully reachable with identical client code. When UNSET, every existing
 * default (and every existing env var) is unchanged — this is purely additive.
 *
 * This is a LEAF module (no Neutron imports) so both the gateway resolvers and
 * the Managed provisioning orchestrator can read the single env var without a
 * cross-tree dependency edge. (Sprint-F Open/Managed classification: the env
 * name is the contract; relocate freely.)
 */

export const SYNDICATION_RELAY_URL_ENV = 'NEUTRON_SYNDICATION_RELAY_URL'

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Resolve the configured syndication relay base URL (no trailing slash), or
 * `undefined` when unset/blank. Trimmed.
 */
export function resolveSyndicationRelayUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = (env[SYNDICATION_RELAY_URL_ENV] ?? '').trim()
  if (raw.length === 0) return undefined
  return stripTrailingSlash(raw)
}

/**
 * Derive the issuer JWKS URL from a relay base. The relay publishes the issuer
 * key set at the conventional `/.well-known/jwks.json` path.
 */
export function syndicationRelayJwksUrl(relay: string): string {
  return `${stripTrailingSlash(relay)}/.well-known/jwks.json`
}

/**
 * Derive the open-workspace base-URL template (with a literal `{slug}`
 * placeholder) from a relay base. The relay fronts each workspace's
 * connect ingress under a `/<slug>` path prefix — the connect meeting-point
 * ingress shape (research § 5.4). Consumed by
 * `resolveOpenInstanceBaseUrl({ template })`.
 */
export function syndicationRelayInstanceTemplate(relay: string): string {
  return `${stripTrailingSlash(relay)}/{slug}`
}
