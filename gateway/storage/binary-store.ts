/**
 * @neutronai/gateway/storage — content-addressed binary store (P7.5).
 *
 * Per docs/plans/P7.5-binary-large-file-handling-sprint-brief.md § 2.
 *
 * Per-project layout (sibling of the P7.4 `.docs-versions/`):
 *
 *   <project>/.docs-blobs/
 *     ├─ index.sqlite              ← path → hash + refcount sidecar
 *     ├─ ab/cd1234…                ← blob bytes, content-addressed
 *     └─ ef/56…
 *
 * Hashing: SHA-256 from `node:crypto` (no new top-level deps per the
 * sprint verification gate). The brief recommends BLAKE3 as a future
 * upgrade once Bun ships a stable native binding — at that point swap
 * `hashBytes` and the implementation otherwise stays put.
 *
 * Concurrency: every write opens a per-project `BEGIN IMMEDIATE`
 * transaction so two concurrent uploads to the same path serialize
 * cleanly. The on-disk blob write happens BEFORE the row commit; if a
 * crash leaves an orphan blob, the next `ensureInit()` sweep cleans it
 * up (the blob is keyed by hash → repeat writes of the same content
 * are idempotent).
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import {
  BINARY_EXTENSIONS,
  BINARY_MIME_WHITELIST,
  BinaryCorruptedError,
  BinaryNotFoundError,
  BinaryPathError,
  BinarySizeError,
  BinaryStorageError,
  BinaryTypeError,
  MAX_BINARY_BYTES,
  canonicalizeMime,
  isBinaryExtension,
  magicByteSniff,
  type BinaryDeleteResult,
  type BinaryPutResult,
  type BinaryReadResult,
  type BinaryRow,
  type BinaryStoreLogger,
  type BinaryStoreOptions,
} from './binary-types.ts'

const BLOBS_DIR = '.docs-blobs'
const INDEX_FILE = 'index.sqlite'

const DEFAULT_LOGGER: BinaryStoreLogger = (event, fields) => {
  try {
    console.warn(`[docs.binary] ${event} ${JSON.stringify(fields)}`)
  } catch {
    console.warn(`[docs.binary] ${event}`)
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS binary_path (
  path           TEXT PRIMARY KEY,
  hash           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  content_type   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  modified_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS binary_blob (
  hash           TEXT PRIMARY KEY,
  size_bytes     INTEGER NOT NULL,
  content_type   TEXT NOT NULL,
  refcount       INTEGER NOT NULL,
  first_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS markdown_link (
  markdown_path  TEXT NOT NULL,
  binary_path    TEXT NOT NULL,
  PRIMARY KEY (markdown_path, binary_path)
);

CREATE INDEX IF NOT EXISTS idx_binary_path_hash ON binary_path(hash);
CREATE INDEX IF NOT EXISTS idx_markdown_link_binary ON markdown_link(binary_path);

CREATE TABLE IF NOT EXISTS schema_version (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
`

interface BinaryPathRow {
  path: string
  hash: string
  size_bytes: number
  content_type: string
  created_at: number
  modified_at: number
}

interface ProjectHandle {
  db: Database
  blobs_root: string
}

const HEX_NAME_RE = /^[0-9a-f]{62}$/
const HEX_DIR_RE = /^[0-9a-f]{2}$/

export class BinaryStore {
  private readonly owner_home: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly max_bytes: number
  private readonly allowed_extensions: readonly string[]
  private readonly allowed_mime_types: readonly string[]
  private readonly logger: BinaryStoreLogger
  private readonly handles = new Map<string, ProjectHandle>()
  // Round-2 BLOCKING #1 — `gc()` MUST run at most once per project per
  // gateway boot. Before this gate, every PUT's `ensureInit(sweep=true)`
  // re-fired gc on the cached handle. Inside `put()`, the blob is
  // mkdir → writeFile → rename'd to its final path BEFORE the
  // `BEGIN IMMEDIATE` transaction at L227. Between those awaits, a
  // concurrent PUT's gc would walk `.docs-blobs/<aa>/<bb...>`, see the
  // just-renamed blob with no matching `binary_blob` row, and `unlinkSync`
  // it. The first PUT then committed a `binary_path` row pointing at a
  // blob that no longer existed — every subsequent GET surfaced
  // `BinaryCorruptedError` permanently. The once-per-boot gate keeps the
  // defensive orphan sweep (cleans crashes from a previous boot) without
  // re-arming the race on every cached-handle PUT.
  private readonly swept = new Set<string>()

  constructor(opts: BinaryStoreOptions) {
    this.owner_home = opts.owner_home
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.max_bytes = opts.max_bytes ?? MAX_BINARY_BYTES
    this.allowed_extensions = opts.allowed_extensions ?? BINARY_EXTENSIONS
    this.allowed_mime_types = opts.allowed_mime_types ?? BINARY_MIME_WHITELIST
    this.logger = opts.logger ?? DEFAULT_LOGGER
  }

  /** Force-close every per-project DB handle. Useful for tests that
   *  swap fixture roots between cases. */
  closeAll(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.db.close()
      } catch {
        /* ignore */
      }
    }
    this.handles.clear()
    // Reset the once-per-boot gc gate too — tests that close handles and
    // re-init the same project_id expect a fresh GC sweep against the
    // (possibly different) on-disk fixture.
    this.swept.clear()
  }

  /**
   * Best-effort init for `<project>/.docs-blobs/`. Creates the dir +
   * sidecar SQLite and runs a GC sweep on the first call per gateway
   * boot. Idempotent; safe to call before every read/write.
   */
  async ensureInit(project_id: string): Promise<void> {
    this.openHandle(project_id, /*sweep=*/ true)
  }

  /**
   * Upload `bytes` at `rel_path`. Returns the canonical metadata. See
   * sprint brief § 2.4 for the full write flow.
   */
  async put(
    project_id: string,
    rel_path: string,
    bytes: Uint8Array,
    declared_content_type: string | null,
  ): Promise<BinaryPutResult> {
    const cleaned = this.validatePath(rel_path)
    if (bytes.length > this.max_bytes) {
      throw new BinarySizeError(bytes.length, this.max_bytes)
    }
    const sniffed = magicByteSniff(bytes)
    if (sniffed === null || !this.allowed_mime_types.includes(sniffed)) {
      throw new BinaryTypeError(
        'unsupported_type',
        `sniffed type ${sniffed ?? '<unknown>'} not in allowed list`,
        { declared: declared_content_type, sniffed },
      )
    }
    const declared = canonicalizeMime(declared_content_type)
    if (declared !== null && declared !== sniffed) {
      throw new BinaryTypeError(
        'content_type_spoof',
        `declared content type ${declared} disagrees with sniffed ${sniffed}`,
        { declared, sniffed },
      )
    }
    const handle = this.openHandle(project_id, /*sweep=*/ false)
    const hash = hashBytes(bytes)
    const blob_dir = join(handle.blobs_root, hash.slice(0, 2))
    const blob_path = join(blob_dir, hash.slice(2))
    const now = Date.now()

    // Step 1 — make sure the blob bytes are on disk BEFORE we open the
    // SQLite txn that will increment refcount. This means a crash
    // mid-txn leaves only an orphan blob (cleaned by GC), never a
    // dangling row with no bytes.
    if (!existsSync(blob_path)) {
      await mkdir(blob_dir, { recursive: true })
      const tmp = `${blob_path}.tmp-${process.pid}-${Math.random()
        .toString(36)
        .slice(2)}`
      try {
        await writeFile(tmp, bytes)
        await rename(tmp, blob_path)
      } catch (err) {
        try {
          await unlink(tmp)
        } catch {
          /* ignore */
        }
        if (isENOSPC(err)) {
          throw new BinaryStorageError(
            `disk full while writing blob hash=${hash}`,
          )
        }
        throw err
      }
    }

    const db = handle.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const prev = db
        .prepare<BinaryPathRow, [string]>(
          'SELECT path, hash, size_bytes, content_type, created_at, modified_at FROM binary_path WHERE path = ?',
        )
        .get(cleaned)

      if (prev !== null && prev.hash === hash) {
        // Same content, same path — bump modified_at only.
        db.run('UPDATE binary_path SET modified_at = ? WHERE path = ?', [
          now,
          cleaned,
        ])
        db.exec('COMMIT')
        return {
          path: cleaned,
          hash,
          size_bytes: bytes.length,
          content_type: sniffed,
          modified_at: now,
        }
      }

      const existingBlob = db
        .prepare<{ hash: string }, [string]>(
          'SELECT hash FROM binary_blob WHERE hash = ?',
        )
        .get(hash)
      if (existingBlob === null) {
        db.run(
          'INSERT INTO binary_blob (hash, size_bytes, content_type, refcount, first_seen_at) VALUES (?, ?, ?, 0, ?)',
          [hash, bytes.length, sniffed, now],
        )
      }

      if (prev !== null) {
        db.run(
          'UPDATE binary_path SET hash = ?, size_bytes = ?, content_type = ?, modified_at = ? WHERE path = ?',
          [hash, bytes.length, sniffed, now, cleaned],
        )
        this.decrementInTxn(handle, prev.hash)
      } else {
        db.run(
          'INSERT INTO binary_path (path, hash, size_bytes, content_type, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)',
          [cleaned, hash, bytes.length, sniffed, now, now],
        )
      }

      db.run('UPDATE binary_blob SET refcount = refcount + 1 WHERE hash = ?', [
        hash,
      ])
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
    return {
      path: cleaned,
      hash,
      size_bytes: bytes.length,
      content_type: sniffed,
      modified_at: now,
    }
  }

  /** Lookup the on-disk path + metadata for `rel_path`. */
  get(project_id: string, rel_path: string): BinaryReadResult {
    const cleaned = this.validatePath(rel_path)
    const handle = this.openHandle(project_id, /*sweep=*/ false)
    const row = handle.db
      .prepare<BinaryPathRow, [string]>(
        'SELECT path, hash, size_bytes, content_type, created_at, modified_at FROM binary_path WHERE path = ?',
      )
      .get(cleaned)
    if (row === null) {
      throw new BinaryNotFoundError(`no binary at path=${cleaned}`)
    }
    const abs_path = join(
      handle.blobs_root,
      row.hash.slice(0, 2),
      row.hash.slice(2),
    )
    if (!existsSync(abs_path)) {
      this.logger('docs.binary.corrupted', {
        project_id,
        path: cleaned,
        hash: row.hash,
      })
      throw new BinaryCorruptedError(cleaned, row.hash)
    }
    return {
      path: cleaned,
      hash: row.hash,
      size_bytes: row.size_bytes,
      content_type: row.content_type,
      modified_at: row.modified_at,
      abs_path,
    }
  }

  /** Read the blob bytes for `rel_path`. Convenience used by tests +
   *  fallback HTTP responses that need to materialize the body. */
  async readBytes(project_id: string, rel_path: string): Promise<Buffer> {
    const row = this.get(project_id, rel_path)
    return await readFile(row.abs_path)
  }

  /**
   * Return binary rows under the project, sorted by `path`. `limit`
   * caps the returned set so a pathological project can't blow up
   * `tree()` (round-2 IMPORTANT #3). DocStore shares its
   * MAX_TREE_NODES budget across markdown + binary tiers by passing
   * the remaining budget here.
   */
  listPaths(project_id: string, limit?: number): BinaryRow[] {
    const handle = this.openHandleOrNull(project_id)
    if (handle === null) return []
    const cappedLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
        ? Math.floor(limit)
        : null
    if (cappedLimit === 0) return []
    const rows = handle.db
      .prepare<
        {
          path: string
          hash: string
          size_bytes: number
          content_type: string
          modified_at: number
          referenced_by_count: number
        },
        [number]
      >(
        `SELECT bp.path, bp.hash, bp.size_bytes, bp.content_type, bp.modified_at,
                COALESCE((
                  SELECT COUNT(*) FROM markdown_link ml
                  WHERE ml.binary_path = bp.path
                ), 0) AS referenced_by_count
           FROM binary_path bp
       ORDER BY bp.path
          LIMIT ?`,
      )
      .all(cappedLimit ?? Number.MAX_SAFE_INTEGER)
    return rows
  }

  /** List the markdown files that link to `rel_path`. */
  listMarkdownReferences(project_id: string, rel_path: string): string[] {
    const cleaned = this.validatePath(rel_path)
    const handle = this.openHandleOrNull(project_id)
    if (handle === null) return []
    const rows = handle.db
      .prepare<{ markdown_path: string }, [string]>(
        'SELECT markdown_path FROM markdown_link WHERE binary_path = ? ORDER BY markdown_path',
      )
      .all(cleaned)
    return rows.map((r) => r.markdown_path)
  }

  /**
   * Round-2 IMPORTANT #5 — recursive delete for every binary whose
   * path starts with `prefix + '/'`. Used by the Expo client when the
   * user deletes a phantom-binary folder (a folder synthesised by
   * `mergeBinariesIntoTree` to host a deep binary leaf). Returns the
   * list of deleted paths + the markdown files that still reference
   * any of them.
   *
   * `prefix` is validated as a path string (NOT as a binary leaf path
   * — recursion folder prefixes don't carry a binary extension). The
   * dispatcher rejects path traversal / hidden segments BEFORE this is
   * reached, so we trust the cleaned shape here.
   */
  async deletePrefix(
    project_id: string,
    prefix: string,
  ): Promise<{
    deleted_paths: string[]
    still_referenced_by: string[]
  }> {
    const cleaned = validateBinaryFolderPath(prefix)
    const handle = this.openHandleOrNull(project_id)
    if (handle === null) {
      return { deleted_paths: [], still_referenced_by: [] }
    }
    const db = handle.db
    // Escape the user-controlled prefix so a `%` or `_` in a real
    // folder name doesn't act as a SQL LIKE wildcard. The trailing
    // `/%` is the intentional descendant wildcard.
    const literalPrefix = cleaned.replace(/[%_\\]/g, (m) => `\\${m}`)
    const safePattern = `${literalPrefix}/%`
    db.exec('BEGIN IMMEDIATE')
    const deletedPaths: string[] = []
    const stillRefSet = new Set<string>()
    try {
      const exactRows = db
        .prepare<BinaryPathRow, [string]>(
          `SELECT path, hash, size_bytes, content_type, created_at, modified_at
             FROM binary_path
            WHERE path LIKE ? ESCAPE '\\'`,
        )
        .all(safePattern)
      for (const row of exactRows) {
        const refs = db
          .prepare<{ markdown_path: string }, [string]>(
            'SELECT markdown_path FROM markdown_link WHERE binary_path = ? ORDER BY markdown_path',
          )
          .all(row.path)
        for (const r of refs) stillRefSet.add(r.markdown_path)
        db.run('DELETE FROM binary_path WHERE path = ?', [row.path])
        this.decrementInTxn(handle, row.hash)
        deletedPaths.push(row.path)
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
    return {
      deleted_paths: deletedPaths,
      still_referenced_by: [...stillRefSet].sort(),
    }
  }

  /** Delete the path row; physical blob removal happens when the
   *  refcount drops to 0. Returns the markdown files that still
   *  reference the binary (informational). */
  async delete(
    project_id: string,
    rel_path: string,
  ): Promise<BinaryDeleteResult> {
    const cleaned = this.validatePath(rel_path)
    const handle = this.openHandle(project_id, /*sweep=*/ false)
    const db = handle.db
    db.exec('BEGIN IMMEDIATE')
    let still_referenced_by: string[] = []
    try {
      const row = db
        .prepare<BinaryPathRow, [string]>(
          'SELECT path, hash, size_bytes, content_type, created_at, modified_at FROM binary_path WHERE path = ?',
        )
        .get(cleaned)
      if (row === null) {
        db.exec('ROLLBACK')
        throw new BinaryNotFoundError(`no binary at path=${cleaned}`)
      }
      still_referenced_by = db
        .prepare<{ markdown_path: string }, [string]>(
          'SELECT markdown_path FROM markdown_link WHERE binary_path = ? ORDER BY markdown_path',
        )
        .all(cleaned)
        .map((r) => r.markdown_path)
      db.run('DELETE FROM binary_path WHERE path = ?', [cleaned])
      this.decrementInTxn(handle, row.hash)
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      if (err instanceof BinaryNotFoundError) throw err
      throw err
    }
    return { deleted_path: cleaned, still_referenced_by }
  }

  /**
   * Sync markdown-link refcounts for `markdown_path` against the set of
   * binary paths discovered in `content`. Called by DocStore.writeDoc
   * after a successful atomic write. The parser is lenient — broken
   * refs (not in `binary_path`) are silently dropped.
   */
  syncMarkdownLinks(
    project_id: string,
    markdown_path: string,
    content: string,
  ): void {
    const handle = this.openHandleOrNull(project_id)
    if (handle === null) return
    const db = handle.db
    const md_path_cleaned = normalizePosix(markdown_path)
    const next_set = parseMarkdownBinaryLinks(
      content,
      posixDirname(md_path_cleaned),
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      const prev_rows = db
        .prepare<{ binary_path: string }, [string]>(
          'SELECT binary_path FROM markdown_link WHERE markdown_path = ?',
        )
        .all(md_path_cleaned)
      const prev_set = new Set(prev_rows.map((r) => r.binary_path))
      const new_set = new Set<string>()
      for (const candidate of next_set) {
        const exists = db
          .prepare<{ hash: string }, [string]>(
            'SELECT hash FROM binary_path WHERE path = ?',
          )
          .get(candidate)
        if (exists !== null) new_set.add(candidate)
      }
      const added: string[] = []
      const removed: string[] = []
      for (const p of new_set) if (!prev_set.has(p)) added.push(p)
      for (const p of prev_set) if (!new_set.has(p)) removed.push(p)
      for (const p of added) {
        const blobRow = db
          .prepare<{ hash: string }, [string]>(
            'SELECT hash FROM binary_path WHERE path = ?',
          )
          .get(p)
        if (blobRow === null) continue
        db.run(
          'INSERT OR IGNORE INTO markdown_link (markdown_path, binary_path) VALUES (?, ?)',
          [md_path_cleaned, p],
        )
        db.run('UPDATE binary_blob SET refcount = refcount + 1 WHERE hash = ?', [
          blobRow.hash,
        ])
      }
      for (const p of removed) {
        const blobRow = db
          .prepare<{ hash: string }, [string]>(
            'SELECT hash FROM binary_path WHERE path = ?',
          )
          .get(p)
        db.run(
          'DELETE FROM markdown_link WHERE markdown_path = ? AND binary_path = ?',
          [md_path_cleaned, p],
        )
        if (blobRow !== null) this.decrementInTxn(handle, blobRow.hash)
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /**
   * Drop every markdown_link row pointing at `markdown_path` and
   * decrement the matching blob refcounts. Called from
   * DocStore.deleteDoc.
   */
  dropMarkdownLinks(project_id: string, markdown_path: string): void {
    const handle = this.openHandleOrNull(project_id)
    if (handle === null) return
    const md_path_cleaned = normalizePosix(markdown_path)
    const db = handle.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db
        .prepare<{ binary_path: string }, [string]>(
          'SELECT binary_path FROM markdown_link WHERE markdown_path = ?',
        )
        .all(md_path_cleaned)
      db.run('DELETE FROM markdown_link WHERE markdown_path = ?', [
        md_path_cleaned,
      ])
      for (const r of rows) {
        const blobRow = db
          .prepare<{ hash: string }, [string]>(
            'SELECT hash FROM binary_path WHERE path = ?',
          )
          .get(r.binary_path)
        if (blobRow !== null) this.decrementInTxn(handle, blobRow.hash)
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /** Rename a markdown file in the markdown_link table. */
  renameMarkdownLinks(
    project_id: string,
    from_path: string,
    to_path: string,
  ): void {
    const handle = this.openHandleOrNull(project_id)
    if (handle === null) return
    const from_cleaned = normalizePosix(from_path)
    const to_cleaned = normalizePosix(to_path)
    const db = handle.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.run(
        'UPDATE OR REPLACE markdown_link SET markdown_path = ? WHERE markdown_path = ?',
        [to_cleaned, from_cleaned],
      )
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /**
   * Public access to the structured-event logger. DocStore's
   * best-effort markdown_link hooks call this when the underlying op
   * throws so refcount drift never goes silent (round-2 IMPORTANT #4).
   */
  logEvent(event: string, fields: Record<string, unknown>): void {
    this.logger(event, fields)
  }

  /** Public helper for tests / GC visibility. */
  getBlobRefcount(project_id: string, hash: string): number | null {
    const handle = this.openHandleOrNull(project_id)
    if (handle === null) return null
    const row = handle.db
      .prepare<{ refcount: number }, [string]>(
        'SELECT refcount FROM binary_blob WHERE hash = ?',
      )
      .get(hash)
    return row?.refcount ?? null
  }

  /* ─── internals ──────────────────────────────────────────────── */

  private validatePath(rel_path: unknown): string {
    return validateBinaryRelativePath(rel_path, this.allowed_extensions)
  }

  private openHandleOrNull(project_id: string): ProjectHandle | null {
    const cleaned = sanitizeProjectId(project_id)
    if (cleaned === null) return null
    const key = cleaned
    const cached = this.handles.get(key)
    if (cached !== undefined) return cached
    const blobs_root = join(this.resolveProjectRoot(cleaned), BLOBS_DIR)
    if (!existsSync(blobs_root)) return null
    return this.openHandle(cleaned, /*sweep=*/ false)
  }

  private openHandle(project_id: string, sweep: boolean): ProjectHandle {
    const cleaned = sanitizeProjectId(project_id)
    if (cleaned === null) {
      throw new BinaryPathError(
        'invalid_project_id',
        'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
      )
    }
    const key = cleaned
    const existing = this.handles.get(key)
    if (existing !== undefined) {
      // Round-2 BLOCKING #1 — only sweep on the FIRST init per gateway
      // boot. Subsequent ensureInit calls (every PUT/GET/DELETE) get the
      // cached handle without a re-sweep, eliminating the
      // concurrent-PUT-vs-gc unlink race documented on `swept`.
      if (sweep && !this.swept.has(key)) {
        this.swept.add(key)
        this.gc(key, existing)
      }
      return existing
    }
    const blobs_root = join(this.resolveProjectRoot(cleaned), BLOBS_DIR)
    mkdirSync(blobs_root, { recursive: true })
    const db = new Database(join(blobs_root, INDEX_FILE))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    db.run(
      "INSERT OR IGNORE INTO schema_version (k, v) VALUES ('binary_store', ?)",
      [1],
    )
    const handle: ProjectHandle = { db, blobs_root }
    this.handles.set(key, handle)
    if (sweep && !this.swept.has(key)) {
      this.swept.add(key)
      this.gc(key, handle)
    }
    return handle
  }

  /** Decrement a blob's refcount inside the caller's open txn. */
  private decrementInTxn(handle: ProjectHandle, hash: string): void {
    const db = handle.db
    db.run('UPDATE binary_blob SET refcount = refcount - 1 WHERE hash = ?', [
      hash,
    ])
    const row = db
      .prepare<{ refcount: number }, [string]>(
        'SELECT refcount FROM binary_blob WHERE hash = ?',
      )
      .get(hash)
    if (row === null) return
    if (row.refcount <= 0) {
      db.run('DELETE FROM binary_blob WHERE hash = ?', [hash])
      const blob_dir = join(handle.blobs_root, hash.slice(0, 2))
      const blob_path = join(blob_dir, hash.slice(2))
      if (existsSync(blob_path)) {
        try {
          unlinkSync(blob_path)
        } catch (err) {
          this.logger('docs.binary.unlink_failed', {
            hash,
            error: stringifyError(err),
          })
        }
        try {
          rmdirSync(blob_dir)
        } catch {
          /* dir not empty — fine */
        }
      }
    }
  }

  /**
   * Defensive GC: unlink blobs on disk that aren't in `binary_blob`
   * (orphaned by mid-txn crashes or external `rm` operations); log
   * binary_blob rows whose blob is missing on disk (do NOT auto-delete
   * — ops needs to see the corruption).
   */
  private gc(project_id: string, handle: ProjectHandle): void {
    let dirs: string[] = []
    try {
      dirs = readdirSync(handle.blobs_root)
    } catch {
      return
    }
    for (const d of dirs) {
      if (d === INDEX_FILE) continue
      if (d.startsWith(INDEX_FILE)) continue
      if (!HEX_DIR_RE.test(d)) continue
      const sub = join(handle.blobs_root, d)
      let files: string[] = []
      try {
        files = readdirSync(sub)
      } catch {
        continue
      }
      for (const f of files) {
        if (!HEX_NAME_RE.test(f)) continue
        const hash = d + f
        const known = handle.db
          .prepare<{ hash: string }, [string]>(
            'SELECT hash FROM binary_blob WHERE hash = ?',
          )
          .get(hash)
        if (known === null) {
          try {
            unlinkSync(join(sub, f))
          } catch {
            /* ignore */
          }
          this.logger('docs.binary.gc.orphan_unlinked', { project_id, hash })
        }
      }
    }
    const rows = handle.db
      .prepare<{ hash: string }, []>('SELECT hash FROM binary_blob')
      .all()
    for (const row of rows) {
      const abs = join(
        handle.blobs_root,
        row.hash.slice(0, 2),
        row.hash.slice(2),
      )
      if (!existsSync(abs)) {
        this.logger('docs.binary.gc.missing_blob', {
          project_id,
          hash: row.hash,
        })
      }
    }
  }
}

/* ─── helpers exposed for DocStore + tests ─────────────────────── */

/** Validate `rel_path` for the binary surface. Returns the cleaned
 *  POSIX path. Throws `BinaryPathError` on any rejection. */
export function validateBinaryRelativePath(
  rel_path: unknown,
  allowed_extensions: readonly string[] = BINARY_EXTENSIONS,
): string {
  if (typeof rel_path !== 'string') {
    throw new BinaryPathError('invalid_path', 'path must be a string')
  }
  if (rel_path.length === 0) {
    throw new BinaryPathError('invalid_path', 'path must be non-empty')
  }
  if (rel_path.length > 1024) {
    throw new BinaryPathError('invalid_path', 'path exceeds 1024 chars')
  }
  if (rel_path.includes('\0')) {
    throw new BinaryPathError('invalid_path', 'path contains NUL byte')
  }
  if (rel_path.startsWith('/') || rel_path.startsWith('\\')) {
    throw new BinaryPathError('invalid_path', 'path must be relative')
  }
  const posix = rel_path.replace(/\\+/g, '/')
  if (/^[A-Za-z]:\//.test(posix)) {
    throw new BinaryPathError('invalid_path', 'path must be relative')
  }
  const segments = posix.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) {
    throw new BinaryPathError('invalid_path', 'path resolves to empty')
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new BinaryPathError('invalid_path', 'path may not contain . or ..')
    }
    if (seg.startsWith('.')) {
      throw new BinaryPathError(
        'hidden_segment',
        `path may not contain hidden segments (${seg})`,
      )
    }
    if (seg.length > 256) {
      throw new BinaryPathError(
        'invalid_path',
        `segment '${seg}' exceeds 256 chars`,
      )
    }
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      throw new BinaryPathError(
        'invalid_path',
        `segment '${seg}' contains a forbidden character`,
      )
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      throw new BinaryPathError(
        'invalid_path',
        `segment '${seg}' may not end with a space or dot`,
      )
    }
  }
  const last = segments[segments.length - 1] ?? ''
  if (!extensionMatches(last, allowed_extensions)) {
    throw new BinaryPathError(
      'invalid_extension',
      `path must end with one of ${allowed_extensions.join(', ')} (got '${last}')`,
    )
  }
  return segments.join('/')
}

/**
 * Round-2 IMPORTANT #5 — folder-shape validator for the recursive
 * binary delete (no extension check, otherwise identical to the leaf
 * validator). Used only by `BinaryStore.deletePrefix`.
 */
export function validateBinaryFolderPath(rel_path: unknown): string {
  if (typeof rel_path !== 'string') {
    throw new BinaryPathError('invalid_path', 'path must be a string')
  }
  if (rel_path.length === 0) {
    throw new BinaryPathError('invalid_path', 'path must be non-empty')
  }
  if (rel_path.length > 1024) {
    throw new BinaryPathError('invalid_path', 'path exceeds 1024 chars')
  }
  if (rel_path.includes('\0')) {
    throw new BinaryPathError('invalid_path', 'path contains NUL byte')
  }
  if (rel_path.startsWith('/') || rel_path.startsWith('\\')) {
    throw new BinaryPathError('invalid_path', 'path must be relative')
  }
  const posix = rel_path.replace(/\\+/g, '/')
  if (/^[A-Za-z]:\//.test(posix)) {
    throw new BinaryPathError('invalid_path', 'path must be relative')
  }
  const segments = posix.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) {
    throw new BinaryPathError('invalid_path', 'path resolves to empty')
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new BinaryPathError('invalid_path', 'path may not contain . or ..')
    }
    if (seg.startsWith('.')) {
      throw new BinaryPathError(
        'hidden_segment',
        `path may not contain hidden segments (${seg})`,
      )
    }
    if (seg.length > 256) {
      throw new BinaryPathError(
        'invalid_path',
        `segment '${seg}' exceeds 256 chars`,
      )
    }
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      throw new BinaryPathError(
        'invalid_path',
        `segment '${seg}' contains a forbidden character`,
      )
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      throw new BinaryPathError(
        'invalid_path',
        `segment '${seg}' may not end with a space or dot`,
      )
    }
  }
  return segments.join('/')
}

function extensionMatches(
  name: string,
  allowed: readonly string[],
): boolean {
  const lower = name.toLowerCase()
  for (const ext of allowed) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

/**
 * Parse `![alt](rel)` and `[text](rel)` references out of markdown and
 * return the normalized binary-extension paths (resolved against
 * `markdown_dir`). External URLs and in-doc anchors are skipped.
 */
export function parseMarkdownBinaryLinks(
  content: string,
  markdown_dir: string,
): Set<string> {
  const result = new Set<string>()
  const imageRe = /!\[[^\]]*\]\(([^)\s]+)\)/g
  let match: RegExpExecArray | null
  while ((match = imageRe.exec(content)) !== null) {
    const rel = match[1] ?? ''
    if (rel.length === 0) continue
    if (rel.includes('://') || rel.startsWith('/')) continue
    if (rel.startsWith('#')) continue
    const normalized = normalizePosix(joinPosix(markdown_dir, rel))
    if (normalized.startsWith('..')) continue
    if (isBinaryExtension(normalized)) result.add(normalized)
  }
  const linkRe = /(^|[^!])\[[^\]]*\]\(([^)\s]+)\)/g
  while ((match = linkRe.exec(content)) !== null) {
    const rel = match[2] ?? ''
    if (rel.length === 0) continue
    if (rel.includes('://') || rel.startsWith('/')) continue
    if (rel.startsWith('#')) continue
    const normalized = normalizePosix(joinPosix(markdown_dir, rel))
    if (normalized.startsWith('..')) continue
    if (isBinaryExtension(normalized)) result.add(normalized)
  }
  return result
}

function joinPosix(a: string, b: string): string {
  if (a === '' || a === '.') return b
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`
}

function normalizePosix(p: string): string {
  const parts = p.split('/').filter((s) => s.length > 0)
  const out: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (out.length === 0) return '..'
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx < 0 ? '' : p.slice(0, idx)
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isENOSPC(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOSPC'
  )
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unstringifiable>'
  }
}
