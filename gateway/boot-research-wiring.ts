/**
 * gateway/boot-research-wiring.ts — the per-instance Research Core LLM
 * call, dispatched through the shared CC subprocess substrate.
 *
 * Split out of the former monolithic `gateway/boot-helpers.ts` (C2
 * refactor). Kept separate from the Cores backend factory map so the
 * research substrate concern (credential-gated LLM dispatch) is a
 * cohesive unit. This module MUST NEVER import `gateway/index.ts`.
 *
 * Open-classified and import-clean of Managed dirs.
 */

/**
 * Build the Research Core's per-instance `ResearchLlmCall` closure
 * against the instance's Anthropic credential pool. The pool is read
 * via a getter rather than captured by value so a no-restart Max
 * OAuth re-paste (or env-var rotation) lands the next /research
 * dispatch on the fresh credentials.
 *
 * Throws on invocation when the instance has no credentials — the
 * orchestrator catches the error and surfaces the task as `failed`
 * with `substrate error: ...` rather than crashing the gateway. The
 * user-visible chat reply explains the gap.
 *
 * Argus r1 BLOCKER #4 close. The previous wiring shipped
 * `buildCannedResearchSubstrate({responses: []})` which threw
 * `no canned response for call #1` on every real /research dispatch.
 */
export function buildResearchLlmCallForOwner(opts: {
  project_slug: string
  slug_suffix: string
  /**
   * Sprint cc-substrate-migration-3-sites (2026-05-31) — Research Core
   * now dispatches through the shared CC subprocess substrate (same
   * `Substrate` instance the phase-spec resolver / LLM router / agent
   * watcher / wow picker / nudge engine consume). Per memory
   * `feedback_cc_subprocess_substrate.md`, direct HTTPS calls to
   * upstream LLM endpoints from instance-facing code are forbidden;
   * the `claude` binary owns wire-level auth + OAuth refresh.
   *
   * Pass `null` when no Anthropic credentials are available; the
   * returned closure then throws a substrate-error per call so the
   * orchestrator surfaces `failed` with the user-visible "reconnect Max"
   * message rather than crashing the gateway. Pre-cc-substrate the
   * call site was `get_anthropic_pool: () => Promise<CredentialPool | null>`
   * (re-resolved per-dispatch); the substrate's internal lazy
   * `resolvePool` now owns the same per-call freshness guarantee, so a
   * an instance that re-pastes Max OAuth mid-session is honoured on the next
   * `/research` dispatch without a gateway restart.
   */
  substrate: import('../runtime/substrate.ts').Substrate | null
}): import('@neutronai/research-core').ResearchLlmCall {
  return async (input) => {
    if (opts.substrate === null) {
      throw new Error(
        `[research-core] project=${opts.project_slug} has no anthropic credentials; ` +
          `reconnect Max OAuth or set ANTHROPIC_API_KEY_${opts.slug_suffix} ` +
          `to enable /research`,
      )
    }
    const { collectTokensToString } = await import(
      './realmode-composer/build-llm-call-substrate.ts'
    )
    const prompt = input.system.length > 0
      ? `${input.system}\n\n${input.user}`
      : input.user
    if (prompt.length === 0) {
      throw new Error('[research-core] empty prompt — refusing to dispatch')
    }
    const spec: import('../runtime/substrate.ts').AgentSpec = {
      prompt,
      tools: [],
      model_preference: [input.model],
      max_tokens: input.max_tokens,
    }
    const handle = opts.substrate.start(spec)
    try {
      return await collectTokensToString(handle)
    } catch (err) {
      throw new Error(
        `[research-core] ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
