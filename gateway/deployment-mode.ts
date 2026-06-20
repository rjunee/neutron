/**
 * Deployment-mode detection (M2.5; extended M2.6 Ph0 — Neutron Connect).
 *
 * Neutron runs in one of three deployment shapes:
 *   - 'managed' — QV's hosted VPS (multiple owner instances). The gateway holds
 *     the identity signing key and mints cross-instance tokens in-process per call.
 *   - 'open'    — a self-hosted single-owner install. It has NO signing key;
 *     to call a Managed workspace-instance's cross-instance API it uses a
 *     FEDERATED JWT obtained from the syndication relay / issuer.
 *   - 'connect' — a Neutron Connect meeting-point node ("Slack Connect for AI
 *     agent harnesses"): it exposes ONLY the cross-instance API + public ingress
 *     and 404s every user-facing surface. M2.6 Ph0 establishes the profile +
 *     route gate; the public HTTPS ingress wiring (Caddy `connect.<domain>` +
 *     guest identity) lands in Ph3.
 *
 * Default is `'open'` (per the M2.5 brief — a self-hoster who never sets the
 * env should never accidentally behave as a Managed host). Managed deployments
 * MUST set the role explicitly; the systemd unit templates do this, and the
 * gateway boot path warns loudly if it resolves to 'open' while a signing key
 * is present (a misconfigured Managed box).
 *
 * NAMING (M2.6 Ph0 reconciliation, brief § 2): `NEUTRON_ROLE` is the canonical
 * public env key (matches the LOCK + roadmap GROUP C). `NEUTRON_DEPLOYMENT_MODE`
 * is kept as a back-compat ALIAS so every already-rendered systemd unit (which
 * sets `NEUTRON_DEPLOYMENT_MODE=managed`) keeps working unchanged. Precedence:
 * `NEUTRON_ROLE` > `NEUTRON_DEPLOYMENT_MODE` > default `'open'`. Both resolve
 * through the SAME `resolveDeploymentMode(env)` — one resolver, two accepted
 * keys — so there is exactly one source of truth for "what shape is this box."
 */

export type DeploymentMode = 'open' | 'managed' | 'connect'

export const DEFAULT_DEPLOYMENT_MODE: DeploymentMode = 'open'

/** Canonical public env key (M2.6 Ph0). Takes precedence over the alias. */
export const DEPLOYMENT_ROLE_ENV = 'NEUTRON_ROLE'

/** Back-compat alias key (pre-M2.6). Still read; lower precedence than the
 *  canonical `NEUTRON_ROLE`. Keeps rendered systemd units working unchanged. */
export const DEPLOYMENT_MODE_ENV = 'NEUTRON_DEPLOYMENT_MODE'

const KNOWN_MODES: ReadonlySet<DeploymentMode> = new Set<DeploymentMode>([
  'open',
  'managed',
  'connect',
])

function normalizeMode(raw: string): DeploymentMode | undefined {
  const v = raw.trim().toLowerCase()
  return KNOWN_MODES.has(v as DeploymentMode) ? (v as DeploymentMode) : undefined
}

/**
 * Resolve the deployment mode from an environment bag. Reads the canonical
 * `NEUTRON_ROLE` first, then the back-compat `NEUTRON_DEPLOYMENT_MODE` alias;
 * unknown / unset values fall back to the default `'open'`. Case-insensitive +
 * trimmed so `NEUTRON_ROLE=Connect ` works.
 */
export function resolveDeploymentMode(
  env: Record<string, string | undefined> = process.env,
): DeploymentMode {
  const fromRole = normalizeMode(env[DEPLOYMENT_ROLE_ENV] ?? '')
  if (fromRole !== undefined) return fromRole
  const fromAlias = normalizeMode(env[DEPLOYMENT_MODE_ENV] ?? '')
  if (fromAlias !== undefined) return fromAlias
  return DEFAULT_DEPLOYMENT_MODE
}

/**
 * M2.6 Ph6 — the explicit hosted-relay marker (Managed-operated). The HOSTED
 * relay we run (the `connect.<base-domain>` host) sets this in its systemd unit; a
 * self-host install template NEVER does. It is the ONLY signal that
 * distinguishes the relay we operate from a privacy-conscious owner running
 * their OWN Connect Server — both set `NEUTRON_ROLE=connect`, so role alone
 * cannot tell them apart.
 *
 * Do NOT reuse `NEUTRON_CONNECT_PUBLIC_BASE_URL` as this gate: a self-hoster
 * sets that too (it just means "I have a public ingress"). This marker's
 * semantics are unambiguously "this is the hosted relay Acme operates."
 */
export const HOSTED_RELAY_MARKER_ENV = 'NEUTRON_CONNECT_METERED'

/**
 * M2.6 Ph6 — TRUE only on the hosted relay WE operate. The relay-only metering
 * composition gate (brief § 2.3 — the § 3 no-runtime-license-check firewall):
 * usage/cap/metering code MUST NOT compose — must not even run — in a
 * self-hoster's runtime. A self-hoster never sets the marker, so this returns
 * false in their process and the entire Ph6 metering layer is a no-op for them.
 *
 * Metering is opt-in by the operator who runs the hosted relay (belt-and-
 * suspenders for the locked principle): the default is "don't meter," so a
 * misconfig fails toward NOT metering a self-hoster, never toward metering them.
 * An enforced cap — or even a recorded counter — on a self-hosted node is a P0
 * bug, not a feature.
 */
export function isHostedRelay(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (resolveDeploymentMode(env) !== 'connect') return false
  const marker = (env[HOSTED_RELAY_MARKER_ENV] ?? '').trim().toLowerCase()
  return marker === '1' || marker === 'true' || marker === 'yes'
}
