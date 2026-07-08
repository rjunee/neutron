/**
 * @neutronai/contracts — LLM-call function signature (L2 leaf).
 *
 * L2 (2026-07) — `LlmCallFn` extracted VERBATIM out of
 * `onboarding/interview/phase-spec-resolver.ts` into this node-free leaf
 * (critic-layering.md §2.1 edge #10: `tasks → onboarding` via
 * `tasks/prioritize-llm.ts`). `tasks/prioritize-llm.ts` now imports the type
 * directly from here; `phase-spec-resolver.ts` keeps a re-export so any
 * other existing import specifier stays valid (test-policy §2.2 barrel
 * rule).
 */

/**
 * Substrate-shaped LLM call. Production wires Anthropic Haiku 4.5 via the
 * instance-resolved Anthropic credentials; tests inject a stub returning
 * a deterministic JSON string.
 */
export type LlmCallFn = (input: {
  system: string
  user: string
  max_tokens: number
}) => Promise<string>
