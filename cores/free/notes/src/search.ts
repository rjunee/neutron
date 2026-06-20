/**
 * @neutronai/notes — KG-traverse + lex/vec hybrid search.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.4 + § 6.4.
 *
 * v1 (S1) implementation:
 *   - lex half: SQLite FTS5 BM25 over `notes_fts` (via NotesStore.ftsSearch).
 *   - vec half: deterministic-rank stub. Returns the lex rows in
 *     lex-rank order with `why='lex'`. The shape leaves a `vec`
 *     branch hookable for S2 without changing the caller.
 *   - KG-traverse half: if the query starts with `#<note_id>`, the
 *     traverse half returns 1-hop outgoing neighbors with
 *     `why='kg_traverse'`; otherwise inert.
 *
 * The hybrid merge uses reciprocal-rank fusion (Cormack 2009). Ties
 * broken by `updated_at DESC`.
 */

import type { NotesStore } from './notes-store.ts'

export interface SearchHit {
  note_id: string
  drawer_id: string
  snippet: string
  /** Hybrid score in [0, 1]; higher = better match. */
  score: number
  why: 'lex' | 'vec' | 'lex+vec' | 'kg_traverse'
  updated_at: number
}

export interface SearchOptions {
  store: NotesStore
  project_id: string
  query: string
  limit?: number
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
/** Reciprocal-rank-fusion `k` constant (Cormack 2009 recommends 60). */
const RRF_K = 60
/** Soft snippet cap. */
const SNIPPET_CHARS = 240

/**
 * Hybrid lex + vec + KG-traverse search.
 *
 * The function is async-shaped even though the v1 implementation is
 * synchronous — S2's vec embeddings will introduce a remote call,
 * and the caller already awaits.
 */
export async function search(opts: SearchOptions): Promise<SearchHit[]> {
  const limit = clampLimit(opts.limit ?? DEFAULT_LIMIT)
  const query = opts.query.trim()
  if (query.length === 0) return []

  // KG-traverse short-circuit: `#<note_id>` syntax surfaces 1-hop
  // outgoing neighbors with `why='kg_traverse'`. Ignores the rest of
  // the query for v1.
  if (query.startsWith('#')) {
    const seedId = query.slice(1).split(/\s+/)[0]
    if (seedId !== undefined && seedId.length > 0) {
      return kgTraverseHits(opts.store, seedId, limit)
    }
  }

  // Lex half — BM25 ranks.
  const lex = opts.store.ftsSearch(query, limit * 3) // overshoot so RRF fusion has signal
  if (lex.length === 0) return []

  // Hydrate notes for the lex hits so the response carries snippets +
  // drawer ids + timestamps. Drop hits whose note row is gone (soft-
  // deleted between FTS write + search; the FTS triggers cover this
  // case but tags can lag.)
  const lexHydrated = lex
    .map((hit, idx) => {
      const note = opts.store.getNote(hit.note_id)
      if (note === null) return null
      return {
        note_id: hit.note_id,
        drawer_id: note.drawer_id,
        snippet: buildSnippet(note.content, query),
        lex_rank: idx,
        updated_at: note.updated_at,
      }
    })
    .filter((h): h is NonNullable<typeof h> => h !== null)

  // Vec half stub — lex rows in lex order, with `why='lex'`.
  // The stub deliberately uses the SAME rank order so RRF fusion
  // collapses to the lex ranking without adding noise. S2 swaps in
  // a real embedding store + reciprocal-rank fusion against the lex
  // half.
  const vecHydrated = lexHydrated.map((h, idx) => ({
    ...h,
    vec_rank: idx,
  }))

  // Reciprocal-rank fusion. Each hit gets two contributions:
  // 1/(k + lex_rank) + 1/(k + vec_rank). The vec stub mirrors lex so
  // the fused score equals 2 * 1/(k + r) — the relative order is
  // unchanged but the score field exposes a sensible [0, 1] number.
  const maxScore = 2 / (RRF_K + 1)
  const fused: SearchHit[] = lexHydrated.map((h, idx) => {
    const vec = vecHydrated[idx]
    if (vec === undefined) {
      // Defensive; mirror is 1:1 in v1.
      return {
        note_id: h.note_id,
        drawer_id: h.drawer_id,
        snippet: h.snippet,
        score: (1 / (RRF_K + h.lex_rank + 1)) / maxScore,
        why: 'lex',
        updated_at: h.updated_at,
      }
    }
    const raw = 1 / (RRF_K + h.lex_rank + 1) + 1 / (RRF_K + vec.vec_rank + 1)
    return {
      note_id: h.note_id,
      drawer_id: h.drawer_id,
      snippet: h.snippet,
      score: raw / (2 * maxScore),
      why: 'lex',
      updated_at: h.updated_at,
    }
  })

  fused.sort(byScoreDescThenUpdatedAtDesc)
  return fused.slice(0, limit)
}

function kgTraverseHits(store: NotesStore, seedNoteId: string, limit: number): SearchHit[] {
  const traversal = store.traverse(seedNoteId, 1)
  const out: SearchHit[] = []
  for (const edge of traversal.edges) {
    const targetNode = traversal.nodes.find((n) => n.id === edge.target_id)
    if (targetNode?.note_id === null || targetNode?.note_id === undefined) continue
    const note = store.getNote(targetNode.note_id)
    if (note === null) continue
    out.push({
      note_id: note.id,
      drawer_id: note.drawer_id,
      snippet: buildSnippet(note.content, ''),
      score: 1.0,
      why: 'kg_traverse',
      updated_at: note.updated_at,
    })
    if (out.length >= limit) break
  }
  return out
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.trunc(n), MAX_LIMIT)
}

function buildSnippet(content: string, query: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (query.length === 0) return flat.slice(0, SNIPPET_CHARS)
  const tokens = query
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return flat.slice(0, SNIPPET_CHARS)
  const lower = flat.toLowerCase()
  let firstHit = -1
  for (const tok of tokens) {
    const idx = lower.indexOf(tok.toLowerCase())
    if (idx !== -1 && (firstHit === -1 || idx < firstHit)) firstHit = idx
  }
  if (firstHit === -1) return flat.slice(0, SNIPPET_CHARS)
  // Center the window on the first match.
  const start = Math.max(0, firstHit - Math.floor(SNIPPET_CHARS / 4))
  return flat.slice(start, start + SNIPPET_CHARS)
}

function byScoreDescThenUpdatedAtDesc(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) return b.score - a.score
  return b.updated_at - a.updated_at
}
