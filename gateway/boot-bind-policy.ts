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
 * `hs256_secret.length > 0`, UNTRIMMED). So `"0"`, `"false"`, and even a
 * whitespace-only `"   "` are live secrets that DO activate the prohibited mode
 * — they all count as SET, no off-value / whitespace exemption.
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
 * using each var's OWN consumer semantics — mirrored EXACTLY, including whether
 * the consumer trims:
 *   - SECRET vars: the consumer keys on the UNTRIMMED length
 *     (`channels/adapters/app-ws/auth.ts`: `hs256_secret.length > 0`), so ANY
 *     non-empty string — INCLUDING whitespace-only (`'   '`) and `'0'`/`'false'`
 *     — is a live secret and counts as active. Do NOT trim.
 *   - FLAG vars: the consumer keys on the exact, UNTRIMMED string `'1'`
 *     (`config/index.ts` `NEUTRON_DEV_AUTH === '1'`, `cores/sdk` `!== '1'`), so
 *     anything but `'1'` is genuinely off.
 * This closes both the `NEUTRON_APP_WS_DEV_SECRET=false` and the `='   '` holes.
 */
function bypassVarActive(name: (typeof DEV_BYPASS_ENV_VARS)[number], raw: string | undefined): boolean {
  if (raw === undefined) return false
  if ((SECRET_BYPASS_VARS as readonly string[]).includes(name)) {
    // Untrimmed length — whitespace IS a live secret to the consumer.
    return raw.length > 0
  }
  // Flag var — exact, untrimmed activation token (matches the consumer).
  return raw === '1'
}

/**
 * STRICT `127.0.0.0/8` check — TRUE only for a valid dotted-quad IPv4 literal in
 * the loopback block: exactly four octets, each a plain 0–255 decimal with no
 * empty part, no leading zero (rejects the `127.0.0.01` ambiguity), no overflow,
 * and first octet exactly 127. This must be airtight: it gates the dev-bypass,
 * so a malformed `127.999.999.999` (which a listener might resolve as a HOSTNAME
 * onto a NON-loopback address) must NOT count as loopback. Linear scan / bounded
 * regex — no ReDoS.
 */
function isLoopbackIpv4(s: string): boolean {
  const parts = s.split('.')
  if (parts.length !== 4) return false
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return false
    if (!/^[0-9]+$/.test(p)) return false
    if (p.length > 1 && p[0] === '0') return false // leading-zero / '00' ambiguity
    if (Number(p) > 255) return false
  }
  return Number(parts[0]) === 127
}

/**
 * TRUE when `host` binds ONLY the loopback interface (reachable solely from the
 * machine itself). `0.0.0.0` / `::` / a LAN address / a hostname are all WIDE.
 * Handles a bracketed IPv6 literal (`[::1]`), the whole (strictly-validated)
 * `127.0.0.0/8` block, and the IPv4-mapped loopback `::ffff:127.x.x.x`.
 */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === 'localhost' || h === '::1') return true
  if (isLoopbackIpv4(h)) return true
  // IPv4-mapped IPv6 loopback (e.g. ::ffff:127.0.0.1) — validate the embedded v4.
  if (h.startsWith('::ffff:')) return isLoopbackIpv4(h.slice('::ffff:'.length))
  return false
}

/**
 * S2 (b) — refuse to boot a WIDE (non-loopback) bind while any dev-auth bypass
 * env is ACTIVE. Throws a loud, actionable error naming the offending vars. A
 * loopback bind is a no-op (dev ergonomics preserved).
 *
 * `env` is REQUIRED (no `process.env` default) — the caller MUST pass the
 * config's own env SNAPSHOT (`BootConfig.devBypassEnv`), so the guard judges a
 * pre-resolved config by the env it was resolved from, not whatever the global
 * `process.env` happens to hold at boot time (the single-snapshot contract).
 */
export function assertWideBindPolicy(host: string, env: BindEnvBag): void {
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
