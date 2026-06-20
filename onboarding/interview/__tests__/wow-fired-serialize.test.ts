/**
 * 2026-05-28 wow-cleanup sprint — Fix D.
 *
 * The wow-dispatcher must SERIALIZE actions that emit button prompts:
 * fire one, wait for the user to tap, fire the next. Sam's verbatim
 * feedback 2026-05-28: "Before I had time to answer the keep/drop
 * project list, immediately a several notifications appeared. They
 * should only come one at a time after the previous one is answered."
 *
 * Mechanism: the dispatcher accepts a `prompt_resolution_probe` that it
 * polls between prompt-emitting actions; the next action only fires
 * once the prior prompt is resolved (or times out). The dispatcher also
 * publishes its picked queue + the in-flight head to `on_pending_queue`
 * so observers (and a future engine-side resume hook) can see what is
 * queued.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { WowDispatcher, type PromptResolutionProbe } from '../../wow-moment/dispatcher.ts'
import { WowTelemetry } from '../../wow-moment/telemetry.ts'
import { ALWAYS_FIRE_FIRST, ALWAYS_FIRE_LAST } from '../../wow-moment/catalogue.ts'
import {
  buildContext,
  makeFixture,
  teardown,
  type TestFixture,
} from '../../wow-moment/__tests__/test-helpers.ts'
import type { LlmCallFn } from '../phase-spec-resolver.ts'
import type { WowActionId } from '../../wow-moment/telemetry.ts'
import type { ImportResult } from '../../history-import/types.ts'

let fix: TestFixture
beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function pickerReturning(pick: ReadonlyArray<WowActionId>): LlmCallFn {
  const explanations: Record<string, string> = {}
  for (const id of pick) explanations[id] = `picked ${id}`
  return async () => JSON.stringify({ pick, explanations })
}

function importFixture(): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [
      { name: 'Topline', rationale: '', suggested_topics: [] },
      { name: 'Acme', rationale: '', suggested_topics: [] },
    ],
    proposed_tasks: [
      { title: 'Reply to Priya', due_at: 1, priority_hint: 'P1' },
    ],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

/**
 * In-memory probe that records every waitFor call and only "resolves"
 * when the test calls `resolveNext(prompt_id)`. Lets a test assert
 * "only one prompt is emitted at a time" by sequencing resolutions.
 */
function makeGatedProbe(): {
  probe: PromptResolutionProbe
  resolveNext: (prompt_id: string) => void
  waited: string[]
} {
  const waited: string[] = []
  const waiters = new Map<string, () => void>()
  const probe: PromptResolutionProbe = {
    waitFor(prompt_id: string): Promise<'resolved' | 'timeout'> {
      waited.push(prompt_id)
      return new Promise((resolve) => {
        waiters.set(prompt_id, () => resolve('resolved'))
      })
    },
  }
  const resolveNext = (prompt_id: string): void => {
    const w = waiters.get(prompt_id)
    if (w === undefined) {
      throw new Error(`no pending waitFor for prompt_id ${prompt_id}`)
    }
    waiters.delete(prompt_id)
    w()
  }
  return { probe, resolveNext, waited }
}

describe('Fix D — wow-dispatcher serializes prompt-emitting actions one at a time', () => {
  test('with a gated probe, only the head prompt emits until resolved; next emits only after', async () => {
    const telemetry = new WowTelemetry({ db: fix.db })
    const sink: Array<{
      active_wow_action_id: WowActionId | null
      active_wow_prompt_id: string | null
      pending: ReadonlyArray<WowActionId>
    }> = []
    const { probe, resolveNext } = makeGatedProbe()
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep: async (): Promise<void> => undefined,
      inter_action_pause_ms: 1,
      prompt_resolution_probe: probe,
      serialize_prompt_timeout_ms: 60_000,
      on_pending_queue: (input) => {
        sink.push({
          active_wow_action_id: input.active_wow_action_id,
          active_wow_prompt_id: input.active_wow_prompt_id,
          pending: input.pending_wow_queue,
        })
      },
    })
    const baseCtx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam', non_work_interests: [{ name: 'climbing' }] },
      },
      import_result: importFixture(),
      captured_projects: [{ name: 'Topline' }, { name: 'Acme' }],
    })

    // Picker chooses two prompt-emitting actions in order. The
    // dispatch promise should NOT resolve until both prompts are
    // resolved + the brief runs.
    const dispatchPromise = dispatcher.dispatch({
      project_slug: baseCtx.project_slug,
      topic_id: baseCtx.topic_id,
      owner_home: baseCtx.owner_home,
      interview: baseCtx.interview,
      import_result: baseCtx.import_result,
      rituals: baseCtx.rituals,
      captured_projects: baseCtx.captured_projects,
      contemplative_keywords: baseCtx.contemplative_keywords,
      stalled_threads: baseCtx.stalled_threads,
      gmail_scopes: baseCtx.gmail_scopes,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: baseCtx.channel,
      gmail: baseCtx.gmail,
      picker_llm: pickerReturning(['06-interest-check-in', '04-overdue-task']),
    })

    // Yield to event loop a couple of times so 06's prompt emits + the
    // dispatcher parks in waitFor for it.
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    // After 07 fires (no prompt) + 06 fires (emits prompt #1), we
    // should see exactly ONE button prompt so far — the second action
    // has not fired because we have not resolved the first.
    expect(fix.channelCalls.prompts.length).toBe(1)
    const firstPrompt = fix.channelCalls.prompts[0]!.prompt
    // Resolve the first prompt. The dispatcher must now fire the
    // second prompt-emitting action.
    resolveNext(firstPrompt.prompt_id)

    // Wait for the second action's prompt to emit.
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(fix.channelCalls.prompts.length).toBeGreaterThanOrEqual(2)
    const secondPrompt = fix.channelCalls.prompts[1]!.prompt
    expect(secondPrompt.prompt_id).not.toBe(firstPrompt.prompt_id)

    // Resolve the second prompt so 01-first-week-brief runs and the
    // dispatch promise settles.
    resolveNext(secondPrompt.prompt_id)
    // 01 emits ITS own affordance prompt (Fix B); that prompt is the
    // last surface so we resolve it too if the probe parks on it. The
    // dispatcher publishes the brief's prompt id via on_pending_queue
    // but does NOT wait for it (the brief is the terminal action).
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    const out = await dispatchPromise
    expect(out.fired).toContain(ALWAYS_FIRE_FIRST)
    expect(out.fired).toContain(ALWAYS_FIRE_LAST)
    expect(out.fired).toContain('06-interest-check-in')
    expect(out.fired).toContain('04-overdue-task')
    expect(out.rescheduled).toBe(false)

    // Sink received the pending_wow_queue + head transitions.
    expect(sink.length).toBeGreaterThan(0)
    const pendingArrays = sink.map((s) => s.pending)
    // Every published queue ends with ALWAYS_FIRE_LAST.
    for (const q of pendingArrays) {
      expect(q[q.length - 1]).toBe(ALWAYS_FIRE_LAST)
    }
    // At least one publish should carry the in-flight action id for
    // each picked candidate.
    const seenHeads = sink.map((s) => s.active_wow_action_id).filter((x) => x !== null)
    expect(seenHeads).toContain('06-interest-check-in')
    expect(seenHeads).toContain('04-overdue-task')
  })

  test('without a probe wired, dispatcher preserves legacy fixed-pause behavior (back-compat)', async () => {
    // Sanity: when no `prompt_resolution_probe` is provided, the
    // dispatcher must NOT block forever — it falls back to the legacy
    // pause + freeform-ack pattern so callers that haven't migrated
    // still complete normally.
    const telemetry = new WowTelemetry({ db: fix.db })
    let sleepCount = 0
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep: async () => {
        sleepCount++
      },
      inter_action_pause_ms: 1,
      // intentionally no prompt_resolution_probe
    })
    const baseCtx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam', non_work_interests: [{ name: 'climbing' }] },
      },
      import_result: importFixture(),
      captured_projects: [{ name: 'Topline' }, { name: 'Acme' }],
    })
    const out = await dispatcher.dispatch({
      project_slug: baseCtx.project_slug,
      topic_id: baseCtx.topic_id,
      owner_home: baseCtx.owner_home,
      interview: baseCtx.interview,
      import_result: baseCtx.import_result,
      rituals: baseCtx.rituals,
      captured_projects: baseCtx.captured_projects,
      contemplative_keywords: baseCtx.contemplative_keywords,
      stalled_threads: baseCtx.stalled_threads,
      gmail_scopes: baseCtx.gmail_scopes,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: baseCtx.channel,
      gmail: baseCtx.gmail,
      picker_llm: pickerReturning(['06-interest-check-in', '04-overdue-task']),
    })
    expect(out.fired).toContain(ALWAYS_FIRE_FIRST)
    expect(out.fired).toContain(ALWAYS_FIRE_LAST)
    expect(sleepCount).toBeGreaterThan(0)
  })

  test('probe timeout reschedules remaining actions', async () => {
    const telemetry = new WowTelemetry({ db: fix.db })
    const rescheduleCalls: Array<{ remaining_actions: WowActionId[] }> = []
    const probe: PromptResolutionProbe = {
      async waitFor(): Promise<'resolved' | 'timeout'> {
        return 'timeout'
      },
    }
    const dispatcher = new WowDispatcher({
      telemetry,
      sleep: async (): Promise<void> => undefined,
      inter_action_pause_ms: 1,
      prompt_resolution_probe: probe,
      serialize_prompt_timeout_ms: 10,
      reschedule: async (input) => {
        rescheduleCalls.push({ remaining_actions: [...input.remaining_actions] })
      },
    })
    const baseCtx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam', non_work_interests: [{ name: 'climbing' }] },
      },
      import_result: importFixture(),
      captured_projects: [{ name: 'Topline' }, { name: 'Acme' }],
    })
    const out = await dispatcher.dispatch({
      project_slug: baseCtx.project_slug,
      topic_id: baseCtx.topic_id,
      owner_home: baseCtx.owner_home,
      interview: baseCtx.interview,
      import_result: baseCtx.import_result,
      rituals: baseCtx.rituals,
      captured_projects: baseCtx.captured_projects,
      contemplative_keywords: baseCtx.contemplative_keywords,
      stalled_threads: baseCtx.stalled_threads,
      gmail_scopes: baseCtx.gmail_scopes,
      reminders: fix.reminders,
      cron_jobs: fix.cron_jobs,
      cron_state: fix.cron_state,
      db: fix.db,
      channel: baseCtx.channel,
      gmail: baseCtx.gmail,
      picker_llm: pickerReturning(['06-interest-check-in', '04-overdue-task']),
    })
    expect(out.rescheduled).toBe(true)
    expect(rescheduleCalls.length).toBe(1)
    // Remaining = the un-fired picked action + the always-fire brief.
    expect(rescheduleCalls[0]!.remaining_actions).toContain(ALWAYS_FIRE_LAST)
  })
})
