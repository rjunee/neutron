/**
 * Unit tests — onboarding/telemetry/composition (P2 S6, Codex r1 follow-up).
 *
 * Asserts the bridging composition is correct: each per-surface sink
 * routes the right `OnboardingEventName` with the right payload shape
 * to the underlying `OnboardingTelemetry`. The most-load-bearing bridge
 * is `bridgeWowEventLogger` — production wires the `WowTelemetry`'s
 * existing `eventLogger` slot to this so wow_action_fired /
 * wow_action_engaged events land in `gateway_events` automatically.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WowTelemetry } from '../../wow-moment/telemetry.ts'
import { OnboardingTelemetry } from '../event-emitter.ts'
import {
  bridgeWowEventLogger,
  composeOnboardingTelemetrySinks,
} from '../composition.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'composition-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('bridgeWowEventLogger fans recordFired through OnboardingTelemetry → gateway_events', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const wowEventLogger = bridgeWowEventLogger(telemetry, { user_id: 'u-casey' })
  const wow = new WowTelemetry({ db, eventLogger: wowEventLogger })

  await wow.recordFired({
    project_slug: 'casey',
    action_id: '01-first-week-brief',
    fired_at: 1_700_000_000_000,
    success: true,
    success_reason: 'ok',
  })

  // The wow row landed.
  const wowRows = wow.list('casey')
  expect(wowRows.length).toBe(1)

  // AND a gateway_events row landed via the bridge.
  const onboardingEvents = telemetry.list('casey')
  const fired = onboardingEvents.filter((e) => e.event === 'onboarding.wow_action_fired')
  expect(fired.length).toBe(1)
  expect(fired[0]?.payload.action_id).toBe('01-first-week-brief')
  expect(fired[0]?.payload.success).toBe(true)
  expect(fired[0]?.user_id).toBe('u-casey')
})

test('bridgeWowEventLogger fans recordEngaged through OnboardingTelemetry', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const wowEventLogger = bridgeWowEventLogger(telemetry, { user_id: 'u-casey' })
  const wow = new WowTelemetry({ db, eventLogger: wowEventLogger })

  await wow.recordFired({
    project_slug: 'casey',
    action_id: '01-first-week-brief',
    fired_at: 1_700_000_000_000,
    success: true,
    success_reason: 'ok',
  })
  await wow.recordEngaged({
    project_slug: 'casey',
    action_id: '01-first-week-brief',
    engagement: 'opened',
    occurred_at: 1_700_000_001_000,
  })

  const events = telemetry.list('casey')
  const engaged = events.filter((e) => e.event === 'onboarding.wow_action_engaged')
  expect(engaged.length).toBe(1)
  expect(engaged[0]?.payload.action_id).toBe('01-first-week-brief')
})

test('composeOnboardingTelemetrySinks returns one sink per surface', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const sinks = composeOnboardingTelemetrySinks(telemetry)

  await sinks.signup.started({ project_slug: 'casey', user_id: 'u', via: 'tg' })
  await sinks.interview.phaseAdvanced({
    project_slug: 'casey',
    user_id: 'u',
    from: 'signup',
    to: 'agent_name_chosen',
  })
  await sinks.archetype.picked({
    project_slug: 'casey',
    user_id: 'u',
    archetype_slugs: ['athena'],
    used_llm_extension: false,
  })
  await sinks.import.started({ project_slug: 'casey', user_id: 'u', source: 'chatgpt-zip' })
  await sinks.persona.committed({
    project_slug: 'casey',
    user_id: 'u',
    draft_id: 'd1',
  })
  await sinks.profile_pic.generated({
    project_slug: 'casey',
    user_id: 'u',
    job_id: 'pp1',
    candidate_count: 3,
  })
  await sinks.completion.completed({
    project_slug: 'casey',
    user_id: 'u',
    time_to_wow_ms: 30 * 60 * 1000,
    total_dollars: 1,
    wow_actions_fired: ['01-first-week-brief'],
  })

  const events = telemetry.list('casey').map((e) => e.event)
  expect(new Set(events)).toEqual(
    new Set([
      'signup.started',
      'onboarding.phase_advanced',
      'onboarding.archetype_picked',
      'onboarding.import_started',
      'onboarding.persona_committed',
      'onboarding.profile_pic_generated',
      'onboarding.completed',
    ]),
  )
})

test('bridgeWowEventLogger ignores unknown event names instead of throwing', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const wowEventLogger = bridgeWowEventLogger(telemetry, { user_id: 'u' })
  expect(() =>
    wowEventLogger({ event: 'unknown.event', payload: { project_slug: 'casey' } }),
  ).not.toThrow()
  // No row landed.
  expect(telemetry.list('casey').length).toBe(0)
})

test('bridgeWowEventLogger drops events without project_slug rather than throwing', () => {
  const telemetry = new OnboardingTelemetry({ db })
  const wowEventLogger = bridgeWowEventLogger(telemetry, { user_id: 'u' })
  expect(() =>
    wowEventLogger({
      event: 'onboarding.wow_action_fired',
      payload: { action_id: '01-first-week-brief', success: true },
    }),
  ).not.toThrow()
  expect(telemetry.list('casey').length).toBe(0)
})
