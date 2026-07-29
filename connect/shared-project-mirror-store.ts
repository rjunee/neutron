/**
 * @neutronai/connect — the collaborator-side SHARED-PROJECT MEMORY-MIRROR
 * import ledger (connect-spec §1.8 + §2.4, IMPORT-ON-JOIN milestone). The
 * writer over `shared_project_mirrors` (migrations/0073_shared_project_mirrors.sql).
 *
 * Under the Slack-Connect model a shared project's memory is host-canonical
 * (§1.8). A collaborator additionally receives a ONE-DIRECTIONAL, scoped
 * (`source=<project>@<host>`) snapshot of the shared project's GBrain GRAPH
 * layer into its OWN GBrain, for cross-project recall. The mirrored graph rows
 * live in GBrain (reached over MCP), NOT here — this table is purely the
 * collaborator-side ONE-TIME-import ledger that makes the import-on-join path
 * idempotent (a re-accept / reconnect must not re-import a duplicate copy) and
 * records the §4 author attribution for audit.
 *
 * SCOPE: this never persists shared-project KNOWLEDGE (that is the GBrain
 * mirror); it records only WHICH (project_id, source) snapshots have already
 * been imported, when, with how many pages/edges, attributed to which author.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface SharedProjectMirrorRow {
  project_id: string
  /** The scope tag stamped on every mirrored entry: `<project>@<host>`. */
  source: string
  /** The host instance slug / home authority (display + audit). */
  host: string
  /** Uniform §4 author id the join was attributed to (local_slug), or null. */
  author_id: string | null
  page_count: number
  edge_count: number
  imported_at: string
}

export interface RecordMirrorInput {
  project_id: string
  source: string
  host: string
  author_id: string | null
  page_count: number
  edge_count: number
  imported_at: string
}

const SELECT_COLS =
  'project_id, source, host, author_id, page_count, edge_count, imported_at'

export class SharedProjectMirrorStore {
  constructor(private readonly db: ProjectDb) {}

  /**
   * Record a completed one-time import. Idempotent on the (project_id, source)
   * PK: a re-import overwrites the prior ledger row in place rather than
   * colliding (the caller is expected to gate on `has` first, but the upsert
   * keeps the ledger consistent if it is called again).
   */
  async record(input: RecordMirrorInput): Promise<void> {
    await this.db.run(
      `INSERT INTO shared_project_mirrors
         (project_id, source, host, author_id, page_count, edge_count, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, source) DO UPDATE SET
         host = excluded.host,
         author_id = excluded.author_id,
         page_count = excluded.page_count,
         edge_count = excluded.edge_count,
         imported_at = excluded.imported_at`,
      [
        input.project_id,
        input.source,
        input.host,
        input.author_id,
        input.page_count,
        input.edge_count,
        input.imported_at,
      ],
    )
  }

  /** Read one import-ledger row, or null if the snapshot was never imported. */
  get(projectId: string, source: string): SharedProjectMirrorRow | null {
    const row = this.db
      .prepare<SharedProjectMirrorRow, [string, string]>(
        `SELECT ${SELECT_COLS} FROM shared_project_mirrors
         WHERE project_id = ? AND source = ? LIMIT 1`,
      )
      .get(projectId, source)
    return row === null || row === undefined ? null : row
  }

  /** True when this (project_id, source) snapshot has already been imported. */
  has(projectId: string, source: string): boolean {
    return this.get(projectId, source) !== null
  }
}
