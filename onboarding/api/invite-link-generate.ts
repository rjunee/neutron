/**
 * @neutronai/onboarding/api — invite-token re-export shim.
 *
 * L3 (2026-07) — the invite-token mint / verify / claim implementation moved to
 * the `connect` package (`connect/invite-token.ts`) so the trusted-accept path
 * no longer imports UP into `onboarding`. This shim re-exports every symbol
 * from the new location so existing import specifiers (the gateway HTTP invite
 * routes + tests) stay valid (test-policy §2.2 barrel rule). `onboarding` (a
 * product-band surface) importing `connect` (a service) is a legal DOWN edge.
 * The L5 import-rewrite sweep will repoint the remaining importers and delete
 * this shim.
 */

export {
  INVITE_TOKEN_TTL_SECONDS,
  INVITE_TOKEN_AUDIENCE,
  InviteTokenError,
  hashInviteeEmail,
  issueInviteToken,
  verifyInviteToken,
  claimInviteToken,
} from '../../connect/invite-token.ts'
export type {
  InviteTokenErrorCode,
  InviteSigningKey,
  IssueInviteTokenInput,
  IssuedInviteToken,
  InviteTokenClaims,
  VerifyInviteTokenInput,
} from '../../connect/invite-token.ts'
