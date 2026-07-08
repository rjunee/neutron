/**
 * @neutronai/research-core — runtime LLM substrate + sub-agent
 * dispatcher adapter.
 *
 * The Research Core programs against two narrow ports:
 *
 *   - `ResearchSubstrate.synthesize({prompt}) → {text, model}` — used
 *     by `/research <topic>` (standard depth)
 *   - `RuntimeSubAgentDispatcher.dispatch({system_prompt, user_prompt,
 *     model, tools, budget_ms}) → {text, model, tool_calls}` — used by
 *     `/research deep <topic>` (Haiku-4.5 sub-agent harness)
 *
 * Both ports stay substrate-agnostic so tests can pass canned
 * fixtures. THIS module wraps an opaque `ResearchLlmCall` function
 * (provided by the gateway against its credential pool) and exposes
 * BOTH ports backed by that one call. The gateway constructs ONE
 * `llm_call` closure against `anthropic` credentials at boot and
 * threads it through both factories below.
 *
 * Closes Argus r1 BLOCKER #3 + #4 — production no longer ships a
 * canned-empty substrate that throws on the first /research dispatch,
 * and `/research deep` is reachable end-to-end through the production
 * composer (substrate IS the runtime LLM; dispatcher IS the runtime
 * LLM with tool-call passthrough disabled).
 */

import { SONNET_MODEL, FAST_MODEL } from '@neutronai/runtime/models.ts'

import type {
  ResearchSubstrate,
  ResearchSubstrateInput,
  ResearchSubstrateResult,
} from './backend.ts'
import type {
  RuntimeSubAgentDispatchInput,
  RuntimeSubAgentDispatchResult,
  RuntimeSubAgentDispatcher,
} from './sub-agent.ts'

/**
 * Opaque LLM-call closure. Returns the assistant's text response.
 * Implementation lives in the gateway against its credential pool
 * (Max OAuth / BYO key / env API key) so the Core never imports an
 * Anthropic SDK or knows about HTTP semantics.
 *
 * `max_tokens` is provided by the substrate adapter (4096 default for
 * synthesis; 8192 default for sub-agent). `model` is the resolved
 * model id (SONNET_MODEL for synthesis; FAST_MODEL for the sub-agent).
 */
export interface ResearchLlmCall {
  (input: {
    system: string
    user: string
    max_tokens: number
    model: string
  }): Promise<string>
}

export interface BuildRuntimeResearchSubstrateOptions {
  llm_call: ResearchLlmCall
  /** Override the model id reported back. Defaults to SONNET_MODEL. */
  default_model?: string
  /** Max tokens per synthesize call. Defaults to 4096. */
  max_tokens?: number
  /** System prompt prefix prepended to the synthesis prompt. The
   *  parse-once-retry-once orchestrator already bakes the structured
   *  instructions into the user-side prompt; this defaults to a short
   *  framer that asks the model to respond in JSON only. */
  system_prompt?: string
}

const DEFAULT_SYNTHESIS_SYSTEM_PROMPT =
  'You are a research assistant. Respond with VALID JSON ONLY. Do not include prose ' +
  'around the JSON. The user prompt specifies the brief schema; follow it exactly.'

const DEFAULT_SYNTHESIS_MAX_TOKENS = 4096
const DEFAULT_SUB_AGENT_MAX_TOKENS = 8192

const DEFAULT_SUB_AGENT_SYSTEM_PROMPT_FALLBACK =
  'You are a research sub-agent. Use the provided tools to gather evidence and ' +
  'respond with VALID JSON ONLY matching the brief schema.'

/**
 * Build a `ResearchSubstrate` backed by the gateway's LLM call. Each
 * `synthesize(input)` invokes `llm_call({system, user, max_tokens,
 * model})` and returns the raw text + the resolved model id. The
 * orchestrator's parse-once-retry-once pipeline consumes the text.
 *
 * Replaces `buildCannedResearchSubstrate({responses: []})` in the
 * production composer. That canned shim throws "no canned response
 * for call #N" on EVERY real /research call — see Argus r1
 * BLOCKER #4.
 */
export function buildRuntimeResearchSubstrate(
  opts: BuildRuntimeResearchSubstrateOptions,
): ResearchSubstrate {
  const default_model = opts.default_model ?? SONNET_MODEL
  const max_tokens = opts.max_tokens ?? DEFAULT_SYNTHESIS_MAX_TOKENS
  const system_prompt = opts.system_prompt ?? DEFAULT_SYNTHESIS_SYSTEM_PROMPT
  return {
    async synthesize(
      input: ResearchSubstrateInput,
    ): Promise<ResearchSubstrateResult> {
      const model =
        input.model_preference !== undefined && input.model_preference.length > 0
          ? (input.model_preference[0] ?? default_model)
          : default_model
      const text = await opts.llm_call({
        system: system_prompt,
        user: input.prompt,
        max_tokens,
        model,
      })
      return { text, model }
    },
  }
}

export interface BuildRuntimeResearchSubAgentDispatcherOptions {
  llm_call: ResearchLlmCall
  /** Override the model id reported back. Defaults to FAST_MODEL (Haiku 4.5). */
  default_model?: string
  /** Max tokens per dispatch. Defaults to 8192. */
  max_tokens?: number
}

/**
 * Build a `RuntimeSubAgentDispatcher` backed by the gateway's LLM
 * call. v1 makes a single Messages-API call against the sub-agent's
 * system + user prompt — actual tool-calling is deferred to a follow-
 * up sprint (the Core's sub-agent harness records `tool_calls: []` in
 * that case, which the orchestrator records as `tool_call_count: 0`).
 *
 * The wireup closes Argus r1 BLOCKER #3 (production must construct
 * a real dispatcher, not throw 'sub_agent_dispatcher + concurrency_gate
 * must be configured'). When the runtime ships proper tool-call
 * passthrough the dispatcher swaps to that path; until then, the deep
 * substrate path is reachable end-to-end.
 */
export function buildRuntimeResearchSubAgentDispatcher(
  opts: BuildRuntimeResearchSubAgentDispatcherOptions,
): RuntimeSubAgentDispatcher {
  const default_model = opts.default_model ?? FAST_MODEL
  const max_tokens = opts.max_tokens ?? DEFAULT_SUB_AGENT_MAX_TOKENS
  return {
    async dispatch(
      input: RuntimeSubAgentDispatchInput,
    ): Promise<RuntimeSubAgentDispatchResult> {
      const model =
        typeof input.model === 'string' && input.model.length > 0
          ? input.model
          : default_model
      const system =
        typeof input.system_prompt === 'string' && input.system_prompt.length > 0
          ? input.system_prompt
          : DEFAULT_SUB_AGENT_SYSTEM_PROMPT_FALLBACK
      const text = await opts.llm_call({
        system,
        user: input.user_prompt,
        max_tokens,
        model,
      })
      return {
        text,
        model,
        tool_calls: [],
      }
    },
  }
}
