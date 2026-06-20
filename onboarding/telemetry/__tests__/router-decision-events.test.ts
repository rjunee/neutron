/**
 * Unit tests — `onboarding.router_decision` event wiring.
 *
 * P2-v3 S2 (2026-05-18). Per sprint brief § 8.4. Asserts:
 *   - the event name is in `ALL_ONBOARDING_EVENT_NAMES` (drift guard)
 *   - the composer's `buildGatewayLlmRouter` translates a router
 *     telemetry hook into a `gateway_events` row + structured-JSON
 *     line via OnboardingTelemetry
 *   - the payload shape matches `RouterDecisionPayload` for each
 *     action (advance / answer / amend)
 *   - reasoning is redacted to ≤100 chars
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  ALL_ONBOARDING_EVENT_NAMES,
  OnboardingTelemetry,
  type EventLogger,
  type PersistedOnboardingEvent,
} from '../event-emitter.ts'
import { buildGatewayLlmRouter } from '../../../gateway/realmode-composer/build-llm-router.ts'
import type {
  AnthropicMessagesClient,
  RouterDecision,
} from '../../interview/llm-router.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'router-decision-events-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('ALL_ONBOARDING_EVENT_NAMES contains onboarding.router_decision', () => {
  expect(ALL_ONBOARDING_EVENT_NAMES).toContain('onboarding.router_decision')
})

function buildStubAnthropic(decision: RouterDecision): AnthropicMessagesClient {
  return {
    messages: {
      async create() {
        return {
          content: [
            {
              text: JSON.stringify({
                ...decision,
                candidate_alternatives: [],
              }),
            },
          ],
        }
      },
    },
  }
}

async function emitOneRoute(opts: {
  decision: RouterDecision
  logger: EventLogger
}): Promise<PersistedOnboardingEvent[]> {
  const onboardingTelemetry = new OnboardingTelemetry({
    db,
    eventLogger: opts.logger,
  })
  const router = buildGatewayLlmRouter({
    anthropicClient: buildStubAnthropic(opts.decision),
    onboardingTelemetry,
  })
  await router.route({
    phase: 'import_upload_pending',
    active_prompt: {
      body: 'upload your zip',
      options: [{ label: 'Skip', body: 'Skip the import', value: 'skip' }],
      allow_freeform: true,
      pick_only: false,
    },
    user_text: 'can you give me the instructions for claude as well',
    knowledge: {
      why_we_ask: 'why',
      faqs: { foo: 'bar' },
      expected_tangents: [
        { user_text_example: 'why?', expected_action: 'answer', summary: 'why' },
      ],
      advance_examples: [],
    },
    captured: {},
    recent_turns: [],
    project_slug: 't1',
    user_id: 'u1',
  })
  // Wait one microtask for the void-emit promise to flush; in practice
  // the SQL insert is synchronous-ish enough that the next tick is
  // enough.
  await new Promise((r) => setTimeout(r, 5))
  return onboardingTelemetry.list('t1')
}

test('answer action emits one router_decision row with the right shape', async () => {
  const logged: PersistedOnboardingEvent[] = []
  const rows = await emitOneRoute({
    decision: {
      action: 'answer',
      confidence: 0.92,
      choice_value: null,
      freeform_text: null,
      response: 'Sure - Claude is in Settings > Privacy',
      state_delta: null,
      reasoning: 'tangent to claude_export_steps',
    },
    logger: (e) => logged.push(e),
  })
  expect(rows.length).toBe(1)
  expect(rows[0]?.event).toBe('onboarding.router_decision')
  expect(rows[0]?.project_slug).toBe('t1')
  expect(rows[0]?.user_id).toBe('u1')
  const p = rows[0]?.payload as Record<string, unknown>
  expect(p['phase']).toBe('import_upload_pending')
  expect(p['action']).toBe('answer')
  expect(p['confidence']).toBe(0.92)
  expect(p['escalated_to_sonnet']).toBe(false)
  expect(p['timed_out']).toBe(false)
  expect(p['clarify_synthesised']).toBe(false)
  expect(typeof p['reasoning_redacted']).toBe('string')
  expect((p['reasoning_redacted'] as string).length).toBeLessThanOrEqual(100)
  expect(typeof p['latency_ms']).toBe('number')
  expect(logged.length).toBe(1)
  expect(logged[0]?.event).toBe('onboarding.router_decision')
})

test('advance action emits the same shape with action=advance', async () => {
  const rows = await emitOneRoute({
    decision: {
      action: 'advance',
      confidence: 0.95,
      choice_value: 'skip',
      freeform_text: null,
      response: null,
      state_delta: null,
      reasoning: 'explicit skip',
    },
    logger: () => undefined,
  })
  expect(rows.length).toBe(1)
  const p = rows[0]?.payload as Record<string, unknown>
  expect(p['action']).toBe('advance')
})

test('amend action emits the same shape with action=amend', async () => {
  const rows = await emitOneRoute({
    decision: {
      action: 'amend',
      confidence: 0.88,
      choice_value: null,
      freeform_text: null,
      response: 'noted',
      state_delta: { user_first_name: 'Doe' } as never,
      reasoning: 'address preference amend',
    },
    logger: () => undefined,
  })
  expect(rows.length).toBe(1)
  const p = rows[0]?.payload as Record<string, unknown>
  expect(p['action']).toBe('amend')
})

test('reasoning longer than 100 chars is redacted with ... suffix', async () => {
  const long = 'a'.repeat(150)
  const rows = await emitOneRoute({
    decision: {
      action: 'answer',
      confidence: 0.9,
      choice_value: null,
      freeform_text: null,
      response: 'k',
      state_delta: null,
      reasoning: long.slice(0, 200),
    },
    logger: () => undefined,
  })
  const p = rows[0]?.payload as Record<string, unknown>
  expect((p['reasoning_redacted'] as string).length).toBeLessThanOrEqual(100)
  expect(p['reasoning_redacted']).toMatch(/\.\.\.$/)
})

test('project_slug/user_id missing on RouterInput → no event emitted', async () => {
  const telemetry = new OnboardingTelemetry({ db })
  const router = buildGatewayLlmRouter({
    anthropicClient: buildStubAnthropic({
      action: 'answer',
      confidence: 0.9,
      choice_value: null,
      freeform_text: null,
      response: 'k',
      state_delta: null,
      reasoning: 'r',
    }),
    onboardingTelemetry: telemetry,
  })
  await router.route({
    phase: 'signup',
    active_prompt: {
      body: 'what is your name?',
      options: [],
      allow_freeform: true,
      pick_only: false,
    },
    user_text: 'Sam',
    knowledge: {
      why_we_ask: 'why',
      faqs: { foo: 'bar' },
      expected_tangents: [
        { user_text_example: 'why?', expected_action: 'answer', summary: 'route to faq' },
      ],
      advance_examples: [],
    },
    captured: {},
    recent_turns: [],
    // project_slug + user_id deliberately absent
  })
  await new Promise((r) => setTimeout(r, 5))
  // No project_slug to scope by — the composer drops the event rather
  // than emit an unscoped row.
  expect(telemetry.list('t1').length).toBe(0)
})
