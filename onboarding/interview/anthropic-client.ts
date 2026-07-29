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
    }): Promise<AnthropicMessageResponse>
  }
}
