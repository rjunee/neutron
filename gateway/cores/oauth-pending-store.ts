/**
 * @neutronai/gateway/cores — `cores_oauth_pending` CRUD.
 *
 * Per-instance store for in-flight Google OAuth flows. The /start handler
 * writes one row per flow (state + PKCE code_verifier + labels + TTL);
 * the /ingest handler consumes it after Google's callback fires +
 * identity routes it back to the instance gateway. Consumed rows are
 * pruned on consume; expired-and-unconsumed rows are swept by
 * `sweepExpired(now)` (the gateway's cron module calls this every 5 min).
 *
 * Per docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 3.2.
 */

import type { ProjectDb } from '../../persistence/index.ts'

/** TTL for a pending row — 10 minutes. */
export const PENDING_TTL_MS = 10 * 60 * 1_000

export interface CoresOAuthPendingRow {
  state: string
  project_slug: string
  code_verifier: string
  /** Decoded JSON array of labels this grant covers. */
  labels: string[]
  redirect_uri: string
  started_at: number
  expires_at: number
}

interface RawPendingRow {
  state: string
  project_slug: string
  code_verifier: string
  labels_json: string
  redirect_uri: string
  started_at: number
  expires_at: number
}

export interface CoresOAuthPendingStoreOptions {
  db: ProjectDb
  now?: () => number
}

export interface PutPendingInput {
  state: string
  project_slug: string
  code_verifier: string
  labels: ReadonlyArray<string>
  redirect_uri: string
  /** Optional TTL override (ms); defaults to PENDING_TTL_MS. */
  ttl_ms?: number
}

export class CoresOAuthPendingStore {
  private readonly db: ProjectDb
  private readonly now: () => number

  constructor(opts: CoresOAuthPendingStoreOptions) {
    this.db = opts.db
    this.now = opts.now ?? ((): number => Date.now())
  }

  async put(input: PutPendingInput): Promise<CoresOAuthPendingRow> {
    const startedAt = this.now()
    const ttl = input.ttl_ms ?? PENDING_TTL_MS
    const expiresAt = startedAt + ttl
    const labelsJson = JSON.stringify([...input.labels])
    await this.db.run(
      `INSERT INTO cores_oauth_pending
         (state, project_slug, code_verifier, labels_json, redirect_uri, started_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        input.state,
        input.project_slug,
        input.code_verifier,
        labelsJson,
        input.redirect_uri,
        startedAt,
        expiresAt,
      ],
    )
    return {
      state: input.state,
      project_slug: input.project_slug,
      code_verifier: input.code_verifier,
      labels: [...input.labels],
      redirect_uri: input.redirect_uri,
      started_at: startedAt,
      expires_at: expiresAt,
    }
  }

  /**
   * Single-use lookup: if a matching non-expired non-consumed row exists,
   * delete it and return its content. Otherwise null. Matches the shape
   * of `identity/oauth/store.ts:OAuthPendingStore.consume` — delete-on-read
   * defeats replay attacks even before sweepExpired runs.
   */
  async consume(state: string): Promise<CoresOAuthPendingRow | null> {
    const now = this.now()
    return this.db.transaction(async (tx) => {
      const row = tx
        .prepare<RawPendingRow, [string, number]>(
          `SELECT state, project_slug, code_verifier, labels_json, redirect_uri, started_at, expires_at
             FROM cores_oauth_pending
             WHERE state = ? AND expires_at > ? AND consumed_at IS NULL`,
        )
        .get(state, now)
      if (row === null) return null
      await tx.run(`DELETE FROM cores_oauth_pending WHERE state = ?`, [state])
      return rowToRecord(row)
    })
  }

  async sweepExpired(now?: number): Promise<number> {
    const cutoff = now ?? this.now()
    const result = await this.db.transaction(async (tx) => {
      const before = tx
        .prepare<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM cores_oauth_pending WHERE expires_at <= ?`,
        )
        .get(cutoff)
      await tx.run(`DELETE FROM cores_oauth_pending WHERE expires_at <= ?`, [cutoff])
      return before?.n ?? 0
    })
    return result
  }
}

function rowToRecord(row: RawPendingRow): CoresOAuthPendingRow {
  let labels: string[]
  try {
    const parsed: unknown = JSON.parse(row.labels_json)
    if (!Array.isArray(parsed)) {
      labels = []
    } else {
      labels = parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    labels = []
  }
  return {
    state: row.state,
    project_slug: row.project_slug,
    code_verifier: row.code_verifier,
    labels,
    redirect_uri: row.redirect_uri,
    started_at: row.started_at,
    expires_at: row.expires_at,
  }
}
