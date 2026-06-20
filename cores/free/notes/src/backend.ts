/**
 * @neutronai/notes — legacy `NotesBackend` interface + NotesStore adapter.
 *
 * The Notes Core v0.1.0 exposed `NotesBackend` (write / recall / list /
 * link) over a prior in-tree MemoryStore adapter. The
 * v0.2.0 sprint (Notes Core S1, 2026-05-20):
 *
 *  - keeps the `NotesBackend` interface so the four legacy MCP tools
 *    (notes_write / notes_recall / notes_list / notes_link) preserve
 *    their wire shape, and
 *  - replaces the prior MemoryStore adapter with a
 *    new `buildNotesStoreBackend(resolver, default_project_id)` that
 *    routes the legacy operations through the per-project NotesStore.
 *
 * The prior external memory workspace dependency is DROPPED at the
 * `package.json` layer; no code under `cores/free/notes/` imports the
 * old `MemoryStore` type. See docs/plans/notes-core-tier1-brief.md
 * § 5 for the rationale (zero Nova imports, ZERO external memory runtime
 * coupling — the schema is re-implemented in-tree).
 */

import type { NotesStore } from './notes-store.ts'
import type { NotesStoreResolver } from './store-resolver.ts'

/**
 * Row shape callers receive on `recall` / `list`. Mirrors the v0.1.0
 * envelope so legacy MCP-tool consumers don't re-version their schema.
 */
export interface NoteRow {
  id: string
  content: string
  score: number
  metadata: Record<string, unknown>
}

export interface NotesWriteInput {
  content: string
  tags?: readonly string[]
  /** Project scope — when omitted, the backend's `default_project_id`
   *  applies. */
  project_id?: string
}

export interface NotesRecallInput {
  query: string
  limit?: number
  project_id?: string
}

export interface NotesListInput {
  limit?: number
  project_id?: string
}

export interface NotesLinkInput {
  source_id: string
  target_id: string
  project_id?: string
}

export interface NotesLinkResult {
  ok: true
  link_id: string
}

export interface NotesBackend {
  write(input: NotesWriteInput): Promise<{ id: string }>
  recall(input: NotesRecallInput): Promise<NoteRow[]>
  list(input: NotesListInput): Promise<NoteRow[]>
  link(input: NotesLinkInput): Promise<NotesLinkResult>
}

const DEFAULT_LIST_LIMIT = 50

/**
 * Internal metadata-keys for the two row shapes the adapter persists.
 * `kind = NOTE_KIND_NOTE` is what `write()` stamps on real notes;
 * `kind = NOTE_KIND_LINK` is reserved (v0.1.0 used it for synthetic
 * link rows; v0.2.0 routes links into `kg_edges` so this constant
 * survives only for back-compat metadata exposure).
 */
export const NOTE_KIND_NOTE = 'notes.note' as const
export const NOTE_KIND_LINK = 'notes.link' as const

export interface NotesStoreBackendOptions {
  resolver: NotesStoreResolver
  /** Project scope used when the caller omits `project_id`. */
  default_project_id: string
}

/**
 * Build a legacy `NotesBackend` that routes the four legacy operations
 * through the per-project `NotesStore`. The S1 surfaces (chat commands,
 * drawer-browser HTTP, search, traverse, drawer-create) use the
 * NotesStore directly — only the four legacy MCP tools come through
 * this adapter.
 */
export function buildNotesStoreBackend(opts: NotesStoreBackendOptions): NotesBackend {
  const { resolver, default_project_id } = opts

  const storeFor = async (project_id: string | undefined): Promise<{ store: NotesStore; project_id: string }> => {
    const scope = project_id ?? default_project_id
    return { store: await resolver.resolve(scope), project_id: scope }
  }

  return {
    async write(input: NotesWriteInput): Promise<{ id: string }> {
      const { store } = await storeFor(input.project_id)
      const writeOpts: Parameters<NotesStore['write']>[0] = {
        content: input.content,
      }
      if (input.tags !== undefined) writeOpts.tags = input.tags
      const result = store.write(writeOpts)
      return { id: result.id }
    },

    async recall(input: NotesRecallInput): Promise<NoteRow[]> {
      const { store } = await storeFor(input.project_id)
      const trimmedQuery = input.query.trim()
      if (trimmedQuery.length === 0) {
        // Empty-query recall: degrade to a recent list. Mirrors the
        // v0.1.0 MemoryStore "empty query = most recent" convention.
        const limit = input.limit ?? DEFAULT_LIST_LIMIT
        return store.listNotes({ limit }).map((n, idx) => ({
          id: n.id,
          content: n.content,
          score: 1.0 - idx * 0.001,
          metadata: { kind: NOTE_KIND_NOTE, drawer_id: n.drawer_id, tags: [...n.tags] },
        }))
      }
      const hits = store.ftsSearch(trimmedQuery, input.limit ?? DEFAULT_LIST_LIMIT)
      const out: NoteRow[] = []
      for (const hit of hits) {
        const note = store.getNote(hit.note_id)
        if (note === null) continue
        // BM25 returns negative numbers (lower = better). Transform
        // into a [0, 1]-ish positive score for the legacy envelope.
        const score = 1 / (1 + Math.abs(hit.rank))
        out.push({
          id: note.id,
          content: note.content,
          score,
          metadata: { kind: NOTE_KIND_NOTE, drawer_id: note.drawer_id, tags: [...note.tags] },
        })
      }
      return out
    },

    async list(input: NotesListInput): Promise<NoteRow[]> {
      const { store } = await storeFor(input.project_id)
      const limit = input.limit ?? DEFAULT_LIST_LIMIT
      return store.listNotes({ limit }).map((n, idx) => ({
        id: n.id,
        content: n.content,
        score: 1.0 - idx * 0.001,
        metadata: { kind: NOTE_KIND_NOTE, drawer_id: n.drawer_id, tags: [...n.tags] },
      }))
    },

    async link(input: NotesLinkInput): Promise<NotesLinkResult> {
      const { store } = await storeFor(input.project_id)
      const edge = store.tunnel(input.source_id, input.target_id)
      return { ok: true, link_id: edge.id }
    },
  }
}

/**
 * @deprecated v0.1.0 entry point. Tests that constructed the backend
 * with an in-memory MemoryStore now construct a `NotesStore` against
 * a tmp SQLite + use the resolver. This export is retained as `null`
 * so legacy import sites fail fast with a clear shape mismatch
 * (rather than silently importing `undefined`).
 */
export const buildMemoryStoreNotesBackend = null
