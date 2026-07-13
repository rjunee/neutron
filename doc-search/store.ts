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
 *
 * Doc search is pure-lexical BM25 with NO external provider. (An optional
 * in-process `embedder` seam once lived here for a hybrid semantic re-rank,
 * but nothing ever wired one — the composer always opened the index lexical-
 * only, so the branch was dead. It could not share RA3's embedder either:
 * RA3 configures an OUT-OF-PROCESS `gbrain serve` child via env vars
 * (`gbrain-memory/embedder-config.ts` → `EmbedderConfig.childEnv`), whereas
 * this seam needed an in-process `embed(texts) → number[][]` function that
 * doesn't exist anywhere in the tree. Rather than fork a parallel embedding
 * path, the dead seam was removed (RA4) — one keyword path, no dead code.)
 */

import type { Database } from 'bun:sqlite'

import { openSidecar } from '@neutronai/persistence/index.ts'

import { sanitizeFtsQuery } from './query.ts'

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
  indexed_at INTEGER NOT NULL
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

/**
 * Schema version stamped into the DB's `PRAGMA user_version`. Bumped for the
 * RA4 embedder-seam removal (the `doc_chunks.embedding` column is gone). Any
 * DB whose stamp is BELOW this — including a legacy DB from before stamping
 * existed, which reports `0` — is a stale schema and gets rebuilt on open (see
 * `migrateSchema`). Bump this whenever the on-disk schema changes.
 */
const SCHEMA_VERSION = 1

/**
 * Drop every doc-search object so `SCHEMA` can recreate it cleanly. Used by the
 * upgrade path when a persistent DB predates the current schema — e.g. an
 * install created before RA4 still carries the removed `doc_chunks.embedding`
 * column, which `CREATE TABLE IF NOT EXISTS` would NOT alter away. Triggers and
 * the FTS mirror are dropped before the base table; the base table's indexes go
 * with it. (Indexes on `doc_chunks` are dropped implicitly with the table.)
 */
const DROP_SCHEMA = `
DROP TRIGGER IF EXISTS doc_chunks_ai;
DROP TRIGGER IF EXISTS doc_chunks_ad;
DROP TRIGGER IF EXISTS doc_chunks_au;
DROP TABLE IF EXISTS doc_fts;
DROP TABLE IF EXISTS doc_chunks;
`

/** BM25 column weights — title matches dominate, then headings, then body. */
const BM25_WEIGHTS = { title: 10.0, heading: 4.0, body: 1.0 } as const

/**
 * Hard cap on BM25-ordered candidate chunks pulled before the per-file
 * collapse. High enough that the document `limit` is never starved by one
 * big file's matching sections, bounded so a pathological broad query
 * over a huge corpus can't load unbounded rows into memory.
 */
const CANDIDATE_CAP = 5000

export class DocSearchIndex {
  private readonly db: Database

  private constructor(db: Database) {
    this.db = db
  }

  /** Open (or create) an index at `path`. Use ':memory:' for tests. */
  static open(path: string): DocSearchIndex {
    // P3 shared open — previously WAL + synchronous + foreign_keys only; now
    // additionally gains busy_timeout/temp_store/cache_size (strictly more
    // tolerant under contention, no semantic change).
    const db = openSidecar(path)
    migrateSchema(db)
    return new DocSearchIndex(db)
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
   *
   * `async` is retained (callers `await` it) even though the body is now
   * fully synchronous — the doc-corpus refresh pipeline awaits every
   * `indexFile`, and keeping the signature avoids a churny ripple through
   * `indexer.ts` / `runtime.ts` for no behavioural gain.
   */
  async indexFile(input: IndexFileInput): Promise<void> {
    const now = Date.now()
    const del = this.db.query(`DELETE FROM doc_chunks WHERE project = ? AND relpath = ?`)
    const ins = this.db.query(
      `INSERT INTO doc_chunks
         (project, relpath, abs_path, title, heading, ordinal, body, mtime_ms, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const tx = this.db.transaction(() => {
      del.run(input.project, input.relpath)
      for (const c of input.chunks) {
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
   * BM25 search returned as ranked DOCUMENTS (best chunk per file).
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
              snippet(doc_fts, 2, '[', ']', ' … ', 12) AS snippet
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
    const scores = minMaxNormalise(files.map((f) => -f.bm25))

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

/**
 * Bring a freshly-opened DB up to the current schema, then stamp its version.
 *
 * The doc-search index is a REBUILDABLE CACHE (lives under
 * `<owner_home>/cache/doc-search/`, derived entirely from the on-disk project
 * docs and repopulated by the next `refreshIndex` pass), so a stale schema is
 * resolved by DROP-and-recreate rather than an in-place `ALTER`. A DB stamped
 * below `SCHEMA_VERSION` — including a legacy pre-RA4 DB that still carries the
 * removed `doc_chunks.embedding` column and reports `user_version` 0 — has its
 * doc-search objects dropped so `SCHEMA` recreates them clean. A brand-new
 * empty DB also reports 0, but the drops are `IF EXISTS` no-ops there, so the
 * fresh-DB path is unchanged. Once at/above the stamp, `SCHEMA` is idempotent
 * (`IF NOT EXISTS`) and nothing is dropped.
 */
function migrateSchema(db: Database): void {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  const version = row?.user_version ?? 0
  if (version < SCHEMA_VERSION) db.exec(DROP_SCHEMA)
  db.exec(SCHEMA)
  // `user_version` takes an integer literal (no bound params in a PRAGMA);
  // SCHEMA_VERSION is a hardcoded numeric constant, so this is injection-safe.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
