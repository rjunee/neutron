/**
 * Open import-PROGRESS wiring — composition reachability + live emit gate.
 *
 * THE BUG (Ryan, dogfooding the self-host install): during onboarding the
 * "Upload Claude export" import runs server-side (the job runner logs
 * `[import] job=… chunk=…` per chunk) but the Open chat shows NO progress
 * — no "Pass 1: N/M batches", no ETA, no completion motion. The previous
 * Managed onboarding surfaced live progress; Open went dark.
 *
 * Root cause: `buildLandingStack` already wires the `sendImportProgress`
 * sender + web registry, but NOTHING ticked `engine.pollImportRunningTick`
 * on Open. The Managed gateway registers the import-running cron from
 * `gateway/composition/build-core-modules.ts` (gated on the
 * `onboarding_import_running_cron` CompositionInput field); the Open
 * composer omitted that field, so the cron never registered, the 5s tick
 * never fired, and the `import_progress` envelope was never emitted (and
 * the phase strands at `import_running` because the terminal-status poll
 * never runs either).
 *
 * The fix: `open/composer.ts` now sets
 * `onboarding_import_running_cron: { engine: landing.engine }`. These tests
 * boot the REAL Open composition (`buildOpenGraphComposer` →
 * `composeProductionGraph`, the same compose `boot()` runs) over a real
 * `Bun.serve` and assert:
 *
 *   1. The import-running cron job is REGISTERED + TICKING in the composed
 *      CronScheduler (`onboarding-import-running-owner`). Red on HEAD
 *      (cron unwired) → green after the fix. This is the exact mechanism
 *      the fix delivers, not phase-machine bookkeeping.
 *
 *   2. A REAL multi-chunk import (seeded `import_jobs` row at
 *      `pass1-running`, 12/40 chunks, pre-counted) drives the registered
 *      cron → engine `pollImportRunningTick` → `sendImportProgress` → web
 *      registry → a live WebSocket, where the client receives an
 *      `import_progress` envelope carrying `Pass 1: 12/40 batches` (NOT a
 *      stub — the runner's own `status()` reads the seeded row, the
 *      engine derives the body, the real chat-bridge routes it to the
 *      `web:owner` topic the live socket registered).
 *
 * Per CLAUDE.md anti-placeholder rules: the emit assertion observes the
 * real envelope delivered over a real socket, not a div's existence or a
 * phase-machine counter. The client-side render of the same envelope
 * (pulsing-dot bubble, N/M body, auto-clear) is pinned separately by
 * `landing/__tests__/chat-import-progress-bubble.test.ts`.
 *
 * No ANTHROPIC_API_KEY is set — the box boots LLM-less; progress emission
 * does not depend on LLM credentials (the runner status read + envelope
 * derivation are pure).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import { buildLocalStartTokenAuth } from '../local-start-token.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const COOKIE_SECRET = 'open-test-secret-0123456789'
const IMPORT_CRON_JOB = 'onboarding-import-running-owner'

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
  server: import('bun').Server<unknown>
  base: string
  port: number
  db: ProjectDb
  owner_home: string
  /** The composed graph — exposes `.get('cron')` for the scheduler. */
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-import-progress-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = COOKIE_SECRET
  delete process.env['ANTHROPIC_API_KEY'] // LLM-less boot
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
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
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
    port: server.port ?? 0,
    db,
    owner_home: tmpDir,
    graph,
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

/** Mint an Open single-owner start-token for the live WS upgrade. */
function mintOwnerStartToken(): string {
  const auth = buildLocalStartTokenAuth(COOKIE_SECRET)
  return auth.mint({ project_slug: 'owner', user_id: 'owner' })
}

/**
 * Seed the owner's onboarding state at `import_running` with a non-null
 * `import_job_id` AND a matching `import_jobs` row mid-Pass-1 (12/40
 * chunks, pre-counted). This is the SQL precondition the cron scans for;
 * the runner's own `status()` reads the row, so the progress envelope the
 * cron emits is derived from REAL persisted job state, not a stub.
 */
async function seedMultiChunkImportRunning(db: ProjectDb, job_id: string): Promise<void> {
  const stateStore = new SqliteOnboardingStateStore({ db })
  await stateStore.upsert({
    project_slug: 'owner',
    user_id: 'owner',
    phase: 'import_running',
    phase_state_patch: {
      topic_id: 'web:owner',
      user_id: 'owner',
      signup_via: 'web',
      import_job_id: job_id,
      import_source: 'claude-zip',
    },
  })
  // 12/40 chunks done, chunks_total_known=1 → body renders "Pass 1: 12/40
  // batches". started_at well in the past so the hard-timeout backstop
  // (15 min) does NOT fire and flip the job terminal.
  await db.run(
    `INSERT INTO import_jobs
       (job_id, project_slug, source, status, dollars_spent, pass1_chunks_done,
        pass1_chunks_total, chunks_total_known, started_at, completed_at,
        error_code, error_message)
     VALUES (?, 'owner', 'claude-zip', 'pass1-running', 0, 12, 40, 1, ?, NULL, NULL, NULL)`,
    [job_id, Date.now() - 30_000],
  )
}

interface OpenSocket {
  frames: Array<Record<string, unknown>>
  close(): void
}

/** Open a live WS to the composed Open server as the owner and collect frames. */
async function openOwnerSocket(port: number): Promise<OpenSocket> {
  const token = mintOwnerStartToken()
  const url = `ws://127.0.0.1:${port}/ws/chat?start=${encodeURIComponent(token)}`
  const frames: Array<Record<string, unknown>> = []
  const ws = new WebSocket(url)
  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      const data = typeof ev.data === 'string' ? ev.data : ''
      if (data.length === 0) return
      const parsed = JSON.parse(data) as Record<string, unknown>
      frames.push(parsed)
    } catch {
      /* ignore non-JSON frames */
    }
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS did not open in 5s')), 5_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WS upgrade failed (401 / handshake error)'))
    })
  })
  return {
    frames,
    close: () => {
      try {
        ws.close()
      } catch {
        /* best-effort */
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('Open import-progress surface wiring', () => {
  test('the import-running cron is REGISTERED + ticking in the composed scheduler (regression: was never wired on Open)', async () => {
    harness = await startHarness()
    const cron = harness.graph.get<{
      scheduler: { runningJobNames(): string[] }
    }>('cron')
    const running = cron.scheduler.runningJobNames()
    // Pre-fix this list did NOT contain the import-running job — the Open
    // composer omitted `onboarding_import_running_cron`, so nothing polled
    // the runner and the chat stayed dark during import.
    expect(running).toContain(IMPORT_CRON_JOB)
  }, 30_000)

  test('a real multi-chunk import emits a live import_progress envelope (Pass 1: 12/40 batches) over the WS to web:owner', async () => {
    harness = await startHarness()
    const job_id = 'job-open-progress-1'
    await seedMultiChunkImportRunning(harness.db, job_id)

    // Live socket registers the `web:owner` sender in the real chat-bridge.
    const sock = await openOwnerSocket(harness.port)
    // Let startSession finish registering the sender before the first tick.
    await sleep(250)

    const cron = harness.graph.get<{
      scheduler: { fireOnce(name: string): Promise<unknown> }
    }>('cron')

    // Deterministically drive the registered cron. A small retry loop
    // absorbs any sender-registration latency without depending on the
    // 5s auto-tick; each fire re-reads the seeded job (still pass1-running)
    // and re-emits, so the assertion converges fast.
    let progress: Record<string, unknown> | undefined
    for (let i = 0; i < 25 && progress === undefined; i++) {
      await cron.scheduler.fireOnce(IMPORT_CRON_JOB)
      await sleep(80)
      progress = sock.frames.find((f) => f['type'] === 'import_progress')
    }
    sock.close()

    expect(progress).toBeDefined()
    expect(progress!['type']).toBe('import_progress')
    expect(progress!['job_id']).toBe(job_id)
    expect(progress!['status']).toBe('pass1-running')
    expect(progress!['pass']).toBe(1)
    expect(progress!['chunks_total_known']).toBe(true)
    expect(typeof progress!['body']).toBe('string')
    expect(progress!['body'] as string).toContain('Pass 1: 12/40 batches')
    // Max-OAuth owners aren't billed per-token — the body must never carry
    // a `$` and the envelope must not regress to the old dollars_spent shape.
    expect(progress!['body'] as string).not.toContain('$')
    expect(JSON.stringify(progress)).not.toContain('dollars_spent')
    // pct ≈ 12/40 = 0.3.
    expect(progress!['pct'] as number).toBeGreaterThan(0.25)
    expect(progress!['pct'] as number).toBeLessThan(0.35)
  }, 30_000)
})
