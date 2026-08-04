/**
 * @neutronai/open — WHICH broker this instance talks to, and whether it is that
 * broker itself.
 *
 * THE FLOW HAS ALWAYS SUPPORTED TWO DEPLOYMENTS; ONLY ONE HALF WAS CONFIGURABLE.
 * `cores-oauth-broker-surface.ts` was written to run either co-located (the
 * instance is its own broker) or centrally (one host serves many instances),
 * and `gateway/composition/input/cores-input.ts:111-113` says outright that in
 * the central deployment "its instances leave this unset". Nothing let them.
 * The composer derived the HMAC secret from the instance's own random AES
 * keyfile — a value no other host can possibly know — pinned all three origins
 * to one env, and mounted the local broker unconditionally. A hosting layer
 * therefore had no way to point an instance at a central broker.
 *
 * This module is that missing half, and it is CONFIGURATION, not a switch. It
 * resolves ONE binding — an origin, a secret, and whether the broker is served
 * in this process — from two optional envs. Every caller downstream reads the
 * same three fields whichever way they resolved, which is what keeps this a
 * single implementation configured two ways rather than the second code path
 * the no-dual-path rule forbids.
 *
 * WHAT DOES *NOT* MOVE — and this is the subtle one. Only `identityBaseUrl` and
 * `redirectUri` follow the broker. `ownerBaseUrl` stays THIS instance's own
 * origin, always: it becomes the `dispatch_url` the broker relays the code back
 * to (built at `gateway/http/cores-oauth-surface.ts:381`, dialled at
 * `cores-oauth-broker-surface.ts:296`). Point it at the broker and the callback
 * is undeliverable — the broker would relay to itself, and the grant would die
 * one hop from completion with nothing in either log naming the cause. So this
 * module never returns an owner origin at all; it returns only what legitimately
 * varies, and the caller keeps supplying its own.
 *
 * THE SECRET IS ONE DEPLOYMENT-WIDE VALUE (SPEC § Decisions Log 2026-08-04).
 * Per-instance secrets were considered and rejected: near-zero marginal security
 * over (shared key + insert-only register + PKCE) against a real cost, including
 * keying a secret store by instance identity — the slug-instability trap this
 * codebase has already been burned by. The attack that motivated the question is
 * closed structurally instead, in `register` itself.
 */

/** The central broker's origin, e.g. `https://identity.example.com`. */
export const CORES_BROKER_BASE_URL_ENV = 'NEUTRON_CORES_OAUTH_BROKER_BASE_URL'
/** The deployment-wide HMAC secret shared with that broker. */
export const CORES_BROKER_SECRET_ENV = 'NEUTRON_CORES_OAUTH_BROKER_SECRET'

export interface ResolveCoresBrokerBindingInput {
  env: NodeJS.ProcessEnv
  /**
   * This instance's own externally-reachable origin — the co-located broker's
   * origin, and NOT the owner origin (which never varies and is the caller's).
   */
  ownBaseUrl: string
  /**
   * The co-located secret, evaluated ONLY when no central broker is declared.
   * A thunk because producing it touches the instance keyfile, which a remote
   * binding has no business creating.
   */
  colocatedSecret: () => string
}

export interface CoresBrokerBinding {
  /** Origin the register call goes to, and the origin Google redirects to. */
  origin: string
  /** HMAC secret both ends of the register + relay pair sign with. */
  shared_secret: string
  /**
   * Whether THIS process serves the broker surface. True co-located; false when
   * a central broker is declared, which is the `cores_oauth_broker_surface`
   * field those instances are meant to leave unset.
   */
  serve_locally: boolean
}

export type ResolveCoresBrokerBindingResult =
  | { ok: true; binding: CoresBrokerBinding }
  | { ok: false; detail: string }

/**
 * Resolve the binding, or say precisely what is wrong with the configuration.
 *
 * A PARTIAL declaration is an error rather than a silent fall back to
 * co-located. Falling back would arm the instance as its own broker against an
 * origin the operator believes is central, and Google would reject the
 * mismatched redirect_uri on its own error page minutes later, naming nothing on
 * this box — the same far-from-the-cause failure the declared-origin guard in
 * `open/connect-base-url.ts` exists to convert into a boot-log line. Same
 * reasoning, same treatment: refuse to arm, and say which env is missing.
 */
export function resolveCoresBrokerBinding(
  input: ResolveCoresBrokerBindingInput,
): ResolveCoresBrokerBindingResult {
  const declaredOrigin = (input.env[CORES_BROKER_BASE_URL_ENV] ?? '').trim()
  const declaredSecret = (input.env[CORES_BROKER_SECRET_ENV] ?? '').trim()

  if (declaredOrigin.length === 0 && declaredSecret.length === 0) {
    return {
      ok: true,
      binding: {
        origin: input.ownBaseUrl,
        shared_secret: input.colocatedSecret(),
        serve_locally: true,
      },
    }
  }
  if (declaredOrigin.length === 0) {
    return {
      ok: false,
      detail: `${CORES_BROKER_SECRET_ENV} is set but ${CORES_BROKER_BASE_URL_ENV} is not`,
    }
  }
  if (declaredSecret.length === 0) {
    return {
      ok: false,
      detail: `${CORES_BROKER_BASE_URL_ENV} is set but ${CORES_BROKER_SECRET_ENV} is not`,
    }
  }
  let parsed: URL
  try {
    parsed = new URL(declaredOrigin)
  } catch {
    return { ok: false, detail: `${CORES_BROKER_BASE_URL_ENV} is not a URL` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, detail: `${CORES_BROKER_BASE_URL_ENV} must be an http(s) origin` }
  }
  return {
    ok: true,
    binding: {
      // Normalized to scheme + host exactly as `resolveConnectBaseUrlWithSource`
      // does, so a trailing slash or a stray path cannot end up doubled into the
      // redirect_uri the operator has to register on the OAuth client.
      origin: `${parsed.protocol}//${parsed.host}`,
      shared_secret: declaredSecret,
      serve_locally: false,
    },
  }
}
