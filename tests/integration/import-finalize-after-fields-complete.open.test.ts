/**
 * Onboarding must finalize when a history import lands AFTER the owner already
 * answered every required field — even if the owner then goes idle.
 *
 * THE BUG (M1 E2E Round 4, 2026-06-29): the onboarding finalizer
 * (`onboardingFinalizer.finalize` — persona commit + project DB rows + topics +
 * gbrain pages + phase→`completed`) was invoked from EXACTLY ONE place: the
 * post-turn extractor's `onComplete`, which only runs on a USER turn. That
 * completion is (correctly) suppressed while an import is in flight. So on the
 * headline "import my whole ChatGPT/Claude history" path with a large export
 * (minutes of synthesis), this sequence stranded the owner permanently:
 *
 *   1. owner answers all 5 required fields while the import is still running
 *      → the field-completing turn is GATED (import in flight) → no finalize;
 *   2. the import completes; the import-completion watcher consumes
 *      `import_analysis_presented` → `work_interview_gap_fill` but did NOT
 *      finalize (it relied on "a subsequent no-op turn");
 *   3. the owner, having answered everything, goes idle / closes the tab.
 *
 * Nothing else finalizes: there is no proactive re-trigger in Open, and
 * `on_session_open` only re-armed the watcher (it never finalized). Result: the
 * cold-start default persona is never replaced, NO `projects` rows / topics /
 * gbrain pages are created (only on-disk seed files), and the owner sees a
 * generic agent with an empty/stale project rail — with no error.
 *
 * THE FIX: make import completion an authoritative finalize trigger.
 *   - `watchImportCompletion`, right after consuming the import, finalizes when
 *     every required field is already present and no import is in flight;
 *   - `on_session_open` finalizes a row already consumed into the conversational
 *     marker (the restart / already-stranded recovery path).
 *
 * Both are gated by `auditRequiredFields(...).next_to_collect === null` so a
 * still-incomplete interview simply continues as before (no premature finalize).
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
import type { OnboardingPhase } from '@neutronai/onboarding/interview/phase.ts'
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
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-import-finalize',
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

/** Every required field present (≥3 projects, ≥1 interest, name, personality,
 *  agent_name) PLUS the engine's stamped ImportResult — i.e. the owner finished
 *  the interview while the import was still synthesizing. */
const COMPLETE_PHASE_STATE: Record<string, unknown> = {
  user_first_name: 'Riya',
  signup_via: 'web',
  primary_projects: ['Acme Launch', 'Infra Migration', 'Personal Site'],
  non_work_interests: ['climbing'],
  agent_personality: 'warm, concise, a little witty',
  agent_name: 'Nova',
  import_result: {
    proposed_projects: [
      { name: 'Acme Launch' },
      { name: 'Infra Migration' },
      { name: 'Personal Site' },
    ],
  },
}

async function startHarness(seedPhase: OnboardingPhase, extraPhaseState: Record<string, unknown> = {}): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())

  const seedStore = new SqliteOnboardingStateStore({ db })
  await seedStore.upsert({
    project_slug: 'owner',
    user_id: 'owner',
    phase: seedPhase,
    phase_state_patch: { ...COMPLETE_PHASE_STATE, ...extraPhaseState },
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

function projectCount(db: ProjectDb): number {
  const row = db.raw()
    .query('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL')
    .get() as { n: number } | null
  return row?.n ?? 0
}

async function openWs(harness: Harness): Promise<WebSocket> {
  const wsUrl = harness.base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
  })
  return ws
}

describe('Open onboarding finalizes after a late import (owner already idle)', () => {
  test('watcher finalizes when it consumes an import_analysis_presented row whose fields are all complete', async () => {
    // The engine left the row at import_analysis_presented (import landed) with
    // every required field already present and NO import job in flight.
    harness = await startHarness('import_analysis_presented')
    // P6 (c): the completion watcher is re-armed FROM DURABLE STATE at
    // composition, so this stranded import_analysis_presented row is consumed +
    // finalized WITHOUT waiting for a reconnect (pre-P6 it stayed stranded until
    // on_session_open re-armed the watcher). The consume/finalize is async right
    // after composition, so the pre-condition is asserted via the convergence
    // wait below rather than a synchronous "still stranded" snapshot. The
    // reconnect is now a redundant, idempotent re-arm.
    const ws = await openWs(harness)
    await waitFor(() => currentPhase(harness!.db) === 'completed', 25_000)
    expect(currentPhase(harness.db)).toBe('completed')
    // Persona + projects were materialized: the imported projects became real
    // DB rows (pre-fix: zero — the owner was stranded un-onboarded).
    expect(projectCount(harness.db)).toBeGreaterThanOrEqual(1)

    ws.close()
    await sleep(50)
  }, 45_000)

  test('on_session_open finalizes a row already consumed into work_interview_gap_fill (restart/idle recovery)', async () => {
    // The watcher already consumed the import (phase work_interview_gap_fill,
    // import_consumed_at stamped) but never finalized — the pre-fix stranded
    // state, or a restart between consume and finalize.
    harness = await startHarness('work_interview_gap_fill', { import_consumed_at: 1 })
    expect(currentPhase(harness.db)).toBe('work_interview_gap_fill')
    expect(projectCount(harness.db)).toBe(0)

    // A plain reconnect must recover it (pre-fix: on_session_open only re-armed
    // the watcher for import-active phases, so this row stayed forever).
    const ws = await openWs(harness)
    await waitFor(() => currentPhase(harness!.db) === 'completed', 25_000)
    expect(currentPhase(harness.db)).toBe('completed')
    expect(projectCount(harness.db)).toBeGreaterThanOrEqual(1)

    ws.close()
    await sleep(50)
  }, 45_000)
})
