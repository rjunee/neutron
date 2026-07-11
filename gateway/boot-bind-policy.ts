/**
 * @neutronai/gateway — S2 (b) fail-closed WIDE-BIND policy guard.
 *
 * The gateway defaults to a loopback bind (`127.0.0.1`), where an
 * unauthenticated single-owner box is only reachable from the machine itself.
 * A self-hoster can opt into a WIDE bind (`NEUTRON_HOST=0.0.0.0` / a LAN
 * address) once they front it with their own auth / a trusted network. But a
 * wide bind that ALSO carries a dev-auth BYPASS env is a footgun: it exposes
 * the agent-driving surfaces to the network with authentication turned OFF.
 * This guard makes that combination FAIL LOUD at boot instead of silently
 * serving an open agent to the LAN.
 *
 * Loopback binds are exempt — today's dev ergonomics (the live 127.0.0.1:7800
 * dogfood, tests, a bare `bun start`) are untouched.
 *
 * A pure leaf (imports nothing): the caller passes the resolved bind host + the
 * raw env bag, so it is trivially unit-testable and reusable from either
 * entrypoint.
 */

export type BindEnvBag = Record<string, string | undefined>

/**
 * The dev-only auth BYPASS env vars. Each turns OFF a real credential check
 * somewhere in the stack, so NONE may be set on a wide bind:
 *   - `NEUTRON_DEV_AUTH`          — dev platform-JWT / secrets accessors (cores/sdk).
 *   - `NEUTRON_APP_WS_BYPASS`     — app-ws resolver accepts ANY bearer.
 *   - `NEUTRON_APP_WS_DEV_SECRET` — app-ws HS256 *dev* shared secret.
 *   - `NEUTRON_E2E_DEV_SECRET`    — e2e-only dev route secret.
 */
export const DEV_BYPASS_ENV_VARS = [
  'NEUTRON_DEV_AUTH',
  'NEUTRON_APP_WS_BYPASS',
  'NEUTRON_APP_WS_DEV_SECRET',
  'NEUTRON_E2E_DEV_SECRET',
] as const

/** A value counts as "set" when present and not an explicit off/empty token. */
function envIsSet(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim()
  return v.length > 0 && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * TRUE when `host` binds ONLY the loopback interface (reachable solely from the
 * machine itself). `0.0.0.0` / `::` / a LAN address / a hostname are all WIDE.
 * Handles a bracketed IPv6 literal (`[::1]`) and the whole `127.0.0.0/8` block.
 */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === 'localhost' || h === '::1') return true
  // Any 127.0.0.0/8 literal is loopback (127.0.0.1 default + aliases).
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true
  return false
}

/**
 * S2 (b) — refuse to boot a WIDE (non-loopback) bind while any dev-auth bypass
 * env is set. Throws a loud, actionable error naming the offending vars. A
 * loopback bind is a no-op (dev ergonomics preserved).
 */
export function assertWideBindPolicy(host: string, env: BindEnvBag = process.env): void {
  if (isLoopbackBindHost(host)) return
  const active = DEV_BYPASS_ENV_VARS.filter((name) => envIsSet(env[name]))
  if (active.length > 0) {
    throw new Error(
      `refusing to boot: NEUTRON_HOST=${host} is a WIDE (non-loopback) bind, but ` +
        `dev-auth bypass env is set: ${active.join(', ')}. A wide bind exposes the ` +
        `agent surfaces to the network — unset ${active.join(' / ')} (they are ` +
        `dev-only), or bind loopback (NEUTRON_HOST=127.0.0.1) for local dev.`,
    )
  }
}
