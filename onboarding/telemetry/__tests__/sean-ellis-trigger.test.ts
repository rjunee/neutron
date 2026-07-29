/**
 * Unit tests — onboarding/telemetry/sean-ellis-trigger (P2 S6).
 *
 * Per docs/plans/P2-onboarding.md § 5.3 + § 9.4 + § 6 S6.
 *
 * Asserts:
 *   - clock-fast-forward fires at +4 weeks (cron tick handler)
 *   - button prompt emitted with correct copy + options
 *   - tap [B] (somewhat_disappointed) enters freeform flow when collector
 *     records the freeform reply
 *   - tap [A]/[C] records response without freeform
 *   - idempotency: a second tick before any response does NOT re-emit
 *   - missing completed_at row → handler skipped (no_completed_onboarding)
 *   - within window → handler skipped (not_yet)
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { OnboardingTelemetry } from '../event-emitter.ts'
import {
  FOUR_WEEKS_MS,
  SEAN_ELLIS_PROMPT_BODY,
  SEAN_ELLIS_PROMPT_OPTIONS,
  SeanEllisStore,
  buildSeanEllisHandler,
  buildSeanEllisJob,
  type SeanEllisChannel,
} from '../sean-ellis-trigger.ts'
import { M2FeedbackCollector } from '../../feedback/m2-week-4-collector.ts'

let tmp: string
let db: ProjectDb

const OWNER = 'casey'
const USER = 'u-casey'
const TOPIC = 'topic-onboarding'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sean-ellis-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

async function seedCompleted(opts: {
  signup_at: number
  completed_at: number
}): Promise<void> {
  // Default randomUUID — multiple ad-hoc OnboardingTelemetry instances
  // run during a test (seed, handler, collector); a deterministic
  // generator scoped to a single instance would collide on
  // gateway_events.id when another instance starts at 1 again.
  const telemetry = new OnboardingTelemetry({ db })
  await telemetry.emit({
    owner_slug: OWNER,
    user_id: USER,
    event: 'signup.started',
    payload: { via: 'tg' },
    ts: opts.signup_at,
  })
  await telemetry.emit({
    owner_slug: OWNER,
    user_id: USER,
    event: 'onboarding.wow_dispatched',
    payload: { fired_count: 4, total_actions: 7 },
    ts: opts.completed_at - 1000,
  })
  await telemetry.emit({
    owner_slug: OWNER,
    user_id: USER,
    event: 'onboarding.completed',
    payload: { time_to_wow_ms: 1, total_dollars: 1, wow_actions_fired: [] },
    ts: opts.completed_at,
  })
}

test('cron handler fires at +4 weeks + 1 minute, emits prompt + open row', async () => {
  const completed_at = 1_700_000_000_000
  await seedCompleted({ signup_at: completed_at - 30 * 60 * 1000, completed_at })

  const telemetry = new OnboardingTelemetry({ db })
  const channel = buildRecordingChannel()
  const now = completed_at + FOUR_WEEKS_MS + 60 * 1000
  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ user_id: USER, topic_id: TOPIC }),
    now: () => now,
  })

  const result = await handler({ job_name: `sean-ellis-${OWNER}`, owner_slug: OWNER, fired_at: now })
  expect(result.status).toBe('ok')
  expect(channel.emitted.length).toBe(1)
  const prompt = channel.emitted[0]?.prompt
  expect(prompt?.body).toBe(SEAN_ELLIS_PROMPT_BODY)
  expect(prompt?.allow_freeform).toBe(true)
  expect(prompt?.options.map((o) => o.value)).toEqual(
    SEAN_ELLIS_PROMPT_OPTIONS.map((o) => o.value),
  )

  // Open row inserted.
  const store = new SeanEllisStore(db)
  const row = store.latestForOwner(OWNER)
  expect(row?.response_kind).toBe('no_response')
  expect(row?.user_id).toBe(USER)
  expect(row?.responded_at).toBeNull()

  // Telemetry event emitted.
  const events = telemetry.list(OWNER).filter((e) => e.event === 'onboarding.sean_ellis_prompt_emitted')
  expect(events.length).toBe(1)
})

test('handler skips before the 4-week window elapses', async () => {
  const completed_at = 1_700_000_000_000
  await seedCompleted({ signup_at: completed_at - 30 * 60 * 1000, completed_at })

  const telemetry = new OnboardingTelemetry({ db })
  const channel = buildRecordingChannel()
  const now = completed_at + FOUR_WEEKS_MS - 60 * 60 * 1000

  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ user_id: USER, topic_id: TOPIC }),
    now: () => now,
  })

  const result = await handler({ job_name: `sean-ellis-${OWNER}`, owner_slug: OWNER, fired_at: now })
  expect(result.status).toBe('skipped')
  expect(channel.emitted.length).toBe(0)
})

test('handler skips when no completed onboarding exists', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const channel = buildRecordingChannel()

  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ user_id: USER, topic_id: TOPIC }),
    now: () => 1,
  })
  const result = await handler({ job_name: `sean-ellis-${OWNER}`, owner_slug: OWNER, fired_at: 1 })
  expect(result.status).toBe('skipped')
  expect(result.detail).toBe('no_completed_onboarding')
})

test('idempotent: a second tick after the prompt is open does NOT re-emit', async () => {
  const completed_at = 1_700_000_000_000
  await seedCompleted({ signup_at: completed_at - 30 * 60 * 1000, completed_at })
  const now = completed_at + FOUR_WEEKS_MS + 60 * 1000
  const telemetry = new OnboardingTelemetry({ db })
  const channel = buildRecordingChannel()
  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ user_id: USER, topic_id: TOPIC }),
    now: () => now,
  })

  await handler({ job_name: `sean-ellis-${OWNER}`, owner_slug: OWNER, fired_at: now })
  const second = await handler({ job_name: `sean-ellis-${OWNER}`, owner_slug: OWNER, fired_at: now + 1000 })
  expect(second.status).toBe('skipped')
  expect(second.detail).toBe('already_emitted')
  expect(channel.emitted.length).toBe(1)
})

test('tap [B] freeform records response_kind + freeform_text + emits sean_ellis_response event', async () => {
  const completed_at = 1_700_000_000_000
  await seedCompleted({ signup_at: completed_at - 30 * 60 * 1000, completed_at })
  const now = completed_at + FOUR_WEEKS_MS + 60 * 1000
  const telemetry = new OnboardingTelemetry({ db })
  const channel = buildRecordingChannel()
  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ user_id: USER, topic_id: TOPIC }),
    now: () => now,
  })
  await handler({ job_name: `sean-ellis-${OWNER}`, owner_slug: OWNER, fired_at: now })

  const store = new SeanEllisStore(db)
  const row = store.latestForOwner(OWNER)
  expect(row).not.toBeNull()

  const writes: Array<{ path: string; contents: string }> = []
  const collector = new M2FeedbackCollector({
    db,
    telemetry,
    feedbackPath: join(tmp, 'M2-casey-week-4.md'),
    appendFile: (path, contents) => writes.push({ path, contents }),
    now: () => now + 5_000,
  })

  const result = await collector.recordResponse({
    owner_slug: OWNER,
    response_id: row!.id,
    user_id: USER,
    response_kind: 'somewhat_disappointed',
    freeform_text: 'Onboarding was solid; the import felt magical',
  })
  expect(result.appended_to_markdown).toBe(true)
  expect(writes.length).toBe(1)
  expect(writes[0]?.contents).toContain('somewhat_disappointed')
  expect(writes[0]?.contents).toContain('Onboarding was solid')

  const updated = store.latestForOwner(OWNER)
  expect(updated?.response_kind).toBe('somewhat_disappointed')
  expect(updated?.freeform_text).toBe('Onboarding was solid; the import felt magical')
  expect(updated?.responded_at).toBe(now + 5_000)

  const responseEvents = telemetry
    .list(OWNER)
    .filter((e) => e.event === 'onboarding.sean_ellis_response')
  expect(responseEvents.length).toBe(1)
  expect(responseEvents[0]?.payload.response).toBe('somewhat_disappointed')
})

test('tap [A] very_disappointed: response recorded, no markdown append', async () => {
  const completed_at = 1_700_000_000_000
  await seedCompleted({ signup_at: completed_at - 30 * 60 * 1000, completed_at })
  const now = completed_at + FOUR_WEEKS_MS + 60 * 1000
  const telemetry = new OnboardingTelemetry({ db })
  const channel = buildRecordingChannel()
  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ user_id: USER, topic_id: TOPIC }),
    now: () => now,
  })
  await handler({ job_name: `sean-ellis-${OWNER}`, owner_slug: OWNER, fired_at: now })

  const store = new SeanEllisStore(db)
  const row = store.latestForOwner(OWNER)!

  const writes: Array<{ path: string; contents: string }> = []
  const collector = new M2FeedbackCollector({
    db,
    telemetry,
    feedbackPath: join(tmp, 'M2-casey-week-4.md'),
    appendFile: (path, contents) => writes.push({ path, contents }),
    now: () => now + 5_000,
  })

  const result = await collector.recordResponse({
    owner_slug: OWNER,
    response_id: row.id,
    user_id: USER,
    response_kind: 'very_disappointed',
  })
  expect(result.appended_to_markdown).toBe(false)
  expect(writes.length).toBe(0)

  const updated = store.latestForOwner(OWNER)
  expect(updated?.response_kind).toBe('very_disappointed')
  expect(updated?.freeform_text).toBeNull()
})

test('buildSeanEllisJob name fits the 64-char cron-name budget for typical slugs', () => {
  const job = buildSeanEllisJob({ owner_slug: 'workspace-acme-launch-team-prod' })
  expect(job.name.length).toBeLessThanOrEqual(64)
  expect(job.handler).toBe('onboarding.sean_ellis_survey')
  expect(job.schedule.kind).toBe('interval_ms')
})

test('Codex r5 P1: handler stores the channel-delivered prompt_id, not the locally-built one', async () => {
  // When the channel adapter dedupes via idempotency_key, the returned
  // prompt_id may be the original previously-emitted one (not the
  // freshly-built one). The handler must persist the DELIVERED
  // prompt_id so the callback router can resolve it.
  const completed_at = 1_700_000_000_000
  await seedCompleted({ signup_at: completed_at - 30 * 60 * 1000, completed_at })

  const telemetry = new OnboardingTelemetry({ db })
  const DEDUP_PROMPT_ID = '11111111-1111-4111-8111-111111111111'
  const channel: SeanEllisChannel = {
    async emitPrompt(_input) {
      // Simulate channel-side dedup returning a different prompt_id.
      return { prompt_id: DEDUP_PROMPT_ID }
    },
  }
  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async () => ({ topic_id: TOPIC }),
    now: () => completed_at + FOUR_WEEKS_MS + 60 * 1000,
  })

  await handler({
    job_name: `sean-ellis-${OWNER}`,
    owner_slug: OWNER,
    fired_at: completed_at + FOUR_WEEKS_MS + 60 * 1000,
  })

  const store = new SeanEllisStore(db)
  const row = store.byPromptId(OWNER, DEDUP_PROMPT_ID)
  expect(row).not.toBeNull()
  expect(row?.prompt_id).toBe(DEDUP_PROMPT_ID)
})

test('Codex r2 P1: multi-user project — older eligible user is surveyed even when a newer user is in-window', async () => {
  // User A completed 5 weeks ago, user B completed 1 week ago. Codex r2's
  // example: under the prior implementation, the handler would see B
  // (most recent), skip "not_yet", and never survey A.
  const OWNER_W = 'workspace-project'
  const userA = 'user-a'
  const userB = 'user-b'
  const fiveWeeksAgo = 1_700_000_000_000
  const oneWeekAgo = fiveWeeksAgo + 4 * 7 * 24 * 60 * 60 * 1000
  const now_ts = oneWeekAgo + 7 * 24 * 60 * 60 * 1000 // == fiveWeeksAgo + 5 weeks

  // Seed both users completed onboardings.
  const telemetry = new OnboardingTelemetry({ db })
  for (const [user_id, completed_at] of [
    [userA, fiveWeeksAgo],
    [userB, oneWeekAgo],
  ] as const) {
    await telemetry.emit({
      owner_slug: OWNER_W,
      user_id,
      event: 'signup.started',
      payload: { via: 'tg' },
      ts: completed_at - 30 * 60 * 1000,
    })
    await telemetry.emit({
      owner_slug: OWNER_W,
      user_id,
      event: 'onboarding.completed',
      payload: { time_to_wow_ms: 1, total_dollars: 1, wow_actions_fired: [] },
      ts: completed_at,
    })
  }

  const channel = buildRecordingChannel()
  const handler = buildSeanEllisHandler({
    db,
    telemetry,
    channel,
    resolveContext: async (input) => ({ topic_id: `topic-${input.user_id}` }),
    now: () => now_ts,
  })

  const result = await handler({
    job_name: `sean-ellis-${OWNER_W}`,
    owner_slug: OWNER_W,
    fired_at: now_ts,
  })
  expect(result.status).toBe('ok')

  // userA (5 weeks past) was surveyed; userB (1 week past) was not.
  expect(channel.emitted.length).toBe(1)
  const store = new SeanEllisStore(db)
  const aRow = store.latestForUser(OWNER_W, userA)
  const bRow = store.latestForUser(OWNER_W, userB)
  expect(aRow?.user_id).toBe(userA)
  expect(bRow).toBeNull()

  // Per-user idempotency: a second tick at the same clock does NOT
  // re-emit to userA.
  const second = await handler({
    job_name: `sean-ellis-${OWNER_W}`,
    owner_slug: OWNER_W,
    fired_at: now_ts + 1000,
  })
  expect(second.status).toBe('skipped')
  expect(channel.emitted.length).toBe(1)
})
