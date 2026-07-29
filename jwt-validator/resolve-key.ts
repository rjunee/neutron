import { importJWK, type JWK, type KeyLike } from 'jose'
import type { JwksCache } from './validator.ts'

/**
 * Adapt `JwksCache` into the `(kid: string) => Promise<KeyLike | null>`
 * shape that `signup/start-token.ts:verifyStartToken` consumes via
 * `gateway/http/chat-bridge.ts:buildWebChatBridge`.
 *
 * Strict guards (defense-in-depth — the deeper verifier in
 * `jwt-validator/validator.ts:183` also pins `algorithms: ['EdDSA']`,
 * but the Sprint 19 plan calls for refusing as early as possible):
 *
 *   - `kid` not in JWKS → null
 *   - `jwk.alg` set and not `'EdDSA'` → null (algorithm-confusion guard)
 *   - `jwk.kty !== 'OKP'` or `jwk.crv !== 'Ed25519'` → null (curve guard)
 *   - `importJWK` returned a `Uint8Array` (symmetric key — never an
 *     EdDSA pubkey) → null
 *
 * Returns the imported asymmetric `KeyLike` on success.
 */
export function buildJwksResolveKey(
  jwks: JwksCache,
): (kid: string) => Promise<KeyLike | null> {
  return async (kid: string): Promise<KeyLike | null> => {
    const set = await jwks.get()
    const jwk = set.keys.find((k) => k.kid === kid) as JWK | undefined
    if (jwk === undefined) return null
    if (jwk.alg !== undefined && jwk.alg !== 'EdDSA') return null
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null
    const key = await importJWK(jwk, 'EdDSA')
    // Runtime narrow: `importJWK` may return `Uint8Array` for symmetric
    // material; an EdDSA pubkey is always asymmetric (`KeyLike`). Refuse
    // here instead of unsafe-casting.
    if (key instanceof Uint8Array) return null
    return key
  }
}
