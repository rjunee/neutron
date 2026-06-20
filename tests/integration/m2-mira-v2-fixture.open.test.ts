/**
 * Integration test — m2-mira-v2 fixture (Open carve).
 *
 * Per docs/plans/P2-onboarding-v2.md § 10.2 (test contract for the v2
 * walkthrough). Single-owner Open end-state. Asserts:
 *
 *   1. Every v2 required field per § 4.1 is populated in
 *      `onboarding_state.phase_state_json` at completion.
 *   2. SOUL.md / USER.md / priority-map.md exist on disk with non-stub
 *      bodies, and the user's first name flows in.
 *   3. wow_events row count is 4-5 (2 always-fire + 2-3 LLM-picked),
 *      every LLM-picked row carries the picker's `explanation` in its
 *      redacted payload, and the dispatcher's selection event records
 *      the same picks with `fallback_used: false`.
 *   4. The interest-check-in action fires (Mira has non_work_interests),
 *      lands a recurring reminder row.
 *
 * The "fixture" is an Mira-shape phase_state + import_result + persona
 * files written via the same seams the real engine uses (onboarding_state
 * repo, persona-gen output). The fixture does NOT traverse the engine
 * phase machine. This file exercises the single-owner END-STATE contract.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  WowDispatcher,
  WowTelemetry,
} from '@neutronai/onboarding/wow-moment/index.ts'
import type {
  CapturedProject,
  GmailDraftClient,
  GmailScopeState,
  RitualEntry,
  StalledEmailThread,
  WowActionId,
  WowChannelAdapter,
} from '@neutronai/onboarding/wow-moment/index.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'

const PROJECT = 'mira'
const TOPIC = 'topic-onboarding'
const NOW_MS = 1_700_000_000_000

interface RequiredFieldsState {
  user_first_name: string
  ai_substrate_used: 'chatgpt' | 'claude' | 'neither'
  work_themes: string[]
  primary_projects: string[]
  non_work_interests: Array<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }>
  rituals: string[]
  inner_circle: string[]
  agent_personality: string
  agent_name: string
  slug: string
}

interface MiraFixture {
  project_slug: string
  owner_home: string
  project_db: ProjectDb
  state: RequiredFieldsState
  wow_events: ReturnType<WowTelemetry['list']>
  reminders: ReturnType<ReminderStore['listPending']>
  channel_texts: Array<{ body: string }>
  channel_prompts: Array<{ topic_id: string }>
  selection: {
    picks: ReadonlyArray<WowActionId>
    explanations: Readonly<Record<string, string>>
    fallback_used: boolean
  } | null
  outcome: { fired: WowActionId[] }
}

function miraImportResult(): ImportResult {
  return {
    entities: [
      { name: 'Mira', kind: 'person', mention_count: 30 },
      { name: 'Dana Reyes', kind: 'person', mention_count: 8 },
      { name: 'Caldera', kind: 'company', mention_count: 18 },
    ],
    topics: [
      { name: 'Caldera Q3 launch', recurrence_score: 0.9, recency_score: 0.95 },
    ],
    proposed_projects: [
      { name: 'Caldera', rationale: 'Q3 launch', suggested_topics: ['caldera-q3'] },
      { name: 'Ledgerline', rationale: 'JV operations', suggested_topics: ['ledgerline-revenue'] },
      { name: 'Childcare logistics', rationale: 'family ops', suggested_topics: ['childcare'] },
    ],
    proposed_tasks: [
      { title: 'Reply to Dana about packaging audit', due_at: NOW_MS - 14 * 24 * 3600_000, priority_hint: 'P1' },
    ],
    proposed_reminders: [
      { pattern: 'daily at 06:30', body: 'morning meditation' },
    ],
    voice_signals: { tone: 'expansive', verbosity: 'medium', structure_pref: 'mixed' },
    facts: {
      user_role: 'CEO Caldera',
      companies: ['Caldera', 'Ledgerline'],
      key_people: ['Dana Reyes'],
    },
    inferred_interests: [
      { name: 'evening painting', basis: 'recurring mentions of art retreat plans', cadence_hint: 'weekly' },
    ],
    conversation_count: 250,
  }
}

function miraRituals(): RitualEntry[] {
  return [
    { kind: 'morning', label: 'meditation', time_of_day: '06:30' },
    { kind: 'weekly', label: 'sunday review', time_of_day: '17:00' },
  ]
}

function miraCapturedProjects(): CapturedProject[] {
  return [
    { name: 'Caldera' },
    { name: 'Ledgerline' },
    { name: 'Childcare logistics' },
  ]
}

function miraStalledThreads(): StalledEmailThread[] {
  return [
    {
      thread_id: 'thread-dana',
      recipient_email: 'dana.reyes@example.com',
      subject: 'Halo packaging audit',
      last_inbound_at: NOW_MS - 14 * 24 * 3600_000,
      last_outbound_at: NOW_MS - 30 * 24 * 3600_000,
      inbound_count: 3,
    },
  ]
}

function gmailScope(): GmailScopeState {
  return { scopes: ['gmail.compose'], has_compose: true }
}

function buildChannel(): {
  adapter: WowChannelAdapter
  texts: Array<{ body: string }>
  prompts: Array<{ topic_id: string }>
} {
  const texts: Array<{ body: string }> = []
  const prompts: Array<{ topic_id: string }> = []
  const adapter: WowChannelAdapter = {
    async emitPrompt(input) {
      prompts.push({ topic_id: input.topic_id })
      return { prompt_id: input.prompt.prompt_id }
    },
    async sendText(input) {
      texts.push({ body: input.body })
      return { message_id: `m-${texts.length}` }
    },
  }
  return { adapter, texts, prompts }
}

function buildGmail(): GmailDraftClient {
  return {
    async createDraft() {
      return { draft_id: 'd1', gmail_open_url: 'https://mail.google.com/d/1' }
    },
  }
}

const MIRA_STATE: RequiredFieldsState = {
  user_first_name: 'Mira',
  ai_substrate_used: 'chatgpt',
  work_themes: ['fragrance brand launch', 'family operations'],
  primary_projects: ['Caldera', 'Ledgerline', 'Childcare logistics'],
  non_work_interests: [
    { name: 'evening painting', cadence_hint: 'weekly' },
  ],
  rituals: ['morning meditation @ 06:30', 'sunday review @ 17:00'],
  inner_circle: ['Alex', 'Dana Reyes', 'Rosa'],
  agent_personality: 'warm and expansive, but cuts to the point',
  agent_name: 'Mimir',
  slug: 'mira',
}

async function runMiraV2Fixture(): Promise<MiraFixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'm2-mira-v2-'))
  const owner_home = join(tmp, 'owner-home')
  mkdirSync(owner_home, { recursive: true })

  // -- Single-owner project DB (migrations 0001..) carries
  //    onboarding_state + wow_events + reminders.
  const project_db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(project_db.raw())

  const now = Date.now() / 1000

  // -- Write the persona files persona-gen would have produced.
  writeSoulFile(owner_home, MIRA_STATE)
  writeUserFile(owner_home, MIRA_STATE)
  writePriorityMapFile(owner_home, MIRA_STATE)

  // -- Seed onboarding_state at `wow_fired` with the v2 phase_state shape
  //    (every required field per § 4.1 populated).
  const phase_state: Record<string, unknown> = {
    user_first_name: MIRA_STATE.user_first_name,
    ai_substrate_used: MIRA_STATE.ai_substrate_used,
    work_themes: MIRA_STATE.work_themes,
    primary_projects: MIRA_STATE.primary_projects,
    non_work_interests: MIRA_STATE.non_work_interests,
    rituals: MIRA_STATE.rituals,
    inner_circle: MIRA_STATE.inner_circle,
    agent_personality: MIRA_STATE.agent_personality,
    agent_name: MIRA_STATE.agent_name,
    slug: MIRA_STATE.slug,
  }
  await project_db.run(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at, attempt_id)
     VALUES (?, 'legacy:pre-project-isolation', 'wow_fired', ?, ?, ?, 'attempt-1')`,
    [PROJECT, JSON.stringify(phase_state), Math.floor(now), Math.floor(now)],
  )

  // -- Run the REAL wow dispatcher with a picker that returns 3 sensible
  //    Mira picks. The picker MUST include 06-interest-check-in because
  //    non_work_interests is non-empty + Alex's biggest-wow framing says
  //    interest-check-in is the v2 differentiator.
  const picker_picks: WowActionId[] = [
    '03-project-shells',
    '04-overdue-task',
    '06-interest-check-in',
  ]
  const picker_explanations: Record<string, string> = {
    '03-project-shells': '3 inferred projects → shells anchor the workspace',
    '04-overdue-task': '1 overdue task surfaced from history-import',
    '06-interest-check-in': 'non_work_interests = [painting weekly] → schedule the proactive nudge',
  }
  const picker_llm: LlmCallFn = async () =>
    JSON.stringify({ pick: picker_picks, explanations: picker_explanations })

  const reminders = new ReminderStore(project_db)
  const cron_jobs = new CronJobRegistry()
  const cron_state = new CronStateStore(project_db)
  const { adapter: channel, texts, prompts } = buildChannel()
  const telemetry = new WowTelemetry({ db: project_db })
  let captured_selection: MiraFixture['selection'] = null
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
      captured_selection = {
        picks: [...s.picks],
        explanations: { ...s.explanations },
        fallback_used: s.fallback_used,
      }
    },
  })

  const outcome = await dispatcher.dispatch({
    project_slug: PROJECT,
    topic_id: TOPIC,
    owner_home,
    interview: {
      display_name: MIRA_STATE.user_first_name,
      archetype_blend: ['Athena'],
      phase_state_json: phase_state,
    },
    import_result: miraImportResult(),
    rituals: miraRituals(),
    captured_projects: miraCapturedProjects(),
    contemplative_keywords: [],
    stalled_threads: miraStalledThreads(),
    gmail_scopes: gmailScope(),
    reminders,
    cron_jobs,
    cron_state,
    db: project_db,
    channel,
    gmail: buildGmail(),
    picker_llm,
  })

  // -- Mark the onboarding row complete.
  await project_db.run(
    `UPDATE onboarding_state
        SET phase = 'completed',
            completed_at = ?,
            last_advanced_at = ?,
            wow_fired = 1
      WHERE project_slug = ?`,
    [Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), PROJECT],
  )

  return {
    project_slug: PROJECT,
    owner_home,
    project_db,
    state: MIRA_STATE,
    wow_events: telemetry.list(PROJECT),
    reminders: reminders.listPending(PROJECT),
    channel_texts: texts,
    channel_prompts: prompts,
    selection: captured_selection,
    outcome,
  }
}

function writeSoulFile(home: string, s: RequiredFieldsState): void {
  const body = [
    `# SOUL.md — ${s.agent_name}`,
    '',
    `_Personality (per ${s.user_first_name}'s framing): ${s.agent_personality}._`,
    '',
    '## Archetypal Blend',
    '',
    '- Athena — strategic clarity.',
    '- Hestia — keeper of the household rhythm.',
    '',
    '## Operating Principles',
    '',
    `1. Cut to the point with ${s.user_first_name}; warmth in delivery, not hedging.`,
    '2. Surface non-work life proactively (the wow-moment commitment).',
    '',
  ].join('\n')
  writeFileSync(join(home, 'SOUL.md'), body)
}

function writeUserFile(home: string, s: RequiredFieldsState): void {
  const body = [
    `# USER.md — ${s.user_first_name}`,
    '',
    `- **Name:** ${s.user_first_name}`,
    `- **Work themes:** ${s.work_themes.join(', ')}`,
    `- **Primary projects:** ${s.primary_projects.join(', ')}`,
    `- **Inner circle:** ${s.inner_circle.join(', ')}`,
    `- **Non-work interests:** ${s.non_work_interests.map((i) => i.name).join(', ')}`,
    `- **Rituals:** ${s.rituals.join('; ')}`,
    '',
  ].join('\n')
  writeFileSync(join(home, 'USER.md'), body)
}

function writePriorityMapFile(home: string, s: RequiredFieldsState): void {
  const body = [
    `# Priority map — ${s.agent_name} for ${s.user_first_name}`,
    '',
    `## ${s.user_first_name}'s programs (ordered)`,
    '',
    ...s.primary_projects.map((p, i) => `${i + 1}. ${p} — P1 (active program; flag scope creep + surface daily)`),
    '',
    '## Urgency levels',
    '',
    '- P0: drop everything (legal, health, security incidents)',
    '- P1: today (revenue-impacting or time-sensitive blockers)',
    '- P2: this week (important but not urgent — track + bundle)',
    '- P3: backlog (do when opportune; review monthly for drift)',
    '',
    '## Auto-resolve lanes',
    '',
    '- Calendar scheduling within stated availability',
    '- Routine acknowledgements + non-sensitive follow-ups',
    '- Vault backup, daily index refresh, health checks',
    '',
  ].join('\n')
  writeFileSync(join(home, 'priority-map.md'), body)
}

let fixture: MiraFixture | null = null
let fixtureDir: string | null = null

beforeEach(async () => {
  fixture = await runMiraV2Fixture()
  fixtureDir = fixture.owner_home.split('/owner-home')[0] ?? null
})

afterEach(() => {
  if (fixture !== null) {
    fixture.project_db.close()
    fixture = null
  }
  if (fixtureDir !== null) {
    rmSync(fixtureDir, { recursive: true, force: true })
    fixtureDir = null
  }
})

test('m2-mira-v2-fixture — required fields filled in phase_state at completion', async () => {
  const f = fixture!
  const row = f.project_db
    .raw()
    .query<{ phase_state_json: string }, [string]>(
      `SELECT phase_state_json FROM onboarding_state WHERE project_slug = ?`,
    )
    .get(f.project_slug)
  expect(row).not.toBeNull()
  const ps = JSON.parse(row!.phase_state_json) as Record<string, unknown>
  expect(ps['user_first_name']).toBeDefined()
  expect(ps['ai_substrate_used']).toBeDefined()
  expect(Array.isArray(ps['work_themes']) ? (ps['work_themes'] as unknown[]).length : 0).toBeGreaterThanOrEqual(1)
  expect(Array.isArray(ps['primary_projects']) ? (ps['primary_projects'] as unknown[]).length : 0).toBeGreaterThanOrEqual(3)
  expect(Array.isArray(ps['non_work_interests']) ? (ps['non_work_interests'] as unknown[]).length : 0).toBeGreaterThanOrEqual(1)
  expect(ps['agent_personality']).toBeDefined()
  expect(ps['agent_name']).toBeDefined()
  expect(ps['slug']).toBeDefined()
})

test('m2-mira-v2-fixture — persona files exist with non-empty body containing the user first name', async () => {
  const f = fixture!
  for (const name of ['SOUL.md', 'USER.md', 'priority-map.md']) {
    const body = readFileSync(join(f.owner_home, name), 'utf8')
    expect(body.length).toBeGreaterThan(200)
    expect(body).toContain('Mira')
  }
})

test('m2-mira-v2-fixture — wow actions fired with LLM explanation populated', async () => {
  const f = fixture!
  // 2 always-fire + 2-3 LLM-picked = 4-5 events.
  expect(f.wow_events.length).toBeGreaterThanOrEqual(4)
  expect(f.wow_events.length).toBeLessThanOrEqual(5)
  // Both always-fire baselines fired.
  expect(f.wow_events.some((e) => e.action_id === ALWAYS_FIRE_FIRST && e.success)).toBe(true)
  expect(f.wow_events.some((e) => e.action_id === ALWAYS_FIRE_LAST && e.success)).toBe(true)
  // LLM-picked middle carries the picker's explanation in payload_json.
  const llm_picked = f.wow_events.filter(
    (e) => e.action_id !== ALWAYS_FIRE_FIRST && e.action_id !== ALWAYS_FIRE_LAST,
  )
  expect(llm_picked.length).toBeGreaterThanOrEqual(2)
  for (const ev of llm_picked) {
    const exp = ev.redacted_payload['explanation']
    expect(typeof exp).toBe('string')
    expect((exp as string).length).toBeGreaterThan(0)
  }
  // Selection telemetry recorded the picker's picks with fallback_used=false.
  expect(f.selection).not.toBeNull()
  expect(f.selection?.fallback_used).toBe(false)
  expect(f.selection?.picks.length).toBe(llm_picked.length)
})

test('m2-mira-v2-fixture — interest-check-in fired and a recurring reminder landed', async () => {
  const f = fixture!
  expect(f.wow_events.some((e) => e.action_id === '06-interest-check-in' && e.success)).toBe(true)
  const recurring = f.reminders.filter((r) => r.recurrence !== null)
  expect(recurring.length).toBe(1)
  expect(recurring[0]?.recurrence).toBe('weekly')
})

test('m2-mira-v2-fixture — id 06 is interest-check-in, NOT dharma-reframe', async () => {
  const f = fixture!
  // Spec § 5.1 — v2 explicitly removes dharma-reframe.
  expect(f.wow_events.some((e) => (e.action_id as string) === '06-dharma-reframe-reminder')).toBe(false)
  expect(f.wow_events.some((e) => e.action_id === '06-interest-check-in')).toBe(true)
})
