/**
 * @neutronai/onboarding/profile-pic — Gemini Imagen 4 client wrapper.
 *
 * Per docs/plans/P2-onboarding.md § 2.7 (Locked 2026-04-29). Wraps the
 * Gemini Imagen 4 API (Nano Banana Pro variant) so the rest of the
 * pipeline can speak in candidate-PNG terms instead of HTTP/JSON. The
 * production client is a thin `fetch` over the Gemini REST surface; the
 * test seam takes a `GeminiImagenFn` so unit tests inject deterministic
 * success/failure sequences without hitting the network.
 *
 * The pipeline (pipeline.ts) is the consumer — it calls `generate(...)`
 * up to `failureBudget` (default 3) times before falling back to the
 * curated 12-PNG gallery (fallback-gallery.ts).
 *
 * Cost control: each call is metered into `runtime/credential-pool.ts`
 * via the optional `onCostReport` hook so the per-instance budget cap
 * accounting stays honest. The integration tests mock this end to end.
 */

export type GeminiImagenErrorCode =
  | 'auth_failed'
  | 'rate_limited'
  | 'safety_blocked'
  | 'transport_error'
  | 'malformed_response'
  | 'empty_image'

export class GeminiImagenError extends Error {
  override readonly name = 'GeminiImagenError'
  constructor(
    readonly code: GeminiImagenErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/**
 * One generated image candidate. The wrapper returns raw PNG bytes; the
 * pipeline writes them to `<owner_home>/persona/profile-pic-candidates/`.
 */
export interface GeminiImageCandidate {
  /** Stable id; defaults to a UUID. The pipeline uses this as the on-disk filename. */
  candidate_id: string
  /** Raw PNG bytes. */
  bytes: Buffer
  /** Width × height (pixels). Convenience for downstream consumers; not validated. */
  width: number
  height: number
  /** What the model emitted as a one-line caption, if any. Optional. */
  caption?: string
}

export interface GeminiImagenInput {
  /** The composed text prompt — typically derived from the chosen archetype + interview signals. */
  prompt: string
  /** How many candidate images to request in this single call. Defaults to 1. */
  count?: number
  /** Optional aspect-ratio hint passed verbatim to the model. */
  aspect_ratio?: '1:1' | '4:5' | '3:4' | '16:9'
  /** Negative-prompt hint (avoid X). Optional. */
  negative_prompt?: string
}

export interface GeminiImagenOutput {
  candidates: GeminiImageCandidate[]
  /** Reported dollars for this call (best-effort; 0 when the upstream doesn't itemize). */
  dollars_billed: number
}

/**
 * The DI seam. Production wires this to a `fetch` against the Gemini
 * REST endpoint; tests inject a deterministic mock returning success /
 * failure sequences. Throws `GeminiImagenError` on non-recoverable
 * issues; the pipeline catches and decrements the failure budget.
 */
export type GeminiImagenFn = (input: GeminiImagenInput) => Promise<GeminiImagenOutput>

export interface GeminiImagenClientDeps {
  generate: GeminiImagenFn
  /** Optional cost-reporter hook. Pipeline forwards per-call billed dollars + candidate count for telemetry. */
  onCostReport?: (input: { dollars: number; candidates: number }) => void
}

/**
 * Thin wrapper. Non-trivial logic lives in the pipeline; this class
 * exists so the production wiring can keep one HTTP client per process
 * (per Gemini's connection-keepalive recommendation) while the
 * pipeline consumes a stable interface.
 */
export class GeminiImagenClient {
  private readonly fn: GeminiImagenFn
  private readonly onCostReport?: (input: { dollars: number; candidates: number }) => void

  constructor(deps: GeminiImagenClientDeps) {
    this.fn = deps.generate
    if (deps.onCostReport !== undefined) this.onCostReport = deps.onCostReport
  }

  async generate(input: GeminiImagenInput): Promise<GeminiImagenOutput> {
    const out = await this.fn(input)
    if (out.candidates.length === 0) {
      throw new GeminiImagenError(
        'empty_image',
        `Gemini returned 0 candidates for prompt of length ${input.prompt.length}`,
      )
    }
    if (this.onCostReport !== undefined) {
      this.onCostReport({
        dollars: out.dollars_billed,
        candidates: out.candidates.length,
      })
    }
    return out
  }
}
