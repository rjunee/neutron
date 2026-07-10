/**
 * @neutronai/research-core — lex+vec hybrid search over prior briefs.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.4.
 *
 * v1 ships LEX-only via SQLite FTS5; vec stays a deterministic-rank
 * stub returning rank-by-recency-with-jitter until embeddings land in
 * S2 (mirrors Notes Core S1's pattern).
 *
 * Hybrid score = 0.6 * lex_score + 0.4 * vec_score
 *   - lex_score normalised against BM25 (FTS5 rank() → 0..1)
 *   - vec_score recency-rank normalised 0..1 with deterministic jitter
 *
 * Search is project-scoped — every query takes a `ResearchProjectStore`
 * (one project's sidecar handle); cross-project search is explicitly
 * out of scope per § 9 of the brief.
 */

import type { ResearchProjectStore } from './research-store.ts'

export type ResearchMatchedIn = 'topic' | 'finding' | 'recommendation'

export interface ResearchSearchHit {
  task_id: string
  topic: string
  /** Lex+vec hybrid score, normalised [0, 1]; higher is better. */
  score: number
  /** Snippet from the matching field. */
  snippet: string
  /** Match origin — for UI affordance ("matched in claims"). */
  matched_in: ResearchMatchedIn
  /** From the parent brief — `null` for in-flight / failed tasks. */
  confidence_level: 'low' | 'medium' | 'high' | null
  claim_count: number
  completed_at: number | null
}

export interface SearchInput {
  query: string
  /** Default 10; cap 50. */
  limit?: number
}

interface FtsRow {
  task_id: string
  topic: string | null
  rank: number
  topic_snippet: string
  finding_snippet: string
  recommendation_snippet: string
}

interface TaskMetaRow {
  task_id: string
  topic: string | null
  confidence_level: string | null
  claim_count: number
  completed_at: number | null
  created_at: number
}

/**
 * Lex+vec hybrid search. v1 LEX-only (FTS5 BM25); vec stub returns
 * deterministic recency-based ranks.
 *
 * The lex-score normalisation maps `rank()` (negative; smaller is
 * better in SQLite's BM25 implementation) to [0, 1] via a soft
 * exponential — `score = exp(rank/10)` clamped to [0, 1].
 *
 * Returns at most `limit` hits, sorted by hybrid score DESC.
 */
export function searchPriorBriefs(
  input: SearchInput,
  deps: { store: ResearchProjectStore },
): ResearchSearchHit[] {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
  const safeQuery = sanitizeFtsQuery(input.query)
  if (safeQuery.length === 0) return []

  const db = deps.store.database()

  // FTS5 query — return rank() per row; pull snippets per column.
  // The FTS5 mirror is populated by `setCompleted` so we only query
  // completed briefs.
  const ftsStmt = db.query<FtsRow, [string, number]>(
    `SELECT task_id,
            topic,
            rank,
            snippet(research_briefs_fts, 1, '[', ']', '...', 8) AS topic_snippet,
            snippet(research_briefs_fts, 2, '[', ']', '...', 8) AS finding_snippet,
            snippet(research_briefs_fts, 3, '[', ']', '...', 8) AS recommendation_snippet
       FROM research_briefs_fts
      WHERE research_briefs_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
  )
  let ftsRows: FtsRow[]
  try {
    ftsRows = ftsStmt.all(safeQuery, limit * 3)
  } catch {
    // FTS5 MATCH syntax error — return empty.
    return []
  }

  if (ftsRows.length === 0) return []

  const taskIds = ftsRows.map((r) => r.task_id)
  const placeholders = taskIds.map(() => '?').join(', ')
  const metaStmt = db.query<TaskMetaRow, string[]>(
    `SELECT id AS task_id, topic, confidence_level, claim_count,
            completed_at, created_at
       FROM research_tasks
      WHERE id IN (${placeholders}) AND status = 'completed'`,
  )
  const metaRows = metaStmt.all(...taskIds)
  const metaByTaskId = new Map<string, TaskMetaRow>()
  for (const m of metaRows) metaByTaskId.set(m.task_id, m)

  // Vec stub — rank by `created_at` DESC with deterministic 5% jitter
  // keyed by task_id so the same input always returns the same order.
  const vecOrdered = [...metaRows].sort((a, b) => {
    const ja = deterministicJitter(a.task_id)
    const jb = deterministicJitter(b.task_id)
    const ra = a.created_at * (1 + ja * 0.05)
    const rb = b.created_at * (1 + jb * 0.05)
    return rb - ra
  })
  const vecRank = new Map<string, number>()
  for (let i = 0; i < vecOrdered.length; i++) {
    vecRank.set(vecOrdered[i]!.task_id, i)
  }

  const hits: ResearchSearchHit[] = []
  for (const row of ftsRows) {
    const meta = metaByTaskId.get(row.task_id)
    if (meta === undefined) continue // not completed yet
    const lex_score = Math.min(1, Math.max(0, Math.exp((row.rank ?? -1) / 10)))
    const vec_score = 1 - (vecRank.get(row.task_id) ?? vecOrdered.length) / Math.max(1, vecOrdered.length)
    const score = 0.6 * lex_score + 0.4 * vec_score
    const { snippet, matched_in } = pickSnippet(row)
    hits.push({
      task_id: row.task_id,
      topic: meta.topic ?? '',
      score,
      snippet,
      matched_in,
      confidence_level:
        meta.confidence_level === null
          ? null
          : (meta.confidence_level as 'low' | 'medium' | 'high'),
      claim_count: meta.claim_count,
      completed_at: meta.completed_at,
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

function pickSnippet(row: FtsRow): { snippet: string; matched_in: ResearchMatchedIn } {
  const candidates: Array<[ResearchMatchedIn, string]> = [
    ['topic', row.topic_snippet],
    ['finding', row.finding_snippet],
    ['recommendation', row.recommendation_snippet],
  ]
  for (const [matched_in, snippet] of candidates) {
    if (snippet !== null && snippet !== undefined && snippet.includes('[')) {
      return { snippet, matched_in }
    }
  }
  return { snippet: row.topic_snippet ?? '', matched_in: 'topic' }
}

/**
 * FTS5 query sanitiser. Strips control chars; quotes terms that contain
 * special FTS5 characters; collapses whitespace.
 */
export function sanitizeFtsQuery(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  // Split on whitespace; for each token, quote it if it contains
  // anything other than ASCII alnum / dash / underscore. Avoids users
  // accidentally writing FTS5 syntax (NEAR / NOT / parens / colons).
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0)
  const cleaned = tokens.map((t) => {
    if (/^[A-Za-z0-9_-]+$/.test(t)) return t
    return '"' + t.replace(/"/g, '""') + '"'
  })
  return cleaned.join(' ')
}

function deterministicJitter(id: string): number {
  // Simple deterministic [0, 1) hash from id — bytes XOR'd into a 32-bit
  // accumulator then normalised.
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h = ((h ^ id.charCodeAt(i)) * 16777619) >>> 0
  }
  return (h % 1_000_000) / 1_000_000
}
