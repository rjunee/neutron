/**
 * @neutronai/onboarding/interview — Anthropic Messages API client surface.
 *
 * Extracted from `llm-router.ts` (K11a2 — refactor unit; router itself dies
 * post-extraction in K11b1). This is the minimal DI shape production code
 * dispatches through (`gateway/wiring/build-anthropic-messages-client.ts`
 * wraps a CC-subprocess `Substrate` into this shape) and tests stub directly
 * (`fixture-anthropic-client.ts`).
 *
 * Zero-import leaf — no runtime dependencies, only structural types.
 */

// ---------------------------------------------------------------------------
// Anthropic Messages API surface (minimal DI shape — tests inject a stub)
// ---------------------------------------------------------------------------

export interface AnthropicMessageBlock {
  text: string
}

export interface AnthropicMessageResponse {
  content: ReadonlyArray<AnthropicMessageBlock>
}

export interface AnthropicMessagesClient {
  messages: {
    create(input: {
      model: string
      system?: string
      messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
      max_tokens: number
      signal?: AbortSignal
      /**
       * OPTIONAL live per-dispatch project identity. When set (and non-empty),
       * the CC-substrate adapter folds it into `spec.metering_context.project_id`,
       * which `build-llm-call-substrate.ts` folds into the warm-pool key — so a
       * per-project dispatch lands on THAT project's OWN warm REPL instead of the
       * substrate's shared `'default'` namespace. This is the SAME per-dispatch
       * key dimension the live-chat agent uses (`build-live-agent-turn.ts`), and
       * it is race-free across concurrent dispatches precisely because it rides
       * the spec (never a shared mutable closure). The per-project KICKOFF-doc
       * composer (whose body is the live opening MESSAGE) and the project
       * materializer's README / transcript-summary composer set this so their
       * composes ISOLATE by construction (no shared transcript ⇒ no cross-project
       * content bleed — ISSUES #378) and warm the SAME session the project's live
       * chat later resumes. Absent for every caller that has no conversational
       * project (router, suggesters).
       */
      project_id?: string
    }): Promise<AnthropicMessageResponse>
  }
}
