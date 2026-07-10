/**
 * @neutronai/gbrain-memory — agent tool surface (`memory_search`).
 *
 * P0-2 — native memory RECALL. Scribe WRITES entities + extracted facts into
 * the long-term memory store on every chat turn (`scribe/write-to-gbrain.ts` →
 * `GBrainSyncHook` → `MemoryStore.add`). Until now the spawned agent had NO
 * tool to read any of it back: the only agent-facing search tools were
 * `doc_search` (project markdown) and `message_search` (raw chat history) —
 * neither covers the entity / company / project / fast-fact drawers the scribe
 * populates. This registers `memory_search` so the live agent can recall what
 * it already knows about a person / company / topic mid-reasoning, closing the
 * write→read asymmetry the lift audit flagged.
 *
 * This is the agent-native twin of Vajra's `mcp__qmd__query` /
 * `mcp__mempalace__search` native MCP recall. It rides on the #87 tools-bridge:
 * registered into the SAME `neutron-tools` registry the bridge advertises, the
 * live chat REPL (which opts in via `enableToolBridge: true`) reaches it as
 * `mcp__neutron__memory_search`.
 *
 * BACKEND-NEUTRAL (RA5 / invariant I2): this surface is written entirely
 * against the `MemoryStore` interface — nothing in the tool name, schema, or
 * agent-facing prose leaks the backing store. Today the store is the SAME
 * `GBrainMemoryStore.query` the admin "Memory" tab uses, so the write path
 * (scribe) and the read path (this tool) share one index; swapping the backend
 * for any other `implements MemoryStore` leaves this file's contract intact.
 * The widening "beyond project docs to a vault-wide search" the audit asks for
 * is the corpus itself: the memory store holds the entity pages (people/
 * companies/projects/meetings/concepts/originals) + scribe facts, a different
 * corpus than `doc_search`'s project files.
 *
 * Read-only; gates on `read:memory`. A host whose memory backend is
 * unavailable (e.g. the `gbrain` binary is missing) degrades to an empty
 * result rather than a broken tool — that fail-soft is owned by the
 * `MemoryStore` implementation (the backend adapter), not decided here, so
 * this surface stays free of backend-specific error handling. Results are
 * plain JSON the registry serialises into the agent's `tool_result`.
 */

import type { JsonSchemaDocument } from '@neutronai/core-sdk/types.ts'
import type { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { MemoryStore } from './memory-store.ts'

export const MEMORY_SEARCH_TOOL = 'memory_search'

/** Cap each result's body so a recall never floods the agent's context. */
const PREVIEW_CAP = 600

/** Default page count when the agent omits `limit`. */
const DEFAULT_LIMIT = 10

/** Hard ceiling mirrored from the input schema's `maximum`. */
const MAX_LIMIT = 50

const memorySearchInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "Free-text recall query (keywords or a phrase) over the owner's memory: " +
        'people, companies, projects, meetings, concepts, originals, and facts the ' +
        'scribe extracted from earlier turns. Pass an empty string to list the most ' +
        'recently updated memory entries.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_LIMIT,
      description: 'Max memory entries to return (default 10).',
    },
  },
  required: ['query'],
  additionalProperties: false,
}

const memorySearchOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory entry slug / id, e.g. "jane-doe".' },
          title: { type: 'string', description: 'Entry title (the entity / fact heading).' },
          content: {
            type: 'string',
            description: 'Matched memory excerpt (entity body or extracted fact).',
          },
          score: {
            type: 'number',
            description: 'Relevance in descending order; 0 for the empty-query recency listing.',
          },
          kind: {
            type: 'string',
            description:
              'Memory entry kind (e.g. person / company / concept) when the store classifies it.',
          },
        },
        required: ['id', 'content', 'score'],
      },
    },
  },
  required: ['results'],
}

interface MemorySearchArgs {
  query?: unknown
  limit?: unknown
}

/**
 * Register `memory_search` against `registry`, backed by the owner's
 * `MemoryStore` (today the same `GBrainMemoryStore` the admin Memory tab + the
 * scribe sync hook share — but this surface depends only on the interface).
 * Returns the registered tool name.
 */
export function registerMemorySearchToolSurface(
  registry: ToolRegistry,
  store: MemoryStore,
): string[] {
  registry.register({
    name: MEMORY_SEARCH_TOOL,
    description:
      "Search the owner's long-term MEMORY — people, companies, projects, meetings, " +
      'concepts, originals, and facts extracted from earlier conversations by the scribe ' +
      '— and return the most relevant memory entries, ranked, with a matching excerpt. ' +
      'This is the recall twin of the scribe write path: anything stated in an earlier ' +
      'turn and remembered is searchable here. Distinct from doc_search (project files) ' +
      'and message_search (raw chat history). Use it to recall what you already know ' +
      'about a person / company / topic before asking the user.',
    input_schema: memorySearchInputSchema,
    output_schema: memorySearchOutputSchema,
    capability_required: 'read:memory',
    approval_policy: 'auto',
    handler: async (args) => {
      const a = (args ?? {}) as MemorySearchArgs
      const query = typeof a.query === 'string' ? a.query : ''
      const limit =
        typeof a.limit === 'number' && Number.isFinite(a.limit)
          ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(a.limit)))
          : DEFAULT_LIMIT
      // Backend-neutral: this tool depends only on `MemoryStore.query`. The
      // fail-soft "unavailable backend → empty recall" policy lives inside the
      // store implementation (the GBrain adapter owns its own unavailability
      // mode), so nothing here references a backend-specific error (I2).
      const rows = await store.query({ query, limit })
      // Backends may rank CHUNKS (GBrain's `search` does), so one entry can
      // surface multiple rows. Rows arrive score-descending, so keeping the
      // first per id yields the best chunk per entry — the agent wants
      // distinct memory entries, not repeated slugs.
      const seen = new Set<string>()
      const results: Array<{
        id: string
        title?: string
        content: string
        score: number
        kind?: string
      }> = []
      for (const r of rows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        const meta = (r.metadata ?? {}) as Record<string, unknown>
        // GBrain returns the entry kind as `type` on both `search` + `list_pages`
        // rows (verified against a real PGLite brain). The scribe's own
        // `entity_kind` is dropped at write time (GBrainMemoryStore.add persists
        // only slug+content), so prefer the real `type` field and keep
        // `entity_kind` only as a defensive fallback for future write paths.
        const kindRaw = meta['type'] ?? meta['entity_kind']
        const kind = typeof kindRaw === 'string' && kindRaw.length > 0 ? kindRaw : undefined
        const title =
          typeof meta['title'] === 'string' && (meta['title'] as string).length > 0
            ? (meta['title'] as string)
            : undefined
        const content =
          r.content.length > PREVIEW_CAP ? `${r.content.slice(0, PREVIEW_CAP)}…` : r.content
        results.push({
          id: r.id,
          ...(title !== undefined ? { title } : {}),
          content,
          score: Number(r.score.toFixed(4)),
          ...(kind !== undefined ? { kind } : {}),
        })
      }
      return { results }
    },
  })

  return [MEMORY_SEARCH_TOOL]
}
