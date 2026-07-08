/**
 * agent-settings Core — backend interface + SQLite/registry impl.
 *
 * The "tweak later" tools the onboarding final-handoff promises the
 * user can call after onboarding ("you can rename / delete / merge
 * projects, switch personality, update my name later — just ask"), plus
 * the Item 3 resumable Telegram connect (`connect_telegram`). This
 * module implements that promise against the canonical stores:
 *
 *   - Projects (list / rename / delete / merge) → the per-project
 *     canonical `projects` + `project_members` tables (migration
 *     0038_projects_canonical.sql, soft-delete columns added in
 *     0053_projects_soft_delete.sql). NOT the onboarding phase_state,
 *     NOT the `topics` table.
 *
 *   - Personality + agent name (update_personality / update_agent_name)
 *     → the platform instance registry row (columns `agent_name`,
 *     `agent_personality`; provisioning migrations 0004 + 0006).
 *     The per-instance gateway opens registry.db READ-ONLY at boot, so
 *     mutations route through an injected `AgentProfileBackend` whose
 *     production impl opens the registry RW via `NEUTRON_REGISTRY_DB_PATH`
 *     (same seam the persona-sync onboarding hook uses).
 *
 *   - Telegram confirmations + forum-topic retitle/archive route through
 *     an injected `AgentSettingsTelegram` so the backend stays testable
 *     (the production impl resolves the bot token lazily from the
 *     SecretsStore + the project's bound chat).
 *
 * KNOWN LIMITATION (documented in the migration + the PR): onboarding
 * does NOT populate the canonical `projects` table — wow-moment project
 * shells land as `topics` rows with a UUID project_id and NO name
 * column (onboarding/wow-moment/actions/03-project-shells.ts). The
 * `projects` table is populated lazily on first PATCH /settings access
 * or by the demo seeder. These tools are CORRECT against the canonical
 * store regardless; on an instance that has never opened a project's
 * settings, `list_projects` returns whatever has been seeded so far
 * (possibly empty). Closing that gap touches onboarding/interview/*
 * (out of scope for this sprint).
 */

import type { ProjectDb } from '../../../../persistence/index.ts'
import { TELEGRAM_BIND_TOKEN_TTL_MS } from '../../../../contracts/handoff-config.ts'
import {
  DEFAULT_AGENT_ENGAGEMENT_MODE,
  isAgentEngagementMode,
  type AgentEngagementMode,
} from '../../../../connect/agent-engagement.ts'

/** The user-facing project shape every tool returns. */
export interface ProjectView {
  id: string
  name: string
  slug: string
  /** Telegram forum-topic thread id, or null when unbound. */
  topic_id: string | null
  /** A short one-line summary used in the project list. */
  context_summary: string
}

/** Personality settings shape returned by update_personality. */
export interface PersonalityView {
  archetype: string | null
  description: string | null
}

/**
 * Outbound Telegram side-effects the tools fire. Injected so the backend
 * is unit-testable; the production impl (built in the gateway's
 * install-bundled backend factory) resolves the bot token + the
 * project's bound chat lazily. Every method is best-effort — a Telegram
 * failure MUST NOT roll back the committed DB mutation, so the impl
 * swallows + logs its own errors and the backend never awaits a throw.
 */
export interface AgentSettingsTelegram {
  /** Emit a plain-text confirmation to the user (no markdown tables). */
  sendConfirmation(text: string): Promise<void>
  /** Retitle a project's forum topic. No-op when topic_id is null. */
  renameTopic(topic_id: string | null, new_name: string): Promise<void>
  /** Close/archive a project's forum topic. No-op when topic_id is null. */
  archiveTopic(topic_id: string | null): Promise<void>
}

/**
 * Canonical user-facing error when the agent-profile registry writer is
 * not wired (e.g. `NEUTRON_REGISTRY_DB_PATH` unset, or the RW open
 * failed). Surfaced by `update_personality` / `update_agent_name` so the
 * owner's CC subprocess relays an HONEST failure to the user instead of a `success`
 * that silently no-ops (Argus r5 IMPORTANT, 2026-06-03).
 */
export const SETTINGS_BACKEND_UNAVAILABLE_ERROR =
  'Settings backend unavailable — change not persisted, please report this'

/**
 * Canonical user-facing error when the Telegram bind-link minter is not
 * wired (`NEUTRON_TELEGRAM_BIND_SECRET` unset / <32 chars on this box)
 * OR the mint itself failed. Same honest-failure discipline as
 * `SETTINGS_BACKEND_UNAVAILABLE_ERROR` — the owner's CC subprocess relays this
 * verbatim instead of inventing a link.
 */
export const CONNECT_TELEGRAM_UNAVAILABLE_ERROR =
  'Telegram connect is unavailable on this deployment — bind-link minting is not configured, please report this'

/**
 * Item 3 (post-onboarding-experience spec § 3.2a, 2026-06-10) — the
 * durable Telegram-connect seam. Mints a fresh one-time
 * `https://t.me/<bot>?start=bind_<token>` deep link on demand, reusing
 * the SAME mint path the wow handoff uses
 * (`signup/telegram-bind-token.ts:buildMintTelegramBindToken` +
 * `onboarding/interview/final-handoff-config.ts:buildTelegramBindDeepLink`)
 * so the unchanged bot-side consumer (`signup/telegram-bind-handler.ts`)
 * accepts it. The production impl is composed in gateway/index.ts
 * `buildAgentSettingsWiring`; tests inject a fake.
 */
export interface TelegramBindLinkMinter {
  /**
   * When explicitly `false`, minting is NOT wired (no HMAC secret on
   * the box) — `connect_telegram` short-circuits to `success:false` +
   * `CONNECT_TELEGRAM_UNAVAILABLE_ERROR`. Omitted / `true` → minter is
   * live.
   */
  available?: boolean
  /**
   * Mint a fresh one-time bind token and return the full deep link, or
   * `null` when minting failed (grammar/length violation or a store
   * error the underlying minter surfaced). Each call mints a NEW token
   * — links are single-use + TTL-bound, so re-entry means re-mint.
   */
  mintDeepLink(): Promise<string | null>
}

/**
 * Read/write the agent profile (name + personality) on the platform
 * registry row. The production impl opens registry.db RW; tests pass an
 * in-memory fake.
 */
export interface AgentProfileBackend {
  /**
   * When explicitly `false`, the registry writer is NOT wired —
   * `setAgentName` / `setAgentPersonality` are no-ops. Profile-mutating
   * tools MUST short-circuit to `success:false` +
   * `SETTINGS_BACKEND_UNAVAILABLE_ERROR` rather than lie that the change
   * persisted (Argus r5 IMPORTANT). Omitted / `true` → writer is live
   * (the default for production + test fakes).
   */
  available?: boolean
  get(): Promise<{
    agent_name: string | null
    agent_personality: string | null
  }>
  setAgentName(agent_name: string | null): Promise<void>
  setAgentPersonality(agent_personality: string | null): Promise<void>
}

export interface AgentSettingsBackend {
  listProjects(): Promise<{ projects: ProjectView[] }>
  renameProject(
    old_name: string,
    new_name: string,
  ): Promise<{ success: boolean; project?: ProjectView }>
  deleteProject(name: string): Promise<{
    success: boolean
    removed?: { name: string; context_archived_at: string | null }
  }>
  /**
   * Archive a project by name (migration 0095) — sets `archived_at` so it
   * leaves the rail but stays restorable from the Admin tab. Reversible, and
   * DISTINCT from `deleteProject` (the topic is closed either way, but archive
   * keeps the project in the owner's Admin list). Unknown / already-archived
   * name → `success:false`.
   */
  archiveProject(name: string): Promise<{
    success: boolean
    archived?: { name: string; archived_at: string }
  }>
  /**
   * Restore an archived project by name — clears `archived_at` so it returns to
   * the rail. Resolves against the archived set only; an unknown / not-archived
   * name → `success:false`.
   */
  restoreProject(name: string): Promise<{
    success: boolean
    restored?: { name: string }
  }>
  mergeProjects(
    from_name: string,
    into_name: string,
  ): Promise<{ success: boolean; merged_project?: ProjectView }>
  updatePersonality(input: {
    new_archetype?: string
    new_description?: string
  }): Promise<{ success: boolean; personality?: PersonalityView; error?: string }>
  updateAgentName(
    new_name: string,
  ): Promise<{ success: boolean; agent_name?: string | null; error?: string }>
  connectTelegram(): Promise<{
    success: boolean
    deep_link?: string
    expires_in_minutes?: number
    error?: string
  }>
  /**
   * Report a shared project's `agent_engagement_mode` (the per-project
   * Connect engagement switch — `all_messages` = engage on every member
   * post, `tag_gated` = engage only on an `@neutron` mention). Resolves
   * the project by display name; unknown name → `success:false` + error.
   */
  getEngagementMode(project_name: string): Promise<{
    success: boolean
    project_name?: string
    mode?: AgentEngagementMode
    error?: string
  }>
  /**
   * Set a shared project's `agent_engagement_mode`. Validates the mode,
   * resolves the project by display name (unknown → `success:false` +
   * error), writes the canonical `projects` column, and emits a Telegram
   * confirmation on success (mirrors the other mutating project tools).
   */
  setEngagementMode(
    project_name: string,
    mode: AgentEngagementMode,
  ): Promise<{
    success: boolean
    project_name?: string
    mode?: AgentEngagementMode
    error?: string
  }>
}

export interface AgentSettingsBackendOptions {
  projectDb: ProjectDb
  profile: AgentProfileBackend
  telegram: AgentSettingsTelegram
  /**
   * Item 3 — optional so existing callers/tests stay valid. When omitted
   * (or `available:false`), `connect_telegram` reports the honest
   * unavailable error instead of pretending to mint.
   */
  bindLink?: TelegramBindLinkMinter
}

interface ProjectRow {
  id: string
  name: string
  description: string | null
  persona: string | null
  topic_id: string | null
  context_archived_at: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Derive a short context summary for the project list. Prefers the
 * project description, falls back to the persona label, then to a
 * generic phrase. Kept deterministic (no LLM) — the agent can elaborate
 * in chat.
 */
function summarize(row: ProjectRow): string {
  const desc = row.description?.trim()
  if (desc !== undefined && desc.length > 0) return desc
  const persona = row.persona?.trim()
  if (persona !== undefined && persona.length > 0) return `Persona: ${persona}`
  return 'No description yet.'
}

function toView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    // The canonical `projects.id` IS the slug (migration 0038: "id
    // TEXT PRIMARY KEY — the slug-ish identifier already in flight on
    // tasks.project_id / sessions.project_id"). Expose it as both.
    slug: row.id,
    name: row.name,
    topic_id: row.topic_id,
    context_summary: summarize(row),
  }
}

const SELECT_COLS =
  'id, name, description, persona, topic_id, context_archived_at'

/**
 * Build the canonical agent-settings backend. Project ops hit the
 * per-project `projects` / `project_members` tables; profile ops route
 * through the injected `AgentProfileBackend`; every successful mutation
 * emits a plain-text Telegram confirmation.
 */
export function buildAgentSettingsBackend(
  opts: AgentSettingsBackendOptions,
): AgentSettingsBackend {
  const { projectDb, profile, telegram, bindLink } = opts

  const findLiveByName = (name: string): ProjectRow | null => {
    const trimmed = name.trim()
    // Case-insensitive name match, live rows only. Returns the
    // most-recently-updated match if two live projects share a name
    // (0038 explicitly allows duplicate names). Archived-projects (0095):
    // `archived_at IS NULL` joins the delete filter so an archived project is
    // not a rename/delete/merge/engagement target until it is restored — it
    // has left every live surface. Restore resolves it via `findArchivedByName`.
    const row = projectDb
      .prepare<ProjectRow, [string]>(
        `SELECT ${SELECT_COLS}
           FROM projects
          WHERE deleted_at IS NULL
            AND archived_at IS NULL
            AND name = ? COLLATE NOCASE
          ORDER BY updated_at DESC, id ASC
          LIMIT 1`,
      )
      .get(trimmed)
    return row ?? null
  }

  // Resolve an ARCHIVED (non-deleted) project by name — the restore target.
  const findArchivedByName = (name: string): ProjectRow | null => {
    const trimmed = name.trim()
    const row = projectDb
      .prepare<ProjectRow, [string]>(
        `SELECT ${SELECT_COLS}
           FROM projects
          WHERE deleted_at IS NULL
            AND archived_at IS NOT NULL
            AND name = ? COLLATE NOCASE
          ORDER BY archived_at DESC, id ASC
          LIMIT 1`,
      )
      .get(trimmed)
    return row ?? null
  }

  const readRow = (id: string): ProjectRow | null => {
    const row = projectDb
      .prepare<ProjectRow, [string]>(
        `SELECT ${SELECT_COLS} FROM projects WHERE id = ?`,
      )
      .get(id)
    return row ?? null
  }

  return {
    async listProjects(): Promise<{ projects: ProjectView[] }> {
      const rows = projectDb
        .prepare<ProjectRow, []>(
          `SELECT ${SELECT_COLS}
             FROM projects
            WHERE deleted_at IS NULL
              AND archived_at IS NULL
            ORDER BY updated_at DESC, id ASC`,
        )
        .all()
      return { projects: rows.map(toView) }
    },

    async renameProject(
      old_name: string,
      new_name: string,
    ): Promise<{ success: boolean; project?: ProjectView }> {
      const row = findLiveByName(old_name)
      if (row === null) return { success: false }
      const trimmedNew = new_name.trim()
      if (trimmedNew.length === 0) return { success: false }
      const ts = nowIso()
      await projectDb.run(
        `UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`,
        [trimmedNew, ts, row.id],
      )
      const updated = readRow(row.id)
      if (updated === null) return { success: false }
      const view = toView(updated)
      // Retitle the Telegram forum topic (best-effort) + confirm.
      await telegram.renameTopic(row.topic_id, trimmedNew)
      await telegram.sendConfirmation(
        `Renamed "${row.name}" to "${trimmedNew}".`,
      )
      return { success: true, project: view }
    },

    async deleteProject(name: string): Promise<{
      success: boolean
      removed?: { name: string; context_archived_at: string | null }
    }> {
      const row = findLiveByName(name)
      if (row === null) return { success: false }
      const ts = nowIso()
      await projectDb.run(
        `UPDATE projects
            SET deleted_at = ?, context_archived_at = ?, updated_at = ?
          WHERE id = ?`,
        [ts, ts, ts, row.id],
      )
      await telegram.archiveTopic(row.topic_id)
      await telegram.sendConfirmation(`Deleted the "${row.name}" project.`)
      return {
        success: true,
        removed: { name: row.name, context_archived_at: ts },
      }
    },

    async archiveProject(name: string): Promise<{
      success: boolean
      archived?: { name: string; archived_at: string }
    }> {
      const row = findLiveByName(name)
      if (row === null) return { success: false }
      const ts = nowIso()
      await projectDb.run(
        `UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?`,
        [ts, ts, row.id],
      )
      // Close/archive the Telegram topic (best-effort) + confirm — mirrors
      // deleteProject, but the project stays restorable from the Admin tab.
      await telegram.archiveTopic(row.topic_id)
      await telegram.sendConfirmation(
        `Archived the "${row.name}" project — it's out of your rail but you can restore it any time from the Admin tab.`,
      )
      return { success: true, archived: { name: row.name, archived_at: ts } }
    },

    async restoreProject(name: string): Promise<{
      success: boolean
      restored?: { name: string }
    }> {
      const row = findArchivedByName(name)
      if (row === null) return { success: false }
      const ts = nowIso()
      await projectDb.run(
        `UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?`,
        [ts, row.id],
      )
      await telegram.sendConfirmation(`Restored the "${row.name}" project — it's back in your rail.`)
      return { success: true, restored: { name: row.name } }
    },

    async mergeProjects(
      from_name: string,
      into_name: string,
    ): Promise<{ success: boolean; merged_project?: ProjectView }> {
      const from = findLiveByName(from_name)
      const into = findLiveByName(into_name)
      if (from === null || into === null) return { success: false }
      if (from.id === into.id) return { success: false }
      const ts = nowIso()
      // KNOWN LIMITATION (Codex P2, ISSUES #87): this moves project
      // MEMBERSHIP only. Project-scoped DATA rows (tasks.project_id,
      // sessions.project_id, topics.project_id, reminders, notes, etc.)
      // still point at `from.id` after the soft-delete, so the surviving
      // project does not yet inherit the source's actual context. Moving
      // that data is deferred to the same follow-up that closes the
      // projects-table-population gap (onboarding doesn't write the
      // canonical `projects` table yet — see ISSUES #87), because both
      // need the project-scoped data model wired end-to-end first. Until
      // then `merge_projects` is a membership-merge + archive, not a full
      // context fuse.
      // Atomic: move members from `from` → `into`, soft-delete `from`,
      // stamp its context_archived_at. INSERT OR IGNORE so a member who
      // already belongs to `into` doesn't violate the composite PK.
      await projectDb.transaction(async (tx) => {
        await tx.run(
          // Carry origin_instance onto the re-pointed rows (ISSUES #200): it
          // is the member's connected_members.local_slug, and the Ph6
          // ConnectUsageMeter joins pm.origin_instance = cm.local_slug to count
          // active shared projects + members. NULLing it on a merge would
          // silently drop a merge-migrated foreign member out of both counts.
          `INSERT OR IGNORE INTO project_members
             (project_id, user_id, name, role, joined_at, origin_instance)
           SELECT ?, user_id, name, role, joined_at, origin_instance
             FROM project_members
            WHERE project_id = ?`,
          [into.id, from.id],
        )
        await tx.run(
          `DELETE FROM project_members WHERE project_id = ?`,
          [from.id],
        )
        await tx.run(
          `UPDATE projects
              SET deleted_at = ?, context_archived_at = ?, updated_at = ?
            WHERE id = ?`,
          [ts, ts, ts, from.id],
        )
        await tx.run(
          `UPDATE projects SET updated_at = ? WHERE id = ?`,
          [ts, into.id],
        )
      })
      const merged = readRow(into.id)
      if (merged === null) return { success: false }
      await telegram.archiveTopic(from.topic_id)
      await telegram.sendConfirmation(
        `Merged "${from.name}" into "${into.name}".`,
      )
      return { success: true, merged_project: toView(merged) }
    },

    async updatePersonality(input: {
      new_archetype?: string
      new_description?: string
    }): Promise<{ success: boolean; personality?: PersonalityView; error?: string }> {
      const archetype = input.new_archetype?.trim()
      const description = input.new_description?.trim()
      if (
        (archetype === undefined || archetype.length === 0) &&
        (description === undefined || description.length === 0)
      ) {
        // Nothing to change — neither field supplied.
        return { success: false }
      }
      // Argus r5 IMPORTANT (2026-06-03): the registry writer is not wired
      // (NEUTRON_REGISTRY_DB_PATH unset / RW open failed). setAgentPersonality
      // would silently no-op; report the failure honestly instead of a
      // success that didn't persist.
      if (profile.available === false) {
        return { success: false, error: SETTINGS_BACKEND_UNAVAILABLE_ERROR }
      }
      // Personality is stored as a single `agent_personality` phrase on
      // the registry row. We compose archetype + description into that
      // phrase, preserving whichever side the caller didn't supply.
      const current = await profile.get()
      const parsed = parsePersonality(current.agent_personality)
      const nextArchetype =
        archetype !== undefined && archetype.length > 0
          ? archetype
          : parsed.archetype
      const nextDescription =
        description !== undefined && description.length > 0
          ? description
          : parsed.description
      const composed = composePersonality(nextArchetype, nextDescription)
      await profile.setAgentPersonality(composed)
      await telegram.sendConfirmation(
        `Updated my personality to: ${composed}`,
      )
      return {
        success: true,
        personality: { archetype: nextArchetype, description: nextDescription },
      }
    },

    async updateAgentName(
      new_name: string,
    ): Promise<{ success: boolean; agent_name?: string | null; error?: string }> {
      const trimmed = new_name.trim()
      if (trimmed.length === 0) return { success: false }
      // Argus r5 IMPORTANT (2026-06-03): honest failure when the registry
      // writer is unavailable — see updatePersonality.
      if (profile.available === false) {
        return { success: false, error: SETTINGS_BACKEND_UNAVAILABLE_ERROR }
      }
      await profile.setAgentName(trimmed)
      await telegram.sendConfirmation(`Got it — I'm ${trimmed} now.`)
      return { success: true, agent_name: trimmed }
    },

    async connectTelegram(): Promise<{
      success: boolean
      deep_link?: string
      expires_in_minutes?: number
      error?: string
    }> {
      // Honest failure when minting is unwired (no HMAC secret on the
      // box) — same discipline as the agent-profile seam above.
      if (bindLink === undefined || bindLink.available === false) {
        return { success: false, error: CONNECT_TELEGRAM_UNAVAILABLE_ERROR }
      }
      let deep_link: string | null
      try {
        deep_link = await bindLink.mintDeepLink()
      } catch (err) {
        console.warn(
          `[agent-settings] connect_telegram mintDeepLink threw (reported as unavailable): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        deep_link = null
      }
      if (deep_link === null) {
        return { success: false, error: CONNECT_TELEGRAM_UNAVAILABLE_ERROR }
      }
      // No Telegram confirmation here — the user is not bound yet (that
      // is the point of the link); the tool result flows back through
      // the agent's chat reply instead.
      return {
        success: true,
        deep_link,
        expires_in_minutes: Math.round(TELEGRAM_BIND_TOKEN_TTL_MS / 60_000),
      }
    },

    async getEngagementMode(project_name: string): Promise<{
      success: boolean
      project_name?: string
      mode?: AgentEngagementMode
      error?: string
    }> {
      const row = findLiveByName(project_name)
      if (row === null) {
        return { success: false, error: `project not found: ${project_name}` }
      }
      const modeRow = projectDb
        .prepare<{ agent_engagement_mode: string | null }, [string]>(
          `SELECT agent_engagement_mode FROM projects WHERE id = ?`,
        )
        .get(row.id)
      const raw = modeRow?.agent_engagement_mode
      const mode = isAgentEngagementMode(raw)
        ? raw
        : DEFAULT_AGENT_ENGAGEMENT_MODE
      return { success: true, project_name: row.name, mode }
    },

    async setEngagementMode(
      project_name: string,
      mode: AgentEngagementMode,
    ): Promise<{
      success: boolean
      project_name?: string
      mode?: AgentEngagementMode
      error?: string
    }> {
      if (!isAgentEngagementMode(mode)) {
        return { success: false, error: `invalid engagement mode: ${String(mode)}` }
      }
      const row = findLiveByName(project_name)
      if (row === null) {
        return { success: false, error: `project not found: ${project_name}` }
      }
      const ts = nowIso()
      await projectDb.run(
        `UPDATE projects SET agent_engagement_mode = ?, updated_at = ? WHERE id = ?`,
        [mode, ts, row.id],
      )
      // Confirm on success — mirrors renameProject's best-effort Telegram
      // confirmation on every committed project mutation.
      await telegram.sendConfirmation(
        mode === 'tag_gated'
          ? `In "${row.name}" I'll now stay quiet until someone @-mentions me.`
          : `In "${row.name}" I'll now respond to every message.`,
      )
      return { success: true, project_name: row.name, mode }
    },
  }
}

/**
 * Personality is persisted as one free-text phrase on the registry row.
 * We encode `archetype` + `description` into it with a stable separator
 * so a subsequent partial update can recover whichever side wasn't
 * touched. Format: `"<archetype> — <description>"` when both present;
 * just the present one otherwise.
 */
const PERSONALITY_SEP = ' — '

export function composePersonality(
  archetype: string | null,
  description: string | null,
): string {
  const a = archetype?.trim() ?? ''
  const d = description?.trim() ?? ''
  if (a.length > 0 && d.length > 0) return `${a}${PERSONALITY_SEP}${d}`
  if (a.length > 0) return a
  return d
}

export function parsePersonality(phrase: string | null): {
  archetype: string | null
  description: string | null
} {
  if (phrase === null) return { archetype: null, description: null }
  const trimmed = phrase.trim()
  if (trimmed.length === 0) return { archetype: null, description: null }
  const idx = trimmed.indexOf(PERSONALITY_SEP)
  if (idx < 0) {
    // No separator — treat the whole phrase as the description (the
    // common onboarding shape, where `personality_offered` captures a
    // single phrase). archetype stays null so a later archetype update
    // doesn't clobber it.
    return { archetype: null, description: trimmed }
  }
  return {
    archetype: trimmed.slice(0, idx).trim() || null,
    description: trimmed.slice(idx + PERSONALITY_SEP.length).trim() || null,
  }
}
