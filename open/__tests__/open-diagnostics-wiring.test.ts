/**
 * O5 — diagnostics surface wiring gate (composition reachability).
 *
 * The surface + compose tests instantiate `createAppDiagnosticsSurface` directly;
 * this one boots the REAL Open composition (`buildOpenGraphComposer` →
 * `composeProductionGraph` → `Bun.serve`) and asserts `GET
 * /api/app/admin/diagnostics` is actually MOUNTED + owner-gated + returns LIVE
 * source output — so removing / misconfiguring `app_diagnostics_surface` in the
 * composer would fail here (404), not slip through green. Mirrors
 * `open-chat-history-wiring.test.ts`.
 *
 * No ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — the box boots LLM-less; the
 * diagnostics surface does not depend on LLM credentials (credentials section
 * simply reports the LLM-less pool state).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const COOKIE_SECRET = 'open-test-secret-0123456789'
const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness {
  base: string
  db: ProjectDb
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-diagnostics-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = COOKIE_SECRET
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  // Seed a LIVE source: a failed import job the diagnostics endpoint must surface.
  await db.run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status, started_at, error_code, error_message)
     VALUES ('wire-job', 'owner', 'chatgpt-zip', 'failed', 100, 'rate_limit', 'slow down')`,
    [],
  )

  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: graph.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

/** `/api/app/*` mobile-JSON requests bypass the browser auth gate and hit the
 *  bearer chain; `dev:owner` is the single-owner dev bearer the composer accepts. */
function ownerHeaders(): Record<string, string> {
  return { authorization: 'Bearer dev:owner', accept: 'application/json' }
}

describe('Open diagnostics surface wiring', () => {
  test('GET /api/app/admin/diagnostics is MOUNTED + owner-gated + returns LIVE source output', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/app/admin/diagnostics`, { headers: ownerHeaders() })
    // A wiring regression (surface not mounted in the composer) surfaces as 404.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      diagnostics: {
        project_slug: string
        import_jobs: { available: boolean; jobs?: Array<{ job_id: string; status?: string }> }
        credentials: { available: boolean }
      }
    }
    expect(body.ok).toBe(true)
    expect(body.diagnostics.project_slug).toBe('owner')
    // LIVE source: the seeded failed import job is reflected through the real graph.
    const seeded = body.diagnostics.import_jobs.jobs?.find((j) => j.job_id === 'wire-job')
    expect(seeded).toBeDefined()
    expect(seeded!.status).toBe('failed')
    // LLM-less box → credentials section is present but not usable-off-pool.
    expect(typeof body.diagnostics.credentials.available).toBe('boolean')
  }, 30_000)

  test('is owner-gated: no bearer → 401 (MOUNTED, not 404)', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/app/admin/diagnostics`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(401)
    expect(res.status).not.toBe(404)
  }, 30_000)
})
