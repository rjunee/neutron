/**
 * @neutronai/message-search — agent tool surface.
 *
 * Registers the live-agent `message_search` tool into the shared
 * {@link ToolRegistry} so the chat agent can full-text-search the CHAT
 * HISTORY mid-conversation — the agent-native counterpart to the user's
 * search box, and the chat-history twin of `doc_search` (which searches
 * project docs).
 *
 * By default the search is scoped to the CURRENT conversation (the call's
 * `topic_id`), which is the dominant need ("where did we land on X earlier?").
 * Passing `global: true` widens it to every conversation when the backing
 * runtime holds them (a client store-backed runtime); the server's per-topic
 * history runtime treats `global` as "no results" rather than pretending.
 *
 * Read-only; gates on `read:project_data`. Results are plain JSON the registry
 * serialises back to the agent.
 */

import type { JsonSchemaDocument } from '../core-sdk/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { MessageSearchRequest, MessageSearchRuntime } from './runtime.ts'

export const MESSAGE_SEARCH_TOOL = 'message_search'

const inputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Free-text search query (keywords or a phrase).' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max messages to return (default 20).',
    },
    global: {
      type: 'boolean',
      description:
        'Search across ALL of the user\'s conversations instead of just the current one. ' +
        'Defaults to false (current conversation only).',
    },
  },
  required: ['query'],
  additionalProperties: false,
}

const outputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic_id: { type: 'string' },
          id: { type: 'string', description: 'Stable message id (message_id, else client_msg_id).' },
          role: { type: 'string', enum: ['user', 'agent'] },
          project_id: { type: 'string' },
          score: { type: 'number', description: 'Relevance in [0,1]; higher is better.' },
          snippet: { type: 'string', description: 'Excerpt with [..] match markers.' },
          body: { type: 'string', description: 'The full message text.' },
          created_at: { type: 'number', description: 'Epoch-ms the message was created.' },
        },
        required: ['topic_id', 'id', 'role', 'score', 'snippet', 'body'],
      },
    },
  },
  required: ['results'],
}

interface MessageSearchArgs {
  query?: unknown
  limit?: unknown
  global?: unknown
}

/**
 * Register `message_search` against `registry`, backed by `runtime`. Returns
 * the registered tool name. The handler defaults the search scope to the
 * call's originating `topic_id` (the current conversation) unless `global`.
 */
export function registerMessageSearchToolSurface(
  registry: ToolRegistry,
  runtime: MessageSearchRuntime,
): string {
  registry.register({
    name: MESSAGE_SEARCH_TOOL,
    description:
      'Search the user\'s chat history by keyword and return the most relevant messages, ' +
      'ranked, with a highlighted snippet. Scoped to the CURRENT conversation by default; ' +
      'pass global=true to search every conversation. Use this to recall what was said ' +
      'earlier instead of asking the user to repeat themselves.',
    input_schema: inputSchema,
    output_schema: outputSchema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as MessageSearchArgs
      const query = typeof a.query === 'string' ? a.query : ''
      const req: MessageSearchRequest = { query }
      if (a.global === true) {
        req.global = true
      } else if (ctx.topic_id !== null && ctx.topic_id.length > 0) {
        req.topic_id = ctx.topic_id
      }
      if (typeof a.limit === 'number' && Number.isFinite(a.limit)) req.limit = Math.trunc(a.limit)
      const hits = await runtime.search(req)
      return {
        results: hits.map((h) => ({
          topic_id: h.topic_id,
          id: h.id,
          role: h.role,
          project_id: h.project_id,
          score: h.score,
          snippet: h.snippet,
          body: h.body,
          created_at: h.created_at,
        })),
      }
    },
  })
  return MESSAGE_SEARCH_TOOL
}
