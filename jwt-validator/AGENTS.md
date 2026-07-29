# AGENTS.md — jwt-validator

This module is the published-as-npm package every per-instance gateway depends on for local-only Neutron JWT validation. It owns the locked claims shape (`Claims` Zod schema), the EdDSA-over-JWKS verification entry point (`validateJwt`), and the in-process JWKS cache (`JwksCache` / `loadJwks`).

## Surface (P1 S2)

- `claims.ts` — `Claims`, `Membership`, `NEUTRON_AUDIENCE`. Locked per `docs/engineering-plan.md` § A.3.4 + § E.1.
- `validator.ts` — `validateJwt(token, jwks, options)` + `loadJwks(url, options)` + `JwksCache`. EdDSA-only; multi-aud `'neutron'` by default.
- `index.ts` — public barrel.

## What this module is NOT

- NOT the issuer (`identity/jwt.ts` owns signing).
- NOT the JWKS server (`identity/keys.ts` + `identity/service.ts` own publication).
- NOT a refresh-token validator (refresh tokens are opaque; only access tokens are JWTs).
- NOT a callback path back to the auth service. **This is the architectural lock.** Per `docs/engineering-plan.md` § A.3.4, per-instance validators MUST NOT phone home per request — the entire single-point-of-failure mitigation depends on it. `tests/integration/jwt-no-roundtrip.test.ts` verifies the contract by tracking every fetch call after the JWKS is cached.

## Locked decisions

- **Algorithm: EdDSA (ed25519).** No alg-confusion fallback. The validator passes `algorithms: ['EdDSA']` to `jose.jwtVerify` so a token presenting any other `alg` (incl. `none`) is rejected before signature check.
- **Audience: `'neutron'`.** Multi-aud per § A.3.4; `aud` is an array, jose's `jwtVerify` does set-membership matching.
- **TTL: 1h JWKS cache by default.** Matches the per-instance pubkey-distribute cadence in § 2.3 of the identity plan.
- **Clock tolerance: 0s by default.** Callers can opt in to skew tolerance via `options.clockToleranceSec` for distributed-clock environments.

## Cross-refs

- `docs/engineering-plan.md` § A.3.4 — identity service architecture
- `docs/engineering-plan.md` § A.3.4 + § E.1 — identity service module breakdown
- `identity/AGENTS.md` — issuer side of the contract
