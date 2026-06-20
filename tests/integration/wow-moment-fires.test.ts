/**
 * Integration test — wow-moment-fires (P2 v2 § 5.4).
 *
 * Originally written under v1 (all 7 actions fire). Updated for v2:
 * dispatcher fires 07 + 01 always-fire baseline + the 2-3 actions the
 * LLM picker selects. This test pins a deterministic picker that
 * returns 02 + 04 + 05 so the test still exercises the gmail-draft
 * negative-send invariant + the recipient-hash telemetry contract.
 *
 * GIVEN: an Mira-shape interview state + a successful Pass-2 import
 *        result with 2 stalled email threads, 3 proposed projects,
 *        2 overdue tasks, 3 captured rituals.
 *
 * WHEN:  WowDispatcher.dispatch(...) runs with a deterministic picker.
 *
 * THEN:  - 5 actions fire: 07 (always), 02 + 04 + 05 (picked), 01 (always)
 *        - wow_events table contains 5 success rows
 *        - for action #5 a Gmail draft was created (mock-Gmail asserts
 *          the call) but NO send call occurred
 *        - action #5 telemetry carries recipient_hash, never raw email
 *
 * MOCKS: Gmail API (records drafts.create calls; asserts users.messages
 *        .send NEVER called); reminders/store (real); cron/state (real).
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
  WowDispatcher,
  WowTelemetry,
  ALWAYS_FIRE_FIRST,
  ALWAYS_FIRE_LAST,
} from '@neutronai/onboarding/wow-moment/index.ts'
import type {
  CapturedProject,
  GmailDraftClient,
  GmailScopeState,
  RitualEntry,
  StalledEmailThread,
  WowChannelAdapter,
} from '@neutronai/onboarding/wow-moment/index.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'

const NOW = 1_700_000_000_000

let tmp: string
let db: ProjectDb
let reminders: ReminderStore
let cron_jobs: CronJobRegistry
let cron_state: CronStateStore
let channelCalls: {
  prompts: Array<{ topic_id: string; promptBody: string; options: string[] }>
  texts: Array<{ topic_id: string; body: string }>
}
let gmailCalls: {
  drafts: Array<{ to: string; subject: string }>
  sends: Array<unknown>
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wow-fires-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  reminders = new ReminderStore(db)
  cron_jobs = new CronJobRegistry()
  cron_state = new CronStateStore(db)
  channelCalls = { prompts: [], texts: [] }
  gmailCalls = { drafts: [], sends: [] }
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function miraImport(): ImportResult {
  return {
    entities: [
      { name: 'Omar', kind: 'person', mention_count: 8 },
      { name: 'Mira Castellan', kind: 'person', mention_count: 42 },
      { name: 'Caldera', kind: 'company', mention_count: 24 },
    ],
    topics: [
      { name: 'Caldera', recurrence_score: 0.8, recency_score: 0.9 },
      { name: 'Ledgerline', recurrence_score: 0.6, recency_score: 0.7 },
    ],
    proposed_projects: [
      { name: 'Caldera', rationale: 'core business', suggested_topics: ['caldera-launch'] },
      { name: 'Ledgerline', rationale: 'JV with Cole', suggested_topics: ['ledgerline-revenue'] },
      { name: 'Childcare logistics', rationale: 'family ops', suggested_topics: ['childcare'] },
    ],
    proposed_tasks: [
      { title: 'Reply to Omar about Q3 invoice', due_at: NOW - 5 * 24 * 3600_000, priority_hint: 'P1' },
      { title: 'Schedule pediatrician follow-up', due_at: NOW - 2 * 24 * 3600_000, priority_hint: 'P2' },
    ],
    proposed_reminders: [],
    voice_signals: { tone: 'expansive', verbosity: 'medium', structure_pref: 'mixed' },
    facts: { user_role: 'CEO Caldera', companies: ['Caldera', 'Ledgerline'] },
  }
}

function miraRituals(): RitualEntry[] {
  return [
    { kind: 'morning', label: 'meditation', time_of_day: '06:30' },
    { kind: 'evening', label: 'family dinner', time_of_day: '19:00' },
    { kind: 'weekly', label: 'sunday review', time_of_day: '17:00' },
  ]
}

function miraCapturedProjects(): CapturedProject[] {
  return [{ name: 'Caldera' }, { name: 'Ledgerline' }]
}

function miraContemplativeKeywords(): string[] {
  return ['meditation', 'mindfulness']
}

function miraStalledThreads(): StalledEmailThread[] {
  return [
    {
      thread_id: 'thread-omar',
      recipient_email: 'omar@example.com',
      subject: 'Q3 invoice',
      last_inbound_at: NOW - 20 * 24 * 3600_000,
      last_outbound_at: NOW - 35 * 24 * 3600_000,
      inbound_count: 3,
      one_line_preview: 'circling back on this',
    },
    {
      thread_id: 'thread-dana',
      recipient_email: 'dana@example.com',
      subject: 'Co-investor meeting',
      last_inbound_at: NOW - 25 * 24 * 3600_000,
      last_outbound_at: NOW - 45 * 24 * 3600_000,
      inbound_count: 4,
    },
  ]
}

function fullScope(): GmailScopeState {
  return { scopes: ['gmail.readonly', 'gmail.compose'], has_compose: true }
}

function buildChannel(): WowChannelAdapter {
  return {
    async emitPrompt(input) {
      channelCalls.prompts.push({
        topic_id: input.topic_id,
        promptBody: input.prompt.body,
        options: input.prompt.options.map((o) => o.value),
      })
      return { prompt_id: input.prompt.prompt_id }
    },
    async sendText(input) {
      channelCalls.texts.push(input)
      return { message_id: `msg-${channelCalls.texts.length}` }
    },
  }
}

function buildGmail(): GmailDraftClient & { send: (input: unknown) => Promise<void> } {
  return {
    async createDraft(input) {
      gmailCalls.drafts.push({ to: input.to, subject: input.subject })
      return {
        draft_id: `draft-${gmailCalls.drafts.length}`,
        gmail_open_url: `https://mail.google.com/draft/${gmailCalls.drafts.length}`,
      }
    },
    // Recorder for the negative assertion — if any code path reaches
    // here, the test fails.
    async send(input) {
      gmailCalls.sends.push(input)
      throw new Error('Action 5 attempted to SEND — drafts only allowed!')
    },
  }
}

test('Mira-shape state fires 2 baseline + 3 picked = 5 actions; gmail draft created, send NEVER called', async () => {
  const telemetry = new WowTelemetry({ db })
  const sleep = async (): Promise<void> => undefined
  const dispatcher = new WowDispatcher({
    telemetry,
    sleep,
    inter_action_pause_ms: 0,
    now: () => NOW,
    uuid: ((): (() => string) => {
      let n = 0
      return (): string => {
        n += 1
        const hex = n.toString(16).padStart(8, '0')
        // Canonical UUID v4-ish — passes the validator.
        return `${hex}-${hex.slice(0, 4)}-4${hex.slice(0, 3)}-8${hex.slice(0, 3)}-${hex.padEnd(12, '0')}`
      }
    })(),
  })

  const channel = buildChannel()
  const gmail = buildGmail()

  const outcome = await dispatcher.dispatch({
    project_slug: 'mira',
    topic_id: 'topic-onboarding',
    owner_home: tmp,
    interview: {
      display_name: 'Mira',
      archetype_blend: ['Athena', 'Curie'],
      phase_state_json: {
        rituals_captured: miraRituals(),
        contemplative_phrase: 'I do morning meditation',
      },
    },
    import_result: miraImport(),
    rituals: miraRituals(),
    captured_projects: miraCapturedProjects(),
    contemplative_keywords: miraContemplativeKeywords(),
    stalled_threads: miraStalledThreads(),
    gmail_scopes: fullScope(),
    reminders,
    cron_jobs,
    cron_state,
    db,
    channel,
    gmail,
    picker_llm: async () =>
      JSON.stringify({
        pick: ['02-lifestyle-reminders', '04-overdue-task', '05-followup-email-draft'],
        explanations: {
          '02-lifestyle-reminders': '3 rituals → schedule the daily rhythm',
          '04-overdue-task': '2 overdue tasks (one P1) → surface highest priority',
          '05-followup-email-draft': '2 stalled threads + gmail.compose scope',
        },
      }),
  })

  // 5 actions fired in order: 07 → picked × 3 → 01.
  expect(outcome.fired).toEqual([
    ALWAYS_FIRE_FIRST,
    '02-lifestyle-reminders',
    '04-overdue-task',
    '05-followup-email-draft',
    ALWAYS_FIRE_LAST,
  ])
  expect(outcome.failed).toEqual([])
  expect(outcome.rescheduled).toBe(false)
  expect(outcome.selection.is_fallback).toBe(false)

  // wow_events has 5 success rows.
  const rows = telemetry.list('mira')
  expect(rows.filter((r) => r.success).length).toBe(5)

  // Gmail mock — drafts.create called exactly once; send NEVER called.
  expect(gmailCalls.drafts.length).toBe(1)
  expect(gmailCalls.drafts[0]?.to).toBe('dana@example.com') // longest-stalled
  expect(gmailCalls.sends.length).toBe(0)

  // Lifestyle reminders inserted (3 rituals → 3 one-shot rows).
  const pendingReminders = reminders.listPending('mira')
  expect(pendingReminders.length).toBe(3)

  // Cron job registered for the overnight pass.
  expect(cron_jobs.get('overnight-mira')).toBeDefined()

  // Channel calls — 1 text (action 01's brief body via sendText)
  // + 3 prompts (action 02 + 04 + 05). Action 01 NO LONGER emits its
  // [A] Start overnight pass affordance prompt: the wow-handoff-fix
  // sprint (Argus r1 BLOCKER #2, 2026-06-09) removed it because it left a
  // stale, still-tappable button competing with the terminal final-handoff
  // guide; the overnight pass is registered via cron and the guide is the
  // single active prompt. So the brief is text-only now → 3 prompts, not 4.
  expect(channelCalls.texts.length).toBe(1)
  expect(channelCalls.prompts.length).toBe(3)
  // Action 5's prompt mentions the draft + the recipient email surface.
  const action5Prompt = channelCalls.prompts.find((p) => p.options.includes('opened'))
  expect(action5Prompt).toBeDefined()
  expect(action5Prompt!.promptBody).toContain('dana@example.com')

  // Telemetry: action 5's redacted_payload carries hashed recipient (NOT raw email).
  const action5Row = rows.find((r) => r.action_id === '05-followup-email-draft')!
  const json = JSON.stringify(action5Row.redacted_payload)
  expect(json).not.toContain('dana@example.com')
  expect(typeof action5Row.redacted_payload['recipient_hash']).toBe('string')
})
