/**
 * Open import-RESUME wiring — composition reachability + shared-instance gate.
 *
 * Restores the K3-deleted (#216) BLOCKER #2 coverage from PR #311 r1, ported
 * to the ACTUAL production mount rather than a hand-built handler.
 *
 * BLOCKER #2 (Argus r1) had two teeth the original test pinned:
 *
 *   1. `POST /api/import/<job_id>/resume` is MOUNTED. The Open composer
 *      (`open/composer.ts`) builds `import_resume_handler` and sets it on the
 *      `CompositionInput` (~:1434 build, ~:3789 spread); `gateway/composition.ts`
 *      copies it to `composeInput.importResumeHandler` (:173) and
 *      `gateway/http/compose.ts` dispatches it for the `/api/import/<id>/resume`
 *      route (:1057). A regression that DROPS `import_resume_handler` from the
 *      composition leaves the route unmounted → the request falls through the
 *      whole chain to a generic 404 instead of the handler's own success/404.
 *
 *   2. The handler is mounted against the SHARED runner / payloadResolver /
 *      stateStore the engine drives (`open/composer.ts` :1427-1441). Without
 *      sharing, a resume would spin a parallel runner that never lands its new
 *      `import_jobs` row on the instance DB, and the phase flip to
 *      `import_running` would target a different state store — the engine's
 *      cron would then poll a job it can't see.
 *
 * This test boots the REAL Open composition (`buildOpenGraphComposer` →
 * `composeProductionGraph`, the same compose `boot()` runs) over a real
 * `Bun.serve`, seeds a genuinely-resumable prior import (cancelled job row +
 * the source ZIP on disk + an owning onboarding_state row), and drives a real
 * `POST /api/import/<job_id>/resume`. It asserts on OBSERVED behaviour that
 * only fires when both teeth are intact:
 *
 *   - HTTP 200 `{ ok, prior_job_id, job_id, source }` with a NEW job_id
 *     (mount reachability — a dropped handler 404s instead).
 *   - a NEW `import_jobs` row for that job_id exists on the SHARED instance DB
 *     (the shared runner ran `.start()` against the same db the composition
 *     built).
 *   - the SHARED onboarding_state store now points `phase_state.import_job_id`
 *     at the new job (the shared stateStore.upsert landed).
 *
 * Per CLAUDE.md anti-placeholder rules the assertions are on the real HTTP
 * response + the real DB/state rows, not call-counts. No ANTHROPIC_API_KEY is
 * set — the box boots LLM-less; the resume MOUNT + dispatch + state flip do not
 * depend on LLM credentials (the background synthesis job fails LLM-less, but
 * the handler's synchronous mount/start/flip complete before the 200).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

// First two bytes are the ZIP local-file-header magic (`PK`). The
// FilesystemImportPayloadResolver only checks the file is non-empty, but a
// realistic magic keeps the fixture honest.
const ZIP_FIXTURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01])

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  db: ProjectDb
  owner_home: string
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-import-resume-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY'] // LLM-less boot
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
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

/**
 * Boot the Open composition the way `gateway/index.ts:boot` does — invoke the
 * Open `GraphComposer` against a real per-owner `project.db`, compose the
 * production graph, and serve it. The returned `db` is the SAME connection the
 * composition's engine + resume handler share, so a test-side query sees the
 * exact rows the handler writes.
 */
async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'Open composition did not expose graph.fetch/websocket — import-resume surface unreachable',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  const h: Harness = {
    server,
    base: `http://127.0.0.1:${server.port}`,
    db,
    owner_home: tmpDir,
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
  return h
}

/**
 * Seed a genuinely-resumable prior import for `owner`:
 *   - a `cancelled` `import_jobs` row (a RESUMABLE_STATUS),
 *   - the source ZIP on disk at `<owner_home>/imports/chatgpt.zip` (so the
 *     FilesystemImportPayloadResolver returns a non-null Buffer and the
 *     handler does NOT short-circuit on `source_zip_missing`),
 *   - an owning `onboarding_state` row (so the handler resolves a non-empty
 *     user_id and does NOT short-circuit on `no_onboarding_state`).
 */
async function seedResumablePriorImport(h: Harness, priorJobId: string): Promise<void> {
  const importsDir = join(h.owner_home, 'imports')
  mkdirSync(importsDir, { recursive: true })
  writeFileSync(join(importsDir, 'chatgpt.zip'), ZIP_FIXTURE)

  h.db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES (?, 'owner', 'chatgpt-zip', 'cancelled', 0, 0, 0, 0, ?)`,
    [priorJobId, 1_700_000_000_000],
  )

  const stateStore = new SqliteOnboardingStateStore({ db: h.db })
  await stateStore.upsert({
    project_slug: 'owner',
    user_id: 'owner',
    phase: 'import_analysis_presented',
    phase_state_patch: {
      import_job_id: priorJobId,
      import_source: 'chatgpt-zip',
      import_failed: true,
    },
  })
}

describe('Open import-resume surface wiring', () => {
  test('POST /api/import/<job_id>/resume is MOUNTED and dispatches through the SHARED runner + stateStore (200 + new job row + phase flip)', async () => {
    harness = await startHarness()
    const priorJobId = 'j-prior-resumable'
    await seedResumablePriorImport(harness, priorJobId)
    expect(existsSync(join(harness.owner_home, 'imports', 'chatgpt.zip'))).toBe(true)

    const res = await fetch(`${harness.base}/api/import/${priorJobId}/resume`, {
      method: 'POST',
    })

    // (1) MOUNT reachability. A dropped `import_resume_handler` leaves the
    // route unmounted → the request falls through to a generic 404, so a
    // real 200 here is the mount fingerprint.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok?: boolean
      prior_job_id?: string
      job_id?: string
      source?: string
    }
    expect(body.ok).toBe(true)
    expect(body.prior_job_id).toBe(priorJobId)
    expect(body.source).toBe('chatgpt-zip')
    expect(typeof body.job_id).toBe('string')
    expect((body.job_id ?? '').length).toBeGreaterThan(0)
    // The resume MUST mint a fresh job — not echo the prior one.
    expect(body.job_id).not.toBe(priorJobId)
    const newJobId = body.job_id!

    // (2) SHARED runner. The synthesis runner `.start()` synchronously
    // INSERTs the new `import_jobs` row on the SAME instance DB the
    // composition built. If open/composer.ts stopped threading the shared
    // runner (or threaded a parallel one over a different db), this row is
    // absent on `harness.db`.
    const newRow = harness.db
      .raw()
      .query<{ job_id: string; project_slug: string }, [string]>(
        `SELECT job_id, project_slug FROM import_jobs WHERE job_id = ?`,
      )
      .get(newJobId)
    expect(newRow).not.toBeNull()
    expect(newRow!.project_slug).toBe('owner')

    // (3) SHARED stateStore. The handler flips onboarding_state to
    // `import_running` and stitches the new job_id into phase_state via the
    // SAME store the engine reads. Read it back through a fresh store over the
    // shared db.
    const stateStore = new SqliteOnboardingStateStore({ db: harness.db })
    const st = await stateStore.get('owner', 'owner')
    expect(st).not.toBeNull()
    expect(st!.phase_state['import_job_id']).toBe(newJobId)
    expect(st!.phase_state['import_source']).toBe('chatgpt-zip')
  }, 30_000)

  test('POST /api/import/<unknown>/resume routes to the handler and returns its 404 job_not_found (owned route, no matching job)', async () => {
    harness = await startHarness()
    // Seed an onboarding_state row so the handler would proceed past the
    // user-id gate IF the job existed — this isolates the "job lookup" 404
    // from the "no onboarding state" 409.
    const stateStore = new SqliteOnboardingStateStore({ db: harness.db })
    await stateStore.upsert({
      project_slug: 'owner',
      user_id: 'owner',
      phase: 'import_analysis_presented',
      phase_state_patch: {},
    })

    const res = await fetch(`${harness.base}/api/import/does-not-exist/resume`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('job_not_found')
  }, 30_000)
})
