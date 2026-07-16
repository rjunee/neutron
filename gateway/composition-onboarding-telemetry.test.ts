/**
 * Per Codex r3 P1 follow-up (2026-05-03). Asserts that the production
 * `composeProductionGraph` actually instantiates the onboarding-telemetry
 * module + (when `onboarding_telemetry.sean_ellis` is supplied) registers
 * the cron job + handler against the instance's CronJobRegistry +
 * CronHandlerRegistry. Without this regression test, the production
 * composition path could regress to the pre-S6 state where the surfaces
 * exist but never run.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import type { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import {
  OnboardingTelemetry,
  SEAN_ELLIS_HANDLER_NAME,
  type ComposedTelemetrySinks,
} from '@neutronai/onboarding/telemetry/index.ts'
import { OVERNIGHT_HANDLER_NAME } from '@neutronai/onboarding/overnight/register.ts'
import { composeProductionGraph } from './composition.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'composition-onboarding-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(async () => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const noOpInputBase = {
  project_slug: 'project-1',
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
}

test('onboarding-telemetry module composes OnboardingTelemetry + sinks even without sean_ellis config', async () => {
  const graph = await composeProductionGraph({ db, ...noOpInputBase })
  try {
    const surface = graph.get<{
      telemetry: OnboardingTelemetry
      composed: ComposedTelemetrySinks
    }>('onboarding-telemetry')
    expect(surface.telemetry).toBeInstanceOf(OnboardingTelemetry)
    expect(typeof surface.composed.signup.started).toBe('function')
    expect(typeof surface.composed.wowEventLogger).toBe('function')

    // Sean Ellis cron NOT registered when config absent.
    const cron = graph.get<{ jobs: CronJobRegistry; handlers: CronHandlerRegistry }>('cron')
    expect(cron.jobs.get(`sean-ellis-${noOpInputBase.project_slug}`)).toBeUndefined()
    expect(cron.handlers.get(SEAN_ELLIS_HANDLER_NAME)).toBeUndefined()
  } finally {
    await graph.shutdown()
  }
})

test('2026-06-19 overnight-engine: production graph ALWAYS registers overnight_handler (replaces the check-in stub)', async () => {
  // Action 07 registers the `overnight-<owner_handle>` JOB at wow-moment
  // dispatch time; the real engine HANDLER must already exist in the
  // production CronHandlerRegistry or every scheduler tick logs
  // "skipping job … handler overnight_handler not registered".
  // No config needed — registration is unconditional.
  const graph = await composeProductionGraph({ db, ...noOpInputBase })
  try {
    const cron = graph.get<{ jobs: CronJobRegistry; handlers: CronHandlerRegistry }>('cron')
    const handler = cron.handlers.get(OVERNIGHT_HANDLER_NAME)
    expect(handler).toBeDefined()
    // The engine handler ticks cleanly with no opted-in projects + no deliver
    // seam — status 'ok' (a benign no-op), never a throw — so cron_state
    // records a clean row.
    const result = await handler!({
      job_name: 'overnight-project-1',
      owner_slug: noOpInputBase.project_slug,
      fired_at: Date.now(),
    })
    expect(result.status).toBe('ok')
  } finally {
    await graph.shutdown()
  }
})

test('Sprint 30 (Codex r1 P1 + r2 P1) — telemetry resolveAttemptId mints-on-miss + reuses pre-existing onboarding_state.attempt_id', async () => {
  const graph = await composeProductionGraph({ db, ...noOpInputBase })
  try {
    const surface = graph.get<{
      telemetry: OnboardingTelemetry
      composed: ComposedTelemetrySinks
    }>('onboarding-telemetry')

    // No onboarding_state row yet — Codex r2 P1 fix: resolver
    // INSERT-OR-IGNOREs a pre-seeded row with a fresh UUID so
    // signup.* events (which fire BEFORE the engine's first upsert)
    // share the same bucket as the later interview events.
    // Pin explicit ts so the ORDER BY ts ASC, id ASC tiebreaker is
    // deterministic across UUID variants.
    await surface.telemetry.emit({
      ts: 1_000_000,
      project_slug: noOpInputBase.project_slug,
      user_id: 'u-1',
      event: 'signup.started',
      payload: { via: 'web' },
    })

    // Resolver minted a row + a UUID. Subsequent events reuse it.
    await surface.telemetry.emit({
      ts: 2_000_000,
      project_slug: noOpInputBase.project_slug,
      user_id: 'u-1',
      event: 'onboarding.phase_advanced',
      payload: { from: 'signup', to: 'agent_name_chosen' },
    })

    const events = surface.telemetry.list(noOpInputBase.project_slug)
    expect(events.length).toBe(2)
    expect(events[0]?.event).toBe('signup.started')
    expect(events[1]?.event).toBe('onboarding.phase_advanced')
    // Both events share one attempt_id — the per-attempt grouping
    // contract holds for the new-onboarding case.
    expect(events[0]?.attempt_id).toBe(events[1]?.attempt_id)
    expect(events[0]?.attempt_id).not.toBe('legacy-pre-S30')
    expect((events[0]?.attempt_id ?? '').length).toBeGreaterThan(0)
  } finally {
    await graph.shutdown()
  }
})

test('Sprint 30 (Codex r2 P1) — pre-existing onboarding_state.attempt_id wins over mint-on-miss', async () => {
  // When the engine has already written a row (e.g. resume / restart),
  // the resolver MUST return the persisted attempt_id verbatim instead
  // of overwriting it.
  db.raw().run(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at,
        last_advanced_at, completed_at, import_job_id,
        persona_files_committed, wow_fired, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['project-1', 'u-1', 'signup', '{}', 1, 1, null, null, 0, 0, 'pre-existing-attempt'],
  )
  const graph = await composeProductionGraph({ db, ...noOpInputBase })
  try {
    const surface = graph.get<{
      telemetry: OnboardingTelemetry
      composed: ComposedTelemetrySinks
    }>('onboarding-telemetry')
    await surface.telemetry.emit({
      project_slug: 'project-1',
      user_id: 'u-1',
      event: 'signup.started',
      payload: { via: 'web' },
    })
    const events = surface.telemetry.list('project-1')
    expect(events[0]?.attempt_id).toBe('pre-existing-attempt')
  } finally {
    await graph.shutdown()
  }
})

test('onboarding-telemetry module registers Sean Ellis cron when sean_ellis config supplied', async () => {
  const graph = await composeProductionGraph({
    db,
    ...noOpInputBase,
    onboarding_telemetry: {
      sean_ellis: {
        channel: { emitPrompt: async () => ({ prompt_id: 'p' }) },
        resolveContext: async () => ({ topic_id: 'topic-1' }),
        interval_ms: 60_000,
      },
    },
  })
  try {
    const cron = graph.get<{ jobs: CronJobRegistry; handlers: CronHandlerRegistry }>('cron')
    const job = cron.jobs.get(`sean-ellis-${noOpInputBase.project_slug}`)
    expect(job).toBeDefined()
    expect(job?.handler).toBe(SEAN_ELLIS_HANDLER_NAME)
    expect(cron.handlers.get(SEAN_ELLIS_HANDLER_NAME)).toBeDefined()
  } finally {
    await graph.shutdown()
  }
})
