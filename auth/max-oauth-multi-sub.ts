/**
 * @neutronai/auth — multi-sub Anthropic Claude Max OAuth client. STUB.
 *
 * STATUS: NOT_IMPLEMENTED. Sprint-1's research spike on Anthropic Max
 * OAuth multi-sub semantics has NOT landed. Per docs/plans/P2-onboarding.md
 * § 2.4 (Locked 2026-04-29 fallback), Sprint-4 ships this stub instead of a
 * real client; the real implementation becomes a follow-up sprint after the
 * research lands.
 *
 * Why a stub instead of skipping the file: every wiring path that *would*
 * call multi-sub (rotator on credential-pool exhaustion, onboarding's "add
 * a second sub" UI flow) needs an unmistakable, typed signal that this
 * code is not yet available. A throw-on-call stub makes that signal
 * impossible to ignore at runtime — silent fallthroughs to a non-existent
 * surface produce far worse failure modes than an obvious typed error.
 *
 * What lands instead at M2 — single-sub Max OAuth (`auth/max-oauth.ts`,
 * shipped in P2 S1) plus the BYO-API-key fallback (`auth/byo-api-key-
 * fallback.ts`, shipped in P1.5). Multi-sub is a Sam-power-user feature,
 * NOT an Casey (M2) blocker — deferring it does not block the M2 cohort.
 *
 * The follow-up sprint (post-research) replaces every `throw new
 * MultiSubNotImplementedError(...)` with a real implementation that
 * registers, rotates, and revokes Max OAuth subs against the
 * `runtime/credential-pool.ts` rotation surface.
 *
 * ORPHAN-IN-OPEN BY DESIGN: this stub's only consumer is the Managed
 * multi-sub rotator (carved into the private tree). `dependency-cruiser`
 * therefore flags it as a zero-importer orphan on an Open-only graph — that
 * is EXPECTED, not dead code. Do NOT delete it in an Open dead-code sweep:
 * it ships in Open so the Managed rotator has the typed stub + error surface
 * to import. See the open-refactor audit (2026-06-15) P3-11.
 */

export type MultiSubMethod =
  | 'addSub'
  | 'removeSub'
  | 'rotateOnExhaustion'
  | 'listAttachedSubs'
  | 'getActiveSub'

/**
 * Thrown by every method on `MultiSubOAuthClient`. The `reason` field
 * carries the locked rationale verbatim so callers (and humans reading
 * stack traces) understand why the surface is unreachable.
 */
export class MultiSubNotImplementedError extends Error {
  override readonly name = 'MultiSubNotImplementedError'
  readonly reason: string
  readonly method: MultiSubMethod

  constructor(method: MultiSubMethod) {
    const reason =
      'Sprint-1 research spike on Anthropic Max OAuth multi-sub semantics has not landed; ' +
      'per docs/plans/P2-onboarding.md § 2.4 (Locked 2026-04-29 fallback), Sprint-4 ships ' +
      'NOT_IMPLEMENTED stubs while the M2 path uses single-sub Max OAuth + BYO-API-key fallback.'
    super(`MultiSubOAuthClient.${method}() is not yet implemented. ${reason}`)
    this.method = method
    this.reason = reason
  }
}

export interface AddSubInput {
  instance_slug: string
  sub_label: string
  return_url: string
}

export interface AddSubResult {
  authorize_url: string
  state: string
  pkce_verifier: string
  expires_at: number
}

export interface AttachedSub {
  sub_label: string
  added_at: number
  rotated_at: number | null
  expires_at: number | null
  scopes: string[]
}

export interface MultiSubOAuthClientDeps {
  // Intentionally empty — the real client will take a SecretsStore +
  // CredentialPool here. Keeping the constructor signature non-empty
  // would lock callers to a shape that may shift after the research
  // lands.
  readonly _stub: true
}

/**
 * Multi-sub Anthropic Max OAuth client. Every method throws
 * `MultiSubNotImplementedError`. See module-level docstring for the
 * deferral rationale.
 */
export class MultiSubOAuthClient {
  // Field is `readonly` so the type system stays honest about the stub
  // shape; the value itself is never inspected.
  private readonly _deps: MultiSubOAuthClientDeps

  constructor(deps: MultiSubOAuthClientDeps = { _stub: true }) {
    this._deps = deps
  }

  /** Returns the rationale string so callers can surface it to logs/UX. */
  static reason(): string {
    return new MultiSubNotImplementedError('addSub').reason
  }

  async addSub(_input: AddSubInput): Promise<AddSubResult> {
    void this._deps
    throw new MultiSubNotImplementedError('addSub')
  }

  async removeSub(_input: { instance_slug: string; sub_label: string }): Promise<void> {
    throw new MultiSubNotImplementedError('removeSub')
  }

  async rotateOnExhaustion(_input: { instance_slug: string; current_sub_label: string }): Promise<{ next_sub_label: string }> {
    throw new MultiSubNotImplementedError('rotateOnExhaustion')
  }

  async listAttachedSubs(_input: { instance_slug: string }): Promise<AttachedSub[]> {
    throw new MultiSubNotImplementedError('listAttachedSubs')
  }

  async getActiveSub(_input: { instance_slug: string }): Promise<{ sub_label: string } | null> {
    throw new MultiSubNotImplementedError('getActiveSub')
  }
}
