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

// Seed the persisted state an import leaves right before a restart: phase already at
// `import_analysis_presented`, with the engine's ImportResult + merged fields stamped
// onto phase_state. (In production the import-running cron re-arms on boot and would
// advance a still-`import_running` row into exactly this phase.)
async function seedStrandedImportRow(db: ProjectDb): Promise<void> {
  const seedStore = new SqliteOnboardingStateStore({ db })
  await seedStore.upsert({
    owner_slug: 'owner',
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
}

// F8 NEGATIVE boundary — a conversational-marker row that is NOT finalize-ready:
// required fields are still missing (no agent_personality, fewer than the required
// primary projects). The boot finalize recovery MUST leave it alone (the readiness
// gate says next_to_collect !== null), or a restart would prematurely "complete" an
// onboarding the owner never finished. Boot with no socket and assert it stays put.
async function seedIncompleteConversationalRow(db: ProjectDb): Promise<void> {
  const seedStore = new SqliteOnboardingStateStore({ db })
  await seedStore.upsert({
    owner_slug: 'owner',
    user_id: 'owner',
    phase: 'work_interview_gap_fill',
    phase_state_patch: {
      user_first_name: 'Riya',
      signup_via: 'web',
      // Deliberately incomplete: no primary_projects, no agent_personality → the
      // finalize readiness gate reports fields still outstanding.
    },
  })
}

// F8 NEGATIVE boundary — an import still IN-FLIGHT (phase `import_running`). The boot
// sweep may re-arm the import machinery for this row, but the FINALIZE recovery must
// never fire on an import-active phase: finalizing on top of a running import would
// race the import's own consume/materialize. Assert it never reaches `completed`.
async function seedInFlightImportRow(db: ProjectDb): Promise<void> {
  const seedStore = new SqliteOnboardingStateStore({ db })
  await seedStore.upsert({
    owner_slug: 'owner',
    user_id: 'owner',
    phase: 'import_running',
    phase_state_patch: {
      user_first_name: 'Riya',
      signup_via: 'web',
      primary_projects: ['Acme Launch', 'Infra', 'Garden'],
      non_work_interests: ['climbing'],
      agent_personality: 'warm and direct',
    },
  })
}

// `seedBeforeCompose` = true → the row exists when the composition-boot re-arm scans
// (so the boot scan consumes it — the offline-restart path). false → the row is absent
// at boot; the test seeds it AFTER composition so ONLY `on_session_open` (reconnect)
// can consume it — the reconnect-path boundary.
// F8 — the M1 E2E Round 4 strand as it looks on disk right before a restart:
// the import already landed and was CONSUMED back into the conversational
// marker (`work_interview_gap_fill`, `import_consumed_at` stamped), the owner
// had already answered EVERY required field (all four present, ≥3 primary
// projects), but there was no further user turn to finalize on — so the row is
// stuck one step short of `completed`. Pre-F8, only an owner RECONNECT recovers
// this (on_session_open's finalize recovery); if the owner never reconnects it
// wedges. `rearmFromDurableState` finalizes it boot-derived, no socket.
async function seedStrandedCompletableRow(db: ProjectDb): Promise<void> {
  const seedStore = new SqliteOnboardingStateStore({ db })
  await seedStore.upsert({
    owner_slug: 'owner',
    user_id: 'owner',
    phase: 'work_interview_gap_fill',
    phase_state_patch: {
      user_first_name: 'Riya',
      signup_via: 'web',
      primary_projects: ['Acme Launch', 'Infra', 'Garden'],
      non_work_interests: ['climbing'],
      agent_personality: 'warm and direct',
      import_result: {
        proposed_projects: [{ name: 'Acme Launch' }, { name: 'Infra' }],
      },
      import_consumed_at: Date.now(),
    },
  })
}

async function startHarness({
  seedBeforeCompose = true,
  seedFn = seedStrandedImportRow,
}: { seedBeforeCompose?: boolean; seedFn?: (db: ProjectDb) => Promise<void> } = {}): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())

  if (seedBeforeCompose) await seedFn(db)

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
  test('a reconnect consumes a stranded import_analysis_presented row that appears AFTER boot (proves on_session_open, not the boot scan)', async () => {
    // Boot with NO stranded row, so the composition-boot re-arm scan finds nothing
    // and cannot consume anything. THEN seed the stranded row (a row that becomes
    // import-active after the process is already up) and open the socket: the ONLY
    // thing that can consume it now is the `on_session_open` reconnect re-arm.
    // Deleting that reconnect re-arm makes THIS test time out (the boot-only path
    // never sees the post-boot row).
    harness = await startHarness({ seedBeforeCompose: false })
    await seedStrandedImportRow(harness.db)
    // Sanity: nothing has consumed it yet (no watcher is armed for this row).
    expect(currentPhase(harness.db)).toBe('import_analysis_presented')

    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })

    // The reconnect-armed watcher (3s tick) consumes the phase, moving it back to the
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

  test('F8 — boot-derived finalize recovery finalizes a complete-but-stranded row WITHOUT any reconnect', async () => {
    // F8 DISTINCT-FROM-P6: P6 boot-re-arms only the import WATCHER (import-active
    // phases). The post-import FINALIZE recovery — an owner who answered every
    // required field while the import synthesized, had it consumed back into
    // `work_interview_gap_fill`, then went idle before any finalize turn — was
    // still ONLY recoverable via `on_session_open` (an owner reconnect). This
    // seeds exactly that strand (all four required fields present, import already
    // consumed) and boots with NO socket: `rearmFromDurableState`'s finalize
    // recovery drives it to `completed`. Deleting the finalize branch leaves the
    // phase stuck at `work_interview_gap_fill` (the boot watcher re-arm never
    // touches a non-import phase), timing this out.
    harness = await startHarness({ seedFn: seedStrandedCompletableRow })
    // No WebSocket — the offline-owner-after-restart case.
    await waitFor(() => currentPhase(harness!.db) === 'completed', 20_000)
    expect(currentPhase(harness.db)).toBe('completed')
  }, 45_000)

  test('F8 — boot re-arm + reconnect double-arm is SAFE (consumes once to the marker, context preserved)', async () => {
    // Boot WITH the stranded `import_analysis_presented` row (composition-boot arms one
    // watcher) AND open a socket (on_session_open calls watchImportCompletion again).
    // Single consumption is guaranteed by the SYNCHRONOUS `importWatchActive` Set in
    // watchImportCompletion (open/composer.ts): it checks-and-adds the user_id BEFORE
    // scheduling any tick, so a second arm returns immediately — only ever ONE watcher
    // (one tick loop) per user. That synchronous guard is the load-bearing correctness
    // mechanism; the per-tick phase read→upsert is NOT atomic, so it alone would not
    // protect two genuinely concurrent watchers.
    //
    // SCOPE: this is a SMOKE test that exercising BOTH arm paths is safe — the row
    // consumes ONCE to `work_interview_gap_fill` with import context preserved (no crash,
    // no double-corruption). It deliberately does NOT assert timing-based dedup: the boot
    // watcher's first tick fires immediately and may consume before the socket opens, and
    // the second arm is a synchronous Set no-op, so there is no observable overlap to
    // assert at this layer. A deterministic forced-overlap test — gate the boot watcher's
    // first read until the reconnect arm has run, then assert a single consume — needs a
    // composer store-injection seam (the same seam the P6 watcher-latch follow-up tracks);
    // filed as a follow-up rather than built here.
    harness = await startHarness() // seeds import_analysis_presented before compose → boot arms
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve() // on_session_open arms again (synchronously deduped)
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })

    // Both arm paths ran; the row consumes to the conversational marker with the import
    // context (result + consumed stamp) preserved through the shallow-merge — no crash,
    // no corruption from double-arming.
    await waitFor(() => currentPhase(harness!.db) === 'work_interview_gap_fill', 20_000)
    const row = harness.db.raw()
      .query("SELECT phase_state_json FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'")
      .get() as { phase_state_json: string }
    const phaseState = JSON.parse(row.phase_state_json) as Record<string, unknown>
    expect(phaseState['import_result']).toBeDefined()
    expect(phaseState['import_consumed_at']).toBeDefined()

    ws.close()
    await sleep(50)
  }, 45_000)

  test('F8 NEGATIVE — boot does NOT finalize a conversational row that is missing required fields', async () => {
    // The mirror of the finalize-recovery test: a `work_interview_gap_fill` row that
    // is NOT ready (required fields still outstanding). `rearmFromDurableState`'s
    // finalize recovery must respect the readiness gate and leave it at
    // `work_interview_gap_fill` — a restart must never "complete" an unfinished
    // onboarding. Boot with no socket; give the boot sweep + a few ticks to run.
    harness = await startHarness({ seedFn: seedIncompleteConversationalRow })
    await sleep(2_000) // let the boot sweep + any tick run
    expect(currentPhase(harness.db)).toBe('work_interview_gap_fill')
    expect(currentPhase(harness.db)).not.toBe('completed')
  }, 30_000)

  test('F8 NEGATIVE — boot does NOT finalize a row whose import is still in-flight', async () => {
    // An `import_running` row (import not yet done). The finalize recovery must skip
    // import-active phases entirely — finalizing on top of a running import would race
    // its consume/materialize. Assert it never reaches `completed` across a settle
    // window (it may be re-armed / advanced by the import machinery, but MUST NOT be
    // finalized).
    harness = await startHarness({ seedFn: seedInFlightImportRow })
    await sleep(2_000)
    expect(currentPhase(harness.db)).not.toBe('completed')
  }, 30_000)
})
