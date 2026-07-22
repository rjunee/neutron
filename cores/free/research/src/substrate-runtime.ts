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
 *     `/research deep <topic>` (research sub-agent harness)
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
 * LLM running a real agentic tool loop).
 *
 * The sub-agent dispatcher (task 10) runs an EMULATED tool protocol
 * over sequential text `llm_call` rounds — native Anthropic
 * Messages-API `tools`/tool_use blocks are impossible on the
 * CC-subprocess substrate (system+user are packed into a single
 * `AgentSpec.prompt` string; `respondToTool` throws). Instead the
 * dispatcher advertises a strict JSON envelope
 * `{"tool_call":{"tool","input"}}`, executes the named tool via
 * injected executors, threads a `[TOOL_RESULT <name>]` block back into
 * the next round's user prompt, and loops until the model emits the
 * final brief JSON — bounded by `budget_ms` (a finalize-margin
 * pre-check per round) + a max-tool-round cap. It reports the real
 * `tool_calls` + `tools_available: true`, which arms the
 * orchestrator's zero-tool grounding gate in production. Callers that
 * pass NO executors keep byte-identical v1 single-call behavior
 * (`tools_available: false`) — back-compat degradation, not a flag.
 */

import { SONNET_MODEL, FAST_MODEL } from '@neutronai/runtime/models.ts'

import { extractJson } from './backend.ts'
import type {
  ResearchSubstrate,
  ResearchSubstrateInput,
  ResearchSubstrateResult,
} from './backend.ts'
import type { ResearchSubAgentToolCall } from './sub-agent.ts'
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

/**
 * A single research tool executor. Receives the model-supplied `input`
 * (already parsed off the JSON envelope; validate inside) plus the
 * dispatch context (project scoping). Returns any JSON-serialisable
 * value; a returned object carrying an `error` key is threaded back to
 * the model as a soft failure (recorded `success: false`) rather than
 * throwing. Executors SHOULD be total (never throw) — a thrown error is
 * still caught and threaded, but a returned `{error}` reads cleaner.
 */
export type ResearchSubAgentToolExecutor = (
  args: unknown,
  ctx: { project_id: string | null },
) => Promise<unknown>

export type ResearchSubAgentToolExecutors = Readonly<
  Record<string, ResearchSubAgentToolExecutor>
>

/** Max tool rounds before the dispatcher forces a finalize turn. */
export const DEFAULT_MAX_TOOL_ROUNDS = 6
/** Hard cap on a single threaded `[TOOL_RESULT]` block (post-serialise). */
const TOOL_RESULT_MAX_CHARS = 30_000
/**
 * Reserve this much of `budget_ms` for the final synthesis turn. When
 * fewer than this many ms remain before the outer deadline, the loop
 * stops calling tools and forces the final-answer turn. The OUTER
 * `dispatchResearchSubAgent` (sub-agent.ts `runWithTimeout`) still
 * races the whole dispatch against `budget_ms` — this internal margin
 * exists so the loop normally self-finalizes BEFORE that outer race
 * trips; the outer timeout remains the backstop for an individual hung
 * `llm_call`.
 */
const FINALIZE_MARGIN_MS = 20_000

/** Marker prefixing the echoed tool_call envelope in the threaded transcript. */
export const TOOL_CALL_BLOCK_MARKER = '[TOOL_CALL]'
/** Build the marker heading a threaded tool result for `name`. */
export function TOOL_RESULT_BLOCK_MARKER(name: string): string {
  return '[TOOL_RESULT ' + name + ']'
}
/** Appended to the transcript on the forced finalize turn. */
export const FINALIZE_MARKER = '[FINAL ANSWER REQUIRED]'

/** Per-tool input-shape hints rendered into the protocol rider. */
const TOOL_INPUT_SCHEMAS: Readonly<Record<string, string>> = {
  research_vault_search: '{"query": string, "limit"?: number}',
  research_web_search: '{"query": string, "max_results"?: number}',
  research_web_fetch: '{"url": string}',
}

/**
 * Build the tool-use protocol rider appended to the sub-agent system
 * prompt. Plain hyphens only (no em dashes) so the prompt text stays
 * clean.
 */
function toolProtocolRider(offered: readonly string[]): string {
  const toolLines = offered.map((name) => {
    const schema = TOOL_INPUT_SCHEMAS[name] ?? '{...}'
    return '- ' + name + ' - input ' + schema
  })
  return [
    '# Tool-use protocol',
    '',
    'You may call the following tools to gather evidence before writing your brief:',
    ...toolLines,
    '',
    'To call a tool, respond with EXACTLY ONE JSON object and NOTHING else:',
    '{"tool_call":{"tool":"<name>","input":{ ... }}}',
    '',
    'The result arrives as a [TOOL_RESULT <name>] block in the next user message.',
    'Read it, then either call another tool the same way, or - when you have',
    'enough evidence - respond with the final ResearchBrief JSON object (NOT',
    'wrapped in tool_call). Never wrap the final brief in a tool_call envelope.',
  ].join('\n')
}

/** JSON-stringify that never throws + never returns undefined. */
function safeStringify(value: unknown): string {
  try {
    const out = JSON.stringify(value)
    return out === undefined ? String(value) : out
  } catch {
    return JSON.stringify({ error: 'tool result was not JSON-serialisable' })
  }
}

export interface BuildRuntimeResearchSubAgentDispatcherOptions {
  llm_call: ResearchLlmCall
  /** Override the model id reported back. Defaults to FAST_MODEL (Haiku 4.5). */
  default_model?: string
  /** Max tokens per dispatch. Defaults to 8192. */
  max_tokens?: number
  /**
   * Tool executors keyed by tool name. When provided AND at least one
   * of the dispatch's requested tools has a matching executor, the
   * dispatcher runs the emulated agentic tool loop. When omitted (or
   * none of the requested tools have executors) it degrades to the
   * byte-identical v1 single-call path (`tools_available: false`).
   */
  tool_executors?: ResearchSubAgentToolExecutors
  /** Max tool rounds before a forced finalize turn. Default 6. */
  max_tool_rounds?: number
  /** Clock override (testing seam). Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Build a `RuntimeSubAgentDispatcher` backed by the gateway's LLM
 * call.
 *
 * When `tool_executors` are supplied (production wiring always supplies
 * them), the dispatcher runs an EMULATED agentic tool loop over
 * sequential text `llm_call` rounds: it advertises a strict JSON
 * `{"tool_call":{"tool","input"}}` envelope in the system prompt,
 * executes the named executor, threads a `[TOOL_RESULT <name>]` block
 * back into the next round's user prompt, and loops until the model
 * emits the final brief JSON. Bounded by `budget_ms` (a
 * `FINALIZE_MARGIN_MS` pre-check per round) + `max_tool_rounds` with a
 * forced `[FINAL ANSWER REQUIRED]` last turn. Reports the real
 * `tool_calls` + `tools_available: true`.
 *
 * When NO executors are supplied (or none of the requested tools have
 * one), the dispatcher makes a single tool-less `llm_call` and returns
 * `tool_calls: []` + `tools_available: false` — byte-identical to the
 * historical v1 behavior. This is back-compat degradation, NOT a
 * feature flag; production always passes executors.
 *
 * Native Anthropic Messages-API tool blocks are impossible on the
 * CC-subprocess substrate (`AgentSpec.prompt` is a single string;
 * `respondToTool` throws) and direct Anthropic HTTPS is forbidden — the
 * emulated protocol is the ONLY way to reach real tool grounding here.
 */
export function buildRuntimeResearchSubAgentDispatcher(
  opts: BuildRuntimeResearchSubAgentDispatcherOptions,
): RuntimeSubAgentDispatcher {
  const default_model = opts.default_model ?? FAST_MODEL
  const max_tokens = opts.max_tokens ?? DEFAULT_SUB_AGENT_MAX_TOKENS
  const max_tool_rounds = opts.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS
  const now = opts.now ?? ((): number => Date.now())
  const tool_executors = opts.tool_executors
  return {
    async dispatch(
      input: RuntimeSubAgentDispatchInput,
    ): Promise<RuntimeSubAgentDispatchResult> {
      const model =
        typeof input.model === 'string' && input.model.length > 0
          ? input.model
          : default_model
      const baseSystem =
        typeof input.system_prompt === 'string' && input.system_prompt.length > 0
          ? input.system_prompt
          : DEFAULT_SUB_AGENT_SYSTEM_PROMPT_FALLBACK
      const project_id = input.project_id ?? null

      // Which requested tools actually have an executor wired?
      const offered =
        tool_executors === undefined
          ? []
          : input.tools.filter((t) =>
              Object.prototype.hasOwnProperty.call(tool_executors, t),
            )

      // v1 back-compat: no executors, or none of the requested tools are
      // executable. Byte-identical to the historical single-call path.
      if (tool_executors === undefined || offered.length === 0) {
        const text = await opts.llm_call({
          system: baseSystem,
          user: input.user_prompt,
          max_tokens,
          model,
        })
        return { text, model, tool_calls: [], tools_available: false }
      }

      const executors = tool_executors
      const system = baseSystem + '\n\n' + toolProtocolRider(offered)
      const deadline = now() + input.budget_ms
      let transcript = input.user_prompt
      const tool_calls: ResearchSubAgentToolCall[] = []
      let toolRounds = 0

      const finalize = (text: string): RuntimeSubAgentDispatchResult => ({
        text,
        model,
        tool_calls,
        tools_available: true,
      })

      for (;;) {
        // Round / budget guard — force the final-answer turn.
        if (
          toolRounds >= max_tool_rounds ||
          deadline - now() < FINALIZE_MARGIN_MS
        ) {
          transcript +=
            '\n\n' +
            FINALIZE_MARKER +
            '\nTool budget exhausted. Do not call tools. Output the single ' +
            'final ResearchBrief JSON object now.'
          const text = await opts.llm_call({
            system,
            user: transcript,
            max_tokens,
            model,
          })
          return finalize(text)
        }

        const text = await opts.llm_call({
          system,
          user: transcript,
          max_tokens,
          model,
        })

        let parsed: unknown
        try {
          parsed = extractJson(text)
        } catch {
          // Not parseable as JSON at all → treat as the final answer and
          // let the orchestrator's parse/schema retry handle the shape.
          return finalize(text)
        }

        const isEnvelope =
          parsed !== null &&
          typeof parsed === 'object' &&
          Object.prototype.hasOwnProperty.call(parsed, 'tool_call')
        if (!isEnvelope) {
          // A JSON object WITHOUT a tool_call key → the final brief.
          return finalize(text)
        }

        const env = (parsed as { tool_call?: unknown }).tool_call
        const envObj =
          env !== null && typeof env === 'object'
            ? (env as { tool?: unknown; input?: unknown })
            : {}
        const name = typeof envObj.tool === 'string' ? envObj.tool : 'unknown'

        let serialized: string
        if (!offered.includes(name)) {
          serialized = JSON.stringify({
            error:
              'tool "' +
              name +
              '" is not available; available tools: ' +
              offered.join(', '),
          })
          tool_calls.push({ tool: name, success: false, elapsed_ms: 0 })
        } else {
          const executor = executors[name]!
          const t0 = now()
          try {
            const result = await executor(envObj.input ?? {}, { project_id })
            serialized = safeStringify(result)
            // A returned `{error}` object is a soft failure (success:false)
            // even though the executor did not throw.
            const success = !(
              result !== null &&
              typeof result === 'object' &&
              'error' in (result as Record<string, unknown>)
            )
            tool_calls.push({ tool: name, success, elapsed_ms: now() - t0 })
          } catch (err) {
            serialized = JSON.stringify({
              error: String((err as { message?: unknown })?.message ?? err),
            })
            tool_calls.push({ tool: name, success: false, elapsed_ms: now() - t0 })
          }
        }
        toolRounds++

        if (serialized.length > TOOL_RESULT_MAX_CHARS) {
          const dropped = serialized.length - TOOL_RESULT_MAX_CHARS
          serialized =
            serialized.slice(0, TOOL_RESULT_MAX_CHARS) +
            '...[truncated ' +
            dropped +
            ' chars]'
        }

        transcript +=
          '\n\n' +
          TOOL_CALL_BLOCK_MARKER +
          '\n' +
          JSON.stringify(parsed) +
          '\n\n' +
          TOOL_RESULT_BLOCK_MARKER(name) +
          '\n' +
          serialized
      }
    },
  }
}
