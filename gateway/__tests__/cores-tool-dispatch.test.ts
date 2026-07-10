/**
 * P3 cores wire-up — per-Core tool dispatch smoke.
 *
 * Boots the bundled-Cores registry against the real `cores/free/` tree
 * with backend factories wired and asserts:
 *
 *   - Reminders Core's `reminders_create` dispatches end-to-end through
 *     the ToolRegistry → CapabilityGuard → reminder-store backend.
 *   - SecretAuditLog records a `tool_call` row for the dispatched tool.
 *   - Calling a non-existent tool surfaces as `undefined` from the
 *     registry (no exception, no auto-magic).
 *   - The other installed Cores (Tasks, Research, Code-Gen) have their
 *     declared tool names registered (one-line smoke per Core — full
 *     output shape is verified in per-Core `__tests__/tools.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { McpServer } from '@neutronai/mcp/server.ts'
import {
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
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

  test('reminders_create dispatches through the registered handler', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    const remindersCreate = bench.tools.get('reminders_create')
    expect(remindersCreate).toBeDefined()
    const result = (await remindersCreate!.handler(
      { message: 'hello from smoke test', fire_at: 4102444800 },
      { project_slug: OWNER, project_id: null, topic_id: null, call_id: 'c1', speaker_user_id: null },
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
    const remindersCreate = bench.tools.get('reminders_create')!
    await remindersCreate.handler(
      { message: 'audited content', fire_at: 4102444800 },
      { project_slug: OWNER, project_id: null, topic_id: null, call_id: 'c2', speaker_user_id: null },
    )
    const rows = bench.db
      .raw()
      .query<{ op: string; label: string; core_slug: string; outcome: string }, []>(
        `SELECT op, label, core_slug, outcome FROM secret_audit_log WHERE op='tool_call'`,
      )
      .all()
    const dispatched = rows.find((r) => r.label === 'reminders_create')
    expect(dispatched).toBeDefined()
    expect(dispatched?.core_slug).toBe('reminders_core')
    expect(dispatched?.outcome).toBe('ok')
  })

  test('X1 — installed Core tools carry {kind:core,slug} provenance (wired + stub paths)', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: buildBackendFactories(bench.db, bench.ownerHome),
    })
    // Wired-backend chokepoint (install-bundled.ts registerCoreTools main loop):
    // a real Core tool is attributed to its originating Core, carrying the Core's
    // manifest-declared capability grant.
    const remindersReg = bench.tools.get('reminders_create')
    expect(remindersReg).toBeDefined()
    const reminders = remindersReg?.provenance
    expect(reminders?.kind).toBe('core')
    if (reminders?.kind === 'core' && remindersReg !== undefined) {
      expect(reminders.slug).toBe('reminders_core')
      // The tool's own capability must be within the Core's declared grant (so the
      // dispatch-time gate journals `allow`, not `denied-capability`).
      expect(reminders.declared_capabilities).toContain(remindersReg.capability_required)
    }
    // Stub chokepoint (registerNotImplementedStubs): scraping_core installs with
    // NO backend factory wired here, so its manifest tools register as throwing
    // stubs — they must STILL be attributed to their Core, not defaulted to
    // platform. Proves both modified install-bundled sites stamp provenance.
    const scrape = bench.tools.get('scrape_x')?.provenance
    expect(scrape?.kind).toBe('core')
    if (scrape?.kind === 'core') {
      expect(scrape.slug).toBe('scraping_core')
      expect(Array.isArray(scrape.declared_capabilities)).toBe(true)
    }
  })

  test('X1 — McpServer.dispatch journals a verdict to system_events WITHOUT writing secret_audit_log', () => {
    // Fresh migrated DB (bench) → the `secret_audit_log` table exists. Register a
    // plain PLATFORM tool (default provenance) whose handler does NOT touch the
    // secret audit, dispatch it through McpServer, and prove the X1 verdict lands
    // in system_events while secret_audit_log is byte-for-byte unchanged (X1 is a
    // NEW event stream, not the Core-internal secret audit).
    const captured: SystemEventInput[] = []
    const sink: SystemEventSink = {
      record: (input) => {
        captured.push(input)
        return { id: `evt-${captured.length}` }
      },
    }
    registerSystemEventSink(sink)
    cleanups.push(() => registerSystemEventSink(null))

    bench.tools.register({
      name: 'noop_platform_tool',
      description: '',
      input_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: {} },
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async () => ({ ok: true }),
    })
    const server = new McpServer({ project_slug: OWNER, registry: bench.tools })

    const countAudit = (): number =>
      bench.db
        .raw()
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM secret_audit_log`)
        .get()?.n ?? 0

    const before = countAudit()
    return server
      .dispatch({ tool_name: 'noop_platform_tool', args: {}, call_id: 'c1' })
      .then((result) => {
        expect(result).toEqual({ ok: true })
        // The X1 verdict was journaled to system_events…
        expect(captured.filter((e) => e.event === 'capability_verdict').length).toBe(1)
        // …and secret_audit_log gained ZERO rows.
        expect(countAudit()).toBe(before)
      })
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
      { project_slug: OWNER, project_id: null, topic_id: null, call_id: 'c-list', speaker_user_id: null },
    )) as { briefs: unknown[] }
    expect(Array.isArray(out.briefs)).toBe(true)
  })

})
