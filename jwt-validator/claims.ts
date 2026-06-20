import { z } from 'zod'

/**
 * Locked JWT claim shape per `docs/engineering-plan.md` § A.3.4 + § E.1
 * (`identity/jwt/issuer.ts`).
 *
 * Multi-aud — every Neutron token carries `aud: ['neutron']`. Per-instance
 * gateways validate locally with the cached JWKS pubkey; they do NOT phone
 * home to the auth service per request. The `memberships[]` array names
 * every project the user is a member of (the owner's project trivially names
 * the owner; workspace projects the user has joined contribute one entry each
 * with the user's role on that workspace).
 *
 * `kid` is in the JWT header (per RFC 7515 §4.1.4), not in the payload — but
 * we mirror the active key id as the issuer's chosen `kid` header at sign
 * time. Validators read `kid` from the protected header and look it up in
 * the cached JWKS; the validator does NOT trust unsigned header claims.
 */
export const MembershipKindSchema = z.enum(['user', 'workspace'])
export type MembershipKind = z.infer<typeof MembershipKindSchema>

export const MembershipRoleSchema = z.enum(['owner', 'admin', 'member'])
export type MembershipRole = z.infer<typeof MembershipRoleSchema>

export const MembershipSchema = z.object({
  slug: z.string().min(1),
  role: MembershipRoleSchema,
  kind: MembershipKindSchema,
})
export type Membership = z.infer<typeof MembershipSchema>

/**
 * `aud` is normalised to an array of strings on this side, but RFC 7519 §4.1.3
 * permits `aud` as either a single string OR an array of strings, and jose's
 * `SignJWT.setAudience(value)` serialises a single-element call as a bare
 * string. Accept both shapes on parse so a token issued with one audience
 * round-trips cleanly while still surfacing as a normalised array to callers.
 * `iat` and `exp` are seconds-since-epoch (RFC 7519). `sub` is the
 * platform-stable user id (uuid) — the user's identity across instances.
 */
const AudienceSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).nonempty()])
  .transform<string[]>((v) => (Array.isArray(v) ? [...v] : [v]))

export const ClaimsSchema = z.object({
  sub: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  aud: AudienceSchema,
  memberships: z.array(MembershipSchema),
})
export type Claims = z.infer<typeof ClaimsSchema>

export const NEUTRON_AUDIENCE = 'neutron'
