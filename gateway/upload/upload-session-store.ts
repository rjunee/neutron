/**
 * @neutronai/gateway/upload — durable upload session store.
 *
 * Backs the chunked resumable upload protocol (migration 0048). One row
 * per `POST /api/upload/<source>/start`; the row tracks the high-water
 * mark `bytes_received` so a `HEAD /api/upload/<source>/<upload_id>`
 * tells a resuming client where to resume from.
 *
 * Owns DB rows only. Filesystem ops (sparse-file create, chunk write,
 * final rename, partial unlink) live in `chunked-upload-handler.ts`; the
 * sweeper that expires stale rows lives in `chunked-upload-sweeper.ts`.
 *
 * Mirrors the narrow-store shape of `profile-pic/pending-call-store.ts`:
 * a tight `ProjectDb` wrapper with explicit method-per-state-transition.
 */

import type { ProjectDb } from '../../persistence/index.ts'

export type UploadSessionStatus = 'uploading' | 'complete' | 'expired'

export interface UploadSessionRow {
  upload_id: string
  project_slug: string
  source: 'chatgpt' | 'claude'
  filename: string
  total_bytes: number
  bytes_received: number
  mime_type: string
  status: UploadSessionStatus
  created_at: number
  expires_at: number
}

interface RawRow {
  upload_id: string
  project_slug: string
  source: string
  filename: string
  total_bytes: number
  bytes_received: number
  mime_type: string
  status: string
  created_at: number
  expires_at: number
}

export interface CreateUploadSessionInput {
  upload_id: string
  project_slug: string
  source: 'chatgpt' | 'claude'
  filename: string
  total_bytes: number
  mime_type: string
  created_at: number
  expires_at: number
}

/**
 * Store-side surface the chunked-upload handler + sweeper depend on.
 * Tests construct an in-memory implementation that satisfies this
 * interface so they don't have to spin up a ProjectDb for every assertion.
 */
export interface UploadSessionStore {
  create(input: CreateUploadSessionInput): Promise<void>
  /** Returns the row regardless of status. Returns null when not found. */
  get(upload_id: string): Promise<UploadSessionRow | null>
  /**
   * Idempotent high-water-mark update. Uses SQL `MAX(bytes_received, ?)`
   * so a retried chunk does NOT regress the offset. ONLY mutates rows
   * whose status is currently 'uploading' — completed / expired rows
   * stay frozen. Returns the post-update bytes_received value (i.e. the
   * caller's Upload-Offset response), or null if the row was missing /
   * non-uploading.
   */
  updateBytesReceived(upload_id: string, candidate_offset: number): Promise<number | null>
  /**
   * Mark the row 'expired'. Idempotent — re-marking is a no-op.
   * Returns true if the row actually transitioned ('uploading' → 'expired').
   */
  markExpired(upload_id: string): Promise<boolean>
  /**
   * Delete the row. Used by the chunked-upload handler on successful
   * completion so completed sessions don't pile up in the table.
   * Returns true if a row was deleted, false if it was already gone.
   */
  deleteSession(upload_id: string): Promise<boolean>
  /**
   * Scan for sessions whose `expires_at` has passed AND status is still
   * 'uploading'. Returns up to `limit` rows. The sweeper iterates these,
   * unlinks the partial file, then `markExpired`s each one.
   */
  listExpiredUploading(now_ms: number, limit: number): Promise<UploadSessionRow[]>
}

/**
 * Production `UploadSessionStore` over the per-project `project.db`.
 * Migration 0048 owns the `upload_sessions` table schema.
 */
export class SqliteUploadSessionStore implements UploadSessionStore {
  constructor(private readonly db: ProjectDb) {}

  async create(input: CreateUploadSessionInput): Promise<void> {
    await this.db.run(
      `INSERT INTO upload_sessions
         (upload_id, project_slug, source, filename, total_bytes,
          bytes_received, mime_type, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'uploading', ?, ?)`,
      [
        input.upload_id,
        input.project_slug,
        input.source,
        input.filename,
        input.total_bytes,
        input.mime_type,
        input.created_at,
        input.expires_at,
      ],
    )
  }

  async get(upload_id: string): Promise<UploadSessionRow | null> {
    const raw = this.db
      .prepare<RawRow, [string]>(
        `SELECT upload_id, project_slug, source, filename, total_bytes,
                bytes_received, mime_type, status, created_at, expires_at
           FROM upload_sessions
          WHERE upload_id = ?`,
      )
      .get(upload_id)
    if (raw === null) return null
    return mapRow(raw)
  }

  async updateBytesReceived(
    upload_id: string,
    candidate_offset: number,
  ): Promise<number | null> {
    // Idempotent UPDATE: bytes_received only grows. Restricted to
    // 'uploading' rows so a completed / expired row stays frozen.
    await this.db.run(
      `UPDATE upload_sessions
          SET bytes_received = MAX(bytes_received, ?)
        WHERE upload_id = ? AND status = 'uploading'`,
      [candidate_offset, upload_id],
    )
    const post = this.db
      .prepare<{ bytes_received: number; status: string }, [string]>(
        `SELECT bytes_received, status FROM upload_sessions WHERE upload_id = ?`,
      )
      .get(upload_id)
    if (post === null) return null
    if (post.status !== 'uploading') return null
    return post.bytes_received
  }

  async markExpired(upload_id: string): Promise<boolean> {
    let changed = false
    await this.db.transaction(async (tx) => {
      const pre = tx
        .prepare<{ status: string }, [string]>(
          `SELECT status FROM upload_sessions WHERE upload_id = ?`,
        )
        .get(upload_id)
      if (pre === null || pre.status !== 'uploading') return
      await tx.run(
        `UPDATE upload_sessions SET status = 'expired' WHERE upload_id = ?`,
        [upload_id],
      )
      changed = true
    })
    return changed
  }

  async deleteSession(upload_id: string): Promise<boolean> {
    let deleted = false
    await this.db.transaction(async (tx) => {
      const pre = tx
        .prepare<{ upload_id: string }, [string]>(
          `SELECT upload_id FROM upload_sessions WHERE upload_id = ?`,
        )
        .get(upload_id)
      if (pre === null) return
      await tx.run(`DELETE FROM upload_sessions WHERE upload_id = ?`, [upload_id])
      deleted = true
    })
    return deleted
  }

  async listExpiredUploading(now_ms: number, limit: number): Promise<UploadSessionRow[]> {
    const rows = this.db
      .prepare<RawRow, [number, number]>(
        `SELECT upload_id, project_slug, source, filename, total_bytes,
                bytes_received, mime_type, status, created_at, expires_at
           FROM upload_sessions
          WHERE status = 'uploading' AND expires_at < ?
          ORDER BY expires_at ASC
          LIMIT ?`,
      )
      .all(now_ms, limit)
    return rows.map(mapRow)
  }
}

function mapRow(raw: RawRow): UploadSessionRow {
  if (raw.source !== 'chatgpt' && raw.source !== 'claude') {
    throw new Error(
      `upload_sessions.source CHECK violation: got ${JSON.stringify(raw.source)} (table schema constrains to chatgpt|claude)`,
    )
  }
  if (
    raw.status !== 'uploading' &&
    raw.status !== 'complete' &&
    raw.status !== 'expired'
  ) {
    throw new Error(
      `upload_sessions.status CHECK violation: got ${JSON.stringify(raw.status)}`,
    )
  }
  return {
    upload_id: raw.upload_id,
    project_slug: raw.project_slug,
    source: raw.source,
    filename: raw.filename,
    total_bytes: raw.total_bytes,
    bytes_received: raw.bytes_received,
    mime_type: raw.mime_type,
    status: raw.status,
    created_at: raw.created_at,
    expires_at: raw.expires_at,
  }
}
