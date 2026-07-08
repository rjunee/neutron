/**
 * @neutronai/doc-search — agent tool surface.
 *
 * Registers the live-agent tools into the shared `ToolRegistry` so the
 * chat agent can search + read project docs mid-conversation (the
 * agent-native QMD equivalent). Two tools:
 *
 *   - `doc_search` — BM25 keyword search across every project's
 *     markdown (README / STATUS / CLAUDE / docs / research / notes /
 *     archive). Returns ranked DOCUMENTS with the matching section's
 *     heading + snippet so the agent can decide what to open.
 *   - `doc_read` — read one doc by (project, path), path-safe. The
 *     natural follow-up to a search hit.
 *
 * Both are read-only and gate on the `read:docs` capability. Handler
 * results are plain JSON (the registry serialises them to the agent).
 */

import type { JsonSchemaDocument } from '@neutronai/core-sdk/types.ts'
import type { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { DocSearchRuntime } from './runtime.ts'

export const DOC_SEARCH_TOOL = 'doc_search'
export const DOC_READ_TOOL = 'doc_read'

const docSearchInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Free-text search query (keywords or a phrase).' },
    project: {
      type: 'string',
      description: 'Optional project id to scope the search to a single project folder.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Max documents to return (default 10).',
    },
  },
  required: ['query'],
  additionalProperties: false,
}

const docSearchOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          path: { type: 'string', description: 'Project-relative path, e.g. docs/plan.md.' },
          title: { type: 'string' },
          heading: { type: 'string', description: 'Matching section heading ("" for preamble).' },
          score: { type: 'number', description: 'Relevance in [0,1]; higher is better.' },
          snippet: { type: 'string', description: 'Excerpt with [..] match markers.' },
        },
        required: ['project', 'path', 'title', 'score', 'snippet'],
      },
    },
  },
  required: ['results'],
}

const docReadInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    project: { type: 'string', description: 'Project id (folder under Projects/).' },
    path: { type: 'string', description: 'Project-relative markdown path, e.g. STATUS.md.' },
  },
  required: ['project', 'path'],
  additionalProperties: false,
}

const docReadOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    project: { type: 'string' },
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['found'],
}

interface DocSearchArgs {
  query?: unknown
  project?: unknown
  limit?: unknown
}

interface DocReadArgs {
  project?: unknown
  path?: unknown
}

/**
 * Register `doc_search` + `doc_read` against `registry`, backed by the
 * supplied runtime. Returns the registered tool names.
 */
export function registerDocSearchToolSurface(
  registry: ToolRegistry,
  runtime: DocSearchRuntime,
): string[] {
  registry.register({
    name: DOC_SEARCH_TOOL,
    description:
      'Search across all of the owner\'s project documentation (README, STATUS, docs, ' +
      'research, notes) by keyword and return the most relevant documents, ranked, with ' +
      'a matching snippet. Use this to find context before asking the user.',
    input_schema: docSearchInputSchema,
    output_schema: docSearchOutputSchema,
    capability_required: 'read:docs',
    approval_policy: 'auto',
    handler: async (args) => {
      const a = (args ?? {}) as DocSearchArgs
      const query = typeof a.query === 'string' ? a.query : ''
      const input: Parameters<DocSearchRuntime['search']>[0] = { query }
      if (typeof a.project === 'string' && a.project.length > 0) input.project = a.project
      if (typeof a.limit === 'number' && Number.isFinite(a.limit)) input.limit = Math.trunc(a.limit)
      const results = await runtime.search(input)
      return {
        results: results.map((r) => ({
          project: r.project,
          path: r.path,
          title: r.title,
          heading: r.heading,
          score: Number(r.score.toFixed(4)),
          snippet: r.snippet,
        })),
      }
    },
  })

  registry.register({
    name: DOC_READ_TOOL,
    description:
      'Read one project document by project id and relative path (e.g. project="topline", ' +
      'path="docs/plan.md"). Typically used to open a document surfaced by doc_search.',
    input_schema: docReadInputSchema,
    output_schema: docReadOutputSchema,
    capability_required: 'read:docs',
    approval_policy: 'auto',
    handler: async (args) => {
      const a = (args ?? {}) as DocReadArgs
      const project = typeof a.project === 'string' ? a.project : ''
      const path = typeof a.path === 'string' ? a.path : ''
      const doc = await runtime.read(project, path)
      if (doc === null) return { found: false }
      return { found: true, project: doc.project, path: doc.path, content: doc.content }
    },
  })

  return [DOC_SEARCH_TOOL, DOC_READ_TOOL]
}
