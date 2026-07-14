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
    try {
      migrateSchema(db)
    } catch (err) {
      // A failed migrate (rolled-back rebuild, SQLITE_BUSY from a concurrent
      // rebuilder, etc.) must not leak the handle or its lock — close it and
      // rethrow so the caller (composer try/catch) degrades doc-search for this
      // process; it self-heals on the next clean open.
      try {
        db.close()
      } catch {
        // best-effort
      }
      throw err
    }
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

/** A DB object as recorded in `sqlite_master`. */
interface SchemaObject {
  type: string
  name: string
  sql: string | null
}

/**
 * The FULL set of OWNED objects in `db` — every object whose name is NOT a
 * SQLite internal (`sqlite_*`: autoindexes, `sqlite_sequence`, etc.). The
 * doc-search index is a DEDICATED cache file that NOTHING else writes to, so it
 * OWNS its entire object set: it must contain EXACTLY the current schema's
 * objects — no more, no less. Fingerprinting/dropping the full owned set (not a
 * name-scoped subset) is what makes an EXTRA/unexpected object (a rogue trigger,
 * a stale/foreign table) detectable and removable.
 */
function ownedObjects(db: Database): SchemaObject[] {
  return db
    .query<SchemaObject, []>(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all()
}

/**
 * A stable structural fingerprint of `db`'s FULL owned object set.
 *
 * NORMALIZES for stability — sort by (type, name) so rowid/creation order never
 * matters, collapse each DDL's internal whitespace, drop `IF NOT EXISTS` (SQLite
 * strips it from stored SQL anyway) — and joins into one deterministic string.
 * Two DBs with a structurally identical owned set fingerprint EQUAL; ANY
 * deviation differs: a MISSING expected object (dropped trigger/index), a
 * CHANGED object (wrong columns, malformed FTS), OR an EXTRA unexpected object
 * (rogue trigger, stale/foreign table). By construction nothing can be added,
 * removed, or altered in the cache undetected. `sql` is NULL for auto-created
 * objects; those are represented by name only.
 */
function schemaFingerprint(db: Database): string {
  return ownedObjects(db)
    .map((r) => {
      const sql = (r.sql ?? '')
        .replace(/\s+/g, ' ')
        .replace(/\bIF NOT EXISTS\b/gi, '')
        .trim()
      return `${r.type}\x1f${r.name}\x1f${sql}`
    })
    .join('\x1e')
}

/**
 * The expected fingerprint of a CORRECT current-schema DB, derived from a fresh
 * in-memory build of `SCHEMA` (never hardcoded, so it can't drift from the DDL).
 * The reference build's owned set is EXACTLY the objects the schema defines
 * (base table, the `doc_fts` virtual table + its FTS5 shadow tables, all
 * indexes, all triggers), so a real DB matches iff its owned set is identical.
 * Computed once and cached for the process.
 */
let expectedFingerprint: string | null = null
function currentSchemaFingerprint(): string {
  if (expectedFingerprint === null) {
    const ref = openSidecar(':memory:')
    try {
      ref.exec(SCHEMA)
      expectedFingerprint = schemaFingerprint(ref)
    } finally {
      ref.close()
    }
  }
  return expectedFingerprint
}

/**
 * Bring a freshly-opened DB to EXACTLY the running binary's schema.
 *
 * The doc-search index is a DEDICATED, REBUILDABLE CACHE (lives under
 * `<owner_home>/cache/doc-search/`, derived entirely from the on-disk project
 * docs and repopulated by the next `refreshIndex` pass; nothing else writes to
 * the file). Because it is disposable AND owns its whole object set, the cache
 * must contain EXACTLY the current schema — no more, no less — and is made
 * SELF-HEALING: DROP-and-recreated on ANY `user_version` mismatch (either
 * direction) OR ANY deviation of its owned object set from the reference
 * fingerprint. There is no in-place `ALTER` and no attempt to trust a foreign
 * or corrupt schema.
 *
 *   - `version !== SCHEMA_VERSION` → rebuild. Covers a legacy pre-RA4 DB (still
 *     carrying the removed `doc_chunks.embedding` column, reporting 0), a fresh
 *     empty DB (also 0; the rebuild's drops are no-ops), AND a DB written by a
 *     NEWER/rolled-back binary (a foreign stamp is NOT trusted — opening a
 *     divergent future DB as-is left an UNUSABLE cache whose `search()` threw
 *     "no such table: doc_fts"; e.g. a bare `PRAGMA user_version=2` DB).
 *   - Otherwise the stamp matches, but the STRUCTURE is still verified against
 *     the FULL-owned-set fingerprint (see `schemaFingerprint`). A same-version
 *     DB whose owned set deviates in ANY way — a missing table, a `doc_chunks`
 *     with the wrong columns, a missing OR extra trigger/index, a rogue trigger,
 *     a stale/foreign table, a malformed FTS mirror — mismatches and is rebuilt.
 *     So `open()` NEVER returns a runtime that would fail or silently misbehave
 *     on a corrupt same-version schema (no "no such table" / "no such column";
 *     no rogue object silently sabotaging inserts).
 *   - A CORRECT current-schema DB fingerprint-matches and is NOT rebuilt on
 *     reopen (idempotent — the FTS5 shadow tables are deterministic across
 *     builds, so a correct reopen never spuriously rebuilds).
 *
 * (Supersedes an earlier "leave inert unrelated future tables in place"
 * behaviour: for a DEDICATED cache a lingering foreign object is WRONG — it can
 * corrupt results — so rebuild-to-exact-schema removes it. Safe: it's a cache.)
 */
function migrateSchema(db: Database): void {
  // LOCK-then-CHECK. Take the write lock BEFORE inspecting version + fingerprint,
  // and re-check UNDER the lock, so the whole decide-then-rebuild is one atomic
  // critical section. Deciding outside the lock is a check-then-act race: two
  // processes opening a stale (e.g. legacy v0) cache could BOTH decide "rebuild";
  // the first rebuilds + starts indexing, then the second acquires the lock with
  // its STALE decision and rebuilds AGAIN, erasing the first's rows. Serializing
  // under `BEGIN IMMEDIATE` means the second waits, re-checks, finds the DB
  // already current, and no-ops — the first's data is safe.
  //
  // `IMMEDIATE` acquires the write lock up front; a concurrent rebuilder either
  // blocks then re-checks, or gets SQLITE_BUSY — which propagates out of `open()`
  // (the handle is closed there) so the composer's try/catch degrades doc-search
  // for that process and retries on the next open. Never a crash.
  db.exec('BEGIN IMMEDIATE')
  try {
    if (schemaIsCurrent(db)) {
      // Already current — possibly rebuilt by whoever held the lock before us.
      // Release the (write-free) lock and return without touching anything.
      db.exec('COMMIT')
      return
    }
    // Still stale under the lock → rebuild. Enumerate the drop-set HERE, under
    // the lock, so it reflects the real current contents (not a pre-lock snapshot).
    dropAllOwnedObjects(db)
    db.exec(SCHEMA)
    // `user_version` takes an integer literal (no bound params in a PRAGMA);
    // SCHEMA_VERSION is a hardcoded numeric constant, so this is injection-safe.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    // Roll back so the DB is never left half-dropped; rethrow for the caller to
    // degrade on (graceful — doc-search disabled for this process, self-heals
    // on the next clean open).
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * True iff `db` is EXACTLY the current schema: stamped at `SCHEMA_VERSION` AND
 * its full owned-object set fingerprint-matches the reference build. Read-only;
 * called under the write lock so the decision can't be stale.
 */
function schemaIsCurrent(db: Database): boolean {
  const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
  return version === SCHEMA_VERSION && schemaFingerprint(db) === currentSchemaFingerprint()
}

/**
 * DROP every OWNED object (the full set — including any rogue/stale object, not
 * just the ones the current `SCHEMA` names). Dropping the full owned set is what
 * makes the rebuild IDEMPOTENT after an extra-object deviation: a rogue
 * table/trigger/view/index is removed here, so the very next reopen
 * fingerprint-matches (no rebuild loop). MUST be called inside the transaction
 * (`migrateSchema` holds `BEGIN IMMEDIATE`) so the teardown + recreate + stamp
 * commit atomically — a crash/error mid-rebuild rolls back to the PRIOR state,
 * never half-dropped.
 *
 * Drop order is safety-critical for FTS5: views + triggers first (they reference
 * tables), then indexes, then the `doc_fts` VIRTUAL table (which auto-drops its
 * shadow tables), then remaining base tables. The captured list still contains
 * the shadow tables, but by the time we reach them the virtual table is gone, so
 * `DROP TABLE IF EXISTS` is a no-op — and we never try to drop a shadow table out
 * from under a live vtable (which SQLite forbids).
 *
 * INVARIANT: the drop-set MUST equal the fingerprint-set. The fingerprint covers
 * EVERY owned object type (`ownedObjects` — table, index, trigger, AND view), so
 * the drop covers every type too. A missed type (e.g. a VIEW left behind) would
 * survive the rebuild → the post-rebuild fingerprint would still mismatch →
 * EVERY reopen rebuilds, losing all indexed rows. Enumerating dynamically by
 * type keeps drop-set == fingerprint-set by construction.
 */
function dropAllOwnedObjects(db: Database): void {
  const owned = ownedObjects(db)
  const isVirtual = (o: SchemaObject): boolean => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql ?? '')
  const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`

  for (const o of owned) if (o.type === 'view') db.exec(`DROP VIEW IF EXISTS ${quote(o.name)}`)
  for (const o of owned) if (o.type === 'trigger') db.exec(`DROP TRIGGER IF EXISTS ${quote(o.name)}`)
  // Skip auto-indexes (sql IS NULL) — they vanish with their table and can't be
  // dropped explicitly.
  for (const o of owned)
    if (o.type === 'index' && o.sql !== null) db.exec(`DROP INDEX IF EXISTS ${quote(o.name)}`)
  // Virtual tables first so their FTS5 shadow tables are gone before we reach them.
  for (const o of owned)
    if (o.type === 'table' && isVirtual(o)) db.exec(`DROP TABLE IF EXISTS ${quote(o.name)}`)
  for (const o of owned)
    if (o.type === 'table' && !isVirtual(o)) db.exec(`DROP TABLE IF EXISTS ${quote(o.name)}`)
}
