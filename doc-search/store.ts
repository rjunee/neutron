/**
 * @neutronai/doc-search — SQLite FTS5 doc-chunk index.
 *
 * The QMD-equivalent corpus index. Markdown chunks (from `chunk.ts`)
 * are stored in a `bun:sqlite` database with an FTS5 mirror so the
 * agent can BM25-search across every project doc mid-conversation,
 * exactly the way Vajra agents hit QMD before asking the user anything.
 *
 * Design choices (mirroring `cores/free/research/src/vault-search.ts`,
 * the in-repo precedent for FTS5 + BM25):
 *
 *   - `doc_chunks` is the content table (one row per chunk); `doc_fts`
 *     is an EXTERNAL-CONTENT FTS5 mirror over (title, heading, body),
 *     kept in sync by AFTER INSERT/UPDATE/DELETE triggers. This is the
 *     canonical FTS5 contentless-sync pattern, so we only ever write to
 *     `doc_chunks` and search joins back by rowid.
 *   - Ranking is BM25 with column weights (title ≫ heading ≫ body).
 *     SQLite's `bm25()` returns a negative score where MORE-negative is
 *     better; we min-max normalise across the candidate set into a
 *     [0,1] relevance so callers get a stable, human-readable score.
 *   - Results are collapsed to the best-scoring chunk PER FILE so a
 *     "doc search" returns ranked DOCUMENTS (with the matching section's
 *     heading + snippet), not a flood of chunks from one big file.
 *   - Semantic search is OPTIONAL and behind the `embedder` seam — when
 *     no embedder is supplied (the OSS baseline) the index is pure
 *     lexical BM25 and pulls in NO external provider. When an embedder
 *     is supplied, chunk embeddings are stored and the top lexical
 *     candidates are re-ranked by cosine similarity, blended with the
 *     lexical score.
 */

import { Database } from 'bun:sqlite'

import { sanitizeFtsQuery } from './query.ts'

/**
 * Pluggable embedding provider for the optional semantic mode. The
 * baseline never requires one; callers that DO want hybrid search wire
 * a local (OSS) embedder. `embed` is batched for index-time efficiency.
 */
export interface Embedder {
  /** Embedding dimensionality (all vectors must share it). */
  readonly dim: number
  embed(texts: string[]): Promise<number[][]>
}

/** A chunk ready for indexing (one file's worth is upserted atomically). */
export interface ChunkInput {
  heading: string
  ordinal: number
  body: string
}

export interface IndexFileInput {
  project: string
  /** Project-relative POSIX path, e.g. `docs/plan.md`. */
  relpath: string
  absPath: string
  title: string
  mtimeMs: number
  chunks: ChunkInput[]
}

export interface DocSearchHit {
  project: string
  /** Project-relative POSIX path. */
  path: string
  title: string
  /** Heading of the best-matching section ('' for a preamble match). */
  heading: string
  /** Relevance in [0,1]; higher is better. */
  score: number
  /** FTS5 snippet of the matching body, with `[` … `]` match markers. */
  snippet: string
  /** Ordinal of the matching chunk within its file. */
  ordinal: number
}

export interface SearchInput {
  query: string
  /** Restrict to a single project folder. */
  project?: string
  /** Default 10; clamped to [1, 50]. */
  limit?: number
}

export interface IndexStats {
  projects: number
  files: number
  chunks: number
}

/** A matched chunk row returned by the candidate query in `search`. */
interface ChunkRow {
  project: string
  relpath: string
  title: string
  heading: string
  ordinal: number
  bm25: number
  snippet: string
  embedding: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_chunks (
  id         INTEGER PRIMARY KEY,
  project    TEXT NOT NULL,
  relpath    TEXT NOT NULL,
  abs_path   TEXT NOT NULL,
  title      TEXT NOT NULL,
  heading    TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  body       TEXT NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  embedding  TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_file ON doc_chunks(project, relpath);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_project ON doc_chunks(project);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  title, heading, body,
  content='doc_chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
  INSERT INTO doc_fts(rowid, title, heading, body)
  VALUES (new.id, new.title, new.heading, new.body);
END;
CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, title, heading, body)
  VALUES ('delete', old.id, old.title, old.heading, old.body);
END;
CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, title, heading, body)
  VALUES ('delete', old.id, old.title, old.heading, old.body);
  INSERT INTO doc_fts(rowid, title, heading, body)
  VALUES (new.id, new.title, new.heading, new.body);
END;
`

/** BM25 column weights — title matches dominate, then headings, then body. */
const BM25_WEIGHTS = { title: 10.0, heading: 4.0, body: 1.0 } as const

/** Blend weight for the lexical score when hybrid (semantic) mode is on. */
const HYBRID_LEX_WEIGHT = 0.6

/**
 * Hard cap on BM25-ordered candidate chunks pulled before the per-file
 * collapse. High enough that the document `limit` is never starved by one
 * big file's matching sections, bounded so a pathological broad query
 * over a huge corpus can't load unbounded rows into memory.
 */
const CANDIDATE_CAP = 5000

export interface DocSearchIndexOptions {
  /** Optional semantic embedder. Omit for the pure-lexical baseline. */
  embedder?: Embedder
}

export class DocSearchIndex {
  private readonly db: Database
  private readonly embedder: Embedder | null

  private constructor(db: Database, embedder: Embedder | null) {
    this.db = db
    this.embedder = embedder
  }

  /** Open (or create) an index at `path`. Use ':memory:' for tests. */
  static open(path: string, options: DocSearchIndexOptions = {}): DocSearchIndex {
    const db = new Database(path, { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    return new DocSearchIndex(db, options.embedder ?? null)
  }

  /** True iff a semantic embedder is wired (hybrid mode active). */
  get semantic(): boolean {
    return this.embedder !== null
  }

  /** Raw handle — for tests / advanced callers. */
  raw(): Database {
    return this.db
  }

  close(): void {
    this.db.close()
  }

  /**
   * Current indexed-file mtimes for a project, keyed by relpath. The
   * indexer diffs this against the on-disk walk to decide what to
   * (re)index and what to drop.
   */
  fileMtimes(project: string): Map<string, number> {
    const rows = this.db
      .query<{ relpath: string; mtime_ms: number }, [string]>(
        `SELECT relpath, MAX(mtime_ms) AS mtime_ms
           FROM doc_chunks WHERE project = ? GROUP BY relpath`,
      )
      .all(project)
    const out = new Map<string, number>()
    for (const r of rows) out.set(r.relpath, r.mtime_ms)
    return out
  }

  /** All project slugs currently represented in the index. */
  indexedProjects(): string[] {
    const rows = this.db
      .query<{ project: string }, []>(`SELECT DISTINCT project FROM doc_chunks ORDER BY project`)
      .all()
    return rows.map((r) => r.project)
  }

  /**
   * Replace all chunks for one file atomically (delete-then-insert).
   * When an embedder is wired, chunk embeddings are computed and stored.
   */
  async indexFile(input: IndexFileInput): Promise<void> {
    const embeddings = await this.maybeEmbed(input.chunks.map((c) => c.body))
    const now = Date.now()
    const del = this.db.query(`DELETE FROM doc_chunks WHERE project = ? AND relpath = ?`)
    const ins = this.db.query(
      `INSERT INTO doc_chunks
         (project, relpath, abs_path, title, heading, ordinal, body, mtime_ms, indexed_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const tx = this.db.transaction(() => {
      del.run(input.project, input.relpath)
      for (let i = 0; i < input.chunks.length; i++) {
        const c = input.chunks[i]!
        const emb = embeddings === null ? null : JSON.stringify(embeddings[i] ?? [])
        ins.run(
          input.project,
          input.relpath,
          input.absPath,
          input.title,
          c.heading,
          c.ordinal,
          c.body,
          input.mtimeMs,
          now,
          emb,
        )
      }
    })
    tx()
  }

  /** Drop every chunk for a file (used when the file is deleted on disk). */
  removeFile(project: string, relpath: string): void {
    this.db.query(`DELETE FROM doc_chunks WHERE project = ? AND relpath = ?`).run(project, relpath)
  }

  /** Drop every chunk for a project (used when the project is gone). */
  removeProject(project: string): void {
    this.db.query(`DELETE FROM doc_chunks WHERE project = ?`).run(project)
  }

  stats(): IndexStats {
    const row = this.db
      .query<{ projects: number; files: number; chunks: number }, []>(
        `SELECT COUNT(DISTINCT project) AS projects,
                COUNT(DISTINCT project || ' ' || relpath) AS files,
                COUNT(*) AS chunks
           FROM doc_chunks`,
      )
      .get()
    return row ?? { projects: 0, files: 0, chunks: 0 }
  }

  /**
   * BM25 search returned as ranked DOCUMENTS (best chunk per file). In
   * semantic mode the top lexical files are re-ranked by query↔best-chunk
   * cosine similarity blended with BM25.
   *
   * Candidate chunks are pulled BM25-ordered up to a high safety cap,
   * then collapsed to the best chunk per file, and ONLY THEN is the
   * document `limit` applied. Collapsing before the limit means a single
   * large file with many matching sections can't crowd other relevant
   * documents out of the result set. (SQLite's `bm25()` auxiliary
   * function can't be used inside an aggregate / grouped query, so the
   * per-file collapse is done in application code rather than via
   * `GROUP BY MIN(bm25(...))`.)
   */
  async search(input: SearchInput): Promise<DocSearchHit[]> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
    const match = sanitizeFtsQuery(input.query)
    if (match.length === 0) return []

    const params: Array<string | number> = [match]
    let projectClause = ''
    if (input.project !== undefined && input.project.length > 0) {
      projectClause = ' AND c.project = ?'
      params.push(input.project)
    }
    params.push(CANDIDATE_CAP)

    const sql =
      `SELECT c.project AS project, c.relpath AS relpath, c.title AS title,
              c.heading AS heading, c.ordinal AS ordinal,
              bm25(doc_fts, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.heading}, ${BM25_WEIGHTS.body}) AS bm25,
              snippet(doc_fts, 2, '[', ']', ' … ', 12) AS snippet,
              c.embedding AS embedding
         FROM doc_fts
         JOIN doc_chunks c ON c.id = doc_fts.rowid
        WHERE doc_fts MATCH ?${projectClause}
        ORDER BY bm25
        LIMIT ?`

    let rows: ChunkRow[]
    try {
      rows = this.db.query<ChunkRow, Array<string | number>>(sql).all(...params)
    } catch {
      // Malformed FTS5 MATCH expression — treat as no results.
      return []
    }
    if (rows.length === 0) return []

    // Collapse to the best (lowest-bm25) chunk per file BEFORE limiting.
    const bestByFile = new Map<string, ChunkRow>()
    for (const r of rows) {
      const key = `${r.project}\x00${r.relpath}`
      const existing = bestByFile.get(key)
      if (existing === undefined || r.bm25 < existing.bm25) bestByFile.set(key, r)
    }
    const files = [...bestByFile.values()]

    // Lexical relevance: min-max normalise -bm25 (higher = better).
    const lexNorm = minMaxNormalise(files.map((f) => -f.bm25))
    const scores =
      this.embedder !== null
        ? await this.blendSemantic(
            input.query,
            files.map((f) => f.embedding),
            lexNorm,
          )
        : lexNorm

    return files
      .map((f, i) => ({
        project: f.project,
        path: f.relpath,
        title: f.title,
        heading: f.heading,
        score: scores[i]!,
        snippet: f.snippet,
        ordinal: f.ordinal,
      }))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit)
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async maybeEmbed(texts: string[]): Promise<number[][] | null> {
    if (this.embedder === null || texts.length === 0) return null
    const vecs = await this.embedder.embed(texts)
    return vecs
  }

  /**
   * Blend the lexical scores with query↔chunk cosine similarity for the
   * supplied per-file best-chunk embeddings. Candidates with no stored
   * embedding fall back to the lowest present cosine so they aren't
   * spuriously boosted. Returns the lexical scores unchanged when the
   * query can't be embedded or nothing has an embedding.
   */
  private async blendSemantic(
    query: string,
    embeddings: Array<string | null>,
    lexNorm: number[],
  ): Promise<number[]> {
    const embedder = this.embedder!
    const [queryVec] = await embedder.embed([query])
    if (queryVec === undefined) return lexNorm

    const cosines = embeddings.map((raw) => {
      if (raw === null) return null
      try {
        return cosineSimilarity(queryVec, JSON.parse(raw) as number[])
      } catch {
        return null
      }
    })
    const present = cosines.filter((c): c is number => c !== null)
    if (present.length === 0) return lexNorm
    const floor = Math.min(...present)
    const cosNorm = minMaxNormalise(cosines.map((c) => c ?? floor))

    return lexNorm.map((lex, i) => HYBRID_LEX_WEIGHT * lex + (1 - HYBRID_LEX_WEIGHT) * cosNorm[i]!)
  }
}

/** Min-max normalise to [0,1]; all-equal inputs map to 1. */
function minMaxNormalise(values: number[]): number[] {
  if (values.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  if (span <= 0) return values.map(() => 1)
  return values.map((v) => (v - min) / span)
}

/** Cosine similarity; returns 0 for zero-norm or mismatched vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
