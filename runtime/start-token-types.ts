/**
 * @neutronai/runtime — start-token structural types (Sprint B, 2026-05-20).
 *
 * The JWT-shape + JTI-grammar surface for the Managed `signup/start-token.ts`
 * primitive. Lifted out of `signup/` so core modules (chat-bridge,
 * landing-stack, platform adapter) can consume the structural types
 * WITHOUT importing the Managed signup tree.
 *
 *   - `ConsumedTokensStore` — the atomic one-time-use claim contract.
 *     The in-memory variant lives at
 *     `runtime/consumed-tokens-in-memory.ts`; the production SQLite
 *     variant stays Managed (`signup/consumed-tokens-sqlite.ts`).
 *
 *   - `ConsumedStartToken` — the verified payload shape Managed's
 *     `verifyStartToken` returns. Core callers see the same flat shape
 *     so they can branch on `signup_via` / `project_slug` etc. without
 *     pulling the verifier itself into the Open import graph.
 *
 *   - `VerifyStartTokenFn` / `ClaimStartTokenJtiFn` — DI-shaped function
 *     types that adapter wiring + chat-bridge accept. Managed boot
 *     supplies the existing `signup/start-token.ts` implementations;
 *     Open boot supplies `undefined` (the recover/start-token landing
 *     handoff is Managed-only).
 *
 * No I/O, no imports outside `jose`. This file is pure structural.
 */

import type { KeyLike } from 'jose'

/** Start-token signup origin tag — locked to the two supported flows. */
export type StartTokenSignupVia = 'telegram' | 'web'

/**
 * Atomic one-time-use claim contract for start-token JTIs.
 *
 * Implementations MUST be safe under concurrent claim() — the in-memory
 * variant uses a single Map.set check; SQLite-backed variants MUST use
 * `INSERT ... ON CONFLICT` or a transaction with `SELECT ... FOR UPDATE`
 * so two near-simultaneous claims never both return true. Replaces the
 * prior has()+mark() shape that allowed a race between the two await
 * points (Codex r1 P2 finding on PR #45).
 */
export interface ConsumedTokensStore {
  /**
   * Returns true when the caller is the first claimant; false when
   * the jti was already marked.
   */
  claim(jti: string, expires_at_ms: number): Promise<boolean>
}

/** The verified payload shape — what `verifyStartToken` returns on success. */
export interface ConsumedStartToken {
  /**
   * The instance/process-identity slug carried by the start-token.
   *
   * OSS-split big-sweep A3 (§ 5 R4): the start-token WIRE now carries a single
   * `instance_slug` claim — the legacy duplicate slug claim emit + accept were
   * ripped under the no-back-compat mandate (see `signup/start-token.ts`).
   * Managed identity validation must track this claim rename in lock-step (T-M).
   */
  instance_slug: string
  /**
   * Project-scope store-mirror slug — the routing key consumers read. Mirrors
   * {@link instance_slug} (the same value in single-instance flows). This is a
   * TS-SYMBOL field, NOT a wire claim. OSS-split big-sweep C4-b renamed this
   * field and migrated the ~40 consumer call sites off the legacy store-mirror
   * symbol to `.project_slug`.
   */
  project_slug: string
  user_id: string
  signup_via: StartTokenSignupVia
  jti: string
  expires_at_ms: number
}

/** Input shape for the verify call — the verifier needs the token bytes,
 *  a JWKS-style key resolver, and an optional now() for test determinism. */
export interface VerifyStartTokenInput {
  token: string
  resolveKey: (kid: string) => Promise<KeyLike | null>
  now?: () => number
}

/** DI-shaped verifier. Managed binds to `signup/start-token.ts:verifyStartToken`. */
export type VerifyStartTokenFn = (
  input: VerifyStartTokenInput,
) => Promise<ConsumedStartToken>

/** Input shape for the atomic claim call. */
export interface ClaimStartTokenJtiInput {
  jti: string
  expires_at_ms: number
  consumedTokens: ConsumedTokensStore
}

/** DI-shaped claimer. Managed binds to `signup/start-token.ts:claimStartTokenJti`. */
export type ClaimStartTokenJtiFn = (input: ClaimStartTokenJtiInput) => Promise<void>
