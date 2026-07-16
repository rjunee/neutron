/**
 * Integration test — m2-sean-ellis-fires (P2 S6, § 6a lines 2303-2308).
 *
 * GIVEN: a completed onboarding with `completed_at = now - (4 weeks - 1
 *        hour)`. cron/scheduler.ts running.
 *
 * WHEN:  advance the clock 1 hour + 1 minute past the 4-week boundary;
 *        cron tick.
 *
 * THEN:  - sean_ellis_responses table doesn't yet have a *responded*
 *          row (the prompt is open with response_kind = 'no_response')
 *        - a button prompt was emitted to mock Telegram
 *        - tap [B] (somewhat_disappointed) + freeform "Onboarding was
 *          solid; the import felt magical"
 *        - row updates to response_kind = 'somewhat_disappointed';
 *          freeform_text + responded_at populated
 *        - the onboarding_metrics view aggregates the response
 *
 * MOCKS: clock; Telegram client.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { OnboardingTelemetry } from '@neutronai/onboarding/telemetry/event-emitter.ts'
import {
  FOUR_WEEKS_MS,
  SeanEllisStore,
  buildSeanEllisHandler,
  registerSeanEllisCron,
  type SeanEllisChannel,
} from '@neutronai/onboarding/telemetry/sean-ellis-trigger.ts'
import { M2FeedbackCollector } from '@neutronai/onboarding/feedback/m2-week-4-collector.ts'

const OWNER = 'mira'
const USER = 'u-mira'
const TOPIC = 'topic-onboarding'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'm2-sean-ellis-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface RecordingChannel extends SeanEllisChannel {
  emitted: Array<{ topic_id: string; prompt: ButtonPrompt }>
}

function buildRecordingChannel(): RecordingChannel {
  const emitted: Array<{ topic_id: string; prompt: ButtonPrompt }> = []
  return {
    emitted,
    async emitPrompt(input) {
      emitted.push({ topic_id: input.topic_id, prompt: input.prompt })
      return { prompt_id: input.prompt.prompt_id }
    },
  }
}

test('Sean Ellis cron fires at +4 weeks via real CronScheduler.fireOnce; tap [B] + freeform records', async () => {
  // ----- 1. Seed a completed onboarding 4 weeks - 1 hour in the past
  //         (fast-forward clock controls the "now").
  const completed_at = 1_700_000_000_000
  const initialNow = completed_at + FOUR_WEEKS_MS - 60 * 60 * 1000
  const telemetry = new OnboardingTelemetry({ db })
  await telemetry.emit({
    project_slug: OWNER,
    user_id: USER,
    event: 'signup.started',
    payload: { via: 'tg' },
    ts: completed_at - 30 * 60 * 1000,
  })
  await telemetry.emit({
    project_slug: OWNER,
    user_id: USER,
    event: 'onboarding.wow_dispatched',
    payload: { fired_count: 4, total_actions: 7 },
    ts: completed_at - 1000,
  })
  await telemetry.emit({
    project_slug: OWNER,
    user_id: USER,
    event: 'onboarding.completed',
    payload: { time_to_wow_ms: 30 * 60 * 1000, total_dollars: 1, wow_actions_fired: [] },
    ts: completed_at,
  })

  // ----- 2. Build the real CronScheduler over the same ProjectDb. Use a
  //         very short interval so we can drive `fireOnce` directly;
  //         the production path runs the same handler via
  //         CronScheduler.fireOnce.
  const channel = buildRecordingChannel()
  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ user_id: USER, topic_id: TOPIC }),
    now: () => clock.now,
  })

  const jobs = new CronJobRegistry()
  const handlers = new CronHandlerRegistry()
  // Codex r1 P1 fix (2026-05-03): production composition uses
  // `registerSeanEllisCron(...)` instead of hand-wiring the registries.
  // The integration test exercises the same path the per-instance gateway
  // boot will use, proving the cron actually wires up.
  registerSeanEllisCron({
    project_slug: OWNER,
    jobs,
    handlers,
    handler,
    interval_ms: 60_000,
  })

  const clock = { now: initialNow }
  const scheduler = new CronScheduler({
    jobs,
    handlers,
    db,
    owner_slug: OWNER,
    now: () => clock.now,
  })

  // ----- 3. Pre-window: tick fires the handler but skips (not yet 4 weeks).
  const skipResult = await scheduler.fireOnce(`sean-ellis-${OWNER}`)
  expect(skipResult.status).toBe('skipped')
  expect(channel.emitted.length).toBe(0)

  // ----- 4. Advance the clock 1 hour + 1 minute past the boundary.
  clock.now = completed_at + FOUR_WEEKS_MS + 60 * 1000

  // ----- 5. Tick again — the handler emits the survey prompt + opens
  //         the response row.
  const fireResult = await scheduler.fireOnce(`sean-ellis-${OWNER}`)
  expect(fireResult.status).toBe('ok')
  expect(channel.emitted.length).toBe(1)
  const prompt = channel.emitted[0]?.prompt
  expect(prompt?.options.map((o) => o.value)).toEqual([
    'very_disappointed',
    'somewhat_disappointed',
    'not_disappointed',
  ])
  expect(prompt?.allow_freeform).toBe(true)

  // The open row exists with response_kind='no_response'.
  const store = new SeanEllisStore(db)
  const open = store.latestForOwner(OWNER)
  expect(open?.response_kind).toBe('no_response')
  expect(open?.responded_at).toBeNull()
  // Codex r4 P1: the prompt_id is persisted so channel callbacks can
  // resolve `prompt_id` → row. Verify the round-trip.
  expect(open?.prompt_id).toBe(prompt!.prompt_id)
  expect(store.byPromptId(OWNER, prompt!.prompt_id)?.id).toBe(open!.id)

  // ----- 6. User taps [B] + supplies freeform — collector records.
  const writes: Array<{ path: string; contents: string }> = []
  const collector = new M2FeedbackCollector({
    db,
    telemetry,
    feedbackPath: join(tmp, 'M2-mira-week-4.md'),
    appendFile: (path, contents) => writes.push({ path, contents }),
    now: () => clock.now + 30_000,
  })
  const collectorOut = await collector.recordResponse({
    project_slug: OWNER,
    response_id: open!.id,
    user_id: USER,
    response_kind: 'somewhat_disappointed',
    freeform_text: 'Onboarding was solid; the import felt magical',
  })
  expect(collectorOut.appended_to_markdown).toBe(true)
  expect(writes.length).toBe(1)
  expect(writes[0]?.contents).toContain('Onboarding was solid')

  // ----- 7. Row updated.
  const updated = store.latestForOwner(OWNER)
  expect(updated?.response_kind).toBe('somewhat_disappointed')
  expect(updated?.freeform_text).toBe('Onboarding was solid; the import felt magical')
  expect(updated?.responded_at).toBe(clock.now + 30_000)

  // ----- 8. metrics view aggregates the response (sean_ellis_response
  //         column reflects the most recent tap).
  interface MetricsRow {
    sean_ellis_response: string | null
  }
  const row = db
    .raw()
    .query<MetricsRow, [string]>(
      `SELECT sean_ellis_response FROM onboarding_metrics WHERE project_slug = ?`,
    )
    .get(OWNER)
  expect(row?.sean_ellis_response).toBe('somewhat_disappointed')

  // ----- 9. Idempotency: another scheduler tick after the response
  //         lands does NOT re-emit the prompt.
  const repeatResult = await scheduler.fireOnce(`sean-ellis-${OWNER}`)
  expect(repeatResult.status).toBe('skipped')
  expect(channel.emitted.length).toBe(1)
})
