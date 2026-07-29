/**
 * @neutronai/runtime — GPT-5.5 Responses API substrate adapter.
 *
 * Implements the locked `Substrate` interface against OpenAI's `/v1/responses`
 * endpoint. Caller-facing `tool_resolution = 'internal'` via `mcp-shim.ts`
 * (the upstream Responses API IS external; the shim translates).
 *
 * Composition:
 *
 *   start(spec)  →  resolveOpenAiAuth (auth.ts)
 *                →  rotation = newRotationState(spec.model_preference)
 *                →  startResponsesStream (responses-stream.ts)
 *                →  shimToInternal (mcp-shim.ts)
 *                →  return SessionHandle{events, respondToTool=throws, cancel}
 *
 * Session continuation primitive: `previous_response_id`. When `spec.session.id`
 * is set, the adapter passes it as `previous_response_id` in the request body
 * so the upstream replays history server-side (no client-side transcript
 * replay needed — fundamentally different from CC's pattern).
 *
 * Per § A.2.1 of the engineering plan, this adapter is the primary risk-
 * mitigation for the "Anthropic blocks Neutron's hosted-CC pattern" scenario.
 */

import type { AgentSpec, Substrate } from '../../substrate.ts'
import type { SessionHandle } from '../../session-handle.ts'
import type { Event } from '../../events.ts'
import { resolveOpenAiAuth } from './auth.ts'
import { startResponsesStream } from './responses-stream.ts'
import { shimToInternal, type McpToolResolver } from './mcp-shim.ts'
import { currentModel, newRotationState, rotate } from './multi-model-rotation.ts'

export interface GptResponsesApiSubstrateOptions {
  /** Override env (production: process.env). */
  env?: Readonly<Record<string, string | undefined>>
  /** Override the OPENAI_API_KEY explicitly (e.g. from credential-pool selection). */
  api_key?: string
  /** Default endpoint — `https://api.openai.com/v1/responses`. */
  endpoint?: string
  /** substrate_instance_id surfaced on completion events. */
  substrate_instance_id: string
  /** Per-instance MCP tool resolver — see `mcp-shim.ts`. */
  mcpResolver: McpToolResolver
  /** Override fetch (tests inject mocks). */
  fetchImpl?: typeof fetch
  /** Cap rounds of tool-call resolution per turn. Default 10. */
  max_tool_rounds?: number
}

export function createGptResponsesApiSubstrate(
  options: GptResponsesApiSubstrateOptions,
): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      return startResponsesSession(spec, options)
    },
  }
}

function startResponsesSession(
  spec: AgentSpec,
  options: GptResponsesApiSubstrateOptions,
): SessionHandle {
  const ac = new AbortController()
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {})
  const authOpts: { env: Readonly<Record<string, string | undefined>>; api_key?: string } = { env }
  if (options.api_key !== undefined) authOpts.api_key = options.api_key
  const auth = resolveOpenAiAuth(authOpts)
  const rotation = newRotationState(spec.model_preference)
  const endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses'

  const buildBody = (model: string, previous_response_id?: string, fnOutputs?: Array<{ call_id: string; output: string }>): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model,
      stream: true,
    }
    if (spec.max_tokens !== undefined) body['max_output_tokens'] = spec.max_tokens
    if (previous_response_id !== undefined) {
      body['previous_response_id'] = previous_response_id
    }
    // input array carries function_call_output items (when continuing after
    // tool resolution) OR the conversation history + new user prompt. We
    // include `spec.messages` whenever there's no previous_response_id —
    // covers stateless-substrate flows AND first-turn flows where the
    // caller has client-side history that the upstream has never seen.
    const input: unknown[] = []
    if (fnOutputs && fnOutputs.length > 0) {
      for (const fo of fnOutputs) {
        input.push({
          type: 'function_call_output',
          call_id: fo.call_id,
          output: fo.output,
        })
      }
    } else {
      if (previous_response_id === undefined && spec.messages && spec.messages.length > 0) {
        for (const m of spec.messages) {
          input.push({ role: m.role, content: m.content })
        }
      }
      input.push({ role: 'user', content: spec.prompt })
    }
    body['input'] = input
    if (spec.tools.length > 0) {
      body['tools'] = spec.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }))
    }
    return body
  }

  const startUpstream = (
    model: string,
    previous_response_id?: string,
    fnOutputs?: Array<{ call_id: string; output: string }>,
  ): AsyncGenerator<Event, void, void> => {
    const streamOpts: Parameters<typeof startResponsesStream>[0] = {
      endpoint,
      authHeaders: auth.headers,
      body: buildBody(model, previous_response_id, fnOutputs),
      signal: ac.signal,
      substrate_instance_id: options.substrate_instance_id,
    }
    if (options.fetchImpl !== undefined) streamOpts.fetchImpl = options.fetchImpl
    return startResponsesStream(streamOpts)
  }

  const events = (async function* (): AsyncGenerator<Event, void, void> {
    // Preserve the LAST retryable upstream error's classification (HTTP-status-
    // bearing message + retry_after_ms) across model rotation so the terminal
    // exhaustion error carries it. Otherwise a two-model 429 collapses into a
    // classification-free "model_preference exhausted" string and the composer
    // can no longer cool the (rate-limited) credential — it stays immediately
    // reselectable and the pool never backs off (audit BLOCKER 2). The exhaustion
    // error keeps its `HTTP 429:` prefix so `parseHttpStatusFromMessage` classifies
    // it and `reportFailure` sets cooldown_until / cooldown_reason with the delay.
    let lastRetryable: { message: string; retry_after_ms?: number } | undefined
    // AT-MOST-ONCE (audit BLOCKER) — once ANY tool has executed this turn, model
    // rotation is UNSAFE: the shim executes side-effecting tools BEFORE the
    // continuation, and rotation restarts from the ORIGINAL `spec.session` + prompt
    // on a DIFFERENT model (the continuation's `previous_response_id` is
    // model-specific and can't be replayed cross-model). A rotated model could
    // request + re-execute the SAME mutation (work_board_add, dispatch, …) → a
    // duplicate side effect. So after a tool runs, a retryable error is SURFACED to
    // the turn (normal turn-level retry/handling) instead of triggering a rotation.
    let toolExecutedThisTurn = false
    // EXPIRED-SESSION REPLAY (audit round 15) — the resume `previous_response_id`
    // this turn started with. If the upstream rejects it as expired/not-found, we
    // clear it and REPLAY the same turn WITHOUT a resume id (buildBody then carries
    // the full `spec.messages`), once, so an expired session never loses history.
    let sessionIdForTurn = spec.session?.id
    let expiryReplayed = false
    const exhaustionError = (reason: string): Event => {
      if (lastRetryable === undefined) {
        return { kind: 'error', message: reason, retryable: false }
      }
      const ev: Event = {
        kind: 'error',
        // Keep the HTTP-status prefix FIRST so the composer's classifier matches.
        message: `${lastRetryable.message} [model rotation exhausted: ${reason}]`,
        retryable: false,
      }
      if (lastRetryable.retry_after_ms !== undefined) ev.retry_after_ms = lastRetryable.retry_after_ms
      return ev
    }
    try {
      // Outer rotation loop. Each iteration starts an upstream stream;
      // retryable errors advance rotation and try the next model.
      while (true) {
        const decision = currentModel(rotation)
        if (decision.decision === 'exhausted') {
          yield exhaustionError(decision.reason)
          return
        }
        const initialUpstream = startUpstream(decision.model, sessionIdForTurn)
        const shimOpts: Parameters<typeof shimToInternal>[1] = {
          resolver: options.mcpResolver,
          continueStream: ({ previous_response_id, outputs }) =>
            startUpstream(decision.model, previous_response_id, outputs),
        }
        if (options.max_tool_rounds !== undefined) shimOpts.max_rounds = options.max_tool_rounds
        let needRotate = false
        let needExpiryReplay = false
        let rotateDelay: number | undefined
        for await (const ev of shimToInternal(initialUpstream, shimOpts)) {
          if (ev.kind === 'tool_call') {
            // A tool has (or is about to) execute this turn — see the shim: the
            // `tool_call` is surfaced right before the resolver runs. Mark it so a
            // later retryable error surfaces instead of rotating + re-executing.
            toolExecutedThisTurn = true
            yield ev
            continue
          }
          if (
            ev.kind === 'error' &&
            isPreviousResponseExpired(ev.message) &&
            sessionIdForTurn !== undefined &&
            !expiryReplayed &&
            !toolExecutedThisTurn
          ) {
            // EXPIRED RESUME — the upstream rejected our `previous_response_id`.
            // Replay the SAME model WITHOUT it (fresh full-history replay via
            // spec.messages), exactly once. Do NOT advance rotation and do NOT fail
            // the turn — the fresh completion returns a NEW response id the caller
            // stores, self-healing the continuity ledger.
            expiryReplayed = true
            sessionIdForTurn = undefined
            needExpiryReplay = true
            yield {
              kind: 'status',
              message: 'previous response expired — replaying full history without resume',
            }
            break
          }
          if (ev.kind === 'error' && ev.retryable) {
            if (toolExecutedThisTurn) {
              // AT-MOST-ONCE — a side-effecting tool already ran this turn.
              // Rotating would restart from the original prompt on another model
              // and could re-execute the mutation. Surface the retryable error for
              // turn-level handling; do NOT rotate.
              yield ev
              return
            }
            needRotate = true
            if (ev.retry_after_ms !== undefined) rotateDelay = ev.retry_after_ms
            // Remember the classification for the terminal exhaustion error.
            lastRetryable = { message: ev.message }
            if (ev.retry_after_ms !== undefined) lastRetryable.retry_after_ms = ev.retry_after_ms
            // Surface as `status` so callers see the rotation happening
            yield { kind: 'status', message: `rotating model after retryable error: ${ev.message}` }
            break
          }
          yield ev
          if (ev.kind === 'completion') return
        }
        if (needExpiryReplay) {
          // Re-run the SAME model this iteration (rotation NOT advanced), now with
          // `sessionIdForTurn === undefined` → full-history replay.
          continue
        }
        if (!needRotate) return
        const next = rotate(rotation, rotateDelay)
        if (next.decision === 'exhausted') {
          yield exhaustionError(next.reason)
          return
        }
        if (next.decision === 'rotate' && rotateDelay !== undefined && rotateDelay > 0) {
          await sleep(rotateDelay)
        }
        // continue outer loop with the rotated model
      }
    } finally {
      try {
        ac.abort()
      } catch {
        // best-effort
      }
    }
  })()

  const handle: SessionHandle = {
    events,
    respondToTool() {
      return Promise.reject(
        new Error(
          'openai-responses adapter: respondToTool called on caller-facing tool_resolution=internal substrate (caller bug; the mcp-shim resolves tools transparently)',
        ),
      )
    },
    async cancel(): Promise<void> {
      try {
        ac.abort()
      } catch {
        // best-effort
      }
    },
    tool_resolution: 'internal',
  }
  return handle
}

/**
 * Detect the responses-stream signal that our `previous_response_id` was rejected
 * as expired/not-found (the `previous_response_not_found:` marker), as opposed to
 * a model-not-found / transient error. Drives the one-shot full-history replay.
 */
function isPreviousResponseExpired(message: string): boolean {
  return /previous_response_not_found:/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
