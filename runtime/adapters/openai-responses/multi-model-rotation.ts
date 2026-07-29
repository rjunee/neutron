/**
 * @neutronai/runtime — GPT-5.5 Responses API: adapter-internal multi-model rotation.
 *
 * Adapter-side rotation per `engineering-plan.md` line 436: the dispatcher
 * does NOT pick the model. Each adapter owns its own rotation policy keyed on
 * `AgentSpec.model_preference: string[]` and the `error.retryable` /
 * `retry_after_ms` hints upstream provides.
 *
 * Policy:
 *
 *   - Try `model_preference[0]` first.
 *   - On retryable error (`error.retryable === true`), advance to the next
 *     model in `model_preference`. If `retry_after_ms` is set, callers use
 *     it as their next-attempt delay (we do not sleep here — the policy is
 *     stateless and deterministic; the adapter that owns the loop sleeps).
 *   - On non-retryable error, surface the error and stop.
 *   - On exhaustion (rotation past the end of `model_preference`), surface
 *     a final `error` event indicating the rotation cap was hit.
 *
 * The function is pure — it returns the next state for the caller to act on,
 * which keeps the rotation logic unit-testable without spinning up a fetch.
 */

export interface RotationState {
  preference: ReadonlyArray<string>
  attempt_idx: number
}

export type RotationDecision =
  | { decision: 'use'; model: string; attempt_idx: number }
  | { decision: 'rotate'; model: string; attempt_idx: number; delay_ms?: number }
  | { decision: 'exhausted'; reason: string }

export function newRotationState(preference: ReadonlyArray<string>): RotationState {
  return { preference, attempt_idx: 0 }
}

/** Return the model to use right now, without advancing. */
export function currentModel(state: RotationState): RotationDecision {
  const model = state.preference[state.attempt_idx]
  if (model === undefined) {
    return {
      decision: 'exhausted',
      reason: `no models left in preference list (attempted ${state.attempt_idx} / ${state.preference.length})`,
    }
  }
  return { decision: 'use', model, attempt_idx: state.attempt_idx }
}

/**
 * Advance to the next model after a retryable error. Returns the next
 * decision; mutates `state.attempt_idx`.
 */
export function rotate(state: RotationState, retry_after_ms?: number): RotationDecision {
  state.attempt_idx++
  const model = state.preference[state.attempt_idx]
  if (model === undefined) {
    return {
      decision: 'exhausted',
      reason: `model_preference exhausted after ${state.attempt_idx} attempts`,
    }
  }
  const out: RotationDecision = { decision: 'rotate', model, attempt_idx: state.attempt_idx }
  if (retry_after_ms !== undefined) (out as { delay_ms?: number }).delay_ms = retry_after_ms
  return out
}
