/**
 * agent-settings Core — tools.ts integration tests.
 *
 * Opens a temp ProjectDb, applies the real project migration tree (so the
 * canonical `projects` + `project_members` tables AND the 0053 soft-
 * delete columns exist), seeds project rows, builds the capability-gated
 * tools against a real backend + an in-memory agent-profile fake + a
 * recording Telegram sink, then asserts:
 *   - the DB mutation landed (rename / soft-delete / merge / profile)
 *   - the Telegram confirmation + topic side-effect fired
 *   - the SecretAuditLog captured a tool_call success / denial row
 *
 * Mirrors the sibling free-Core tools test pattern. Timestamps are
 * Date.now()-relative (the rows stamp `new Date().toISOString()`), never
 * hardcoded ISO strings.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'
import { acceptTrustedMember } from '../../../../connect/member-join.ts'
import { ConnectedMembersStore } from '../../../../connect/connected-members-store.ts'

import {
  SETTINGS_BACKEND_UNAVAILABLE_ERROR,
  buildAgentSettingsBackend,
  buildTools,
  loadManifest,
  type AgentProfileBackend,
  type AgentSettingsTelegram,
} from '../index.ts'

const OWNER = 't1'

/**
 * ISSUES #219 — the Connect usage meter lives in a Managed-carved metering
 * module that the Open split strips from the public tree, so this Open test
 * mirrors the two count queries it asserts on (active shared projects + active
 * members) rather than importing the Managed class. Verbatim copies of
 * `ConnectUsageMeter.read()`'s `sharedRow` / `membersRow` SQL — the
 * origin_instance ⇄ local_slug join + active-status + live-project filter
 * are exactly what the #200 invariant below depends on.
 */
function readConnectMeterCounts(db: ProjectDb): {
  activeSharedProjects: number
  activeMembers: number
} {
  const sharedRow = db
    .prepare<{ n: number }, []>(
      `SELECT COUNT(DISTINCT pm.project_id) AS n
         FROM project_members pm
         JOIN connected_members cm ON cm.local_slug = pm.origin_instance
         JOIN projects p ON p.id = pm.project_id
        WHERE cm.status = 'active'
          AND p.deleted_at IS NULL`,
    )
    .get()
  const membersRow = db
    .prepare<{ n: number }, []>(
      `SELECT COUNT(DISTINCT cm.local_slug) AS n
         FROM connected_members cm
         JOIN project_members pm ON pm.origin_instance = cm.local_slug
         JOIN projects p ON p.id = pm.project_id
        WHERE cm.status = 'active'
          AND p.deleted_at IS NULL`,
    )
    .get()
  return {
    activeSharedProjects: sharedRow?.n ?? 0,
    activeMembers: membersRow?.n ?? 0,
  }
}

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog

/** Recording Telegram sink — captures every call for assertions. */
interface TelegramCalls {
  confirmations: string[]
  renames: Array<{ topic_id: string | null; new_name: string }>
  archives: Array<string | null>
}
function buildRecordingTelegram(): {
  telegram: AgentSettingsTelegram
  calls: TelegramCalls
} {
  const calls: TelegramCalls = { confirmations: [], renames: [], archives: [] }
  const telegram: AgentSettingsTelegram = {
    async sendConfirmation(text) {
      calls.confirmations.push(text)
    },
    async renameTopic(topic_id, new_name) {
      calls.renames.push({ topic_id, new_name })
    },
    async archiveTopic(topic_id) {
      calls.archives.push(topic_id)
    },
  }
  return { telegram, calls }
}

/** In-memory agent-profile fake mirroring the registry RW contract. */
function buildFakeProfile(initial?: {
  agent_name?: string | null
  agent_personality?: string | null
}): AgentProfileBackend & {
  state: { agent_name: string | null; agent_personality: string | null }
} {
  const state = {
    agent_name: initial?.agent_name ?? null,
    agent_personality: initial?.agent_personality ?? null,
  }
  return {
    state,
    async get() {
      return { ...state }
    },
    async setAgentName(agent_name) {
      state.agent_name = agent_name
    },
    async setAgentPersonality(agent_personality) {
      state.agent_personality = agent_personality
    },
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Seed a live project row directly into the canonical table. */
async function seedProject(opts: {
  id: string
  name: string
  description?: string | null
  topic_id?: string | null
}): Promise<void> {
  const ts = nowIso()
  await projectDb.run(
    `INSERT INTO projects
       (id, name, description, persona, privacy_mode, billing_mode,
        created_at, updated_at, deleted_at, context_archived_at, topic_id)
     VALUES (?, ?, ?, NULL, 'private', 'personal', ?, ?, NULL, NULL, ?)`,
    [
      opts.id,
      opts.name,
      opts.description ?? null,
      ts,
      ts,
      opts.topic_id ?? null,
    ],
  )
}

async function seedMember(opts: {
  project_id: string
  user_id: string
  name: string
  role?: 'owner' | 'member'
}): Promise<void> {
  await projectDb.run(
    `INSERT INTO project_members (project_id, user_id, name, role, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
    [opts.project_id, opts.user_id, opts.name, opts.role ?? 'member', nowIso()],
  )
}

function liveRow(id: string): {
  name: string
  deleted_at: string | null
  context_archived_at: string | null
} | null {
  const row = projectDb
    .prepare<
      { name: string; deleted_at: string | null; context_archived_at: string | null },
      [string]
    >('SELECT name, deleted_at, context_archived_at FROM projects WHERE id = ?')
    .get(id)
  return row ?? null
}

function memberCount(project_id: string): number {
  const row = projectDb
    .prepare<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?',
    )
    .get(project_id)
  return row?.n ?? 0
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-settings-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function buildToolsForTest(opts?: {
  manifest?: NeutronManifest
  profile?: AgentProfileBackend
  telegram?: AgentSettingsTelegram
}) {
  const manifest = opts?.manifest ?? loadManifest()
  const profile = opts?.profile ?? buildFakeProfile()
  const { telegram } = opts?.telegram
    ? { telegram: opts.telegram }
    : buildRecordingTelegram()
  const backend = buildAgentSettingsBackend({ projectDb, profile, telegram })
  return buildTools({ manifest, project_slug: OWNER, audit, backend })
}

describe('agent-settings tools — project ops', () => {
  test('list_projects returns only live rows, newest-first', async () => {
    await seedProject({ id: 'home-base', name: 'Home Base', topic_id: '42' })
    await seedProject({ id: 'acme', name: 'Acme', description: 'Brand work' })
    // A soft-deleted row must NOT appear.
    await seedProject({ id: 'gone', name: 'Gone' })
    await projectDb.run('UPDATE projects SET deleted_at = ? WHERE id = ?', [
      nowIso(),
      'gone',
    ])

    const tools = buildToolsForTest()
    const out = await tools.list_projects({})
    const ids = out.projects.map((p) => p.id)
    expect(ids).toContain('home-base')
    expect(ids).toContain('acme')
    expect(ids).not.toContain('gone')

    const homeBase = out.projects.find((p) => p.id === 'home-base')
    expect(homeBase?.name).toBe('Home Base')
    expect(homeBase?.slug).toBe('home-base')
    expect(homeBase?.topic_id).toBe('42')
    const ama = out.projects.find((p) => p.id === 'acme')
    expect(ama?.context_summary).toBe('Brand work')
  })

  test('rename_project mutates the row, retitles the topic, confirms', async () => {
    await seedProject({ id: 'home-base', name: 'Home Base', topic_id: '42' })
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ telegram })

    const res = await tools.rename_project({
      old_name: 'Home Base',
      new_name: 'Lookout Point',
    })
    expect(res.success).toBe(true)
    expect(res.project?.name).toBe('Lookout Point')

    expect(liveRow('home-base')?.name).toBe('Lookout Point')
    expect(calls.renames).toEqual([{ topic_id: '42', new_name: 'Lookout Point' }])
    expect(calls.confirmations[0]).toContain('Renamed')
    expect(calls.confirmations[0]).toContain('Lookout Point')
  })

  test('rename_project on an unknown name returns success:false, no side-effects', async () => {
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ telegram })
    const res = await tools.rename_project({ old_name: 'Nope', new_name: 'X' })
    expect(res.success).toBe(false)
    expect(calls.renames).toEqual([])
    expect(calls.confirmations).toEqual([])
  })

  test('delete_project soft-deletes, archives the topic, returns context_archived_at', async () => {
    await seedProject({ id: 'old', name: 'Old Stuff', topic_id: '99' })
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ telegram })

    const res = await tools.delete_project({ name: 'Old Stuff' })
    expect(res.success).toBe(true)
    expect(res.removed?.name).toBe('Old Stuff')
    expect(typeof res.removed?.context_archived_at).toBe('string')

    const row = liveRow('old')
    expect(row?.deleted_at).not.toBeNull()
    expect(row?.context_archived_at).not.toBeNull()
    expect(calls.archives).toEqual(['99'])
    expect(calls.confirmations[0]).toContain('Deleted')

    // It no longer shows in list_projects.
    const list = await tools.list_projects({})
    expect(list.projects.some((p) => p.id === 'old')).toBe(false)
  })

  test('archive_project sets archived_at, closes the topic, confirms, and hides from list', async () => {
    await seedProject({ id: 'summer', name: 'Summer Trip', topic_id: '55' })
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ telegram })

    const res = await tools.archive_project({ name: 'Summer Trip' })
    expect(res.success).toBe(true)
    expect(res.archived?.name).toBe('Summer Trip')
    expect(typeof res.archived?.archived_at).toBe('string')

    // archived_at set; NOT deleted (distinct from delete_project).
    const row = projectDb
      .prepare<{ archived_at: string | null; deleted_at: string | null }, [string]>(
        'SELECT archived_at, deleted_at FROM projects WHERE id = ?',
      )
      .get('summer')
    expect(row?.archived_at).not.toBeNull()
    expect(row?.deleted_at).toBeNull()
    expect(calls.archives).toEqual(['55'])
    expect(calls.confirmations[0]).toContain('Archived')

    // It no longer shows in list_projects (left the rail).
    const list = await tools.list_projects({})
    expect(list.projects.some((p) => p.id === 'summer')).toBe(false)
  })

  test('restore_project clears archived_at and returns the project to the list', async () => {
    await seedProject({ id: 'summer', name: 'Summer Trip', topic_id: '55' })
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ telegram })

    await tools.archive_project({ name: 'Summer Trip' })
    expect((await tools.list_projects({})).projects.some((p) => p.id === 'summer')).toBe(false)

    const res = await tools.restore_project({ name: 'Summer Trip' })
    expect(res.success).toBe(true)
    expect(res.restored?.name).toBe('Summer Trip')

    const row = projectDb
      .prepare<{ archived_at: string | null }, [string]>(
        'SELECT archived_at FROM projects WHERE id = ?',
      )
      .get('summer')
    expect(row?.archived_at).toBeNull()
    expect(calls.confirmations.some((c) => c.includes('Restored'))).toBe(true)
    expect((await tools.list_projects({})).projects.some((p) => p.id === 'summer')).toBe(true)
  })

  test('archive_project on an unknown name fails; restore_project on a non-archived name fails', async () => {
    await seedProject({ id: 'active', name: 'Active One' })
    const tools = buildToolsForTest()
    expect((await tools.archive_project({ name: 'Nope' })).success).toBe(false)
    // 'Active One' is live (not archived) → restore can't resolve it.
    expect((await tools.restore_project({ name: 'Active One' })).success).toBe(false)
  })

  test('merge_projects moves members, soft-deletes from, archives from topic', async () => {
    await seedProject({ id: 'from', name: 'Side Notes', topic_id: '7' })
    await seedProject({ id: 'into', name: 'Main Work', topic_id: '8' })
    await seedMember({ project_id: 'from', user_id: 'u1', name: 'Sam', role: 'owner' })
    await seedMember({ project_id: 'from', user_id: 'u2', name: 'Casey' })
    await seedMember({ project_id: 'into', user_id: 'u1', name: 'Sam', role: 'owner' })

    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ telegram })

    const res = await tools.merge_projects({
      from_name: 'Side Notes',
      into_name: 'Main Work',
    })
    expect(res.success).toBe(true)
    expect(res.merged_project?.id).toBe('into')

    // `from` is soft-deleted; its members moved (deduped on the shared u1).
    expect(liveRow('from')?.deleted_at).not.toBeNull()
    expect(memberCount('from')).toBe(0)
    expect(memberCount('into')).toBe(2) // u1 (already there) + u2 (moved)

    expect(calls.archives).toEqual(['7'])
    expect(calls.confirmations[0]).toContain('Merged')
  })

  test('merge_projects refuses to merge a project into itself', async () => {
    await seedProject({ id: 'p', name: 'Solo' })
    const tools = buildToolsForTest()
    const res = await tools.merge_projects({ from_name: 'Solo', into_name: 'Solo' })
    expect(res.success).toBe(false)
  })

  // ISSUES #200 regression: merge_projects must CARRY origin_instance onto the
  // re-pointed member rows, not NULL it. The Ph6 ConnectUsageMeter counts
  // shared projects + active members by joining pm.origin_instance = cm.local_slug;
  // a merge-migrated foreign member whose origin_instance was cleared silently
  // falls out of BOTH activeSharedProjects and activeMembers. The invariant: the
  // meter counts are STABLE across a merge (the member is still counted, just on
  // the surviving project). Pre-fix this test goes RED (both counts drop to 0).
  test('merge_projects preserves origin_instance so Connect meter counts survive the merge (ISSUES #200)', async () => {
    // `from` is a cross-org shared project (one ACTIVE foreign member).
    await seedProject({ id: 'from', name: 'Shared Notes', topic_id: '7' })
    // `into` is the surviving solo (owner-home) project the foreign member moves to.
    await seedProject({ id: 'into', name: 'Main Work', topic_id: '8' })
    await seedMember({ project_id: 'into', user_id: 'u-owner', name: 'Sam', role: 'owner' })

    // Accept a trusted foreign member on `from` — writes connected_members
    // (status='active') + a project_members row with origin_instance = local_slug.
    const store = new ConnectedMembersStore(projectDb)
    await acceptTrustedMember(
      {
        display_name: 'Alice',
        home_instance_slug: 'a-org',
        home_user_id: 'u-foreign',
        project_id: 'from',
        receiving_instance_slug: OWNER,
      },
      { store, db: projectDb },
    )

    // Baseline: `from` is one active shared project with one active member.
    const before = readConnectMeterCounts(projectDb)
    expect(before.activeSharedProjects).toBe(1)
    expect(before.activeMembers).toBe(1)

    const tools = buildToolsForTest()
    const res = await tools.merge_projects({
      from_name: 'Shared Notes',
      into_name: 'Main Work',
    })
    expect(res.success).toBe(true)

    // After the merge the foreign member lives on the surviving `into` project.
    // origin_instance must be carried over so the meter still joins it through
    // connected_members — counts UNCHANGED. (Pre-fix: origin_instance NULLed →
    // member drops out → both counts read 0.)
    const after = readConnectMeterCounts(projectDb)
    expect(after.activeSharedProjects).toBe(1)
    expect(after.activeMembers).toBe(1)
  })
})

describe('agent-settings tools — agent profile ops', () => {
  test('update_agent_name writes the profile + confirms', async () => {
    const profile = buildFakeProfile({ agent_name: 'Assistant' })
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ profile, telegram })

    const res = await tools.update_agent_name({ new_name: 'Nova' })
    expect(res.success).toBe(true)
    expect(res.agent_name).toBe('Nova')
    expect(profile.state.agent_name).toBe('Nova')
    expect(calls.confirmations[0]).toContain('Nova')
  })

  test('update_personality composes archetype + description, confirms', async () => {
    const profile = buildFakeProfile()
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ profile, telegram })

    const res = await tools.update_personality({
      new_archetype: 'calm strategist',
      new_description: 'precise, warm, no hype',
    })
    expect(res.success).toBe(true)
    expect(res.personality?.archetype).toBe('calm strategist')
    expect(res.personality?.description).toBe('precise, warm, no hype')
    expect(profile.state.agent_personality).toContain('calm strategist')
    expect(profile.state.agent_personality).toContain('precise, warm, no hype')
    expect(calls.confirmations[0]).toContain('personality')
  })

  test('update_personality with only a description preserves a prior archetype', async () => {
    const profile = buildFakeProfile({
      agent_personality: 'calm strategist — precise',
    })
    const tools = buildToolsForTest({ profile })
    const res = await tools.update_personality({ new_description: 'playful now' })
    expect(res.success).toBe(true)
    expect(res.personality?.archetype).toBe('calm strategist')
    expect(res.personality?.description).toBe('playful now')
  })

  test('update_personality with no fields returns success:false', async () => {
    const tools = buildToolsForTest()
    const res = await tools.update_personality({})
    expect(res.success).toBe(false)
  })
})

// Argus r5 IMPORTANT (2026-06-03): when the registry writer is not wired
// (NEUTRON_REGISTRY_DB_PATH unset → the gateway's no-op fallback, which
// sets `available:false`), the profile-mutating tools MUST report an
// HONEST failure (success:false + the canonical error) instead of a
// success that silently no-ops. The owner's CC subprocess relays the error to the
// user. The no-op fallback can STAY — it just must signal honestly.
describe('agent-settings tools — registry writer unavailable (honest no-op)', () => {
  /** Mirrors gateway/index.ts's `available:false` no-op fallback. */
  function buildUnavailableProfile(): {
    profile: AgentProfileBackend
    calls: { setName: number; setPersonality: number }
  } {
    const calls = { setName: 0, setPersonality: 0 }
    const profile: AgentProfileBackend = {
      available: false,
      async get() {
        return { agent_name: null, agent_personality: null }
      },
      async setAgentName() {
        calls.setName += 1
      },
      async setAgentPersonality() {
        calls.setPersonality += 1
      },
    }
    return { profile, calls }
  }

  test('update_agent_name → success:false + canonical error, no write, no confirmation', async () => {
    const { profile, calls: writes } = buildUnavailableProfile()
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ profile, telegram })

    const res = await tools.update_agent_name({ new_name: 'Nova' })
    expect(res.success).toBe(false)
    expect(res.error).toBe(SETTINGS_BACKEND_UNAVAILABLE_ERROR)
    expect(res.agent_name).toBeUndefined()
    // The no-op writer was NOT called (we short-circuit before it).
    expect(writes.setName).toBe(0)
    // No dishonest "Got it — I'm Nova now." confirmation.
    expect(calls.confirmations).toEqual([])
  })

  test('update_personality → success:false + canonical error, no write, no confirmation', async () => {
    const { profile, calls: writes } = buildUnavailableProfile()
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ profile, telegram })

    const res = await tools.update_personality({
      new_archetype: 'calm strategist',
      new_description: 'precise, warm',
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe(SETTINGS_BACKEND_UNAVAILABLE_ERROR)
    expect(res.personality).toBeUndefined()
    expect(writes.setPersonality).toBe(0)
    expect(calls.confirmations).toEqual([])
  })

  test('the empty-input guard still wins over the availability check', async () => {
    // No fields supplied → the "nothing to change" success:false (no
    // error) takes precedence; we never reach the availability branch.
    const { profile } = buildUnavailableProfile()
    const tools = buildToolsForTest({ profile })
    const res = await tools.update_personality({})
    expect(res.success).toBe(false)
    expect(res.error).toBeUndefined()
  })
})

/**
 * Connect per-project engagement mode (get/set). The `agent_engagement_mode`
 * column is added to the canonical `projects` table by migration 0088 (owned
 * by a separate worker). This Core's worktree may not carry 0088 yet, so the
 * harness ensures the column exists IDEMPOTENTLY — a no-op once 0088 lands.
 */
function ensureEngagementColumn(): void {
  const cols = projectDb
    .prepare<{ name: string }, []>(`PRAGMA table_info(projects)`)
    .all()
  if (!cols.some((c) => c.name === 'agent_engagement_mode')) {
    projectDb
      .prepare(
        `ALTER TABLE projects
           ADD COLUMN agent_engagement_mode TEXT NOT NULL DEFAULT 'all_messages'`,
      )
      .run()
  }
}

describe('agent-settings tools — engagement mode (Connect)', () => {
  test('a freshly seeded project defaults to all_messages', async () => {
    ensureEngagementColumn()
    await seedProject({ id: 'grp', name: 'Family Trip' })
    const tools = buildToolsForTest()
    const out = await tools.get_engagement_mode({ project_name: 'Family Trip' })
    expect(out.success).toBe(true)
    expect(out.project_name).toBe('Family Trip')
    expect(out.mode).toBe('all_messages')
  })

  test('set_engagement_mode → get_engagement_mode round-trips, confirms', async () => {
    ensureEngagementColumn()
    await seedProject({ id: 'grp', name: 'Family Trip', topic_id: '5' })
    const { telegram, calls } = buildRecordingTelegram()
    const tools = buildToolsForTest({ telegram })

    const set = await tools.set_engagement_mode({
      project_name: 'Family Trip',
      mode: 'tag_gated',
    })
    expect(set.success).toBe(true)
    expect(set.mode).toBe('tag_gated')
    expect(calls.confirmations[0]).toContain('@-mention')

    const get = await tools.get_engagement_mode({ project_name: 'Family Trip' })
    expect(get.success).toBe(true)
    expect(get.mode).toBe('tag_gated')

    // Flip back to all_messages and confirm the round-trip again.
    const reset = await tools.set_engagement_mode({
      project_name: 'family trip', // case-insensitive resolve
      mode: 'all_messages',
    })
    expect(reset.success).toBe(true)
    expect(reset.mode).toBe('all_messages')
    const get2 = await tools.get_engagement_mode({ project_name: 'Family Trip' })
    expect(get2.mode).toBe('all_messages')
  })

  test('unknown project → success:false + error on both get and set', async () => {
    ensureEngagementColumn()
    const tools = buildToolsForTest()
    const get = await tools.get_engagement_mode({ project_name: 'Nope' })
    expect(get.success).toBe(false)
    expect(get.error).toContain('Nope')
    const set = await tools.set_engagement_mode({
      project_name: 'Nope',
      mode: 'tag_gated',
    })
    expect(set.success).toBe(false)
    expect(set.error).toContain('Nope')
  })
})

describe('agent-settings tools — capability gate + audit', () => {
  test('successful calls record tool_call success rows in the audit log', async () => {
    await seedProject({ id: 'p', name: 'P', topic_id: '1' })
    const tools = buildToolsForTest()
    await tools.list_projects({})
    await tools.rename_project({ old_name: 'P', new_name: 'Q' })

    const rows = await audit.list({ project_slug: OWNER, core_slug: 'agent_settings' })
    const ok = rows.filter((r) => r.outcome === 'ok')
    const labels = new Set(ok.map((r) => r.label))
    expect(labels.has('list_projects')).toBe(true)
    expect(labels.has('rename_project')).toBe(true)
  })

  test('missing write capability denies write tools but allows read', async () => {
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'write:agent_settings'),
    }
    await seedProject({ id: 'p', name: 'P' })
    const tools = buildToolsForTest({ manifest: downgraded })

    await expect(
      tools.rename_project({ old_name: 'P', new_name: 'Q' }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(tools.update_agent_name({ new_name: 'X' })).rejects.toThrow(
      CapabilityDeniedError,
    )

    // Read still resolves.
    const list = await tools.list_projects({})
    expect(list.projects.some((p) => p.id === 'p')).toBe(true)

    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'agent_settings',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('rename_project')).toBe(true)
    expect(labels.has('update_agent_name')).toBe(true)
    expect(labels.has('list_projects')).toBe(false)
  })
})
