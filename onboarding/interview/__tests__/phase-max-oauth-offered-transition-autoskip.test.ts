/**
 * 2026-06-03 (max-oauth-autoskip-wiring) — regression tests for the
 * auto-skip firing at the TRANSITION INTO `max_oauth_offered`.
 *
 * Live incident: instance `t-44444444` (url_slug `sage`). The instance
 * attached its Claude Max paste-token ~20h BEFORE reaching
 * `max_oauth_offered`, yet still saw the "Connect Claude Max" prompt.
 *
 * Root cause (NOT the identity-mismatch hypothesised in the brief — that
 * was investigated against the live prod DB and DISPROVEN: the secret was
 * keyed by the frozen `internal_handle` and `secretsIdentity()` resolved
 * it correctly): `advanceFromPersonaReviewed` emitted the connect prompt
 * UNCONDITIONALLY. The pre-existing auto-skip call sites only fire on a
 * SUBSEQUENT inbound (`normalAdvance`, state already at the phase) or on
 * `engine.start` (resume) — never on the first landing from
 * `persona_reviewed`. So the prompt always showed exactly once.
 *
 * These tests walk the real persona_reviewed → max_oauth_offered
 * transition (via [A] Looks good) and assert the prompt is suppressed
 * when Max is already attached — including the slug-rename identity
 * bridge that the incident actually exercised (state keyed by url_slug,
 * secret keyed by the frozen internal_handle).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import {
  InterviewEngine,
  type MaxOauthSecretsStore,
} from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { PersonaComposer } from '../../persona-gen/compose.ts'
import { deterministicCringe, type CringeChecker } from '../../persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '../../archetypes/library.ts'

const ARCHETYPE_DATA_DIR = join(import.meta.dir, '..', '..', 'archetypes', 'data')

const USER = 'u-1'
const TOPIC = `web:${USER}`

interface HarnessRow {
  id: string
  internal_handle: string
  label: string
  kind: string
}

interface Harness {
  tmp: string
  db: ProjectDb
  stateStore: InMemoryOnboardingStateStore
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
  listRows: HarnessRow[]
  engine: InterviewEngine
}

interface HarnessOpts {
  /** Pre-seed a `max_oauth_refresh` row keyed by this identity so the
   *  auto-skip detection trips. */
  seedRefreshRowFor?: string
  /** When set, wire `deps.internal_handle` so `secretsIdentity()` keys
   *  the auto-skip lookup on the FROZEN handle rather than the (renamed)
   *  url_slug — mirrors the production t-44444444/`sage` wiring. */
  internalHandle?: string
}

let priorEnvToken: string | undefined
let envSaved = false

function clearEnvToken(): void {
  if (!envSaved) {
    priorEnvToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
    envSaved = true
  }
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
}

function restoreEnvToken(): void {
  if (!envSaved) return
  if (priorEnvToken === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = priorEnvToken
  envSaved = false
  priorEnvToken = undefined
}

function permissiveCringeChecker(): CringeChecker {
  return {
    threshold: 9999,
    async check({ content }): Promise<{ flags: number; reasons: string[] }> {
      return deterministicCringe(content)
    },
  }
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-max-oauth-transition-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  const listRows: HarnessRow[] = []
  if (opts.seedRefreshRowFor !== undefined) {
    listRows.push({
      id: 'pre-attached-1',
      internal_handle: opts.seedRefreshRowFor,
      label: 'default',
      kind: 'max_oauth_refresh',
    })
  }
  const secrets: MaxOauthSecretsStore = {
    async put(input) {
      return { id: `secret-${input.kind}-${input.label}` }
    },
    async list(input) {
      return listRows
        .filter(
          (r) =>
            r.internal_handle === input.internal_handle &&
            (input.kind === undefined || r.kind === input.kind),
        )
        .map((r) => ({ id: r.id, label: r.label, kind: r.kind }))
    },
  }
  const archetypes = new ArchetypeLibrary({
    dataDir: ARCHETYPE_DATA_DIR,
    cacheDir: join(tmp, 'arch-cache'),
  })
  const composer = new PersonaComposer({
    cringeChecker: permissiveCringeChecker(),
    ownerHomeFor: (slug: string): string => join(tmp, slug, 'persona'),
    archetypes,
  })
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    personaComposer: composer,
    secrets,
    ...(opts.internalHandle !== undefined ? { internal_handle: opts.internalHandle } : {}),
  })
  return { tmp, db, stateStore, sentPrompts, listRows, engine }
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

const V2_PHASE_STATE = {
  user_id: USER,
  topic_id: TOPIC,
  signup_via: 'web',
  ai_substrate_used: 'claude',
  user_first_name: 'Sam',
  agent_name: 'Sage',
  agent_personality: 'a warm thinking-partner with a sharp edge',
  primary_projects: ['Topline', 'Northwind'],
  non_work_interests: [{ name: 'meditation' }],
  work_themes: ['productizing Nova'],
  companies: ['Topline'],
  inner_circle: ['Casey (wife)'],
} as const

/** Walk projects_proposed → persona_synthesizing → persona_reviewed, and
 *  return the review prompt id so the caller can fire [A] Looks good. */
async function walkToPersonaReviewed(h: Harness, project_slug: string): Promise<string> {
  await h.stateStore.upsert({
    user_id: USER,
    project_slug,
    phase: 'projects_proposed',
    phase_state_patch: { ...V2_PHASE_STATE },
    advanced_at: Date.now(),
  })
  await h.engine.advance({
    project_slug,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    observed_at: Date.now(),
  })
  const projState = await h.stateStore.get(project_slug, USER)
  const projPromptId = (projState?.phase_state as Record<string, unknown>)['active_prompt_id']
  if (typeof projPromptId !== 'string') {
    throw new Error('walk: projects_proposed prompt did not stamp active_prompt_id')
  }
  await h.engine.advance({
    project_slug,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    choice: {
      prompt_id: projPromptId,
      choice_value: 'auto',
      chosen_at: Date.now(),
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    },
    observed_at: Date.now(),
  })
  const reviewed = await h.stateStore.get(project_slug, USER)
  if (reviewed?.phase !== 'persona_reviewed') {
    throw new Error(`walk: expected persona_reviewed, got ${reviewed?.phase}`)
  }
  const reviewPromptId = (reviewed.phase_state as Record<string, unknown>)['active_prompt_id']
  if (typeof reviewPromptId !== 'string') {
    throw new Error('walk: persona_reviewed prompt did not stamp active_prompt_id')
  }
  return reviewPromptId
}

async function tapLooksGood(h: Harness, project_slug: string, promptId: string): Promise<void> {
  await h.engine.advance({
    project_slug,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    choice: {
      prompt_id: promptId,
      choice_value: 'looks_good',
      chosen_at: Date.now(),
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    },
    observed_at: Date.now(),
  })
}

function connectPromptsSent(h: Harness): Array<{ prompt: ButtonPrompt }> {
  return h.sentPrompts.filter(
    (p) =>
      p.prompt.body.includes('Connect Claude Max') ||
      p.prompt.body.includes('Claude Max sub') ||
      p.prompt.body.includes('Max sub connected') ||
      (p.prompt.options ?? []).some((o) => o.value === 'attach_max'),
  )
}

describe('InterviewEngine — auto-skip fires at the transition INTO max_oauth_offered', () => {
  let h: Harness
  beforeEach(() => {
    restoreEnvToken()
    clearEnvToken()
  })
  afterEach(() => {
    teardown(h)
    restoreEnvToken()
  })

  test('happy path: Max attached (identity matches) → Looks-good never shows the connect prompt', async () => {
    const slug = 't-attached'
    h = makeHarness({ seedRefreshRowFor: slug })
    const reviewPromptId = await walkToPersonaReviewed(h, slug)
    const promptsBefore = h.sentPrompts.length
    await tapLooksGood(h, slug, reviewPromptId)

    const after = await h.stateStore.get(slug, USER)
    // Auto-skip advanced past the phase (wow_fired; dispatcher unwired).
    expect(after!.phase).not.toBe('max_oauth_offered')
    expect(after!.phase === 'wow_fired' || after!.phase === 'completed').toBe(true)
    expect(after!.phase_state['max_substrate']).toBe('max_oauth')
    // No connect prompt was EVER sent across the whole walk.
    expect(connectPromptsSent(h)).toHaveLength(0)
    // And specifically none after the Looks-good tap.
    const sentAfter = h.sentPrompts.slice(promptsBefore)
    expect(
      sentAfter.some((p) => (p.prompt.options ?? []).some((o) => o.value === 'attach_max')),
    ).toBe(false)
  })

  test('slug-rename identity bridge: state keyed by url_slug, secret keyed by frozen internal_handle (the t-44444444/`sage` incident)', async () => {
    const url_slug = 'sage'
    const internal_handle = 't-44444444'
    // Secret is keyed by the FROZEN handle (as the write path does); the
    // onboarding state machine keys by the renamed url_slug. The
    // auto-skip must bridge via `secretsIdentity()` → deps.internal_handle.
    h = makeHarness({ seedRefreshRowFor: internal_handle, internalHandle: internal_handle })
    const reviewPromptId = await walkToPersonaReviewed(h, url_slug)
    await tapLooksGood(h, url_slug, reviewPromptId)

    const after = await h.stateStore.get(url_slug, USER)
    expect(after!.phase).not.toBe('max_oauth_offered')
    expect(after!.phase === 'wow_fired' || after!.phase === 'completed').toBe(true)
    expect(connectPromptsSent(h)).toHaveLength(0)
  })

  test('no Max attached → Looks-good lands on max_oauth_offered AND emits the single connect CTA', async () => {
    const slug = 't-not-attached'
    h = makeHarness({})
    const reviewPromptId = await walkToPersonaReviewed(h, slug)
    const promptsBefore = h.sentPrompts.length
    await tapLooksGood(h, slug, reviewPromptId)

    const after = await h.stateStore.get(slug, USER)
    expect(after!.phase).toBe('max_oauth_offered')
    const sentAfter = h.sentPrompts.slice(promptsBefore)
    const connect = sentAfter.find((p) =>
      (p.prompt.options ?? []).some((o) => o.value === 'attach_max'),
    )
    expect(connect).toBeTruthy()
    expect(connect!.prompt.options).toHaveLength(1)
    expect(connect!.prompt.options[0]?.body).toBe('Connect Claude Max')
  })
})
