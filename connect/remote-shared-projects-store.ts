/**
 * @neutronai/connect — the collaborator-side THIN SHARED-PROJECT REFERENCE
 * store (connect-spec §1.7). The writer over `remote_shared_projects`
 * (migrations/0060_remote_shared_projects.sql + 0061 `active` flag).
 *
 * Under the Slack-Connect model a shared project is single-hosted on the host's
 * instance with one memory; a collaborator's instance holds only a LIGHTWEIGHT
 * POINTER to each shared project it can access — `{ project_id, host
 * relay_base_url, host instance (owner_home), active }` — just enough to find
 * the host and open a LIVE session against it. There is NO content, NO memory,
 * and NO content-sync read-replica cursor: that cursor was part of the deleted
 * mesh and is gone (connect-spec §2.1, §2.2).
 *
 * SCOPE: this is a reference pointer only — it never persists shared-project
 * knowledge. Collaborators participate LIVE against the host (connect-spec
 * §1.7); cross-project recall is served by the separate one-way memory-graph
 * mirror (connect-spec §1.8), not by this store.
 */

import type { ProjectDb } from '../persistence/index.ts'

export interface RemoteSharedProjectRow {
  project_id: string
  relay_base_url: string
  owner_home: string
  joined_at: string
  /** 1 while the share is live; flipped to 0 when the host revokes the
   *  collaborator (the live reference is torn down). */
  active: number
}

export interface RegisterRemoteSharedProjectInput {
  project_id: string
  /** The host/connect node's public ingress base URL the collaborator's live
   *  session connects to. */
  relay_base_url: string
  /** The host's home authority / instance slug (display + audit). */
  owner_home: string
  /** ISO-8601 UTC join timestamp. */
  joined_at: string
}

const SELECT_COLS = 'project_id, relay_base_url, owner_home, joined_at, active'

export class RemoteSharedProjectsStore {
  constructor(private readonly db: ProjectDb) {}

  /**
   * Register a freshly-accepted shared-project reference. Idempotent on
   * `project_id`: re-accepting an existing reference re-points the host
   * relay/owner display + re-activates the row.
   */
  async register(input: RegisterRemoteSharedProjectInput): Promise<void> {
    await this.db.run(
      `INSERT INTO remote_shared_projects
         (project_id, relay_base_url, owner_home, joined_at, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(project_id) DO UPDATE SET
         relay_base_url = excluded.relay_base_url,
         owner_home = excluded.owner_home,
         active = 1`,
      [input.project_id, input.relay_base_url, input.owner_home, input.joined_at],
    )
  }

  /** Read one reference row (any active state). */
  get(projectId: string): RemoteSharedProjectRow | null {
    const row = this.db
      .prepare<RemoteSharedProjectRow, [string]>(
        `SELECT ${SELECT_COLS} FROM remote_shared_projects WHERE project_id = ? LIMIT 1`,
      )
      .get(projectId)
    return row === null || row === undefined ? null : row
  }

  /** All ACTIVE shared-project references — the set the unified list shows
   *  beside the collaborator's own private projects (connect-spec §1.7). */
  listActive(): RemoteSharedProjectRow[] {
    return this.db
      .prepare<RemoteSharedProjectRow, []>(
        `SELECT ${SELECT_COLS} FROM remote_shared_projects WHERE active = 1 ORDER BY project_id ASC`,
      )
      .all()
  }

  /**
   * Mark a reference inactive — called when the host revokes the collaborator.
   * Stops the unified list from showing the shared project + tears down the
   * live reference.
   */
  async markInactive(projectId: string): Promise<void> {
    await this.db.run(
      `UPDATE remote_shared_projects SET active = 0 WHERE project_id = ?`,
      [projectId],
    )
  }
}
