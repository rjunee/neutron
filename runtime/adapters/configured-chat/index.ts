import { configuredModels } from '../../configured-models.ts'
import type { Event, SubstrateErrorClass } from '../../events.ts'
import type { Substrate } from '../../substrate.ts'
import type { McpToolResolver } from '../openai-responses/mcp-shim.ts'

export interface ConfiguredChatOptions {
  tier: string
  env: Readonly<Record<string, string | undefined>>
  substrate_instance_id: string
  resolver: McpToolResolver
  fetchImpl?: typeof fetch
  maxToolRounds?: number
}

/** Chat-completions transport shared by configured providers and compatible routers.
 * History is replayed from AgentSpec.messages; no remote session id is reused.
 * Model attribution is checked before tokens or tool calls leave each stream chunk.
 */
export function createConfiguredChatSubstrate(options: ConfiguredChatOptions): Substrate {
  return { start(spec) {
    const ac = new AbortController()
    const events = (async function* (): AsyncGenerator<Event> {
      let name = options.tier
      let reason = 'invalid configuration'
      let code: SubstrateErrorClass | undefined = 'spawn_configuration'
      try {
        const row = configuredModels(options.env).find((model) => model.tier === options.tier)
        reason = 'unknown configured model'
        if (!row) throw new Error()
        name = row.model
        reason = `missing credential ${row.credential}`
        code = 'no_credentials'
        const key = options.env[row.credential]
        if (!key?.trim()) throw new Error()
        code = undefined
        const messages: unknown[] = [...(spec.messages ?? []), { role: 'user', content: spec.prompt }]
        const usage = { input_tokens: 0, output_tokens: 0 }
        const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(spec.turn_absolute_ceiling_ms ?? 480_000)])
        for (let round = 0; ; round++) {
          reason = 'tool round limit exceeded'
          if (round > (options.maxToolRounds ?? 10)) throw new Error()
          reason = 'request failed or invalid response'
          const response = await (options.fetchImpl ?? fetch)(row.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: row.model, stream: true,
              stream_options: { include_usage: true },
              ...(spec.max_tokens === undefined ? {} : { max_tokens: spec.max_tokens }), messages,
              ...(spec.tools.length ? { tools: spec.tools.map((tool) => ({ type: 'function', function: {
                name: tool.name, description: tool.description, parameters: tool.input_schema,
              } })) } : {}),
            }),
            signal,
            redirect: 'error',
          })
          code = 'http_status'
          reason = `HTTP ${response.status}`
          if (!response.ok) throw new Error()
          code = undefined
          reason = 'invalid or incomplete stream'
          const calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>()
          let content = ''
          let finish: string | undefined
          let done = false
          for await (const data of sseData(response)) {
            if (data === '[DONE]') { done = true; break }
            const chunk = JSON.parse(data)
            reason = 'response model does not match requested model'
            if (chunk.model !== row.model) throw new Error()
            reason = 'invalid or incomplete stream'
            if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw new Error()
            if (chunk.usage) {
              const { prompt_tokens, completion_tokens } = chunk.usage
              if (!Number.isFinite(prompt_tokens) || !Number.isFinite(completion_tokens)) throw new Error()
              usage.input_tokens += prompt_tokens
              usage.output_tokens += completion_tokens
            }
            const choice = chunk.choices[0]
            if (!choice) continue
            if (finish !== undefined || choice.index !== 0 || !choice.delta) throw new Error()
            const delta = choice.delta
            if (delta.content !== undefined && delta.content !== null) {
              if (typeof delta.content !== 'string') throw new Error()
              content += delta.content
              yield { kind: 'token', text: delta.content }
            }
            for (const part of delta.tool_calls ?? []) {
              if (!Number.isInteger(part.index) || part.index < 0) throw new Error()
              const call = calls.get(part.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
              call.id += part.id ?? ''
              call.function.name += part.function?.name ?? ''
              call.function.arguments += part.function?.arguments ?? ''
              calls.set(part.index, call)
            }
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason
          }
          if (!done || !['stop', 'tool_calls'].includes(finish ?? '') || (finish === 'stop' && calls.size > 0)) throw new Error()
          if (finish === 'stop') {
            yield { kind: 'completion', usage, substrate_instance_id: options.substrate_instance_id }
            return
          }
          // Validate the entire batch BEFORE any tool can have side effects.
          reason = 'invalid or undeclared tool call'
          const ids = new Set<string>()
          const parsed = [...calls.values()].map((call) => {
            if (!call.id || ids.has(call.id) || !spec.tools.some((tool) => tool.name === call.function.name)) throw new Error()
            ids.add(call.id)
            return { call, args: JSON.parse(call.function.arguments) as unknown }
          })
          if (parsed.length === 0) throw new Error()
          messages.push({ role: 'assistant', content: content || null, tool_calls: [...calls.values()] })
          for (const { call, args } of parsed) {
            reason = 'tool execution failed'
            yield { kind: 'tool_call', call_id: call.id, tool_name: call.function.name, args }
            if (signal.aborted) throw new Error()
            const output = await options.resolver({ call_id: call.id, tool_name: call.function.name, args })
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) ?? 'null' })
          }
        }
      } catch {
        // Neither provider bodies nor resolver exceptions are safe to echo.
        if (ac.signal.aborted) { code = 'aborted'; reason = 'cancelled' }
        yield { kind: 'error', ...(code === undefined ? {} : { code }), retryable: false, message: `configured model ${name}: ${reason}` }
      } finally { ac.abort() }
    })()
    return { events, tool_resolution: 'internal',
      async respondToTool() { throw new Error('configured chat resolves tools internally') },
      async cancel() { ac.abort() },
    }
  } }
}

/** SSE framing handles split UTF-8, CRLF, comments and multi-line data. */
async function* sseData(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length > 1_048_576) throw new Error()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}
