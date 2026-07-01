/**
 * P3 cores wire-up — per-Core tool dispatch smoke.
 *
 * Boots the bundled-Cores registry against the real `cores/free/` tree
 * with backend factories wired and asserts:
 *
 *   - Notes Core's `notes_write` dispatches end-to-end through the
 *     ToolRegistry → CapabilityGuard → MemoryStore backend.
 *   - SecretAuditLog records a `tool_call` row for the dispatched tool.
 *   - Calling a non-existent tool surfaces as `undefined` from the
 *     registry (no exception, no auto-magic).
 *   - The other 4 installed Cores (Tasks, Reminders, Research,
 *     Code-Gen) have their declared tool names registered (one-line
 *     smoke per Core — full output shape is verified in per-Core
 *     `__tests__/tools.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { SecretsStore } from '../../auth/secrets-store.ts'
import { ToolRegistry } from '../../tools/registry.ts'
import { installBundledCores } from '../cores/install-bundled.ts'
import type { CoreBackendFactoryMap } from '../cores/install-bundled.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OWNER = 'smoke-project'

interface Bench {
  ownerHome: string
  db: ProjectDb
  secrets: SecretsStore
  tools: ToolRegistry
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

function makeBench(): Bench {
  const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-cores-dispatch-'))
  cleanups.push(() => rmSync(ownerHome, { recursive: true, force: true }))
  const dbDir = join(ownerHome, 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secrets = new SecretsStore({ data_dir: ownerHome, db })
  const tools = new ToolRegistry()
  return { ownerHome, db, secrets, tools }
}

function buildBackendFactories(db: ProjectDb, ownerHome: string): CoreBackendFactoryMap {
  return {
    notes: async () => {
      const mod = await import('@neutronai/notes')
      const resolver = new mod.NotesStoreResolver({ owner_home: ownerHome })
      return {
        backend: mod.buildNotesStoreBackend({
          resolver,
          default_project_id: 'default',
        }),
        // The four S1 tools (create_drawer/drawer_list/search/traverse)
        // resolve project scope against this SAME resolver via
        // `buildExtraTools` — mirror the production factory
        // (gateway/boot-helpers.ts) which returns `{ backend, resolver }`.
        resolver,
      }
    },
    tasks_core: async ({ project_slug }) => {
      const mod = await import('@neutronai/tasks-core')
      return {
        store: mod.buildSubstrateTaskStoreBackend({
          project_slug,
          projectDb: db,
        }),
      }
    },
    reminders_core: async ({ project_slug }) => {
      const mod = await import('@neutronai/reminders-core')
      return {
        backend: mod.buildReminderStoreBackend({ project_slug, projectDb: db }),
      }
    },
    research_core: async ({ project_slug }) => {
      const mod = await import('@neutronai/research-core')
      const resolver = new mod.ResearchStoreResolver({
        project_slug,
        owner_home: ownerHome,
      })
      const substrate = mod.buildCannedResearchSubstrate({ responses: [] })
      const subAgent = mod.buildCannedSubAgentDispatcher({
        responses: [{ query_match: /./, text: '{}' }],
      })
      const concurrencyGate = new mod.PerOwnerConcurrencyGate({ cap: 2 })
      const manifest = mod.loadManifest()
      return {
        backend: mod.buildProjectResearchOrchestrator({
          resolver,
          substrate,
          sub_agent_dispatcher: subAgent,
          concurrency_gate: concurrencyGate,
          manifest,
          project_slug,
        }),
      }
    },
    codegen_core: async () => {
      const mod = await import('@neutronai/codegen-core')
      const runner = mod.buildSkeletonCodegenRunner()
      return { orchestrator: new mod.CodegenOrchestrator({ runner }) }
    },
  }
}

describe('cores tool dispatch — end-to-end', () => {
  let bench: Bench
  beforeEach(() => {
    bench = makeBench()
  })

  test('notes_write dispatches through the registered handler', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    const notesWrite = bench.tools.get('notes_write')
    expect(notesWrite).toBeDefined()
    const result = (await notesWrite!.handler(
      { content: 'hello from smoke test', tags: ['t1'] },
      { project_slug: OWNER, topic_id: null, call_id: 'c1', speaker_user_id: null },
    )) as { id: string }
    expect(typeof result.id).toBe('string')
    expect(result.id.length).toBeGreaterThan(0)
  })

  test('SecretAuditLog records a tool_call row for the dispatched tool', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    const notesWrite = bench.tools.get('notes_write')!
    await notesWrite.handler(
      { content: 'audited content' },
      { project_slug: OWNER, topic_id: null, call_id: 'c2', speaker_user_id: null },
    )
    const rows = bench.db
      .raw()
      .query<{ op: string; label: string; core_slug: string; outcome: string }, []>(
        `SELECT op, label, core_slug, outcome FROM secret_audit_log WHERE op='tool_call'`,
      )
      .all()
    const dispatched = rows.find((r) => r.label === 'notes_write')
    expect(dispatched).toBeDefined()
    expect(dispatched?.core_slug).toBe('notes')
    expect(dispatched?.outcome).toBe('ok')
  })

  test('unknown tool name returns undefined from the registry', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    expect(bench.tools.get('definitely_not_a_tool')).toBeUndefined()
  })

  test('each installed Tier 1 Core registers its declared tool names', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    const names = new Set(bench.tools.list().map((t) => t.name))
    // Notes
    expect(names.has('notes_write')).toBe(true)
    expect(names.has('notes_recall')).toBe(true)
    // Tasks
    expect(names.has('tasks_create')).toBe(true)
    expect(names.has('tasks_list')).toBe(true)
    // Reminders
    expect(names.has('reminders_create')).toBe(true)
    expect(names.has('reminders_list')).toBe(true)
    // Research
    expect(names.has('research_start')).toBe(true)
    expect(names.has('research_status')).toBe(true)
    // Code-gen
    expect(names.has('codegen_dispatch')).toBe(true)
    expect(names.has('codegen_status')).toBe(true)
  })

  test('Research Core registers ALL 8 manifest-declared tools (Argus r1 BLOCKER #2)', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    // All 3 base + 5 extra tools the manifest declares must be live
    // (no `not_implemented` fallback stub for any of them) — closes
    // the buildExtraTools wire-up gap.
    const required = [
      'research_start',
      'research_status',
      'research_fetch',
      'research_deep',
      'research_list',
      'research_find',
      'research_cite',
      'research_claims_list',
    ]
    for (const name of required) {
      expect(bench.tools.get(name)).toBeDefined()
    }
    // Verify the extras dispatch through the CapabilityGuard +
    // backend (not the manifest-tool-unimplemented stub) — dispatch
    // research_list and assert it returns an object with `briefs`.
    const list = bench.tools.get('research_list')!
    const out = (await list.handler(
      { project_id: 'demo-project' },
      { project_slug: OWNER, topic_id: null, call_id: 'c-list', speaker_user_id: null },
    )) as { briefs: unknown[] }
    expect(Array.isArray(out.briefs)).toBe(true)
  })

  test('Notes Core registers ALL 8 manifest-declared tools (ISSUE #330)', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    // The 4 legacy + 4 S1 tools the manifest declares must ALL be live
    // (no `not_implemented` fallback stub for any of them) — closes the
    // buildExtraTools wire-up gap that logged `manifest_tool_unimplemented
    // core=notes` ×4 on every owner boot.
    const required = [
      'notes_write',
      'notes_recall',
      'notes_list',
      'notes_link',
      'notes_create_drawer',
      'notes_drawer_list',
      'notes_search',
      'notes_traverse',
    ]
    for (const name of required) {
      expect(bench.tools.get(name)).toBeDefined()
    }
    // Verify an S1 extra dispatches through the CapabilityGuard +
    // resolver-backed store (not the manifest-tool-unimplemented stub):
    // create a drawer then list it back.
    const createDrawer = bench.tools.get('notes_create_drawer')!
    const created = (await createDrawer.handler(
      { project_id: 'demo-project', name: 'Inbox2' },
      { project_slug: OWNER, topic_id: null, call_id: 'c-drawer', speaker_user_id: null },
    )) as { id: string }
    expect(typeof created.id).toBe('string')
    const drawerList = bench.tools.get('notes_drawer_list')!
    const drawers = (await drawerList.handler(
      { project_id: 'demo-project' },
      { project_slug: OWNER, topic_id: null, call_id: 'c-dlist', speaker_user_id: null },
    )) as { drawers: Array<{ id: string }> }
    expect(drawers.drawers.some((d) => d.id === created.id)).toBe(true)
  })
})

// `buildFakeMemoryStore` (the v0.1.0 helper) was removed when Notes Core
// S1 (2026-05-20) replaced the MemoryStore-adapter backend with a
// per-project NotesStore + resolver. The backend factories above now
// construct a real NotesStoreResolver against the tmp owner_home.
