/**
 * @neutronai/runtime — OpenAI Responses API SSE consumer.
 *
 * POSTs to `/v1/responses` with `stream:true`, parses Server-Sent Events,
 * yields the substrate `Event` tagged union. Mirrors the CC adapter's
 * transport-stream architecturally — same SSE frame parser, same coalescing
 * rule (only `token` events MAY be coalesced), same `iterator.return()` →
 * `AbortController.abort()` cancellation path.
 *
 * Event mapping (Responses API → substrate Event):
 *
 *   response.output_text.delta              → token
 *   response.reasoning_summary.delta        → thinking
 *   response.function_call.delta            → accumulate args (no emission)
 *   response.function_call.completed        → tool_call
 *   response.completed                      → completion (with usage + response.id)
 *   response.error                          → error
 *
 * `response.id` is captured and surfaced as `completion.session.id` so
 * callers can use it as `previous_response_id` on the next turn — Responses
 * API's primary session-continuation primitive.
 *
 * UPSTREAM `tool_resolution` is `external` (the Responses API surfaces
 * function calls and waits for `function_call_output` items in the next
 * turn). The adapter index uses `mcp-shim.ts` to translate that into the
 * caller-facing `tool_resolution: 'internal'` per § 4.3 of the P1 plan.
 */

import type { Event, TokenUsage } from '../../events.ts'

export interface ResponsesStreamOptions {
  endpoint: string
  authHeaders: Record<string, string>
  body: Record<string, unknown>
  signal: AbortSignal
  substrate_instance_id: string
  fetchImpl?: typeof fetch
}

interface FunctionCallAccum {
  call_id: string
  name: string
  args_buf: string
}

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

export async function* startResponsesStream(
  opts: ResponsesStreamOptions,
): AsyncGenerator<Event, void, void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.authHeaders,
  }

  let response: Response
  try {
    response = await fetchImpl(opts.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    })
  } catch (err) {
    if (opts.signal.aborted) {
      yield { kind: 'error', message: 'cancelled', retryable: false }
      return
    }
    yield { kind: 'error', message: `fetch failed: ${(err as Error).message}`, retryable: true }
    return
  }

  if (!response.ok || !response.body) {
    const status = response.status
    const text = await response.text().catch(() => '')
    const retryable = status === 429 || status === 408 || (status >= 500 && status < 600)
    const retry_after = parseRetryAfterMs(response.headers.get('retry-after'))
    const ev: Event =
      retry_after !== undefined
        ? {
            kind: 'error',
            message: `HTTP ${status}: ${truncate(text, 400)}`,
            retryable,
            retry_after_ms: retry_after,
          }
        : { kind: 'error', message: `HTTP ${status}: ${truncate(text, 400)}`, retryable }
    yield ev
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let currentEventType = ''
  const fnAccums = new Map<string, FunctionCallAccum>()
  let usage: TokenUsage = { ...ZERO_USAGE }
  let responseId: string | undefined
  let completionEmitted = false
  let errorEmitted = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let frameEnd = buf.indexOf('\n\n')
      while (frameEnd !== -1) {
        const frame = buf.slice(0, frameEnd)
        buf = buf.slice(frameEnd + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) {
            currentEventType = line.slice('event:'.length).trim()
          } else if (line.startsWith('data:')) {
            const payload = line.slice('data:'.length).trim()
            if (payload.length === 0) continue
            let data: unknown
            try {
              data = JSON.parse(payload)
            } catch {
              continue
            }
            for (const ev of mapResponsesEvent(currentEventType, data, fnAccums, (u) => {
              usage = { ...usage, ...u }
            }, (id) => {
              responseId = id
            })) {
              if (ev.kind === 'completion') {
                completionEmitted = true
                const completion: Event = {
                  kind: 'completion',
                  usage,
                  substrate_instance_id: opts.substrate_instance_id,
                }
                if (responseId) {
                  completion.session = { id: responseId, last_active_at: Date.now() }
                }
                yield completion
              } else {
                if (ev.kind === 'error') errorEmitted = true
                yield ev
              }
            }
          }
        }
        frameEnd = buf.indexOf('\n\n')
      }
    }
    // Only synthesise a terminal completion when the stream closed cleanly
    // (no in-stream error). After an error the error IS the terminal event;
    // emitting a completion would let consumers commit usage / session state
    // for a failed turn (Codex r1 P1 finding).
    if (!completionEmitted && !errorEmitted) {
      const completion: Event = {
        kind: 'completion',
        usage,
        substrate_instance_id: opts.substrate_instance_id,
      }
      if (responseId) completion.session = { id: responseId, last_active_at: Date.now() }
      yield completion
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // best-effort
    }
  }
}

interface ResponsesEnvelope {
  type?: string
  delta?: string | { text?: string }
  text?: string
  call_id?: string
  name?: string
  arguments?: string
  response?: {
    id?: string
    usage?: Partial<TokenUsage>
  }
  usage?: Partial<TokenUsage>
  error?: { message?: string; type?: string }
}

function mapResponsesEvent(
  eventType: string,
  data: unknown,
  fnAccums: Map<string, FunctionCallAccum>,
  updateUsage: (u: Partial<TokenUsage>) => void,
  setResponseId: (id: string) => void,
): Event[] {
  if (typeof data !== 'object' || data === null) return []
  const evt = data as ResponsesEnvelope
  switch (eventType) {
    case 'response.created': {
      if (evt.response?.id) setResponseId(evt.response.id)
      return []
    }
    case 'response.output_text.delta': {
      const text = typeof evt.delta === 'string' ? evt.delta : evt.delta?.text
      if (typeof text === 'string') return [{ kind: 'token', text }]
      return []
    }
    case 'response.reasoning_summary.delta':
    case 'response.reasoning.delta': {
      const text = typeof evt.delta === 'string' ? evt.delta : evt.delta?.text
      if (typeof text === 'string') return [{ kind: 'thinking', text }]
      return []
    }
    case 'response.function_call.delta':
    case 'response.function_call_arguments.delta': {
      if (typeof evt.call_id !== 'string') return []
      const accum = fnAccums.get(evt.call_id) ?? {
        call_id: evt.call_id,
        name: evt.name ?? '',
        args_buf: '',
      }
      if (typeof evt.arguments === 'string') accum.args_buf += evt.arguments
      else if (typeof evt.delta === 'string') accum.args_buf += evt.delta
      if (evt.name) accum.name = evt.name
      fnAccums.set(evt.call_id, accum)
      return []
    }
    case 'response.function_call.completed':
    case 'response.function_call_arguments.done': {
      if (typeof evt.call_id !== 'string') return []
      const accum = fnAccums.get(evt.call_id)
      if (!accum) return []
      fnAccums.delete(evt.call_id)
      let parsed: unknown = {}
      if (accum.args_buf.trim().length > 0) {
        try {
          parsed = JSON.parse(accum.args_buf)
        } catch {
          parsed = { _parse_error: true, _raw: accum.args_buf }
        }
      }
      return [
        {
          kind: 'tool_call',
          tool_name: accum.name,
          args: parsed,
          call_id: accum.call_id,
        },
      ]
    }
    case 'response.completed': {
      if (evt.response?.id) setResponseId(evt.response.id)
      if (evt.response?.usage) updateUsage(evt.response.usage)
      if (evt.usage) updateUsage(evt.usage)
      return [
        {
          kind: 'completion',
          usage: ZERO_USAGE,
          substrate_instance_id: '__pending__',
        },
      ]
    }
    case 'response.error':
    case 'error': {
      const message = evt.error?.message ?? 'unknown openai error'
      const retryable =
        evt.error?.type === 'rate_limit_exceeded' ||
        evt.error?.type === 'server_error' ||
        evt.error?.type === 'timeout'
      return [{ kind: 'error', message, retryable }]
    }
    default:
      return []
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds * 1000
  const dt = Date.parse(value)
  if (Number.isFinite(dt)) return Math.max(0, dt - Date.now())
  return undefined
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}
