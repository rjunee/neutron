/**
 * @neutronai/open — retire the button prompt of a host-deploy grant the sweep
 * just expired.
 *
 * WHY THIS EXISTS. A host-deploy grant dies after `HOST_DEPLOY_APPROVAL_TTL_MS`;
 * the `button_prompts` row it was rendered as does NOT — its `expires_at` is a
 * decade out (the reply-row TTL), which is why the owner was left looking at an
 * Approve button that was still drawn, still tappable, and connected to nothing.
 * Expiring the grant alone fixes the state and none of the picture.
 *
 * WHAT IT DOES, and why in this exact order:
 *
 *  1. `ButtonStore.resolve()` with the `__timeout__` sentinel,
 *     {@link SYSTEM_SPEAKER_USER_ID} and `channel_kind:'webhook'` — the shape
 *     `ButtonStore.sweepExpired` synthesizes (`channels/button-store.ts`). The
 *     sentinel is what makes the retired row read as SYSTEM-resolved rather than
 *     as a real answer: reserved resolution values are never rendered as a user
 *     reply and never replayed to a late tap. The prompt row's own expiry is a
 *     decade away, so `resolve()`'s transactional expiry check cannot reject
 *     this synthesized choice.
 *  2. `AppWsAdapter.recordPromptChoice` — stamps the chat-log message meta and
 *     fans a `prompt_resolved` frame to the topic, which is what actually
 *     COLLAPSES the button on every connected surface. It is a separate step
 *     from (1) on purpose: the store write is durable state, the fan is the
 *     picture, and a missing/already-resolved store row must not cost the fan.
 *
 * Both halves are guarded. A stale client that missed the frame and taps anyway
 * lands in the evicted branch of `handleOwnerButtonAnswer` (T4), which explains
 * the eviction and re-raises — so the worst case of a failed retirement is a
 * sentence, never a deploy.
 */

import type { ButtonChoice } from '@neutronai/channels/button-primitive.ts'
import { SYSTEM_SPEAKER_USER_ID } from '@neutronai/channels/button-store.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('host-deploy-prompt-retirer')

/** The structural slices this closure needs — stubbed whole in its unit test. */
export interface HostDeployPromptRetirerDeps {
  buttonStore: { resolve(input: { choice: ButtonChoice }): Promise<unknown> }
  recordPromptChoice: (input: {
    channel_topic_id: string
    prompt_id: string
    chosen_value: string
    project_id?: string
  }) => Promise<unknown>
}

/**
 * Build the `retire_prompt` seam `createHostDeployService` calls from its
 * expiry sweep. Never throws.
 */
export function buildHostDeployPromptRetirer(
  deps: HostDeployPromptRetirerDeps,
): (input: { prompt_id: string; topic_id: string }) => Promise<void> {
  return async ({ prompt_id, topic_id }): Promise<void> => {
    const choice: ButtonChoice = {
      prompt_id,
      choice_value: '__timeout__',
      chosen_at: Date.now(),
      speaker_user_id: SYSTEM_SPEAKER_USER_ID,
      channel_kind: 'webhook',
    }
    try {
      await deps.buttonStore.resolve({ choice })
    } catch (err) {
      // A missing or already-resolved row must not stop the LIVE fan below —
      // that fan is the only thing the owner's screen actually reacts to.
      log.warn('retire_resolve_failed', {
        prompt_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // The app-ws topic grammar is `app:<user>[:<project>]`; the project segment
    // is what scopes the chat log the fan reads. A project-less owner topic
    // simply carries no project_id (the adapter's own default).
    const parts = topic_id.split(':')
    const project_id = parts.length >= 3 ? parts.slice(2).join(':') : undefined
    try {
      await deps.recordPromptChoice({
        channel_topic_id: topic_id,
        prompt_id,
        chosen_value: '__timeout__',
        ...(project_id !== undefined ? { project_id } : {}),
      })
    } catch (err) {
      log.warn('retire_fan_failed', {
        prompt_id,
        topic_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
