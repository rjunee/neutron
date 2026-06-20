/**
 * Integration test — m2-soren-v2 fixture, no-import branch (Open carve).
 *
 * Per docs/plans/P2-onboarding-v2.md § 14.2 — the canonical Soren-shape
 * walkthrough end-state contract for the user who answers `neither` at
 * `ai_substrate_offered` and walks through `work_interview_gap_fill` into
 * personality / name / slug. Sibling of `m2-mira-v2-fixture.open.test.ts`
 * (which covers the import-branch). Both assert per § 10.2 contract.
 *
 * The Soren shape:
 *   - `user_first_name`     = "Soren"
 *   - `ai_substrate_used`   = "neither" (NO ImportResult — the upstream
 *     phase machine routes straight to `work_interview_gap_fill`)
 *   - `work_themes`         = ["tax compliance", "client portfolios"]
 *   - `primary_projects`    = ≥3 (interview-only, no import substrate)
 *   - `non_work_interests`  = ≥1 (interview-only)
 *   - `agent_personality`   = free-text
 *   - `agent_name` + slug
 *
 * Open single-owner coverage lands here:
 *   1. § 10.2 required-fields fill assertion at completion.
 *   2. Persona files exist + non-empty + contain "Soren".
 *   3. Wow dispatcher still fires the 2 always-fire + 2-3 LLM-picked
 *      candidates on the no-import branch (with `inferred_interests`
 *      empty because there's no ImportResult).
 *   4. `gap_fill_iteration_count` stays under cap when the user
 *      cooperates — engine advances to `personality_offered` within
 *      1-3 iterations once required fields are extracted.
 *   5. § 3.8 / § 12 trapdoor — uncooperative user across 5 iterations
 *      transitions the engine to `phase='failed'` with the structured
 *      `gap_fill_failure_reason='gap_fill_cap_no_required_fields'` per
 *      spec. NO synthetic-placeholder advance.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import type {
  DrivenPhasePromptSpec,
  ExtractedFields,
  GeneratePromptInput,
} from '@neutronai/onboarding/interview/llm-prompt-driver.ts'
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
  RitualEntry,
  StalledEmailThread,
  WowActionId,
  WowChannelAdapter,
} from '@neutronai/onboarding/wow-moment/index.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'

const PROJECT = 'soren'
const TOPIC = 'topic-onboarding'
const NOW_MS = 1_700_000_000_000

interface RequiredFieldsState {
  user_first_name: string
  ai_substrate_used: 'chatgpt' | 'claude' | 'neither'
  work_themes: string[]
  primary_projects: string[]
  non_work_interests: Array<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }>
  agent_personality: string
  agent_name: string
  slug: string
}

interface SorenFixture {
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

const SOREN_STATE: RequiredFieldsState = {
  user_first_name: 'Soren',
  ai_substrate_used: 'neither',
  work_themes: ['tax compliance', 'client portfolios'],
  primary_projects: ['Tax season 2026', 'Client retention', 'Tooling upgrade'],
  non_work_interests: [
    { name: 'running', cadence_hint: 'weekly' },
  ],
  agent_personality: 'precise and pragmatic, surfaces risks before they grow',
  agent_name: 'Forseti',
  slug: 'soren',
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

function writeSoulFile(home: string, s: RequiredFieldsState): void {
  const body = [
    `# SOUL.md — ${s.agent_name}`,
    '',
    `_Personality (per ${s.user_first_name}'s framing): ${s.agent_personality}._`,
    '',
    '## Archetypal Blend',
    '',
    '- Forseti — clear-eyed mediator who finds the binding decision.',
    '- Thoth — keeper of the ledger; precision over flourish.',
    '',
    '## Operating Principles',
    '',
    `1. Surface risks to ${s.user_first_name} early; do not bury them in summaries.`,
    '2. Prefer numbered checklists; treat tax compliance as a deadline-driven craft.',
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
    `- **Non-work interests:** ${s.non_work_interests.map((i) => i.name).join(', ')}`,
    '',
    '## Background context',
    '',
    `${s.user_first_name} answered "neither" at the AI-substrate question, so no`,
    'ChatGPT / Claude export ran. Every field here was collected via the',
    'work_interview_gap_fill phase per § 3.8 of the v2 spec.',
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
    '- P0: drop everything (legal, compliance breaches, health, security)',
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

/**
 * END-STATE Soren fixture — sets up the v2 phase_state + persona files as
 * if onboarding has just transitioned into `wow_fired`, then runs the
 * REAL wow dispatcher with `import_result=null` and a deterministic
 * picker. Mirrors `runMiraV2Fixture` in
 * `m2-mira-v2-fixture.open.test.ts`.
 */
async function runSorenV2Fixture(): Promise<SorenFixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'm2-soren-v2-'))
  const owner_home = join(tmp, 'owner-home')
  mkdirSync(owner_home, { recursive: true })

  const project_db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(project_db.raw())

  const now = Date.now() / 1000

  writeSoulFile(owner_home, SOREN_STATE)
  writeUserFile(owner_home, SOREN_STATE)
  writePriorityMapFile(owner_home, SOREN_STATE)

  // -- Seed onboarding_state at `wow_fired` with the v2 phase_state shape
  //    (every required field per § 4.1 populated). No `import_failed`
  //    flag, no `import_result` reference — the no-import branch never
  //    enters `import_running`.
  const phase_state: Record<string, unknown> = {
    user_first_name: SOREN_STATE.user_first_name,
    ai_substrate_used: SOREN_STATE.ai_substrate_used,
    work_themes: SOREN_STATE.work_themes,
    primary_projects: SOREN_STATE.primary_projects,
    non_work_interests: SOREN_STATE.non_work_interests,
    agent_personality: SOREN_STATE.agent_personality,
    agent_name: SOREN_STATE.agent_name,
    slug: SOREN_STATE.slug,
    gap_fill_iteration_count: 2,
  }
  await project_db.run(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at, attempt_id)
     VALUES (?, ?, 'wow_fired', ?, ?, ?, 'attempt-1')`,
    [PROJECT, 'u-soren', JSON.stringify(phase_state), Math.floor(now), Math.floor(now)],
  )

  // -- Picker — Soren has 3 projects + 1 interest but no import + no
  //    stalled threads + no rituals. So action 06 (interest-check-in) is
  //    the always-fires candidate; we pair it with 03 (project-shells)
  //    which fires off the captured_projects list. Two LLM picks is the
  //    spec floor (§ 5.4: 2-3 picks); we deliberately do NOT include
  //    actions 02 / 04 / 05 because their trigger predicates would
  //    return false on the no-import substrate and pad the wow_events
  //    table with no-trigger rows the assertions on `success === true`
  //    would need to filter around.
  const picker_picks: WowActionId[] = ['03-project-shells', '06-interest-check-in']
  const picker_explanations: Record<string, string> = {
    '03-project-shells': '3 interview-captured projects → shells anchor the workspace',
    '06-interest-check-in': 'non_work_interests = [running weekly] → schedule the proactive nudge',
  }
  const picker_llm: LlmCallFn = async () =>
    JSON.stringify({ pick: picker_picks, explanations: picker_explanations })

  const reminders = new ReminderStore(project_db)
  const cron_jobs = new CronJobRegistry()
  const cron_state = new CronStateStore(project_db)
  const { adapter: channel, texts, prompts } = buildChannel()
  const telemetry = new WowTelemetry({ db: project_db })
  let captured_selection: SorenFixture['selection'] = null
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

  const rituals: RitualEntry[] = [] // Soren didn't volunteer any rituals.
  const captured_projects: CapturedProject[] = SOREN_STATE.primary_projects.map((name) => ({ name }))
  const stalled_threads: StalledEmailThread[] = []
  const gmail: GmailDraftClient | null = buildGmail()

  const outcome = await dispatcher.dispatch({
    project_slug: PROJECT,
    topic_id: TOPIC,
    owner_home,
    interview: {
      display_name: SOREN_STATE.user_first_name,
      archetype_blend: ['Forseti'],
      phase_state_json: phase_state,
    },
    import_result: null,
    rituals,
    captured_projects,
    contemplative_keywords: [],
    stalled_threads,
    gmail_scopes: null,
    reminders,
    cron_jobs,
    cron_state,
    db: project_db,
    channel,
    gmail,
    picker_llm,
  })

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
    state: SOREN_STATE,
    wow_events: telemetry.list(PROJECT),
    reminders: reminders.listPending(PROJECT),
    channel_texts: texts,
    channel_prompts: prompts,
    selection: captured_selection,
    outcome,
  }
}

let fixture: SorenFixture | null = null
let fixtureDir: string | null = null

describe('m2-soren-v2-fixture — END-STATE contract (§ 10.2 + § 14.2 no-import branch)', () => {
  beforeEach(async () => {
    fixture = await runSorenV2Fixture()
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

  test('m2-soren-v2-fixture — required fields filled in phase_state at completion', async () => {
    const f = fixture!
    const row = f.project_db
      .raw()
      .query<{ phase_state_json: string }, [string]>(
        `SELECT phase_state_json FROM onboarding_state WHERE project_slug = ?`,
      )
      .get(f.project_slug)
    expect(row).not.toBeNull()
    const ps = JSON.parse(row!.phase_state_json) as Record<string, unknown>
    expect(ps['user_first_name']).toBe('Soren')
    expect(ps['ai_substrate_used']).toBe('neither')
    expect(Array.isArray(ps['work_themes']) ? (ps['work_themes'] as unknown[]).length : 0).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(ps['primary_projects']) ? (ps['primary_projects'] as unknown[]).length : 0).toBeGreaterThanOrEqual(3)
    expect(Array.isArray(ps['non_work_interests']) ? (ps['non_work_interests'] as unknown[]).length : 0).toBeGreaterThanOrEqual(1)
    expect(ps['agent_personality']).toBeDefined()
    expect(ps['agent_name']).toBeDefined()
    expect(ps['slug']).toBeDefined()
  })

  test('m2-soren-v2-fixture — persona files exist with non-empty body containing the user first name', async () => {
    const f = fixture!
    for (const name of ['SOUL.md', 'USER.md', 'priority-map.md']) {
      const body = readFileSync(join(f.owner_home, name), 'utf8')
      expect(body.length).toBeGreaterThan(200)
      expect(body).toContain('Soren')
    }
  })

  test('m2-soren-v2-fixture — wow actions fired with LLM explanation populated (no-import branch)', async () => {
    const f = fixture!
    // 2 always-fire + 2 LLM-picked = 4 events. The no-import branch
    // deliberately picks the minimum-spec 2 candidates (03, 06) — actions
    // 02 / 04 / 05 are skipped because their trigger predicates (rituals,
    // overdue tasks, stalled threads) are false on Soren's substrate.
    expect(f.wow_events.length).toBeGreaterThanOrEqual(4)
    expect(f.wow_events.length).toBeLessThanOrEqual(5)
    expect(f.wow_events.some((e) => e.action_id === ALWAYS_FIRE_FIRST && e.success)).toBe(true)
    expect(f.wow_events.some((e) => e.action_id === ALWAYS_FIRE_LAST && e.success)).toBe(true)
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

    // The interest-check-in fired (Soren has a non_work_interest)
    // and landed a recurring weekly reminder.
    expect(f.wow_events.some((e) => e.action_id === '06-interest-check-in' && e.success)).toBe(true)
    const recurring = f.reminders.filter((r) => r.recurrence !== null)
    expect(recurring.length).toBe(1)
    expect(recurring[0]?.recurrence).toBe('weekly')
  })
})

// ---------------------------------------------------------------------------
// Engine-driven gap-fill self-loop coverage (§ 3.8 + § 12).
//
// These tests don't reuse `runSorenV2Fixture` — they drive the real
// `InterviewEngine` from `ai_substrate_offered` (neither) into
// `work_interview_gap_fill`, then through the cooperative or
// uncooperative reply pattern to assert iteration-counter behaviour
// and the cap-hit → phase=failed trapdoor.
// ---------------------------------------------------------------------------

const ENGINE_PROJECT = 'soren'
const ENGINE_TOPIC = 'topic-1'
const ENGINE_USER = 'u-soren'

interface EngineHarness {
  tmp: string
  db: ProjectDb
  buttonStore: ButtonStore
  stateStore: InMemoryOnboardingStateStore
  transcript: TranscriptWriter
  sentPrompts: Array<{ prompt: ButtonPrompt }>
}

function setupEngineHarness(): EngineHarness {
  const tmp = mkdtempSync(join(tmpdir(), 'm2-soren-engine-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  return {
    tmp,
    db,
    buttonStore: new ButtonStore({ db }),
    stateStore: new InMemoryOnboardingStateStore(),
    transcript: new TranscriptWriter({
      path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
    }),
    sentPrompts: [],
  }
}

function teardownEngineHarness(h: EngineHarness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

/**
 * Driver stub that mimics what a real LLM would emit on the gap-fill
 * phase: pattern-matches the user's most recent reply and extracts the
 * structured fields (Soren-flavoured: tax / clients / tooling /
 * running). Non-gap-fill phases collapse to the static fallback.
 */
function makeSorenCooperativeDriver(): (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec> {
  return async (input) => {
    if (input.phase !== 'work_interview_gap_fill') {
      return {
        phase: input.phase,
        body: 'fallback',
        options: [],
        allow_freeform: true,
        next_phase_on_default: input.phase,
        is_fallback: true,
      }
    }
    const lastUser = [...input.transcript_so_far].reverse().find((t) => t.role === 'user')
    const reply = (lastUser?.body ?? '').toLowerCase()
    const extracted: ExtractedFields = {}
    if (reply.includes('tax season') || reply.includes('client retention')) {
      extracted.primary_projects = ['Tax season 2026', 'Client retention']
    }
    if (reply.includes('tooling')) {
      extracted.primary_projects = ['Tooling upgrade']
    }
    if (reply.includes('running')) {
      extracted.non_work_interests = [{ name: 'running', cadence_hint: 'weekly' }]
    }
    const iteration = typeof input.phase_state['gap_fill_iteration_count'] === 'number'
      ? (input.phase_state['gap_fill_iteration_count'] as number)
      : 0
    const spec: DrivenPhasePromptSpec = {
      phase: input.phase,
      body: `gap-fill question turn ${iteration} reply=${reply.slice(0, 60)}`,
      options: [],
      allow_freeform: true,
      next_phase_on_default: input.phase,
      is_fallback: false,
    }
    if (Object.keys(extracted).length > 0) spec.extracted_fields = extracted
    return spec
  }
}

/**
 * Driver stub that never extracts. Mirrors the gap-fill-iterates test's
 * `makeUncooperativeDriver` so cap-hit fires after 5 user replies.
 */
function makeSorenUncooperativeDriver(): (
  input: GeneratePromptInput,
) => Promise<DrivenPhasePromptSpec> {
  return async (input) => {
    if (input.phase !== 'work_interview_gap_fill') {
      return {
        phase: input.phase,
        body: 'fallback',
        options: [],
        allow_freeform: true,
        next_phase_on_default: input.phase,
        is_fallback: true,
      }
    }
    const iteration = typeof input.phase_state['gap_fill_iteration_count'] === 'number'
      ? (input.phase_state['gap_fill_iteration_count'] as number)
      : 0
    const lastUser = [...input.transcript_so_far].reverse().find((t) => t.role === 'user')
    const reply = (lastUser?.body ?? '').slice(0, 40)
    return {
      phase: input.phase,
      body: `gap-fill question turn ${iteration} reply=${reply}`,
      options: [],
      allow_freeform: true,
      next_phase_on_default: input.phase,
      is_fallback: false,
    }
  }
}

function makeEngine(
  h: EngineHarness,
  driver: (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec>,
): InterviewEngine {
  return new InterviewEngine({
    buttonStore: h.buttonStore,
    stateStore: h.stateStore,
    transcript: h.transcript,
    sendButtonPrompt: async (input) => {
      h.sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${h.sentPrompts.length}`, was_new: true }
    },
    promptDriver: driver,
  })
}

function lastPromptId(h: EngineHarness): string {
  const sent = h.sentPrompts[h.sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt.prompt_id
}

async function advanceFreeform(
  engine: InterviewEngine,
  h: EngineHarness,
  text: string,
  observed_at: number,
): Promise<void> {
  const prompt_id = lastPromptId(h)
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: text,
    chosen_at: observed_at,
    speaker_user_id: ENGINE_USER,
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug: ENGINE_PROJECT,
    topic_id: ENGINE_TOPIC,
    user_id: ENGINE_USER,
    channel_kind: 'app-socket',
    choice,
    observed_at,
  })
}

async function landSorenAtGapFill(
  engine: InterviewEngine,
  h: EngineHarness,
  observed_at: number,
): Promise<number> {
  await engine.start({
    project_slug: ENGINE_PROJECT,
    topic_id: ENGINE_TOPIC,
    user_id: ENGINE_USER,
    signup_via: 'web',
  })
  let t = observed_at
  t += 1_000
  await advanceFreeform(engine, h, 'Soren', t)
  // ai_substrate_offered — pick `neither` to enter the no-import branch.
  t += 1_000
  const prompt_id = lastPromptId(h)
  await engine.advance({
    project_slug: ENGINE_PROJECT,
    topic_id: ENGINE_TOPIC,
    user_id: ENGINE_USER,
    channel_kind: 'app-socket',
    choice: {
      prompt_id,
      choice_value: 'neither',
      chosen_at: t,
      speaker_user_id: ENGINE_USER,
      channel_kind: 'app-socket',
    },
    observed_at: t,
  })
  const state = await h.stateStore.get(ENGINE_PROJECT, ENGINE_USER)
  expect(state!.phase).toBe('work_interview_gap_fill')
  return t
}

describe('m2-soren-v2-fixture — gap-fill self-loop (§ 3.8 + § 12)', () => {
  let h: EngineHarness

  beforeEach(() => {
    h = setupEngineHarness()
  })

  afterEach(() => {
    teardownEngineHarness(h)
  })

  test('m2-soren-v2-fixture — gap_fill_iterations stays under cap when user cooperates', async () => {
    const engine = makeEngine(h, makeSorenCooperativeDriver())
    let t = await landSorenAtGapFill(engine, h, NOW_MS)

    // Turn 1 — Soren lists two projects in one reply. Audit still
    // needs ≥3 projects + ≥1 non_work_interest → stay on gap_fill.
    t += 1_000
    await advanceFreeform(engine, h, 'Tax season 2026 plus client retention', t)
    let state = await h.stateStore.get(ENGINE_PROJECT, ENGINE_USER)
    expect(state!.phase).toBe('work_interview_gap_fill')
    let ps = state!.phase_state as Record<string, unknown>
    expect(ps['gap_fill_iteration_count']).toBe(1)
    expect(ps['primary_projects']).toEqual(['Tax season 2026', 'Client retention'])

    // Turn 2 — Soren adds the third project. Still missing
    // non_work_interests → stay on gap_fill.
    t += 1_000
    await advanceFreeform(engine, h, 'Also a tooling upgrade for the firm', t)
    state = await h.stateStore.get(ENGINE_PROJECT, ENGINE_USER)
    expect(state!.phase).toBe('work_interview_gap_fill')
    ps = state!.phase_state as Record<string, unknown>
    expect(ps['gap_fill_iteration_count']).toBe(2)
    expect(ps['primary_projects']).toEqual([
      'Tax season 2026',
      'Client retention',
      'Tooling upgrade',
    ])

    // Turn 3 — Soren volunteers the non-work interest. After merge the
    // audit clears and the engine advances to personality_offered. The
    // iteration counter is 3 (well under the cap of 5).
    t += 1_000
    await advanceFreeform(engine, h, 'Outside work I keep running on weekends', t)
    state = await h.stateStore.get(ENGINE_PROJECT, ENGINE_USER)
    expect(state!.phase).toBe('personality_offered')
    ps = state!.phase_state as Record<string, unknown>
    expect(ps['gap_fill_iteration_count']).toBe(3)
    expect((ps['gap_fill_iteration_count'] as number)).toBeLessThan(5)
    expect(ps['non_work_interests']).toEqual([
      { name: 'running', cadence_hint: 'weekly' },
    ])
    // No cap-fail strand — phase advanced via the audit-clean branch.
    expect(ps['gap_fill_failure_reason']).toBeUndefined()
    expect(ps['gap_fill_failure_missing']).toBeUndefined()
  })

  test('m2-soren-v2-fixture — gap_fill_cap_hit transitions to phase=failed', async () => {
    // Per spec § 3.8 + § 12: 5 uncooperative replies → engine
    // transitions to `phase='failed'` with `gap_fill_failure_reason =
    // 'gap_fill_cap_no_required_fields'`. No synthetic-placeholder
    // path. The brief's wording "phase_state.failure_reason" maps to
    // the engine's `gap_fill_failure_reason` field (engine.ts L6098);
    // both are the same trapdoor — the field name is the source of
    // truth.
    const engine = makeEngine(h, makeSorenUncooperativeDriver())
    let t = await landSorenAtGapFill(engine, h, NOW_MS)

    // Replies 1-4 — each extracts nothing; audit stays dirty; engine
    // stays on gap_fill and bumps the iteration counter.
    const skipReplies = ['hmm', 'idk', 'pass', 'no idea']
    for (const reply of skipReplies) {
      t += 1_000
      await advanceFreeform(engine, h, reply, t)
      const mid = await h.stateStore.get(ENGINE_PROJECT, ENGINE_USER)
      expect(mid!.phase).toBe('work_interview_gap_fill')
    }
    let state = await h.stateStore.get(ENGINE_PROJECT, ENGINE_USER)
    expect(state!.phase_state['gap_fill_iteration_count']).toBe(4)
    expect(state!.phase).toBe('work_interview_gap_fill')

    // Reply 5 — cap fires. Engine transitions to phase=failed with the
    // structured failure reason. NO synthetic primary_projects /
    // non_work_interests get written; the missing list is the
    // remaining required-for-gap-fill fields.
    t += 1_000
    await advanceFreeform(engine, h, 'still nothing to share', t)
    state = await h.stateStore.get(ENGINE_PROJECT, ENGINE_USER)
    expect(state!.phase).toBe('failed')
    const ps = state!.phase_state as Record<string, unknown>
    expect(ps['gap_fill_iteration_count']).toBe(5)
    expect(ps['gap_fill_failure_reason']).toBe('gap_fill_cap_no_required_fields')
    expect(ps['gap_fill_failure_missing']).toEqual([
      'primary_projects',
      'non_work_interests',
    ])
    // Audit did not synthesize placeholder data.
    expect(ps['primary_projects']).toBeUndefined()
    expect(ps['non_work_interests']).toBeUndefined()
  })
})
