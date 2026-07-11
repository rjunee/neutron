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
 * SECRET-valued bypass vars: their consumer activates on ANY non-empty string
 * (e.g. `channels/adapters/app-ws/auth.ts` enables HS256 when
 * `hs256_secret.length > 0`). So `"0"` / `"false"` are 1/5-char secrets that DO
 * activate the prohibited mode — they count as SET, no off-value exemption.
 */
const SECRET_BYPASS_VARS = ['NEUTRON_APP_WS_DEV_SECRET', 'NEUTRON_E2E_DEV_SECRET'] as const

/**
 * FLAG bypass vars: their consumer activates ONLY on the exact flag `"1"`
 * (`config/index.ts` derives `devAuth: NEUTRON_DEV_AUTH === '1'`, `cores/sdk`
 * throws unless `=== '1'`; app-ws dev-bypass is documented `NEUTRON_APP_WS_BYPASS=1`).
 * So `"0"` / `"false"` / anything-but-`"1"` is genuinely OFF for these.
 */
const FLAG_BYPASS_VARS = ['NEUTRON_DEV_AUTH', 'NEUTRON_APP_WS_BYPASS'] as const

/**
 * The dev-only auth BYPASS env vars. Each turns OFF a real credential check
 * somewhere in the stack, so NONE may be ACTIVE on a wide bind:
 *   - `NEUTRON_DEV_AUTH`          — dev platform-JWT / secrets accessors (cores/sdk).
 *   - `NEUTRON_APP_WS_BYPASS`     — app-ws resolver accepts ANY bearer.
 *   - `NEUTRON_APP_WS_DEV_SECRET` — app-ws HS256 *dev* shared secret.
 *   - `NEUTRON_E2E_DEV_SECRET`    — e2e-only dev route secret.
 */
export const DEV_BYPASS_ENV_VARS = [...FLAG_BYPASS_VARS, ...SECRET_BYPASS_VARS] as const

/**
 * TRUE when `name`'s configured `raw` value would ACTIVATE its dev-bypass mode,
 * using each var's OWN consumer semantics (secret ⇒ any non-empty; flag ⇒ the
 * exact `"1"`). This closes the "`NEUTRON_APP_WS_DEV_SECRET=false` slips through"
 * hole: `false` is a live HS256 secret, so it activates and MUST be caught.
 */
function bypassVarActive(name: (typeof DEV_BYPASS_ENV_VARS)[number], raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim()
  if (v.length === 0) return false
  if ((SECRET_BYPASS_VARS as readonly string[]).includes(name)) return true
  // Flag var — only the exact activation token counts (matches the consumer).
  return v === '1'
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
  const active = DEV_BYPASS_ENV_VARS.filter((name) => bypassVarActive(name, env[name]))
  if (active.length > 0) {
    throw new Error(
      `refusing to boot: NEUTRON_HOST=${host} is a WIDE (non-loopback) bind, but ` +
        `dev-auth bypass env is set: ${active.join(', ')}. A wide bind exposes the ` +
        `agent surfaces to the network — unset ${active.join(' / ')} (they are ` +
        `dev-only), or bind loopback (NEUTRON_HOST=127.0.0.1) for local dev.`,
    )
  }
}
