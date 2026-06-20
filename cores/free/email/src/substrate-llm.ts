/**
 * @neutronai/email-managed-core — substrate-backed Haiku LLM caller.
 *
 * Production wiring for `composeBriefSummary` (summarizer.ts § 3.3)
 * and `composeTriage` (triage.ts § 3.4). Both compose against a
 * `(prompt: string) => Promise<string>` callable; this module
 * produces that callable on top of the gateway's `Substrate`
 * (runtime/substrate.ts).
 *
 * Mirrors `onboarding/history-import/substrate-callers.ts` —
 * `substrate.start({prompt, tools: [], model_preference})` →
 * drain the `SessionHandle.events` stream collecting assistant
 * tokens until `completion` lands, then return the joined text.
 *
 * Errors from the substrate (`kind:'error'` event before
 * completion, or stream ending without a completion event) are
 * thrown to the caller. `composeBriefSummary` / `composeTriage`
 * catch and fall through to their deterministic-fallback paths
 * with `outcome:'llm_error'` — a transient Haiku outage never
 * silently drops a daily triage or a prose brief.
 *
 * Why the Core owns this factory (not the gateway): the chat-bridge
 * filter (`createEmailChatCommandFilter`), the MCP tool layer
 * (`buildTools`), AND the triage scheduler all need the same
 * `(prompt: string) => Promise<string>` callable. The factory
 * lives here so every entry point composes the same substrate
 * call shape — closes the Argus r1 BLOCKER #1 spec-conformance gap
 * (CLAUDE.md "Spec is the source of truth" — placeholder phase-
 * prompt bodies that ship as no-ops are the forbidden pattern).
 */

import type { Substrate } from '@neutronai/runtime'
import type { Event } from '@neutronai/runtime'

/**
 * Default max-tokens budget. The triage prompt is structured-JSON
 * (5 picks × ~30 tokens each = ~150 tokens of useful output);
 * the prose-brief prompt is 2-3 sentences (~80 tokens). 1024 gives
 * comfortable headroom on either prompt without burning Haiku
 * quota on a runaway generation.
 */
export const DEFAULT_EMAIL_LLM_MAX_TOKENS = 1024

export interface BuildSubstrateEmailLlmDeps {
  /** Substrate the gateway constructed for this instance. */
  substrate: Substrate
  /** Resolved Haiku-fast model id (production passes
   *  `FAST_MODEL` from `@neutronai/runtime`'s `models.ts`). */
  model: string
  /** Optional max-tokens override. Defaults to
   *  `DEFAULT_EMAIL_LLM_MAX_TOKENS` (1024). */
  max_tokens?: number
}

/**
 * Build the `(prompt: string) => Promise<string>` callable that
 * `composeBriefSummary` and `composeTriage` consume.
 *
 * Per-call shape:
 *   substrate.start({
 *     prompt,
 *     tools: [],
 *     model_preference: [deps.model],
 *     max_tokens: deps.max_tokens ?? DEFAULT_EMAIL_LLM_MAX_TOKENS,
 *   })
 *
 * Each call drains the `SessionHandle.events` stream:
 *   - `kind:'token'` → append to the text accumulator
 *   - `kind:'completion'` → mark completed (do not break — let
 *     the iterator's finally tear down the underlying fetch)
 *   - `kind:'error'` before completion → throw
 *   - thinking / tool_call / tool_result_ack / status → ignore
 *     (`tools: []` so tool_call events shouldn't fire; if a
 *     future adapter emits one, ignoring it is the safe choice —
 *     `tool_resolution: 'internal'` means the adapter handles it
 *     server-side).
 *
 * If the stream ends without a completion event, throws — the
 * Core's downstream catch surfaces this as `outcome:'llm_error'`
 * + the deterministic-fallback ranking / bulletised key_points.
 */
export function buildSubstrateEmailLlm(
  deps: BuildSubstrateEmailLlmDeps,
): (prompt: string) => Promise<string> {
  const max_tokens = deps.max_tokens ?? DEFAULT_EMAIL_LLM_MAX_TOKENS
  const model_preference = [deps.model]
  return async (prompt: string): Promise<string> => {
    const handle = deps.substrate.start({
      prompt,
      tools: [],
      model_preference,
      max_tokens,
    })
    let text = ''
    let completed = false
    for await (const ev of handle.events as AsyncIterable<Event>) {
      if (ev.kind === 'token') {
        text += ev.text
        continue
      }
      if (ev.kind === 'completion') {
        completed = true
        continue
      }
      if (ev.kind === 'error') {
        throw new Error(
          `email_managed_core substrate error: ${ev.message}`,
        )
      }
      // thinking / tool_call / tool_result_ack / status → ignore.
    }
    if (!completed) {
      throw new Error(
        'email_managed_core substrate stream ended without a completion event',
      )
    }
    return text
  }
}
