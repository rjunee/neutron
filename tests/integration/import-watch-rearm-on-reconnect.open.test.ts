/**
 * Restart-resilience: the import-completion watcher re-arms on reconnect.
 *
 * THE BUG (M1 E2E Round 2, 2026-06-29): the Path-1 import-completion watcher
 * (`watchImportCompletion`, the ONLY consumer of the `import_analysis_presented`
 * phase) is a purely in-memory `setTimeout` chain armed ONLY inside
 * `notifyImportUpload` (the upload request). The accept button for that phase is
 * deliberately suppressed on the assumption the watcher auto-consumes it, and the
 * post-turn extractor refuses to finalize on top of an import phase. So if the
 * server restarts mid-import (redeploy / crash / `launchctl kickstart`), the
 * watcher is gone; the import-running cron (which DOES re-arm on boot) drives the
 * persisted row into `import_analysis_presented`; and nothing ever consumes it.
 * Onboarding wedges PERMANENTLY — the owner sees a chat that never finishes
 * onboarding and never materializes the imported projects.
 *
 * THE FIX: `on_session_open` re-arms the (idempotent) watcher whenever the
 * persisted phase is import-active, so a reconnect after a restart resumes the
 * consume.
 *
 * This simulates a restart: it seeds an `onboarding_state` row at
 * `import_analysis_presented` (with an `import_result`, exactly the engine's
 * stamp), then boots a FRESH Open composition over `Bun.serve` (no upload ran in
 * THIS process → the watcher is unarmed), opens `/ws/app/chat` (drives
 * `on_session_open`), and asserts the phase transitions back to
 * `work_interview_gap_fill` within a few watcher ticks. Pre-fix it stays at
 * `import_analysis_presented` forever (the assertion times out).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { buildOpenGraphComposer } from '../../open/composer.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { Event } from '../../runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness { base: string; db: ProjectDb; close(): Promise<void> }
let harness: Harness | null = null

function recordingSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'ok' }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-import-rearm-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-import-rearm'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) { await harness.close(); harness = null }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(50)
  }
}

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())

  // Simulate the persisted state left by an import that finished right before a
  // restart: phase already at `import_analysis_presented`, with the engine's
  // ImportResult + merged fields stamped onto phase_state. (In production the
  // import-running cron re-arms on boot and would advance a still-`import_running`
  // row into exactly this phase.)
  const seedStore = new SqliteOnboardingStateStore({ db })
  await seedStore.upsert({
    project_slug: 'owner',
    user_id: 'owner',
    phase: 'import_analysis_presented',
    phase_state_patch: {
      user_first_name: 'Riya',
      signup_via: 'web',
      primary_projects: ['Acme Launch', 'Infra'],
      non_work_interests: ['climbing'],
      import_result: {
        proposed_projects: [{ name: 'Acme Launch' }, { name: 'Infra' }],
      },
    },
  })

  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) throw new Error('no fetch/ws')
  const server = Bun.serve({ port: 0, fetch: (req, srv) => graph.fetch!(req, srv), websocket: graph.websocket })
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) { try { cleanup() } catch { /* */ } }
      await graph.shutdown()
      db.close()
    },
  }
}

function currentPhase(db: ProjectDb): string | null {
  const row = db.raw()
    .query("SELECT phase FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'")
    .get() as { phase: string } | null
  return row?.phase ?? null
}

describe('Open import-watch re-arm on reconnect (restart resilience)', () => {
  test('a reconnect after restart consumes a stranded import_analysis_presented row', async () => {
    harness = await startHarness()
    // Pre-condition: the seeded row is stranded at import_analysis_presented.
    expect(currentPhase(harness.db)).toBe('import_analysis_presented')

    // Owner reconnects (post-restart) — this drives on_session_open, which must
    // re-arm the import-completion watcher.
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })

    // The re-armed watcher (3s tick) consumes the phase, moving it back to the
    // conversational marker so onboarding can finish. Pre-fix this never happens.
    await waitFor(() => currentPhase(harness!.db) === 'work_interview_gap_fill', 20_000)
    expect(currentPhase(harness.db)).toBe('work_interview_gap_fill')

    // The import context is preserved through the consume (shallow-merge).
    const row = harness.db.raw()
      .query("SELECT phase_state_json FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'")
      .get() as { phase_state_json: string }
    const phaseState = JSON.parse(row.phase_state_json) as Record<string, unknown>
    expect(phaseState['import_result']).toBeDefined()
    expect(phaseState['import_consumed_at']).toBeDefined()

    ws.close()
    await sleep(50)
  }, 45_000)
})
