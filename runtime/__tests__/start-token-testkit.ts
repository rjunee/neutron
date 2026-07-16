/**
 * Open-resident start-token TEST KIT (ISSUES #219, 2026-06-13).
 *
 * A faithful, dependency-light mirror of the Managed
 * `signup/start-token.ts` mint/verify/claim primitives, used ONLY by
 * Open-classified tests (gateway/http, gateway/wiring,
 * landing/) that drive the chat-bridge + landing auth-gate through their
 * `verifyStartToken` / `claimStartTokenJti` DI seams.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `signup/` is a Managed-classified directory: the Sprint-C carve
 * (`scripts/sprint-c/carve-open-tree.sh`) strips it from the public Open
 * tree, then runs `bun test` INSIDE that tree as a hard gate. The 11
 * Open-co-located tests that previously imported `signup/start-token.ts`
 * to mint a fixture token would `import`-fail there and abort the carve
 * (ISSUES #219). The production code under test already consumes the
 * verifier + JTI claimer through the PlatformAdapter / bridge-input DI
 * seams (`runtime/start-token-types.ts:VerifyStartTokenFn` /
 * `ClaimStartTokenJtiFn`) — nothing in the Open graph imports the Managed
 * verifier directly. So a test only needs a *self-consistent* mint/verify
 * pair to exercise the bridge: this kit supplies one.
 *
 * FAITHFULNESS
 * ────────────
 * The mint, verify, JTI-claim, and cryptographic-result logic below is a
 * line-for-line port of `signup/start-token.ts` (same EdDSA alg, same
 * `neutron-onboarding-start` audience, same dual `instance_slug` /
 * `project_slug` claim emission, same `StartTokenError` codes, same 15-min
 * TTL cap). Tokens this kit mints verify identically under the real
 * Managed `verifyStartToken`, and vice-versa — so the tests assert on the
 * exact same bridge behavior they did before. The canonical
 * implementation + its own dedicated coverage stay Managed-side
 * (`signup/__tests__/`); this kit is a *fixture* mirror, not a second
 * source of truth for the primitive's semantics.
 *
 * Pure: imports only `jose` + Open runtime structural types. No I/O.
 */

import { randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify, type KeyLike, type JWTPayload } from 'jose'
import type {
  ConsumedStartToken,
  ConsumedTokensStore,
  StartTokenSignupVia,
  VerifyStartTokenInput,
  ClaimStartTokenJtiFn,
  VerifyStartTokenFn,
} from '@neutronai/runtime/start-token-types.ts'
import { buildLocalPlatformAdapter } from '@neutronai/runtime/platform-adapter-local.ts'
import type {
  PlatformAdapter,
  PlatformInstanceInfo,
} from '@neutronai/runtime/platform-adapter.ts'

// Re-export the structural types + the in-memory claim store so tests can
// pull everything start-token-shaped from this one kit.
export { InMemoryConsumedTokens } from '@neutronai/runtime/consumed-tokens-in-memory.ts'
export type {
  ConsumedStartToken,
  ConsumedTokensStore,
  StartTokenSignupVia,
  VerifyStartTokenInput,
}

/** Locked TTL ceiling — mirrors signup/start-token.ts. */
export const START_TOKEN_TTL_SECONDS = 15 * 60
/** Locked audience claim — mirrors signup/start-token.ts. */
export const START_TOKEN_AUDIENCE = 'neutron-onboarding-start'

export type StartTokenErrorCode =
  | 'expired'
  | 'invalid_signature'
  | 'wrong_audience'
  | 'replay'
  | 'malformed'

export class StartTokenError extends Error {
  override readonly name = 'StartTokenError'
  constructor(
    readonly code: StartTokenErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface StartTokenSigningKey {
  kid: string
  privateKey: KeyLike
}

export interface StartTokenVerificationKey {
  kid: string
  publicKey: KeyLike
}

export interface IssueStartTokenInput {
  project_slug: string
  user_id: string
  signup_via: StartTokenSignupVia
  signing_key: StartTokenSigningKey
  /** Override TTL (seconds); defaults to 15 min. */
  ttl_seconds?: number
  /** Inject for test determinism. */
  now?: () => number
  jti?: string
}

export interface IssuedStartToken {
  token: string
  jti: string
  expires_at_ms: number
}

export async function issueStartToken(
  input: IssueStartTokenInput,
): Promise<IssuedStartToken> {
  const ttl = input.ttl_seconds ?? START_TOKEN_TTL_SECONDS
  if (ttl > START_TOKEN_TTL_SECONDS) {
    throw new StartTokenError(
      'malformed',
      `start-token TTL must be <= ${START_TOKEN_TTL_SECONDS}s, got ${ttl}`,
    )
  }
  const now = input.now ?? ((): number => Date.now())
  const iat_s = Math.floor(now() / 1000)
  const exp_s = iat_s + ttl
  const jti = input.jti ?? randomUUID()
  const token = await new SignJWT({
    // Dual-emit the slug claim (OSS-split C4-a § 2.3, SD3): `instance_slug`
    // is canonical, `project_slug` is the back-compat alias — both the same
    // value, mirroring signup/start-token.ts.
    instance_slug: input.project_slug,
    project_slug: input.project_slug,
    signup_via: input.signup_via,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: input.signing_key.kid })
    .setSubject(input.user_id)
    .setIssuedAt(iat_s)
    .setExpirationTime(exp_s)
    .setAudience([START_TOKEN_AUDIENCE])
    .setJti(jti)
    .sign(input.signing_key.privateKey)
  return { token, jti, expires_at_ms: exp_s * 1000 }
}

/**
 * Read the instance slug from a verified payload, accepting either the
 * canonical `instance_slug` claim or the legacy `project_slug` claim.
 * Returns '' when neither is present as a string.
 */
function readSlugClaim(payload: JWTPayload): string {
  if (
    typeof payload['instance_slug'] === 'string' &&
    payload['instance_slug'].length > 0
  ) {
    return payload['instance_slug']
  }
  if (typeof payload['project_slug'] === 'string') {
    return payload['project_slug']
  }
  return ''
}

export async function verifyStartToken(
  input: VerifyStartTokenInput,
): Promise<ConsumedStartToken> {
  const now = input.now ?? ((): number => Date.now())
  let parsed: {
    payload: JWTPayload
    protectedHeader: { alg?: string; kid?: string }
  }
  try {
    parsed = await jwtVerify(
      input.token,
      async (header) => {
        if (header.alg !== 'EdDSA') {
          throw new StartTokenError('malformed', `unexpected alg=${header.alg}`)
        }
        const kid = header.kid
        if (typeof kid !== 'string' || kid.length === 0) {
          throw new StartTokenError('malformed', 'header.kid required')
        }
        const key = await input.resolveKey(kid)
        if (key === null) {
          throw new StartTokenError('invalid_signature', `unknown kid=${kid}`)
        }
        return key
      },
      {
        audience: START_TOKEN_AUDIENCE,
        currentDate: new Date(now()),
      },
    )
  } catch (err) {
    if (err instanceof StartTokenError) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (/exp/.test(message) || /JWTExpired/i.test(err instanceof Error ? err.name : '')) {
      throw new StartTokenError('expired', message, err)
    }
    if (/audience/i.test(message)) {
      throw new StartTokenError('wrong_audience', message, err)
    }
    if (/signature/i.test(message)) {
      throw new StartTokenError('invalid_signature', message, err)
    }
    throw new StartTokenError('malformed', message, err)
  }
  const payload = parsed.payload
  const jti = typeof payload.jti === 'string' ? payload.jti : ''
  if (jti.length === 0) throw new StartTokenError('malformed', 'jti claim required')
  const slug = readSlugClaim(payload)
  if (slug.length === 0) {
    throw new StartTokenError(
      'malformed',
      'instance_slug (or legacy project_slug) claim required',
    )
  }
  const user_id = typeof payload.sub === 'string' ? payload.sub : ''
  if (user_id.length === 0) throw new StartTokenError('malformed', 'sub claim required')
  const signup_via_raw =
    typeof payload['signup_via'] === 'string' ? (payload['signup_via'] as string) : ''
  if (signup_via_raw !== 'telegram' && signup_via_raw !== 'web') {
    throw new StartTokenError(
      'malformed',
      `signup_via must be telegram|web; got ${signup_via_raw}`,
    )
  }
  const exp_s = typeof payload.exp === 'number' ? payload.exp : 0
  const expires_at_ms = exp_s * 1000
  return {
    instance_slug: slug,
    project_slug: slug,
    user_id,
    signup_via: signup_via_raw,
    jti,
    expires_at_ms,
  }
}

export async function claimStartTokenJti(input: {
  jti: string
  expires_at_ms: number
  consumedTokens: ConsumedTokensStore
}): Promise<void> {
  const claimed = await input.consumedTokens.claim(input.jti, input.expires_at_ms)
  if (!claimed) {
    throw new StartTokenError('replay', `start-token jti=${input.jti} already consumed`)
  }
}

export type VerifyStartTokenCryptographicReason =
  | 'empty-token'
  | 'expired'
  | 'invalid-signature'
  | 'wrong-audience'
  | 'malformed'

export type VerifyStartTokenCryptographicResult =
  | { ok: true; claims: ConsumedStartToken }
  | { ok: false; reason: VerifyStartTokenCryptographicReason }

export async function verifyStartTokenCryptographic(
  input: VerifyStartTokenInput,
): Promise<VerifyStartTokenCryptographicResult> {
  if (typeof input.token !== 'string' || input.token.length === 0) {
    return { ok: false, reason: 'empty-token' }
  }
  try {
    const verifyArgs: VerifyStartTokenInput = {
      token: input.token,
      resolveKey: input.resolveKey,
    }
    if (input.now !== undefined) verifyArgs.now = input.now
    const claims = await verifyStartToken(verifyArgs)
    return { ok: true, claims }
  } catch (err) {
    if (err instanceof StartTokenError) {
      switch (err.code) {
        case 'expired':
          return { ok: false, reason: 'expired' }
        case 'invalid_signature':
          return { ok: false, reason: 'invalid-signature' }
        case 'wrong_audience':
          return { ok: false, reason: 'wrong-audience' }
        case 'malformed':
          return { ok: false, reason: 'malformed' }
        case 'replay':
          return { ok: false, reason: 'malformed' }
      }
    }
    return { ok: false, reason: 'malformed' }
  }
}

/**
 * Default sentinel instance for the test platform. Single-instance Open
 * shape — the start-token WS-upgrade tests never resolve an instance off
 * the adapter (they assert on the bridge's auth path + slug-history
 * shim), so the concrete identity here is immaterial.
 */
const TESTKIT_SELF_OWNER: PlatformInstanceInfo = {
  owner_handle: 't-start-token-testkit-0001',
  url_slug: 'testkit',
  owner_home: '/tmp/neutron-start-token-testkit',
  agent_name: null,
  tier: 'open',
  kind: 'user',
}

/**
 * Build a `PlatformAdapter` whose `verifyStartToken` / `claimStartTokenJti`
 * seams are wired — the Open test analogue of the production Managed
 * composer's `buildManagedPlatformAdapter({ verifyStartToken,
 * claimStartTokenJti, ... })`. The landing stack / chat-bridge reach the
 * start-token auth path purely through the PRESENCE of these two methods
 * (`input.platform.verifyStartToken` / `.claimStartTokenJti`), so a Local
 * adapter base with the pair grafted on drives the exact same code path
 * the real composer does, without importing the Managed shim.
 *
 * Pass the testkit's own `verifyStartToken` / `claimStartTokenJti` (or
 * any caller-supplied pair) — the same self-consistent mint/verify pair
 * the rest of this kit produces.
 */
export function buildStartTokenTestPlatform(input: {
  verifyStartToken: VerifyStartTokenFn
  claimStartTokenJti: ClaimStartTokenJtiFn
  selfOwner?: PlatformInstanceInfo
}): PlatformAdapter {
  const base = buildLocalPlatformAdapter({
    selfOwner: input.selfOwner ?? TESTKIT_SELF_OWNER,
  })
  return {
    ...base,
    capabilities: { ...base.capabilities, start_token_verify: true },
    verifyStartToken: input.verifyStartToken,
    claimStartTokenJti: input.claimStartTokenJti,
  }
}
