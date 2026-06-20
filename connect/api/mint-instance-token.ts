/**
 * Outbound cross-instance token minter (M2.3).
 *
 * The complement to `jwt-bearer-middleware.ts`: that module VERIFIES an
 * inbound token whose `aud` is `connect.<receiving_slug>`; this module
 * SIGNS one. A member instance's gateway calls this when it fans out to a
 * receiving instance's Connect API (e.g. the unified-project-list aggregator) so the call
 * authenticates as the logged-in user speaking for their own instance
 * origin.
 *
 * Mirrors `identity/jwt.ts:issueAccessToken` exactly EXCEPT the audience:
 *   - access tokens    → `aud = ['neutron']`             (global)
 *   - cross-instance   → `aud = ['connect.<slug>']` (one receiving instance)
 *
 * The `memberships` claim carries the SAME array the access token does —
 * the receiving instance's middleware reads the origin header and asserts it
 * is one of these memberships before resolving the origin. The caller's own
 * instance slug (the `kind='user'` membership) MUST be present or the
 * receiving middleware rejects the declared origin with `origin_not_a_member`.
 *
 * The signing key is an INJECTED `getActiveKey` thunk — this module has no
 * opinion about which authority backs it. On the hosted relay that thunk is
 * fed by the identity service's `KeyManager`; on the Connect guest path the
 * node mints with its OWN key (see guest-auth-handler.ts — the connect node
 * is the sole authority for guest bearers). Taking a thunk rather than
 * importing a key manager keeps this module off any static dependency edge
 * into `identity/` and trivially unit-testable with a fixture key.
 */

import { SignJWT } from 'jose'
import type { Membership } from '../../jwt-validator/index.ts'

/** Default 5-minute TTL — long enough for a fan-out round-trip + retry,
 *  short enough that a leaked token is useless quickly. Cross-instance tokens
 *  are minted on demand per request, not cached, so a short TTL costs
 *  nothing. */
export const CROSS_INSTANCE_TOKEN_TTL_SECONDS = 5 * 60

/** Private-key material accepted by `jose`'s `SignJWT.sign`. Derived
 *  structurally so we don't have to import `identity/keys.ts`'s
 *  `SigningKeyMaterial` type and pull that module onto our static edge. */
type SignKey = Parameters<InstanceType<typeof SignJWT>['sign']>[0]

export interface CrossInstanceActiveKey {
  kid: string
  privateKey: SignKey
}

export interface MintInstanceTokenInput {
  /** Returns the identity service's current active EdDSA signing key. */
  getActiveKey: () => Promise<CrossInstanceActiveKey>
  /** Platform user id — becomes the JWT `sub`. */
  userId: string
  /** The user's full memberships array. MUST include the caller's own
   *  instance slug declared via the origin header. */
  memberships: ReadonlyArray<Membership>
  /** Slug of the workspace instance being called. Sets
   *  `aud = ['connect.<targetInstanceSlug>']`. */
  targetInstanceSlug: string
  /** Wall clock in ms (injectable for tests). */
  now: number
  /** Override the TTL (tests). */
  ttlSeconds?: number
}

export interface MintInstanceTokenResult {
  token: string
  kid: string
  /** The audience string baked in — `connect.<slug>`. */
  audience: string
}

/**
 * Sign a cross-instance bearer token authorized for exactly one receiving
 * workspace instance. Throws only if the underlying `getActiveKey()` /
 * `sign()` throws (no active key, bad key material); callers in the
 * aggregator path catch and degrade to "this workspace unavailable".
 */
export async function mintInstanceToken(
  input: MintInstanceTokenInput,
): Promise<MintInstanceTokenResult> {
  const active = await input.getActiveKey()
  const iat = Math.floor(input.now / 1_000)
  const exp = iat + (input.ttlSeconds ?? CROSS_INSTANCE_TOKEN_TTL_SECONDS)
  const audience = `connect.${input.targetInstanceSlug}`
  // Copy the memberships so a caller mutating the source array after the
  // mint can't retroactively change what was signed.
  const memberships: Membership[] = input.memberships.map((m) => ({ ...m }))
  const token = await new SignJWT({ memberships })
    .setProtectedHeader({ alg: 'EdDSA', kid: active.kid })
    .setSubject(input.userId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience([audience])
    .sign(active.privateKey)
  return { token, kid: active.kid, audience }
}
