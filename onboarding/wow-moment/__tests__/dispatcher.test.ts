/**
 * Dispatcher — P2 v2 flow (docs/plans/P2-onboarding-v2.md § 5.4):
 *
 *   ALWAYS fire 07-overnight-pass FIRST.
 *   LLM picker chooses 2-3 of (02, 03, 04, 05, 06-interest-check-in).
 *   ALWAYS fire 01-first-week-brief LAST.
 *
 * Per-action pause + freeform-pause + reschedule-on-keep-typing semantics
 * carry over unchanged from v1.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { WowDispatcher } from '../dispatcher.ts'
import { WowTelemetry } from '../telemetry.ts'
import { ALWAYS_FIRE_FIRST, ALWAYS_FIRE_LAST, CANDIDATE_IDS } from '../catalogue.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from './test-helpers.ts'
import type { FreeformProbe } from '../dispatcher.ts'
import type { LlmCallFn } from '../../interview/phase-spec-resolver.ts'
import type { WowActionId } from '../telemetry.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})

afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function pickerReturning(pick: ReadonlyArray<WowActionId>, extra: Record<string, string> = {}): LlmCallFn {
  const explanations: Record<string, string> = { ...extra }
  for (const id of pick) {
    if (!(id in explanations)) explanations[id] = `picked ${id}`
  }
  return async () => JSON.stringify({ pick, explanations })
}

function failingPicker(): LlmCallFn {
  return async () => {
    throw new Error('picker-substrate-down')
  }
}

describe('WowDispatcher (P2 v2)', () => {
  test('happy path: 07 first → 2 picked middle → 01 last; selection telemetry fires', async () => {
    const sleepCalls: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
    }
    const telemetry = new WowTelemetry({ db: fix.db })
    const selectionCalls: Array<{
      project_slug: string
      picks: ReadonlyArray<string>
      fallback_used: boolean
    }> = []
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep,
      inter_action_pause_ms: 5_000,
      on_selection: (s) => {
        selectionCalls.push({
          project_slug: s.project_slug,
          picks: s.picks,
          fallback_used: s.fallback_used,
        })
      },
    })
    const ctx = buildContext(fix)
    const out = await dispatcher.dispatch({
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      owner_home: ctx.owner_home,
      interview: ctx.interview,
      import_result: ctx.import_result,
      rituals: ctx.rituals,
      captured_projects: ctx.captured_projects,
      contemplative_keywords: ctx.contemplative_keywords,
      stalled_threads: ctx.stalled_threads,
      gmail_scopes: ctx.gmail_scopes,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: ctx.channel,
      gmail: ctx.gmail,
      picker_llm: pickerReturning(['03-project-shells', '04-overdue-task']),
    })

    // Two middle picks → three inter-action pauses (after 07, between
    // the two middle picks, and after the last middle pick before 01).
    expect(sleepCalls.length).toBe(3)
    for (const ms of sleepCalls) expect(ms).toBe(5_000)

    // 07 ran first, 01 ran last, both picked middle actions ran.
    const rows = telemetry.list(ctx.project_slug)
    expect(rows.map((r) => r.action_id)).toEqual([
      ALWAYS_FIRE_FIRST,
      '03-project-shells',
      '04-overdue-task',
      ALWAYS_FIRE_LAST,
    ])

    // Selection telemetry fired once with the picker output.
    expect(selectionCalls.length).toBe(1)
    expect(selectionCalls[0]?.picks).toEqual(['03-project-shells', '04-overdue-task'])
    expect(selectionCalls[0]?.fallback_used).toBe(false)

    // Outcome carries the selection.
    expect(out.selection.pick).toEqual(['03-project-shells', '04-overdue-task'])
    expect(out.selection.is_fallback).toBe(false)
    expect(out.rescheduled).toBe(false)
  })

  test('picker LLM error → deterministic fallback over CANDIDATE_IDS (capped at 3); selection marked is_fallback', async () => {
    const sleep = async (): Promise<void> => undefined
    const telemetry = new WowTelemetry({ db: fix.db })
    const selectionCalls: Array<{ fallback_used: boolean; picks: ReadonlyArray<string> }> = []
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep,
      inter_action_pause_ms: 0,
      on_selection: (s) => {
        selectionCalls.push({ fallback_used: s.fallback_used, picks: s.picks })
      },
    })
    // Fixture with overrides that trip multiple predicates so the
    // fallback path has candidates to pick.
    const ctx = buildContext(fix, {
      rituals: [{ kind: 'morning', label: 'meditation', time_of_day: '06:30' }],
      captured_projects: [{ name: 'A' }, { name: 'B' }],
      interview: {
        phase_state_json: {
          non_work_interests: [{ name: 'climbing', cadence_hint: 'weekly' }],
        },
      },
    })
    const out = await dispatcher.dispatch({
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      owner_home: ctx.owner_home,
      interview: ctx.interview,
      import_result: null,
      rituals: ctx.rituals,
      captured_projects: ctx.captured_projects,
      contemplative_keywords: [],
      stalled_threads: [],
      gmail_scopes: null,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: ctx.channel,
      gmail: null,
      picker_llm: failingPicker(),
    })
    expect(out.selection.is_fallback).toBe(true)
    expect(out.selection.pick.length).toBeLessThanOrEqual(3)
    // Every fallback pick is a CANDIDATE_IDS member.
    for (const id of out.selection.pick) {
      expect(CANDIDATE_IDS).toContain(id)
    }
    expect(selectionCalls.length).toBe(1)
    expect(selectionCalls[0]?.fallback_used).toBe(true)
  })

  test('picker LLM invalid JSON → fallback path', async () => {
    const sleep = async (): Promise<void> => undefined
    const telemetry = new WowTelemetry({ db: fix.db })
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep,
      inter_action_pause_ms: 0,
    })
    const ctx = buildContext(fix, {
      rituals: [{ kind: 'morning', label: 'meditation', time_of_day: '06:30' }],
    })
    const out = await dispatcher.dispatch({
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      owner_home: ctx.owner_home,
      interview: ctx.interview,
      import_result: null,
      rituals: ctx.rituals,
      captured_projects: [],
      contemplative_keywords: [],
      stalled_threads: [],
      gmail_scopes: null,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: ctx.channel,
      gmail: null,
      picker_llm: async () => 'this is not json',
    })
    expect(out.selection.is_fallback).toBe(true)
  })

  test('freeform inbound after 07 triggers ack + 60s pause', async () => {
    let callCount = 0
    const probe: FreeformProbe = {
      hasInbound(): boolean {
        callCount += 1
        return callCount === 1
      },
      async acknowledge(): Promise<void> {
        // no-op
      },
    }
    const sleepCalls: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
    }
    const telemetry = new WowTelemetry({ db: fix.db })
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep,
      freeform_probe: probe,
      inter_action_pause_ms: 5_000,
      freeform_pause_ms: 60_000,
    })
    const ctx = buildContext(fix)
    await dispatcher.dispatch({
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      owner_home: ctx.owner_home,
      interview: ctx.interview,
      import_result: null,
      rituals: [],
      captured_projects: [],
      contemplative_keywords: [],
      stalled_threads: [],
      gmail_scopes: null,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: ctx.channel,
      gmail: null,
      picker_llm: pickerReturning(['03-project-shells', '04-overdue-task']),
    })
    // At least one freeform-pause hop landed.
    expect(sleepCalls.filter((ms) => ms === 60_000).length).toBeGreaterThanOrEqual(1)
  })

  test('user keeps typing past 60s window → reschedule fires + dispatch returns early', async () => {
    const probe: FreeformProbe = {
      hasInbound(): boolean {
        return true
      },
      async acknowledge(): Promise<void> {
        // no-op
      },
    }
    const rescheduleCalls: Array<{
      project_slug: string
      remaining_actions: WowActionId[]
      reason: string
    }> = []
    const sleep = async (): Promise<void> => undefined
    const telemetry = new WowTelemetry({ db: fix.db })
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep,
      freeform_probe: probe,
      reschedule: async (input) => {
        rescheduleCalls.push({
          project_slug: input.project_slug,
          remaining_actions: [...input.remaining_actions],
          reason: input.reason,
        })
      },
    })
    const ctx = buildContext(fix)
    const out = await dispatcher.dispatch({
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      owner_home: ctx.owner_home,
      interview: ctx.interview,
      import_result: null,
      rituals: [],
      captured_projects: [],
      contemplative_keywords: [],
      stalled_threads: [],
      gmail_scopes: null,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: ctx.channel,
      gmail: null,
      picker_llm: pickerReturning(['03-project-shells', '04-overdue-task']),
    })
    expect(out.rescheduled).toBe(true)
    expect(rescheduleCalls.length).toBe(1)
    expect(rescheduleCalls[0]?.project_slug).toBe('t1')
    expect(rescheduleCalls[0]?.reason).toBe('kept_typing')
    // Reschedule fires after 07, so the picked middle (2) + 01 (1) = 3 remaining.
    expect(rescheduleCalls[0]?.remaining_actions).toEqual([
      '03-project-shells',
      '04-overdue-task',
      ALWAYS_FIRE_LAST,
    ])
  })

  test('explanation threaded through fired-event payload (per-pick rationale lands in wow_events)', async () => {
    const sleep = async (): Promise<void> => undefined
    const telemetry = new WowTelemetry({ db: fix.db })
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep,
      inter_action_pause_ms: 0,
    })
    const ctx = buildContext(fix, {
      rituals: [{ kind: 'morning', label: 'meditation', time_of_day: '06:30' }],
    })
    await dispatcher.dispatch({
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      owner_home: ctx.owner_home,
      interview: ctx.interview,
      import_result: null,
      rituals: ctx.rituals,
      captured_projects: [],
      contemplative_keywords: [],
      stalled_threads: [],
      gmail_scopes: null,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: ctx.channel,
      gmail: null,
      picker_llm: pickerReturning(['02-lifestyle-reminders', '04-overdue-task'], {
        '02-lifestyle-reminders': 'morning ritual captured - schedule the first beat',
        '04-overdue-task': 'no overdue but pick anyway',
      }),
    })
    const rows = telemetry.list(ctx.project_slug)
    const lifestyle = rows.find((r) => r.action_id === '02-lifestyle-reminders')
    expect(lifestyle).toBeDefined()
    expect((lifestyle!.redacted_payload['explanation'] as string)).toBe(
      'morning ritual captured - schedule the first beat',
    )
  })
})
