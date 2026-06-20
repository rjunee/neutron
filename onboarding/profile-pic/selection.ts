/**
 * @neutronai/onboarding/profile-pic — selection UI helpers.
 *
 * Per docs/plans/P2-onboarding.md § 2.7. Builds the button-prompt
 * surface for the async UX pattern described in the spec:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Your portraits are being painted (~30 sec).  │
 *   │ [A] Wait                                     │
 *   │ [B] Pick from generic gallery instead        │
 *   │ [C] Upload my own                            │
 *   └──────────────────────────────────────────────┘
 *
 * After the pipeline completes, a second button-prompt surfaces the
 * generated candidates so the user picks one ([A]/[B]/[C] for up-to-3
 * candidates) or asks for a regenerate ([D]).
 *
 * The selection module emits the prompts; the engine dispatches them
 * via the channel adapter. The pipeline (`pipeline.ts`) handles the
 * actual `pick(...)` / `acceptUpload(...)` / `pickFallback(...)`
 * back-ends after the user taps.
 */

import {
  buildButtonPrompt,
  type ButtonPrompt,
} from '../../channels/button-primitive.ts'

export const PORTRAIT_WAIT_PROMPT_BODY =
  'Your portraits are being painted (~30 sec). Tap a button below or wait — I will surface them when ready.'

export const PORTRAIT_PICK_PROMPT_BODY =
  'Your portraits are ready. Pick the one that feels right, or regenerate for a fresh set.'

export interface BuildPortraitWaitPromptInput {
  project_slug: string
  topic_id: string
  job_id: string
  uuid?: () => string
}

/**
 * Surfaces during generation. The user can wait for the candidates to
 * land, short-circuit to the gallery, or upload a custom image. Idempotent
 * by job_id so re-emits collapse to one render.
 */
export function buildPortraitWaitPrompt(input: BuildPortraitWaitPromptInput): ButtonPrompt {
  const builder: Parameters<typeof buildButtonPrompt>[0] = {
    body: PORTRAIT_WAIT_PROMPT_BODY,
    options: [
      { label: 'A', body: 'Wait', value: 'wait' },
      { label: 'B', body: 'Pick from generic gallery', value: 'gallery' },
      { label: 'C', body: 'Upload my own', value: 'upload' },
    ],
    allow_freeform: false,
    idempotency: {
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `portrait-wait:${input.job_id}`,
    },
  }
  if (input.uuid !== undefined) builder.uuid = input.uuid
  return buildButtonPrompt(builder)
}

export interface BuildPortraitPickPromptInput {
  project_slug: string
  topic_id: string
  job_id: string
  /** The candidate ids the user can pick from. 1-3 entries. */
  candidate_ids: string[]
  /** Whether to include a `[D] Regenerate` option. */
  allow_regenerate?: boolean
  uuid?: () => string
}

/**
 * Surfaces after generation succeeded. One option per candidate +
 * optional Regenerate. Each option's `value` is the candidate_id (or
 * `regen` for the regenerate path) so the engine can route the tap
 * back into `pipeline.pick(...)` / `pipeline.start(...)`.
 */
export function buildPortraitPickPrompt(input: BuildPortraitPickPromptInput): ButtonPrompt {
  if (input.candidate_ids.length === 0 || input.candidate_ids.length > 3) {
    throw new Error(
      `buildPortraitPickPrompt expects 1-3 candidate_ids, got ${input.candidate_ids.length}`,
    )
  }
  const labels = ['A', 'B', 'C'] as const
  const options: Parameters<typeof buildButtonPrompt>[0]['options'] = input.candidate_ids.map(
    (id, i) => ({
      label: labels[i]!,
      body: `Portrait ${i + 1}`,
      value: id,
    }),
  )
  if (input.allow_regenerate === true) {
    const nextLabel = labels[input.candidate_ids.length] ?? 'D'
    options.push({ label: nextLabel as string, body: 'Regenerate', value: 'regen' })
  }
  const builder: Parameters<typeof buildButtonPrompt>[0] = {
    body: PORTRAIT_PICK_PROMPT_BODY,
    options,
    allow_freeform: false,
    idempotency: {
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `portrait-pick:${input.job_id}`,
    },
  }
  if (input.uuid !== undefined) builder.uuid = input.uuid
  return buildButtonPrompt(builder)
}
