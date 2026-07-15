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
import { dirname, join } from 'node:path'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

let home: IsolatedHome

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
  // Shared G9 test-isolation testkit: a fresh, unique NEUTRON_HOME tmpdir +
  // the standard per-instance env, with the extra onboarding-boot keys layered
  // on and all of them restored on teardown. See tests/support/test-isolation.ts.
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-import-rearm',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
    },
  })
})

afterEach(async () => {
  if (harness !== null) { await harness.close(); harness = null }
  home.restore()
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
    // P6 (c): the completion watcher is re-armed FROM DURABLE STATE at
    // composition (the restart-boot), so the seeded stranded
    // import_analysis_presented row is consumed WITHOUT needing the owner to
    // reconnect. The consume is async right after composition; assert it via the
    // convergence wait below rather than a synchronous "still stranded" snapshot.
    // The reconnect below is now a redundant, idempotent re-arm (importWatchActive
    // guards the double-arm) and must not disturb the already-consumed row.
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

  test('composition-boot re-arm consumes a stranded row WITHOUT any reconnect (proves the boot scan, not on_session_open)', async () => {
    // P6 (c) BOUNDARY: the reconnect test above opens a WebSocket, and
    // `on_session_open` ALSO re-arms the watcher — so it would still pass if the
    // composition-time boot scan (open/composer.ts, the onboarding_state
    // import-active re-arm) were deleted. This test opens NO socket: the ONLY thing
    // that can consume the seeded stranded `import_analysis_presented` row is the
    // composition-boot re-arm. Deleting that boot scan makes THIS test time out
    // (verified: reverting the composer.ts re-arm block leaves the phase stranded).
    harness = await startHarness()
    // No WebSocket. The offline-owner-after-restart case.
    await waitFor(() => currentPhase(harness!.db) === 'work_interview_gap_fill', 20_000)
    expect(currentPhase(harness.db)).toBe('work_interview_gap_fill')

    // The import context is preserved through the boot-driven consume.
    const row = harness.db.raw()
      .query("SELECT phase_state_json FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'")
      .get() as { phase_state_json: string }
    const phaseState = JSON.parse(row.phase_state_json) as Record<string, unknown>
    expect(phaseState['import_result']).toBeDefined()
    expect(phaseState['import_consumed_at']).toBeDefined()
  }, 45_000)
})
