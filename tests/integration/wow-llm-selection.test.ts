/**
 * Integration test — wow-moment LLM-selection (P2 v2 § 5.3 + § 5.4).
 *
 * Walks the dispatcher with a mocked LLM picker across every failure
 * mode the spec promises a fallback for:
 *
 *   - happy path → picks land in fired[] in returned order
 *   - LLM error → fallback to deterministic predicates
 *   - invalid pick → fallback
 *   - non_work_interests present + LLM picks 06 → reminder row landed +
 *     scheduled with weekly cadence
 *   - catalogue invariant: id 06 = interest-check-in (NOT dharma-reframe)
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronStateStore } from '@neutronai/cron/state.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import {
  ALWAYS_FIRE_FIRST,
  ALWAYS_FIRE_LAST,
  CANDIDATE_IDS,
  WowDispatcher,
  WowTelemetry,
  getActionModule,
} from '@neutronai/onboarding/wow-moment/index.ts'
import type {
  CapturedProject,
  GmailDraftClient,
  RitualEntry,
  WowActionId,
  WowChannelAdapter,
} from '@neutronai/onboarding/wow-moment/index.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'

const OWNER = 'sel-owner'
const TOPIC = 'topic-1'
const NOW_MS = 1_700_000_000_000

let tmp: string
let owner_home: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wow-sel-'))
  owner_home = join(tmp, 'owner-home')
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function buildChannel(): WowChannelAdapter & {
  prompts: Array<{ topic_id: string }>
  texts: Array<{ body: string }>
} {
  const prompts: Array<{ topic_id: string }> = []
  const texts: Array<{ body: string }> = []
  return {
    prompts,
    texts,
    async emitPrompt(input) {
      prompts.push({ topic_id: input.topic_id })
      return { prompt_id: input.prompt.prompt_id }
    },
    async sendText(input) {
      texts.push({ body: input.body })
      return { message_id: `m-${texts.length}` }
    },
  }
}

function buildGmail(): GmailDraftClient {
  return {
    async createDraft() {
      return { draft_id: 'd1', gmail_open_url: 'https://mail.google.com/d/1' }
    },
  }
}

interface DispatchHarness {
  reminders: ReminderStore
  cron_jobs: CronJobRegistry
  cron_state: CronStateStore
  channel: ReturnType<typeof buildChannel>
  telemetry: WowTelemetry
  dispatcher: WowDispatcher
  selectionRecorder: Array<{ picks: ReadonlyArray<string>; fallback_used: boolean }>
}

function makeDispatcher(picker_llm: LlmCallFn): DispatchHarness {
  const reminders = new ReminderStore(db)
  const cron_jobs = new CronJobRegistry()
  const cron_state = new CronStateStore(db)
  const channel = buildChannel()
  const telemetry = new WowTelemetry({ db })
  const selectionRecorder: Array<{ picks: ReadonlyArray<string>; fallback_used: boolean }> = []
  const dispatcher = new WowDispatcher({
    telemetry,
    sleep: async () => undefined,
    inter_action_pause_ms: 0,
    now: () => NOW_MS,
    uuid: ((): (() => string) => {
      let n = 0
      return (): string => {
        n += 1
        const hex = n.toString(16).padStart(8, '0')
        return `${hex}-${hex.slice(0, 4)}-4${hex.slice(0, 3)}-8${hex.slice(0, 3)}-${hex.padEnd(12, '0')}`
      }
    })(),
    on_selection: (s) => {
      selectionRecorder.push({ picks: s.picks, fallback_used: s.fallback_used })
    },
  })
  return { reminders, cron_jobs, cron_state, channel, telemetry, dispatcher, selectionRecorder }
}

function ritualSeed(): RitualEntry[] {
  return [{ kind: 'morning', label: 'meditation', time_of_day: '06:30' }]
}

function projectSeed(): CapturedProject[] {
  return [{ name: 'A' }, { name: 'B' }]
}

async function runDispatch(h: DispatchHarness, picker_llm: LlmCallFn, opts: {
  with_interest?: boolean
  with_rituals?: boolean
  with_projects?: boolean
} = {}): Promise<ReturnType<WowDispatcher['dispatch']> extends Promise<infer R> ? R : never> {
  const phase_state_json: Record<string, unknown> = {}
  if (opts.with_interest === true) {
    phase_state_json['non_work_interests'] = [
      { name: 'painting', cadence_hint: 'weekly' },
    ]
  }
  return h.dispatcher.dispatch({
    project_slug: OWNER,
    topic_id: TOPIC,
    owner_home,
    interview: {
      display_name: 'User',
      archetype_blend: ['Athena'],
      phase_state_json,
    },
    import_result: null,
    rituals: opts.with_rituals === true ? ritualSeed() : [],
    captured_projects: opts.with_projects === true ? projectSeed() : [],
    contemplative_keywords: [],
    stalled_threads: [],
    gmail_scopes: null,
    reminders: h.reminders,
    cron_jobs: h.cron_jobs,
    cron_state: h.cron_state,
    db,
    channel: h.channel,
    gmail: buildGmail(),
    picker_llm,
  })
}

// =================== CATALOGUE INVARIANT =====================

test('catalogue: id 06 is interest-check-in, NOT dharma-reframe', () => {
  expect(CANDIDATE_IDS).toContain('06-interest-check-in' as WowActionId)
  expect(CANDIDATE_IDS).not.toContain('06-dharma-reframe-reminder' as WowActionId)
  expect(getActionModule('06-interest-check-in').action_id).toBe('06-interest-check-in')
})

// =================== HAPPY PATH =====================

test('LLM picks 2 valid actions → fired[] is [07, ...picks, 01]; selection telemetry records non-fallback', async () => {
  const picks: WowActionId[] = ['03-project-shells', '06-interest-check-in']
  const llm: LlmCallFn = async () =>
    JSON.stringify({
      pick: picks,
      explanations: {
        '03-project-shells': '2 projects ready',
        '06-interest-check-in': 'painting interest captured',
      },
    })
  const h = makeDispatcher(llm)
  const out = await runDispatch(h, llm, { with_interest: true, with_projects: true })

  // Outcome carries the LLM picks (no fallback).
  expect(out.selection.is_fallback).toBe(false)
  expect(out.selection.pick).toEqual(picks)
  expect(out.fired.includes(ALWAYS_FIRE_FIRST)).toBe(true)
  expect(out.fired.includes(ALWAYS_FIRE_LAST)).toBe(true)
  for (const id of picks) expect(out.fired.includes(id as WowActionId)).toBe(true)

  // Selection telemetry fired once.
  expect(h.selectionRecorder.length).toBe(1)
  expect(h.selectionRecorder[0]?.fallback_used).toBe(false)
  expect(h.selectionRecorder[0]?.picks).toEqual(picks)

  // wow_events rows are in dispatch order: 07 → picks → 01.
  const rows = h.telemetry.list(OWNER)
  expect(rows.map((r) => r.action_id)).toEqual([
    ALWAYS_FIRE_FIRST,
    '03-project-shells',
    '06-interest-check-in',
    ALWAYS_FIRE_LAST,
  ])
})

// =================== LLM-FAILURE FALLBACK =====================

test('LLM throws → fallback to deterministic predicates; selection.is_fallback = true', async () => {
  const llm: LlmCallFn = async () => {
    throw new Error('substrate-down')
  }
  const h = makeDispatcher(llm)
  const out = await runDispatch(h, llm, { with_rituals: true, with_projects: true, with_interest: true })
  expect(out.selection.is_fallback).toBe(true)
  // Fallback picks ≥1 from CANDIDATE_IDS.
  expect(out.selection.pick.length).toBeGreaterThanOrEqual(1)
  for (const id of out.selection.pick) {
    expect(CANDIDATE_IDS).toContain(id)
  }
  // Always-fire baseline still landed.
  expect(out.fired.includes(ALWAYS_FIRE_FIRST)).toBe(true)
  expect(out.fired.includes(ALWAYS_FIRE_LAST)).toBe(true)
  expect(h.selectionRecorder[0]?.fallback_used).toBe(true)
})

test('LLM returns invalid JSON → fallback', async () => {
  const llm: LlmCallFn = async () => 'definitely not JSON {{{'
  const h = makeDispatcher(llm)
  const out = await runDispatch(h, llm, { with_rituals: true, with_projects: true, with_interest: true })
  expect(out.selection.is_fallback).toBe(true)
})

test('LLM returns 0 picks → fallback', async () => {
  const llm: LlmCallFn = async () =>
    JSON.stringify({ pick: [], explanations: {} })
  const h = makeDispatcher(llm)
  const out = await runDispatch(h, llm, { with_interest: true })
  expect(out.selection.is_fallback).toBe(true)
})

// =================== INTEREST-CHECK-IN END-TO-END =====================

test('non_work_interests present + LLM picks 06 → recurring reminder landed with weekly cadence', async () => {
  const llm: LlmCallFn = async () =>
    JSON.stringify({
      pick: ['02-lifestyle-reminders', '06-interest-check-in'],
      explanations: {
        '02-lifestyle-reminders': 'morning meditation captured',
        '06-interest-check-in': 'painting weekly',
      },
    })
  const h = makeDispatcher(llm)
  const out = await runDispatch(h, llm, { with_interest: true, with_rituals: true })
  expect(out.fired).toContain('06-interest-check-in' as WowActionId)

  // One reminder row landed with recurrence = 'weekly'.
  const pending = h.reminders.listPending(OWNER)
  const recurring = pending.filter((r) => r.recurrence !== null)
  expect(recurring.length).toBe(1)
  expect(recurring[0]?.recurrence).toBe('weekly')

  // Per-pick explanation is threaded through wow_events.payload_json.
  const rows = h.telemetry.list(OWNER)
  const interestRow = rows.find((r) => r.action_id === '06-interest-check-in')
  expect(interestRow).toBeDefined()
  expect(interestRow!.redacted_payload['explanation']).toBe('painting weekly')
})
