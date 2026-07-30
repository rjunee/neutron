/**
 * ISSUES #415 — the server-side ONE-SHOT CLAIM for a button tap.
 *
 * A `button_choice` used to be un-gated end to end. The app-ws surface decoded
 * `prompt_id` and discarded it, nothing marked the prompt answered server-side,
 * and the only re-tap guard was a session-scoped `chosenByPrompt` React state
 * whose own comment assumed the server did the marking. It did not. Combined
 * with the ten-year TTL every reply row carries, that meant a Retry button
 * survived forever and any remount resurrected a LIVE one: a tap silently ran
 * the agent again, and left no trace explaining the second answer (or, in the
 * reported case, the second identical "that one took too long" bubble).
 *
 * This is the `button_choice` twin of the typed path's `was_new` gate.
 * `ButtonStore.resolve` is idempotent on `prompt_id`, so its `was_new` IS the
 * authority on "is this the first tap": the surface dispatches on true and
 * drops the tap on false. Storage idempotency alone does not make the surface
 * idempotent — this gate does.
 *
 * It also gives the tap the durable TRACE it never had: the resolution stamped
 * on the row renders as the owner's turn in chat history and splices into the
 * next prompt, so a second failure bubble is explained by the tap above it
 * rather than reading as a duplicate.
 *
 * Extracted from the Open wiring so the regression suite exercises THIS
 * function rather than a hand-written lookalike.
 */
import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import { ButtonStoreError } from '@neutronai/channels/button-store.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('button-prompt-claim')

export interface ButtonPromptClaimInput {
  user_id: string
  project_slug: string
  prompt_id: string
  choice_value: string
  freeform_text?: string
  observed_at: number
}

export function buildButtonPromptClaim(deps: {
  buttonStore: ButtonStore
}): (input: ButtonPromptClaimInput) => Promise<boolean> {
  return async function claimButtonPrompt(input: ButtonPromptClaimInput): Promise<boolean> {
    // The trace must read as the owner's words, not the routing token. A Retry
    // tap resolves to the opaque `__retry_turn__`, which would render verbatim
    // in history AND splice into the next prompt as "User: __retry_turn__".
    // Prefer the client's freeform, else the tapped option's human body
    // ("Retry"). Cosmetic — a failed lookup never blocks the claim.
    let trace = input.freeform_text
    if (trace === undefined || trace.length === 0) {
      try {
        const prompt = await deps.buttonStore.get(input.prompt_id, input.observed_at)
        const opt = prompt?.options.find((o) => o.value === input.choice_value)
        if (opt !== undefined) trace = opt.body
      } catch {
        /* best-effort label lookup */
      }
    }
    try {
      const { was_new } = await deps.buttonStore.resolve({
        choice: {
          prompt_id: input.prompt_id,
          choice_value: input.choice_value,
          chosen_at: input.observed_at,
          speaker_user_id: input.user_id,
          channel_kind: 'app_socket',
          ...(trace !== undefined && trace.length > 0 ? { freeform_text: trace } : {}),
        },
      })
      if (!was_new) {
        moduleLog.info('button_choice_replay_skipped', {
          project: input.project_slug,
          prompt_id: input.prompt_id,
        })
      }
      return was_new
    } catch (err) {
      if (err instanceof ButtonStoreError) {
        // No row to gate on — a prompt this store never persisted (the emit
        // failed and the envelope shipped buttonless) or a client-minted id.
        // There is nothing to double-dispatch AGAINST, so let it through
        // rather than swallow a legitimate first tap.
        if (err.code === 'prompt_not_found') return true
        // A dead affordance must not act: `expires_at` passed with no answer,
        // so this tap is on a button that is no longer live.
        if (err.code === 'expired') {
          moduleLog.info('button_choice_expired_skipped', {
            project: input.project_slug,
            prompt_id: input.prompt_id,
          })
          return false
        }
      }
      throw err
    }
  }
}
