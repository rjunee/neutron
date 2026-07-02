/**
 * P3 cores wire-up — composition integration test.
 *
 * Boots `installBundledCores(...)` against the real cores tree (the
 * registry's `findCoreDirs` walks `cores/<container>/<core>/`, so the
 * 7 Tier 1 free Cores under `cores/free/` AND the staging Tier 2
 * Cores under `cores/paid-staging/` surface as discovered):
 *
 *   - registry discovers 8 Cores total (7 Tier 1 free + 1 DTC Analytics staging)
 *   - 6 install cleanly (no required secrets); 3 (Calendar, Email-
 *     Managed, Google Workspace) fail with `manifest_invalid` because
 *     their manifests declare `required: true` OAuth/BYO-API secrets and
 *     the Noop prompter returns `null` — the brief's failure-isolation path
 *   - `core_installations` rows exist for the 6 successful installs
 *   - Sidecar files live at the canonical path for every sidecar-layout install
 *   - The production `ToolRegistry` carries tools from the installed Cores
 *   - The composer's failure-rate gate does NOT trip (3 of 8 = 37%, below 50%)
 *
 * DTC Analytics lives at `cores/paid-staging/dtc-analytics/` as the
 * interim Tier 2 staging home until the Sprint C physical repo split
 * moves it to `neutron-managed/cores/dtc-analytics/`. Until then, the
 * bundled-Core registry sees it under the same public-repo root and
 * installs it cleanly (no secrets, no connectors in v1).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { SecretsStore } from '../../auth/secrets-store.ts'
import { ToolRegistry } from '../../tools/registry.ts'
import { CoreInstallationsStore } from '../../cores/runtime/installations-store.ts'
import { sidecarDbPath } from '../../cores/runtime/data-namespace.ts'
import { installBundledCores } from '../cores/install-bundled.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OWNER = 'forge-cores-test'

// Deployment-mode-aware expectations. The bundled-Core registry walks
// `cores/<container>/<core>/` across REPO_ROOT; the Tier 2 staging Core
// `dtc_analytics` lives under `cores/paid-staging/`, which the Sprint C
// Open carve strips (leak-gate FORBIDDEN_PREFIX). So the monorepo / Managed
// tree discovers 9 (installs 7) while the carved Open tree discovers 8
// (installs 6). Derive the expected set from what's actually on disk rather
// than hardcoding one tree's inventory.
const HAS_PAID_STAGING = existsSync(join(REPO_ROOT, 'cores', 'paid-staging', 'dtc-analytics'))
const DISCOVERED_SLUGS = [
  'calendar_core',
  'codegen_core',
  'email_managed_core',
  'google_workspace_core',
  'reminders_core',
  'research_core',
  'scraping_core',
  'tasks_core',
  'agent_settings',
  ...(HAS_PAID_STAGING ? ['dtc_analytics'] : []),
].sort()
const INSTALLED_SLUGS = [
  'codegen_core',
  'reminders_core',
  'research_core',
  // Scraping Core (parity gap #6) installs cleanly — its `apify`
  // byo_api_key is `required: false` (optional-until-credentialed).
  'scraping_core',
  'tasks_core',
  'agent_settings',
  ...(HAS_PAID_STAGING ? ['dtc_analytics'] : []),
].sort()
// Cores with a `required: true` OAuth secret the Noop prompter can't
// satisfy → install_failed(manifest_invalid). Calendar + Email + the
// Google Workspace Core (gap-audit P0-6) all gate on Google OAuth.
const FAILED_SLUGS = [
  'calendar_core',
  'email_managed_core',
  'google_workspace_core',
].sort()
const EXPECTED_DISCOVERED = DISCOVERED_SLUGS.length
const EXPECTED_INSTALLED = INSTALLED_SLUGS.length

interface Bench {
  ownerHome: string
  db: ProjectDb
  secrets: SecretsStore
  tools: ToolRegistry
  installations: CoreInstallationsStore
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

function makeBench(): Bench {
  const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-cores-comp-'))
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
  const installations = new CoreInstallationsStore({ db })
  return { ownerHome, db, secrets, tools, installations }
}

describe('installBundledCores — bundled Tier 1 boot', () => {
  let bench: Bench
  beforeEach(() => {
    bench = makeBench()
  })

  test('discovers all Cores under cores/ and surfaces them via registry.list()', async () => {
    const result = await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
    })
    // 8 Tier 1 free Cores + 1 Tier 2 staging Core (DTC Analytics) = 9
    // discovered in the monorepo / Managed tree. The Sprint C Open carve
    // strips `cores/paid-staging/`, so the carved Open tree discovers 8
    // (the Managed adapter's multi-root walk re-surfaces the paid Core).
    // Per `docs/research/neutron-cores-marketplace-split-2026-05-17.md § 3`.
    expect(result.discovered).toBe(EXPECTED_DISCOVERED)
    const slugs = result.registry.list().map((c) => c.slug).sort()
    expect(slugs).toEqual(DISCOVERED_SLUGS)
  })

  test('7 Cores install cleanly; 2 (Calendar, Email-Managed) fail with manifest_invalid', async () => {
    const result = await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
    })
    expect(result.installed.size).toBe(EXPECTED_INSTALLED)
    expect(result.failures.length).toBe(FAILED_SLUGS.length)
    const failedSlugs = result.failures.map((f) => f.core_slug).sort()
    expect(failedSlugs).toEqual(FAILED_SLUGS)
    for (const failure of result.failures) {
      expect(failure.code).toBe('manifest_invalid')
    }
  })

  test('core_installations rows exist for every successful install', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
    })
    const rows = await bench.installations.listForProject(OWNER)
    expect(rows).toHaveLength(EXPECTED_INSTALLED)
    for (const row of rows) {
      expect(row.installed_at).toBeGreaterThan(0)
      expect(row.uninstalled_at).toBeNull()
    }
    const installed = rows.map((r) => r.core_slug).sort()
    expect(installed).toEqual(INSTALLED_SLUGS)
  })

  test('sidecar files exist at the canonical path for every sidecar-layout install', async () => {
    await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
    })
    const rows = await bench.installations.listForProject(OWNER)
    for (const row of rows) {
      if (row.data_layout === 'sidecar') {
        expect(row.sidecar_db_path).not.toBeNull()
        expect(existsSync(row.sidecar_db_path!)).toBe(true)
        // The lifecycle's canonical path resolver lines up with the
        // stored row's path — the layout invariant.
        expect(row.sidecar_db_path).toBe(sidecarDbPath(bench.ownerHome, row.core_slug))
      }
    }
  })

  test('failure-rate gate (50%) is NOT tripped — OAuth-gated failures of the discovered set', async () => {
    // No throw expected — 3 of 9/10 (~30-33%) is well under the 50% gate.
    const result = await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
    })
    expect(result.discovered).toBe(EXPECTED_DISCOVERED)
    expect(result.failures.length).toBe(FAILED_SLUGS.length)
  })

  test('a second installBundledCores call is idempotent — no duplicate rows, no re-prompted secrets', async () => {
    const first = await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
    })
    expect(first.installed.size).toBe(EXPECTED_INSTALLED)
    const firstRowCount = (await bench.installations.listForProject(OWNER)).length
    // Build a fresh tool registry for the second boot — a Core's
    // tools.register throws on duplicate name, which is correct
    // behaviour but unrelated to install idempotency.
    const tools2 = new ToolRegistry()
    const second = await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: tools2,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
    })
    expect(second.installed.size).toBe(EXPECTED_INSTALLED)
    const secondRowCount = (await bench.installations.listForProject(OWNER)).length
    expect(secondRowCount).toBe(firstRowCount)
  })

  test('tool registry carries manifest tools for every successfully-installed Core', async () => {
    // Wire backend factories so the cores' real buildTools(...) runs
    // (otherwise tools register with `not_implemented` stubs but
    // still appear in the registry).
    const result = await installBundledCores({
      project_slug: OWNER,
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [REPO_ROOT],
      backends: {
        tasks_core: async ({ project_slug }) => {
          const mod = await import('@neutronai/tasks-core')
          return {
            store: mod.buildSubstrateTaskStoreBackend({
              project_slug,
              projectDb: bench.db,
            }),
          }
        },
        reminders_core: async ({ project_slug }) => {
          const mod = await import('@neutronai/reminders-core')
          return {
            backend: mod.buildReminderStoreBackend({ project_slug, projectDb: bench.db }),
          }
        },
        research_core: async ({ project_slug }) => {
          const mod = await import('@neutronai/research-core')
          const store = new mod.ResearchStore({ project_slug, db: bench.db })
          const substrate = mod.buildCannedResearchSubstrate({ responses: [] })
          return { backend: mod.buildResearchOrchestrator({ store, substrate }) }
        },
        codegen_core: async () => {
          const mod = await import('@neutronai/codegen-core')
          const runner = mod.buildSkeletonCodegenRunner()
          return { orchestrator: new mod.CodegenOrchestrator({ runner }) }
        },
      },
    })

    // Sanity: the full installed set (5 Tier 1 + the Tier 2 staging DTC
    // Analytics when `cores/paid-staging/` is present).
    expect(result.installed.size).toBe(EXPECTED_INSTALLED)
    // Every installed Core's tool surface is in the registry.
    const toolNames = bench.tools.list().map((t) => t.name)
    expect(toolNames).toContain('tasks_create')
    expect(toolNames).toContain('reminders_create')
    expect(toolNames).toContain('research_start')
    expect(toolNames).toContain('codegen_dispatch')
    // DTC Analytics tools register without a backend factory (the
    // install-bundled path stamps `not_implemented` stubs when no
    // backend is wired, same shape as Tier 1 Cores that haven't been
    // wired to substrate primitives yet). Only present when the
    // paid-staging container ships (stripped from the carved Open tree).
    if (HAS_PAID_STAGING) {
      expect(toolNames).toContain('dtc_analytics_snapshot')
      expect(toolNames).toContain('dtc_analytics_import_csv')
    }
  })
})
