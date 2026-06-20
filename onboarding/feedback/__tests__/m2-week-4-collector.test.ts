/**
 * Unit tests — onboarding/feedback/m2-week-4-collector (P2 S6).
 *
 * Per docs/plans/P2-onboarding.md § 9.4 + § 6 S6 line 2187.
 *
 * Asserts:
 *   - the collector NEVER overwrites the existing M2-casey-week-4.md file
 *     (append-only across multiple recordResponse calls)
 *   - [A] / [C] taps without freeform skip the markdown append
 *   - the response_kind + freeform_text update lands in
 *     `sean_ellis_responses` and the `onboarding.sean_ellis_response`
 *     telemetry event is emitted
 *   - the markdown entry shape includes ISO timestamp + project_slug +
 *     response_kind + the freeform body
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { OnboardingTelemetry } from '../../telemetry/event-emitter.ts'
import { SeanEllisStore } from '../../telemetry/sean-ellis-trigger.ts'
import {
  M2FeedbackCollector,
  formatMarkdownEntry,
  routeSeanEllisChoice,
} from '../m2-week-4-collector.ts'
import type { ButtonChoice } from '../../../channels/button-primitive.ts'
// readFileSync is already imported by the file's existing tests


let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'm2-collector-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedOpenRow(): Promise<{ id: string }> {
  const store = new SeanEllisStore(db)
  return await store.insertOpen({
    project_slug: 'casey',
    user_id: 'u-casey',
    prompt_emitted_at: 1_700_000_000_000,
  })
}

test('appends to the markdown file (append-only) on [B] freeform; never overwrites', async () => {
  const feedbackPath = join(tmp, 'M2-casey-week-4.md')
  const telemetry = new OnboardingTelemetry({ db })

  const { id: id1 } = await seedOpenRow()
  const collector = new M2FeedbackCollector({ db, telemetry, feedbackPath })
  await collector.recordResponse({
    project_slug: 'casey',
    response_id: id1,
    user_id: 'u-casey',
    response_kind: 'somewhat_disappointed',
    freeform_text: 'first response',
  })
  expect(existsSync(feedbackPath)).toBe(true)
  const afterFirst = readFileSync(feedbackPath, 'utf8')
  expect(afterFirst).toContain('first response')

  // Second response tap on a fresh open row appends; first response not
  // overwritten.
  const { id: id2 } = await seedOpenRow()
  await collector.recordResponse({
    project_slug: 'casey',
    response_id: id2,
    user_id: 'u-casey',
    response_kind: 'somewhat_disappointed',
    freeform_text: 'second response',
  })
  const afterSecond = readFileSync(feedbackPath, 'utf8')
  expect(afterSecond).toContain('first response')
  expect(afterSecond).toContain('second response')
  expect(afterSecond.length).toBeGreaterThan(afterFirst.length)
})

test('[A] tap (very_disappointed) without freeform records but does NOT append markdown', async () => {
  const feedbackPath = join(tmp, 'M2-casey-week-4.md')
  const telemetry = new OnboardingTelemetry({ db })

  const { id } = await seedOpenRow()
  const collector = new M2FeedbackCollector({ db, telemetry, feedbackPath })
  const out = await collector.recordResponse({
    project_slug: 'casey',
    response_id: id,
    user_id: 'u-casey',
    response_kind: 'very_disappointed',
  })
  expect(out.appended_to_markdown).toBe(false)
  expect(existsSync(feedbackPath)).toBe(false)

  const store = new SeanEllisStore(db)
  const row = store.latestForOwner('casey')
  expect(row?.response_kind).toBe('very_disappointed')
  expect(row?.freeform_text).toBeNull()

  const events = telemetry
    .list('casey')
    .filter((e) => e.event === 'onboarding.sean_ellis_response')
  expect(events.length).toBe(1)
  expect(events[0]?.payload.response).toBe('very_disappointed')
})

test('M2_FEEDBACK_PATH env override redirects the destination', async () => {
  const customPath = join(tmp, 'custom-feedback.md')
  const previous = process.env.M2_FEEDBACK_PATH
  try {
    process.env.M2_FEEDBACK_PATH = customPath
    const telemetry = new OnboardingTelemetry({ db })
    const { id } = await seedOpenRow()
    const collector = new M2FeedbackCollector({ db, telemetry })
    await collector.recordResponse({
      project_slug: 'casey',
      response_id: id,
      user_id: 'u-casey',
      response_kind: 'somewhat_disappointed',
      freeform_text: 'env-routed',
    })
    expect(existsSync(customPath)).toBe(true)
    expect(readFileSync(customPath, 'utf8')).toContain('env-routed')
  } finally {
    if (previous === undefined) delete process.env.M2_FEEDBACK_PATH
    else process.env.M2_FEEDBACK_PATH = previous
  }
})

test('formatMarkdownEntry shape includes ISO ts + project_slug + response_kind', () => {
  const entry = formatMarkdownEntry({
    project_slug: 'casey',
    response_kind: 'somewhat_disappointed',
    freeform_text: 'helpful feedback',
    timestamp_ms: 1_700_000_000_000,
  })
  expect(entry).toContain('---')
  expect(entry).toContain('casey')
  expect(entry).toContain('somewhat_disappointed')
  expect(entry).toContain('helpful feedback')
  expect(entry).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
})

test('routeSeanEllisChoice maps SEAN_ELLIS option values to canonical response_kinds', async () => {
  const feedbackPath = join(tmp, 'M2-casey-week-4.md')
  const telemetry = new OnboardingTelemetry({ db })
  const collector = new M2FeedbackCollector({ db, telemetry, feedbackPath })

  const buildChoice = (choice_value: string): ButtonChoice => ({
    prompt_id: '00000000-0000-4000-8000-000000000000',
    choice_value,
    chosen_at: 1_700_000_001_000,
    speaker_user_id: 'u-casey',
    channel_kind: 'telegram',
  })

  // [A] very_disappointed → finalized immediately (no follow-up
  // freeform expected for the [A] tap).
  const { id: id1 } = await seedOpenRow()
  const out1 = await routeSeanEllisChoice(collector, {
    project_slug: 'casey',
    user_id: 'u-casey',
    response_id: id1,
    choice: buildChoice('very_disappointed'),
  })
  expect(out1.kind).toBe('finalized')
  if (out1.kind === 'finalized') {
    expect(out1.result.appended_to_markdown).toBe(false)
  }

  // [B] somewhat_disappointed + freeform on the same inbound →
  // finalized immediately (channel can deliver tap + freeform together).
  const { id: id2 } = await seedOpenRow()
  const out2 = await routeSeanEllisChoice(collector, {
    project_slug: 'casey',
    user_id: 'u-casey',
    response_id: id2,
    choice: buildChoice('somewhat_disappointed'),
    freeform_text: 'really helpful',
  })
  expect(out2.kind).toBe('finalized')
  if (out2.kind === 'finalized') {
    expect(out2.result.appended_to_markdown).toBe(true)
  }

  // Unknown choice value → unknown_choice; the row stays open.
  const { id: id3 } = await seedOpenRow()
  const out3 = await routeSeanEllisChoice(collector, {
    project_slug: 'casey',
    user_id: 'u-casey',
    response_id: id3,
    choice: buildChoice('not_an_option'),
  })
  expect(out3.kind).toBe('unknown_choice')
})

test('Codex r4 P1: [B] tap without freeform parks pending; freeform follow-up finalizes', async () => {
  const feedbackPath = join(tmp, 'M2-casey-week-4.md')
  const telemetry = new OnboardingTelemetry({ db })
  const collector = new M2FeedbackCollector({ db, telemetry, feedbackPath })

  const { id } = await seedOpenRow()
  // [B] tapped, no freeform yet → pending.
  const tapOutcome = await routeSeanEllisChoice(collector, {
    project_slug: 'casey',
    user_id: 'u-casey',
    response_id: id,
    choice: {
      prompt_id: '00000000-0000-4000-8000-000000000000',
      choice_value: 'somewhat_disappointed',
      chosen_at: 1_700_000_001_000,
      speaker_user_id: 'u-casey',
      channel_kind: 'telegram',
    },
  })
  expect(tapOutcome.kind).toBe('pending')

  const store = new SeanEllisStore(db)
  const afterTap = store.byId({ project_slug: 'casey', id })
  expect(afterTap?.response_kind).toBe('no_response')
  expect(afterTap?.responded_at).toBeNull()
  expect(afterTap?.pending_response_kind).toBe('somewhat_disappointed')

  // Markdown NOT appended yet.
  expect(existsSync(feedbackPath)).toBe(false)

  // Freeform follow-up arrives — finalize.
  const finalizeResult = await collector.applyFreeformFollowUp({
    project_slug: 'casey',
    user_id: 'u-casey',
    freeform_text: 'the import felt magical but onboarding ran a bit long',
  })
  expect(finalizeResult).not.toBeNull()
  expect(finalizeResult?.appended_to_markdown).toBe(true)

  const final = store.byId({ project_slug: 'casey', id })
  expect(final?.response_kind).toBe('somewhat_disappointed')
  expect(final?.responded_at).not.toBeNull()
  expect(final?.freeform_text).toBe('the import felt magical but onboarding ran a bit long')
  expect(final?.pending_response_kind).toBeNull()
  expect(readFileSync(feedbackPath, 'utf8')).toContain('the import felt magical')
})

test('Codex r5 P2: telemetry event still fires when markdown append throws', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const collector = new M2FeedbackCollector({
    db,
    telemetry,
    feedbackPath: join(tmp, 'M2-casey-week-4.md'),
    appendFile: () => {
      throw new Error('synthetic disk full')
    },
  })

  const { id } = await seedOpenRow()
  await expect(
    collector.recordResponse({
      project_slug: 'casey',
      response_id: id,
      user_id: 'u-casey',
      response_kind: 'somewhat_disappointed',
      freeform_text: 'feedback that should still telemeter',
    }),
  ).rejects.toThrow(/synthetic disk full/)

  // The telemetry event landed BEFORE the markdown append failed. The
  // SQL row also updated.
  const events = telemetry
    .list('casey')
    .filter((e) => e.event === 'onboarding.sean_ellis_response')
  expect(events.length).toBe(1)
  expect(events[0]?.payload.response).toBe('somewhat_disappointed')

  const store = new SeanEllisStore(db)
  const row = store.byId({ project_slug: 'casey', id })
  expect(row?.response_kind).toBe('somewhat_disappointed')
  expect(row?.responded_at).not.toBeNull()
})

test('applyFreeformFollowUp returns null when no pending row exists', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const collector = new M2FeedbackCollector({
    db,
    telemetry,
    feedbackPath: join(tmp, 'M2-casey-week-4.md'),
  })
  const result = await collector.applyFreeformFollowUp({
    project_slug: 'casey',
    user_id: 'u-casey',
    freeform_text: 'unbound text',
  })
  expect(result).toBeNull()
})

test('empty / whitespace-only freeform_text does NOT trigger markdown append', async () => {
  const feedbackPath = join(tmp, 'M2-casey-week-4.md')
  const telemetry = new OnboardingTelemetry({ db })
  const { id } = await seedOpenRow()
  const collector = new M2FeedbackCollector({ db, telemetry, feedbackPath })
  const out = await collector.recordResponse({
    project_slug: 'casey',
    response_id: id,
    user_id: 'u-casey',
    response_kind: 'somewhat_disappointed',
    freeform_text: '   \n\t',
  })
  expect(out.appended_to_markdown).toBe(false)
  expect(existsSync(feedbackPath)).toBe(false)
})
