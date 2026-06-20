/**
 * Open-mode workspace base-URL resolution (M2.5).
 *
 * In Managed mode, `shared-projects-resolver` resolves a workspace slug to its
 * connect API base URL via the local instance registry (loopback port or
 * subdomain). An Open self-hosted client has no registry of the Managed
 * workspaces — it reaches them over the public internet. It resolves a
 * workspace slug to a public connect ingress URL via:
 *
 *   1. A per-workspace override learned at invite-accept time (highest priority).
 *   2. A URL template `NEUTRON_OPEN_INSTANCE_BASE_URL` with `{slug}` interpolated,
 *      e.g. `https://{slug}.<your-instance-host>` (a per-slug subdomain ingress shape).
 *   3. M2.6 Ph0 — when neither of the above is set, a template DERIVED from the
 *      single coherent `NEUTRON_SYNDICATION_RELAY_URL` relay pointer
 *      (`<relay>/{slug}`), so a path-based connect relay resolves
 *      with identical client code. Unset relay → unchanged (returns undefined).
 *
 * Returns null when neither is configured — the workspace is then reported as
 * skipped and the unified list still renders the user's healthy sources.
 */

import {
  resolveSyndicationRelayUrl,
  syndicationRelayInstanceTemplate,
} from './syndication-relay.ts'

export const OPEN_INSTANCE_BASE_URL_ENV = 'NEUTRON_OPEN_INSTANCE_BASE_URL'

export interface OpenInstanceBaseUrlOptions {
  /**
   * Template with a literal `{slug}` placeholder. When absent, only explicit
   * overrides resolve.
   */
  template?: string
  /** Per-workspace explicit base URLs (slug → full base URL). */
  overrides?: ReadonlyMap<string, string>
}

/**
 * Read the workspace base-URL template from an environment bag (trimmed; empty
 * → undefined). Precedence: the explicit `NEUTRON_OPEN_INSTANCE_BASE_URL`
 * template wins; otherwise (M2.6 Ph0) a template derived from
 * `NEUTRON_SYNDICATION_RELAY_URL` (`<relay>/{slug}`). When neither is set,
 * returns undefined (unchanged pre-M2.6 behaviour — a subdomain ingress host was
 * never a hardcoded default here; it was passed in by the caller).
 */
export function readOpenInstanceBaseUrlTemplate(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = (env[OPEN_INSTANCE_BASE_URL_ENV] ?? '').trim()
  if (raw.length > 0) return raw
  const relay = resolveSyndicationRelayUrl(env)
  if (relay !== undefined) return syndicationRelayInstanceTemplate(relay)
  return undefined
}

/**
 * Resolve a workspace slug to its connect API base URL (no trailing
 * slash), or null when unresolvable.
 */
export function resolveOpenInstanceBaseUrl(
  slug: string,
  opts: OpenInstanceBaseUrlOptions = {},
): string | null {
  const override = opts.overrides?.get(slug)
  if (override !== undefined && override.length > 0) {
    return stripTrailingSlash(override)
  }
  if (opts.template !== undefined && opts.template.length > 0) {
    if (!opts.template.includes('{slug}')) return null
    return stripTrailingSlash(opts.template.replaceAll('{slug}', slug))
  }
  return null
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
