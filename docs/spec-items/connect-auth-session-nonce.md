---
title: Bind connect callbacks to the initiating login session
group: security
status: open
priority: P1
cutover: false
legacy_ref: "#621"
---

## Contract

The connect-auth surface must verify a nonce before redeeming any callback code.
The nonce is generated at start, bound to the verified initiating login session,
expires after ten minutes, and permits at most one redemption attempt. Different
sessions belonging to the same user must remain distinct.

Verification has three outcomes: verified, failed verification (missing or wrong
nonce on an available attempt), and could not verify (no verified session, no
pending attempt, expiry, or prior use). Both refusals retain the existing
`connect=error` redirect vocabulary; session authentication failures retain HTTP
401 `unauthorized`. Logs distinguish the outcome and reason without recording
codes, nonces, or session identifiers.

## Acceptance

- A legitimate start/callback round trip redeems exactly once.
- Missing state and another session's state cannot redeem, including when both
  sessions belong to the same user and have pending attempts.
- Replay and concurrent duplicate callbacks cannot redeem twice.
- Expired attempts and missing session context refuse with a reason distinct
  from a wrong nonce.
- Verification checks run before redemption, and consumption precedes its await.
- Each guard has a mutation control that fails when the guard is broken and
  passes when restored. Verify with `gateway/http/app-connect-auth-nonce.test.ts`.
- Production Open boot must construct the surface with a verified session ID and
  identity-service configuration; a test that injects its own surface does not
  satisfy this criterion.

## Delivery boundary

The callback security portion can ship before composition, as authorized for
this issue. Production composition remains open. Open's current resolver returns
owner and user identity only (`open/composer.ts:2031`); its cookie signer encodes
slug and expiry (`landing/session-cookie.ts:56`). A future composer must not
substitute user identity for a distinct, verified login-session ID.
