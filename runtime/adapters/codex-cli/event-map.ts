/**
 * @neutronai/runtime — Codex CLI JSONL → substrate Event mapping.
 *
 * Mapping table per internal design notes
 * § Q9(A) (Codex CLI JSONL emission shape):
 *
 *   thread.started        → swallow (capture thread_id for substrate_instance_id)
 *   turn.started          → swallow
 *   item.agent_message    → token
 *   item.reasoning        → thinking
 *   item.command_execution → tool_call(name='shell')
 *   item.mcp_tool_call    → tool_call(name=`${server}.${tool}`)
 *   item.web_search       → tool_call(name='web_search')
 *   item.plan_update      → thinking (serialized plan)
 *   item.file_change      → tool_call(name='edit')
 *   turn.completed        → completion (usage)
 *   turn.failed           → error
 *   error                 → error
 *
 * `tool_resolution: 'internal'` — tools are resolved by Codex's own MCP
 * machinery (configured in `~/.codex/config.toml`), so the `tool_call` events
 * are informational only.
 */

import type { Event, TokenUsage } from '../../events.ts'

export interface CodexJsonlMapper {
  /** thread_id captured from the most recent `thread.started`. */
  thread_id?: string
  /** Last seen usage; carried forward for the synthetic completion if the stream truncates. */
  last_usage: TokenUsage
}

export function newCodexJsonlMapper(): CodexJsonlMapper {
  return {
    last_usage: { input_tokens: 0, output_tokens: 0 },
  }
}

interface CodexEnvelope {
  type?: string
  thread_id?: string
  text?: string
  command?: string
  output?: string
  server?: string
  tool?: string
  input?: unknown
  query?: string
  plan?: unknown
  path?: string
  diff?: string
  usage?: Partial<TokenUsage>
  error?: { message?: string } | string
  message?: string
  call_id?: string
}

/**
 * Map one parsed JSONL envelope to zero-or-one substrate `Event`. Returns
 * `null` for envelopes the substrate semantics do not surface (e.g.
 * `turn.started`).
 */
export function mapCodexEvent(env: unknown, mapper: CodexJsonlMapper): Event | null {
  if (typeof env !== 'object' || env === null) return null
  const e = env as CodexEnvelope
  switch (e.type) {
    case 'thread.started': {
      if (typeof e.thread_id === 'string') mapper.thread_id = e.thread_id
      return null
    }
    case 'turn.started':
      return null
    case 'item.agent_message': {
      if (typeof e.text !== 'string') return null
      return { kind: 'token', text: e.text }
    }
    case 'item.reasoning': {
      if (typeof e.text !== 'string') return null
      return { kind: 'thinking', text: e.text }
    }
    case 'item.command_execution': {
      const args: Record<string, unknown> = {}
      if (typeof e.command === 'string') args['command'] = e.command
      if (typeof e.output === 'string') args['output'] = e.output
      return {
        kind: 'tool_call',
        tool_name: 'shell',
        args,
        call_id: e.call_id ?? mintCallId(),
      }
    }
    case 'item.mcp_tool_call': {
      const tool_name = `${e.server ?? '?'}.${e.tool ?? '?'}`
      return {
        kind: 'tool_call',
        tool_name,
        args: e.input ?? {},
        call_id: e.call_id ?? mintCallId(),
      }
    }
    case 'item.web_search': {
      return {
        kind: 'tool_call',
        tool_name: 'web_search',
        args: { query: e.query ?? '' },
        call_id: e.call_id ?? mintCallId(),
      }
    }
    case 'item.plan_update': {
      return { kind: 'thinking', text: JSON.stringify(e.plan ?? null) }
    }
    case 'item.file_change': {
      return {
        kind: 'tool_call',
        tool_name: 'edit',
        args: { path: e.path ?? '', diff: e.diff ?? '' },
        call_id: e.call_id ?? mintCallId(),
      }
    }
    case 'turn.completed': {
      if (e.usage) mapper.last_usage = { ...mapper.last_usage, ...e.usage }
      return {
        kind: 'completion',
        usage: { ...mapper.last_usage },
        substrate_instance_id: mapper.thread_id ?? '__codex_unknown__',
      }
    }
    case 'turn.failed':
    case 'error': {
      const message =
        typeof e.error === 'string'
          ? e.error
          : (e.error?.message ?? e.message ?? 'unknown codex error')
      return { kind: 'error', message, retryable: false }
    }
    default:
      return null
  }
}

function mintCallId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `codex-call-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}
