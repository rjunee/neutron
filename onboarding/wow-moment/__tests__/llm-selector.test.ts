/**
 * Unit tests for `onboarding/wow-moment/llm-selector.ts`.
 *
 * Per docs/plans/P2-onboarding-v2.md § 5.3 + § 9.8.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { pickWowActions, _setCachedSystemPromptForTests } from '../llm-selector.ts'
import type { WowSelectorInput } from '../llm-selector.ts'
import { CANDIDATE_IDS, getActionModule } from '../catalogue.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from './test-helpers.ts'
import type { LlmCallFn } from '../../interview/phase-spec-resolver.ts'
import type { WowActionId } from '../telemetry.ts'

let fix: TestFixture
beforeEach(() => {
  fix = makeFixture()
  _setCachedSystemPromptForTests('# wow-action-picker (test stub)\n')
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
  _setCachedSystemPromptForTests(null)
})

function baseInput(overrides: Partial<WowSelectorInput> = {}): WowSelectorInput {
  return {
    project_slug: 't1',
    collected_data: {
      user_first_name: 'Casey',
      primary_projects: ['Acme', 'Topline'],
      non_work_interests: [{ name: 'painting', cadence_hint: 'weekly' }],
      rituals: ['morning meditation @ 06:30'],
    },
    import_result: null,
    candidates: CANDIDATE_IDS,
    ...overrides,
  }
}

function fixtureCandidateModules(): Record<string, ReturnType<typeof getActionModule>> {
  const out: Record<string, ReturnType<typeof getActionModule>> = {}
  for (const id of CANDIDATE_IDS) out[id] = getActionModule(id)
  return out
}

describe('pickWowActions', () => {
  test('happy path: LLM returns 2 valid picks → result.pick matches; not fallback', async () => {
    const llm: LlmCallFn = async () =>
      JSON.stringify({
        pick: ['03-project-shells', '06-interest-check-in'],
        explanations: {
          '03-project-shells': '2 projects from import',
          '06-interest-check-in': 'painting weekly',
        },
      })
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.pick).toEqual(['03-project-shells', '06-interest-check-in'])
    expect(out.is_fallback).toBe(false)
    expect(out.explanations['03-project-shells']).toBe('2 projects from import')
  })

  test('LLM returns 3 valid picks', async () => {
    const llm: LlmCallFn = async () =>
      JSON.stringify({
        pick: ['03-project-shells', '04-overdue-task', '06-interest-check-in'],
        explanations: {},
      })
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.pick.length).toBe(3)
    expect(out.is_fallback).toBe(false)
  })

  test('LLM returns >3 picks → capped at 3', async () => {
    const llm: LlmCallFn = async () =>
      JSON.stringify({
        pick: [
          '02-lifestyle-reminders',
          '03-project-shells',
          '04-overdue-task',
          '05-followup-email-draft',
        ],
        explanations: {},
      })
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.pick.length).toBe(3)
    expect(out.is_fallback).toBe(false)
  })

  test('LLM returns 1 pick → fails validation → fallback path', async () => {
    const llm: LlmCallFn = async () =>
      JSON.stringify({ pick: ['03-project-shells'], explanations: {} })
    const ctx = buildContext(fix, {
      rituals: [{ kind: 'morning', label: 'meditation', time_of_day: '06:30' }],
      captured_projects: [{ name: 'A' }, { name: 'B' }],
    })
    const out = await pickWowActions(baseInput(), {
      llm,
      fallback_ctx: ctx,
      candidate_modules: fixtureCandidateModules(),
    })
    expect(out.is_fallback).toBe(true)
    // Fallback picks ≥2 from CANDIDATE_IDS whose predicates fire.
    expect(out.pick.length).toBeGreaterThanOrEqual(1)
  })

  test('LLM returns an id not in candidates → fallback path', async () => {
    const llm: LlmCallFn = async () =>
      JSON.stringify({
        pick: ['03-project-shells', '99-not-real'],
        explanations: {},
      })
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.is_fallback).toBe(true)
  })

  test('LLM throws → fallback path', async () => {
    const llm: LlmCallFn = async () => {
      throw new Error('substrate down')
    }
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.is_fallback).toBe(true)
  })

  test('LLM returns unparseable JSON → fallback path', async () => {
    const llm: LlmCallFn = async () => 'not json'
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.is_fallback).toBe(true)
  })

  test('LLM wraps JSON in code fences → still parses', async () => {
    const llm: LlmCallFn = async () =>
      '```json\n{"pick":["02-lifestyle-reminders","06-interest-check-in"],"explanations":{}}\n```'
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.pick).toEqual(['02-lifestyle-reminders', '06-interest-check-in'])
    expect(out.is_fallback).toBe(false)
  })

  test('LLM call exceeds timeout → fallback path', async () => {
    const llm: LlmCallFn = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('{"pick":["02-lifestyle-reminders","06-interest-check-in"]}'), 200)
      })
    const out = await pickWowActions(baseInput(), { llm, timeout_ms: 50 })
    expect(out.is_fallback).toBe(true)
  })

  test('LLM removes duplicates in pick before validating min length', async () => {
    const llm: LlmCallFn = async () =>
      JSON.stringify({
        pick: ['03-project-shells', '03-project-shells'],
        explanations: {},
      })
    const out = await pickWowActions(baseInput(), { llm })
    // dedup → 1 item → fails min_picks=2 → fallback path.
    expect(out.is_fallback).toBe(true)
  })

  test('fallback path with no fallback_ctx or modules → empty pick', async () => {
    const llm: LlmCallFn = async () => 'not json'
    const out = await pickWowActions(baseInput(), { llm })
    expect(out.is_fallback).toBe(true)
    expect(out.pick).toEqual([])
  })

  test('import_result is summarized into the user payload', async () => {
    const seen: { system?: string; user?: string } = {}
    const llm: LlmCallFn = async (input) => {
      seen.system = input.system
      seen.user = input.user
      return JSON.stringify({
        pick: ['03-project-shells', '06-interest-check-in'],
        explanations: {},
      })
    }
    await pickWowActions(
      baseInput({
        import_result: {
          entities: [],
          topics: [],
          proposed_projects: [
            { name: 'A', rationale: 'r', suggested_topics: [] },
            { name: 'B', rationale: 'r', suggested_topics: [] },
          ],
          proposed_tasks: [
            { title: 't1', due_at: Date.now() - 100 },
            { title: 't2' },
          ],
          proposed_reminders: [],
          voice_signals: { tone: 'expansive', verbosity: 'medium' },
          facts: {},
          inferred_interests: [{ name: 'x' }],
        },
      }),
      { llm },
    )
    expect(seen.user).toBeDefined()
    const payload = JSON.parse(seen.user!)
    expect(payload.import_summary.proposed_project_count).toBe(2)
    expect(payload.import_summary.proposed_task_count).toBe(2)
    expect(payload.import_summary.overdue_task_count).toBe(1)
    expect(payload.import_summary.inferred_interest_count).toBe(1)
  })
})
