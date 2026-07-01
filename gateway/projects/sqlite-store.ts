/**
 * @neutronai/gateway/projects — SQLite-backed project settings store
 * (ISSUES #9).
 *
 * Backs the P5.2 `GET` + `PATCH` `/api/app/projects/<id>/settings`
 * surface + the new `GET /api/app/projects` list endpoint with the
 * canonical per-project `projects` + `project_members` tables
 * (migration `0038_projects_canonical.sql`).
 *
 * Replaces `InMemoryProjectSettingsStore` in production
 * (`gateway/index.ts` boot wiring). The in-memory implementation
 * stays in the surface module as a test seam — gateway test suites
 * that boot the surface against a synthetic auth resolver continue to
 * use it; the production-composer integration test boots this
 * SQLite-backed store against a real `ProjectDb` + applied migrations
 * so the wire shape, the surface, and the substrate are exercised
 * end-to-end (the same anti-pattern guard PR #229/#231/#233 enforce).
 *
 * Auto-seed-on-first-access. `get(project_slug, project_id)` upserts
 * a default row if none exists for the requested project_id —
 * matching the in-memory store's behaviour so the settings drawer
 * renders the canonical sections without an explicit "create project"
 * flow. Every first-access row comes from the generic default builder
 * (`buildDefaultSettings`): a humanised name + empty fields. There is
 * no hardcoded demo seed (the `KNOWN_PROJECTS` map was removed in the
 * R6 refactor — audit P2-11); real projects are written to the table
 * by the onboarding wow-moment.
 *
 * Project scoping. The `projects` + `project_members` tables live in
 * the per-instance SQLite file already (one DB per instance); the store
 * does NOT carry a `project_slug` column on either table. The
 * `project_slug` argument to the methods is interface parity with
 * `InMemoryProjectSettingsStore` (which keys by
 * `project_slug::project_id`) — it is not used in any WHERE clause
 * because the DB itself IS the project scope. Cross-instance audit
 * tooling that wants to enumerate projects across instances can read
 * sqlite_master / iterate the instance fleet.
 */

import type { ProjectDb } from '../../persistence/index.ts'
import type { AgentEngagementMode } from '../../connect/agent-engagement.ts'
import { appWsProjectTopicId } from '../../channels/adapters/app-ws/envelope.ts'
import {
  type PrivacyMode,
  type BillingMode,
  type ProjectMember,
  type ProjectSettings,
  type ProjectListEntry,
  type ProjectSettingsStore,
  buildDefaultSettings,
} from '../http/app-projects-surface.ts'
import { resolveProjectEmoji } from './default-emoji.ts'

interface ProjectRow {
  id: string
  name: string
  description: string | null
  persona: string | null
  emoji: string | null
  privacy_mode: PrivacyMode
  billing_mode: BillingMode
  agent_engagement_mode: AgentEngagementMode
  created_at: string
  updated_at: string
  /** ISO-8601; NULL on legacy rows → sort falls back to updated_at. */
  last_activity_at: string | null
}

interface MemberRow {
  project_id: string
  user_id: string
  name: string
  role: 'owner' | 'member'
  joined_at: string
}

const PROJECT_COLS =
  'id, name, description, persona, emoji, privacy_mode, billing_mode, agent_engagement_mode, created_at, updated_at, last_activity_at'

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Map a (project row, member rows) pair to the canonical
 * `ProjectSettings` wire shape used by the HTTP surface. Members are
 * sorted owner-first, then alphabetic by name, matching the brief's
 * § 4.5 settings-drawer rendering contract.
 */
function rowToSettings(row: ProjectRow, members: MemberRow[]): ProjectSettings {
  const sorted = [...members].sort((a, b) => {
    if (a.role === 'owner' && b.role !== 'owner') return -1
    if (b.role === 'owner' && a.role !== 'owner') return 1
    return a.name.localeCompare(b.name)
  })
  const projectMembers: ProjectMember[] = sorted.map((m) => ({
    user_id: m.user_id,
    name: m.name,
    role: m.role,
  }))
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    persona: row.persona ?? '',
    // Resolve a legacy NULL emoji to the deterministic default from the name,
    // so every row reads back a concrete glyph for the rail.
    emoji: resolveProjectEmoji(row.emoji, row.name),
    privacy_mode: row.privacy_mode,
    billing_mode: row.billing_mode,
    agent_engagement_mode: row.agent_engagement_mode,
    members: projectMembers,
  }
}

/**
 * SQLite-backed implementation of `ProjectSettingsStore` + a
 * `list(project_slug)` extension used by the new
 * `GET /api/app/projects` route. Mounted in production via
 * `gateway/index.ts` (replaces `InMemoryProjectSettingsStore` from
 * the P5.2 substrate stub).
 */
export class SqliteProjectSettingsStore implements ProjectSettingsStore {
  constructor(private readonly db: ProjectDb) {}

  async get(
    project_slug: string,
    project_id: string,
  ): Promise<ProjectSettings | null> {
    void project_slug
    const row = this.readRow(project_id)
    if (row !== null) {
      const members = this.readMembers(project_id)
      return rowToSettings(row, members)
    }
    // Auto-seed: mirror InMemoryProjectSettingsStore. The settings
    // drawer GETs project_id N and expects a canonical doc back; we
    // synth one via `buildDefaultSettings` (the same helper the
    // in-memory store uses) and persist it so subsequent reads +
    // PATCH writes hit the same row.
    // Argus r1 IMPORTANT 3 — `readRow` now filters `deleted_at IS NULL`, so
    // a soft-deleted project surfaces here as a null row. We MUST NOT
    // auto-seed in that case: INSERT OR IGNORE would no-op on the existing
    // (archived) id, the filtered re-read would stay null, and the seed
    // guard below would throw. More importantly, resurrecting a project the
    // user asked us to delete/merge is wrong. Distinguish "genuinely-new
    // id" (seed it) from "soft-deleted id" (return not-found) by probing
    // for ANY row with this id, deleted or not.
    if (this.rowExistsIncludingDeleted(project_id)) {
      return null
    }
    const seed = buildDefaultSettings(project_id)
    await this.upsertSeed(seed)
    const reread = this.readRow(project_id)
    if (reread === null) {
      // Should be unreachable — upsertSeed just wrote the row. Bail
      // loudly so a future contention bug doesn't silently surface a
      // null doc.
      throw new Error(`[sqlite-project-store] seed for ${project_id} did not persist`)
    }
    const members = this.readMembers(project_id)
    return rowToSettings(reread, members)
  }

  async update(
    project_slug: string,
    project_id: string,
    patch: {
      privacy_mode?: PrivacyMode
      agent_engagement_mode?: AgentEngagementMode
      name?: string
      emoji?: string
    },
  ): Promise<ProjectSettings | null> {
    // Resolve-or-seed so callers always get a coherent doc back. The
    // surface's PATCH never fabricates a value on the client — an
    // undefined field in `patch` leaves the existing column in place.
    const existing = await this.get(project_slug, project_id)
    if (existing === null) return null
    if (
      patch.privacy_mode === undefined &&
      patch.agent_engagement_mode === undefined &&
      patch.name === undefined &&
      patch.emoji === undefined
    ) {
      return existing
    }
    const ts = nowIso()
    // Only touch the columns present in `patch` (each independently
    // optional), mirroring privacy_mode's coalesce-on-undefined contract.
    const next_privacy = patch.privacy_mode ?? existing.privacy_mode
    const next_engagement = patch.agent_engagement_mode ?? existing.agent_engagement_mode
    const next_name = patch.name ?? existing.name
    // Emoji is written ONLY when the caller explicitly set one — `existing.emoji`
    // is the RESOLVED glyph (a default when the column is NULL), so coalescing it
    // into every UPDATE would freeze that default into the row and stop a legacy
    // row re-deriving as its name changes. Guard the column out otherwise.
    if (patch.emoji !== undefined) {
      await this.db.run(
        `UPDATE projects
            SET name = ?,
                emoji = ?,
                privacy_mode = ?,
                agent_engagement_mode = ?,
                updated_at = ?
          WHERE id = ?`,
        [next_name, patch.emoji, next_privacy, next_engagement, ts, project_id],
      )
    } else {
      await this.db.run(
        `UPDATE projects
            SET name = ?,
                privacy_mode = ?,
                agent_engagement_mode = ?,
                updated_at = ?
          WHERE id = ?`,
        [next_name, next_privacy, next_engagement, ts, project_id],
      )
    }
    const row = this.readRow(project_id)
    if (row === null) return null
    const members = this.readMembers(project_id)
    return rowToSettings(row, members)
  }

  /**
   * List every project in the instance's DB. Used by the new
   * `GET /api/app/projects` list endpoint to back the project-list
   * screen. Members are joined per-row.
   *
   * The brief's § 4.14 keeps the project-LIST UI on the dev-stub
   * (`loadProjects()`) until "production wiring lands in a follow-up
   * P5.x sprint" — ISSUES #9 IS that sprint. Returns rows in
   * `updated_at DESC` order so the most-recently-touched project
   * floats to the top of the list.
   */
  async list(project_slug: string, user_id?: string): Promise<ProjectListEntry[]> {
    void project_slug
    // 2026-06-03 (onboarding-buttons-only-tweak-later): exclude rows the
    // settings Core soft-deleted (delete_project / merge_projects set
    // `deleted_at`, migration 0053). Without this filter `/api/app/projects`
    // would keep showing a project that `list_projects` already hides — the
    // user-facing list and the tweak-later tools would disagree (Codex P2).
    //
    // Rail-redesign: sort by ACTIVITY (`COALESCE(last_activity_at, updated_at)`
    // DESC) so a project with new messages pops to the top; a legacy row with a
    // NULL activity key falls back to updated_at rather than sinking.
    const rows = this.db
      .prepare<ProjectRow, []>(
        `SELECT ${PROJECT_COLS}
           FROM projects
          WHERE deleted_at IS NULL
          ORDER BY COALESCE(last_activity_at, updated_at) DESC, id ASC`,
      )
      .all()
    if (rows.length === 0) return []
    const ids = new Set(rows.map((r) => r.id))
    // Single-shot member read — cheaper than N+1 queries even with
    // SQLite's in-process cost model.
    const memberRows = this.db
      .prepare<MemberRow, []>(
        `SELECT project_id, user_id, name, role, joined_at FROM project_members`,
      )
      .all()
    const byProject = new Map<string, MemberRow[]>()
    for (const m of memberRows) {
      if (!ids.has(m.project_id)) continue
      const list = byProject.get(m.project_id)
      if (list === undefined) byProject.set(m.project_id, [m])
      else list.push(m)
    }
    return rows.map((r) => {
      const settings = rowToSettings(r, byProject.get(r.id) ?? [])
      return {
        ...settings,
        last_activity_at: r.last_activity_at ?? r.updated_at,
        unread_count: user_id !== undefined ? this.unreadCount(user_id, r.id) : 0,
      }
    })
  }

  /**
   * Per-project unread count: agent messages on the project's chat topic
   * (`app:<user>:<project>`) with a seq beyond the highest the owner has a READ
   * receipt for. Honest — derived from the real chat-log + receipt cursor, so a
   * caught-up project reads 0 (never a fabricated badge). Best-effort: a read
   * failure (e.g. the chat tables absent in a minimal test DB) degrades to 0.
   */
  private unreadCount(user_id: string, project_id: string): number {
    const topic = appWsProjectTopicId(user_id, project_id)
    try {
      const row = this.db
        .prepare<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n
             FROM app_chat_messages m
            WHERE m.topic_id = ?
              AND m.role = 'agent'
              AND m.seq > (
                SELECT COALESCE(MAX(r.seq), 0)
                  FROM app_chat_receipts r
                 WHERE r.topic_id = ? AND r.read_at IS NOT NULL
              )`,
        )
        .get(topic, topic)
      return row?.n ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Stamp a project's `last_activity_at` to `now` (best-effort). Called from the
   * chat-message fan when a message lands on the project's topic, so the rail
   * reorders (most-recent-activity first) on the next `projects_changed` frame.
   * A no-op on a missing/soft-deleted row.
   */
  async touchActivity(project_id: string, iso: string = nowIso()): Promise<void> {
    try {
      await this.db.run(
        `UPDATE projects SET last_activity_at = ? WHERE id = ? AND deleted_at IS NULL`,
        [iso, project_id],
      )
    } catch {
      /* activity stamping must never break a message turn */
    }
  }

  /**
   * Idempotent — insert seed rows for any project_ids in `seeds` that
   * are not already present. Used at boot by the production composer
   * to materialize the canonical demo projects (Neutron / Acme /
   * Northwind) so the project-list screen renders something useful on
   * a fresh instance. Existing rows are left untouched (PATCH-edited
   * privacy_mode etc. survives a re-seed).
   */
  async seedDefaults(seeds: ReadonlyArray<ProjectSettings>): Promise<void> {
    for (const seed of seeds) {
      const existing = this.readRow(seed.id)
      if (existing !== null) continue
      await this.upsertSeed(seed)
    }
  }

  /** Test helper — wipe every project + member row. */
  async reset(): Promise<void> {
    // ON DELETE CASCADE on project_members.project_id cleans up the
    // join table when we drop the projects rows.
    await this.db.run('DELETE FROM projects', [])
  }

  /**
   * Read a LIVE project row. Argus r1 IMPORTANT 3 (2026-06-03): the
   * `deleted_at IS NULL` filter is the default so neither `get` nor
   * `update` (which resolves through `get`) can read OR mutate a
   * soft-deleted project — `delete_project` / `merge_projects` set
   * `deleted_at` (migration 0053) and the user-facing list already hides
   * those rows; GET/PATCH `/api/app/projects/<id>/settings` must agree.
   * Internal callers that genuinely need an archived row use
   * `rowExistsIncludingDeleted` (existence only) or a dedicated query.
   */
  private readRow(project_id: string): ProjectRow | null {
    const row = this.db
      .prepare<ProjectRow, [string]>(
        `SELECT ${PROJECT_COLS} FROM projects WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(project_id)
    return row ?? null
  }

  /**
   * True when ANY row (live OR soft-deleted) carries this id. Used by
   * `get` to decide between auto-seeding a genuinely-new project_id and
   * returning not-found for a soft-deleted one (never resurrect it).
   */
  private rowExistsIncludingDeleted(project_id: string): boolean {
    const row = this.db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? LIMIT 1`,
      )
      .get(project_id)
    return row !== undefined && row !== null
  }

  private readMembers(project_id: string): MemberRow[] {
    return this.db
      .prepare<MemberRow, [string]>(
        `SELECT project_id, user_id, name, role, joined_at
           FROM project_members
          WHERE project_id = ?`,
      )
      .all(project_id)
  }

  private async upsertSeed(seed: ProjectSettings): Promise<void> {
    const ts = nowIso()
    await this.db.transaction(async (tx) => {
      // INSERT OR IGNORE — `get`'s upstream caller is async + the
      // store is shared across HTTP requests, so two concurrent
      // first-access GETs on the same project_id race to seed. The
      // IGNORE keeps the loser idempotent.
      await tx.run(
        `INSERT OR IGNORE INTO projects
           (id, name, description, persona, emoji, privacy_mode, billing_mode, agent_engagement_mode, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seed.id,
          seed.name,
          seed.description.length > 0 ? seed.description : null,
          seed.persona.length > 0 ? seed.persona : null,
          // `seed.emoji` is the resolved default from buildDefaultSettings; persist
          // it so a freshly-seeded row already carries a concrete glyph.
          seed.emoji.length > 0 ? seed.emoji : null,
          seed.privacy_mode,
          seed.billing_mode,
          seed.agent_engagement_mode,
          ts,
          ts,
          ts,
        ],
      )
      for (const m of seed.members) {
        await tx.run(
          `INSERT OR IGNORE INTO project_members
             (project_id, user_id, name, role, joined_at)
           VALUES (?, ?, ?, ?, ?)`,
          [seed.id, m.user_id, m.name, m.role, ts],
        )
      }
    })
  }
}
