/**
 * 2026-05-28 — `max_oauth_offered` UX cleanup tests.
 *
 * Sprint: drop the BYO + skip buttons, surface a single "Connect Claude
 * Max" CTA, and auto-skip the entire phase when the owner already has
 * a `max_oauth_refresh` secret persisted (e.g. instances that attached
 * Max during the import phase).
 *
 * These tests pin the new behavior. The legacy 3-way tests in
 * `max-oauth-offered.test.ts` cover the defensive byo_key + skip
 * handlers (kept in the engine for stale in-flight prompts but
 * unreachable from fresh emits).
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
  type MaxOAuthEngineHook,
  type MaxOauthSecretsStore,
} from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { STATIC_PHASE_SPECS, buildMaxOauthOfferedPromptSpec } from '../phase-prompts.ts'

interface HarnessRow {
  id: string
  internal_handle: string
  label: string
  kind: string
}

interface Harness {
  tmp: string
  db: ProjectDb
  buttonStore: ButtonStore
  stateStore: InMemoryOnboardingStateStore
  transcript: TranscriptWriter
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
  startHandoffCalls: Array<{ project_slug: string; user_id: string }>
  putCalls: Array<{
    internal_handle: string
    kind: string
    label: string
    plaintext: string
    expires_at?: number
  }>
  listCalls: Array<{ internal_handle: string; kind?: string }>
  listRows: HarnessRow[]
  engine: InterviewEngine
}

interface HarnessOpts {
  /** Pre-seed the list rows so auto-skip detection trips immediately. */
  seedRefreshRowFor?: string
  /** Wire the maxOauth dep (default true). Set false to test the
   *  "Connect failed" rejection path. */
  maxOauthWired?: boolean
  /** Wire the secrets dep (default true). */
  secretsWired?: boolean
  /** Override the process env CLAUDE_CODE_OAUTH_TOKEN for the duration
   *  of the test. Set null to clear; undefined to leave alone. */
  envToken?: string | null
}

let priorEnvToken: string | undefined
let envTokenOverridden = false

function setEnvTokenForTest(token: string | null): void {
  if (!envTokenOverridden) {
    priorEnvToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
    envTokenOverridden = true
  }
  if (token === null) {
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  } else {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = token
  }
}

function restoreEnvToken(): void {
  if (!envTokenOverridden) return
  if (priorEnvToken === undefined) {
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  } else {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = priorEnvToken
  }
  envTokenOverridden = false
  priorEnvToken = undefined
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-max-oauth-autoskip-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  const startHandoffCalls: Harness['startHandoffCalls'] = []
  const putCalls: Harness['putCalls'] = []
  const listCalls: Harness['listCalls'] = []
  const listRows: HarnessRow[] = []
  if (opts.seedRefreshRowFor !== undefined) {
    listRows.push({
      id: 'pre-attached-1',
      internal_handle: opts.seedRefreshRowFor,
      label: 'default',
      kind: 'max_oauth_refresh',
    })
  }
  const secretsStub: MaxOauthSecretsStore = {
    async put(input) {
      putCalls.push({ ...input })
      return { id: `secret-${putCalls.length}` }
    },
    async list(input) {
      const args: { internal_handle: string; kind?: string } = {
        internal_handle: input.internal_handle,
      }
      if (input.kind !== undefined) args.kind = input.kind
      listCalls.push(args)
      return listRows.filter(
        (r) =>
          r.internal_handle === input.internal_handle &&
          (input.kind === undefined || r.kind === input.kind),
      )
    },
  }
  const maxOauthStub: MaxOAuthEngineHook = {
    async startHandoff(input) {
      startHandoffCalls.push({ ...input })
      return { url: 'https://anthropic-handoff.example/once-abc' }
    },
  }
  const secretsWired = opts.secretsWired ?? true
  const maxOauthWired = opts.maxOauthWired ?? true
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    ...(maxOauthWired ? { maxOauth: maxOauthStub } : {}),
    ...(secretsWired ? { secrets: secretsStub } : {}),
  })
  return {
    tmp,
    db,
    buttonStore,
    stateStore,
    transcript,
    sentPrompts,
    startHandoffCalls,
    putCalls,
    listCalls,
    listRows,
    engine,
  }
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

async function seedAtMaxOauthOffered(h: Harness, slug: string): Promise<void> {
  await h.stateStore.upsert({
    user_id: 'u-1',
    project_slug: slug,
    phase: 'max_oauth_offered',
    phase_state_patch: {
      user_id: 'u-1',
      topic_id: 'web:u-1',
      signup_via: 'web',
    },
    advanced_at: Date.now(),
  })
}

describe('STATIC_PHASE_SPECS.max_oauth_offered — single CTA copy', () => {
  test('body matches Sam 2026-05-28 single-CTA framing', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec).toBeDefined()
    expect(spec!.body).toBe(
      'I need your Claude Max sub to run premium models. One click to connect.',
    )
  })

  test('options is a single Connect-Claude-Max button', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec!.options).toEqual([
      { label: 'A', body: 'Connect Claude Max', value: 'attach_max' },
    ])
    expect(spec!.allow_freeform).toBe(false)
  })

  test('body does NOT mention BYO API key or skip-onto-free-tier', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec!.body).not.toMatch(/API key/i)
    expect(spec!.body).not.toMatch(/skip/i)
    expect(spec!.body).not.toMatch(/free tier/i)
  })
})

describe('buildMaxOauthOfferedPromptSpec — substrate-aware Shape-1 wording (2026-06-03)', () => {
  const CLAUDE_ACK =
    'Earlier you mentioned you use Claude. To run premium models for you, I need your Max sub connected. One click.'
  const ORIGINAL = 'I need your Claude Max sub to run premium models. One click to connect.'

  test('ai_substrate_used="claude" → acknowledging body', () => {
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
      ai_substrate_used: 'claude',
    })
    expect(spec.body).toBe(CLAUDE_ACK)
    // Single Connect CTA preserved.
    expect(spec.options).toEqual([
      { label: 'A', body: 'Connect Claude Max', value: 'attach_max' },
    ])
  })

  test('ai_substrate_used="chatgpt" → original blunt body', () => {
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
      ai_substrate_used: 'chatgpt',
    })
    expect(spec.body).toBe(ORIGINAL)
  })

  test('ai_substrate_used=null / omitted → original blunt body (back-compat)', () => {
    const withNull = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
      ai_substrate_used: null,
    })
    const omitted = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
    })
    expect(withNull.body).toBe(ORIGINAL)
    expect(omitted.body).toBe(ORIGINAL)
  })

  test('rejection reason is stitched in front of the substrate-aware body', () => {
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: 'Connect failed; tap to try again.',
      ai_substrate_used: 'claude',
    })
    expect(spec.body).toBe(`Connect failed; tap to try again.\n\n${CLAUDE_ACK}`)
  })
})

describe('InterviewEngine — auto-skip past max_oauth_offered when Max already attached', () => {
  let h: Harness
  beforeEach(() => {
    restoreEnvToken()
    setEnvTokenForTest(null)
  })
  afterEach(() => {
    teardown(h)
    restoreEnvToken()
  })

  test('emit at max_oauth_offered with existing refresh row → advances past, no prompt visible', async () => {
    const slug = 't-attached-1'
    h = makeHarness({ seedRefreshRowFor: slug })
    await seedAtMaxOauthOffered(h, slug)
    const r = await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    expect(r.state?.phase).not.toBe('max_oauth_offered')
    // wow_fired (unwired dispatcher) is the legal target after the
    // auto-skip's `advanceFromMaxOauthOffered('max_oauth')` call. With
    // a dispatcher wired the phase would advance further to completed.
    expect(r.state?.phase === 'wow_fired' || r.state?.phase === 'completed').toBe(true)
    // No max_oauth_offered prompt was sent to the user — the auto-skip
    // means the surface never saw a Connect button.
    const maxPrompts = h.sentPrompts.filter(
      (p) => p.prompt.body.includes('Connect Claude Max') || p.prompt.body.includes('Claude Max sub'),
    )
    expect(maxPrompts).toHaveLength(0)
    // The substrate marker was written.
    expect(r.state?.phase_state['max_substrate']).toBe('max_oauth')
  })

  test('emit at max_oauth_offered WITHOUT a refresh row → prompt is emitted with the single CTA', async () => {
    const slug = 't-not-attached-1'
    h = makeHarness({})
    await seedAtMaxOauthOffered(h, slug)
    const r = await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    expect(r.state?.phase).toBe('max_oauth_offered')
    expect(h.sentPrompts).toHaveLength(1)
    const sent = h.sentPrompts[0]!.prompt
    expect(sent.body).toContain('Claude Max sub')
    expect(sent.options).toHaveLength(1)
    expect(sent.options[0]?.value).toBe('attach_max')
    expect(sent.options[0]?.body).toBe('Connect Claude Max')
  })

  test('env stop-gap: CLAUDE_CODE_OAUTH_TOKEN set + no secrets row → still auto-skips', async () => {
    setEnvTokenForTest('sk-ant-env-fake')
    const slug = 't-env-stopgap-1'
    h = makeHarness({})
    await seedAtMaxOauthOffered(h, slug)
    const r = await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    expect(r.state?.phase).not.toBe('max_oauth_offered')
    expect(r.state?.phase_state['max_substrate']).toBe('max_oauth')
  })

  test('auto-skip is no-op when secrets unwired AND env unset', async () => {
    const slug = 't-no-detect-1'
    h = makeHarness({ secretsWired: false })
    await seedAtMaxOauthOffered(h, slug)
    const r = await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    expect(r.state?.phase).toBe('max_oauth_offered')
    // The single-CTA prompt is the surface the user sees.
    expect(h.sentPrompts).toHaveLength(1)
    expect(h.sentPrompts[0]!.prompt.options[0]?.value).toBe('attach_max')
  })
})

describe('InterviewEngine — rejection text for failed Connect handoff', () => {
  let h: Harness
  beforeEach(() => {
    restoreEnvToken()
    setEnvTokenForTest(null)
  })
  afterEach(() => {
    teardown(h)
    restoreEnvToken()
  })

  test('attach_max with maxOauth unwired → rejection body does NOT mention API key or skip', async () => {
    const slug = 't-unwired-1'
    h = makeHarness({ maxOauthWired: false })
    await seedAtMaxOauthOffered(h, slug)
    // Initial emit shows the single-CTA prompt.
    await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    const initialPrompt = h.sentPrompts[0]!.prompt
    const promptId = initialPrompt.prompt_id

    // User taps Connect Claude Max — maxOauth is unwired, so the
    // engine re-emits with the new rejection text.
    await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: promptId,
        choice_value: 'attach_max',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })

    expect(h.sentPrompts.length).toBeGreaterThanOrEqual(2)
    const reemit = h.sentPrompts[h.sentPrompts.length - 1]!.prompt
    expect(reemit.body).toContain('Connect failed')
    // Regression: the legacy "Use your own API key or skip for now"
    // pointers are gone — those options no longer exist on the surface.
    expect(reemit.body).not.toMatch(/API key/i)
    expect(reemit.body).not.toMatch(/skip for now/i)
    expect(reemit.body).not.toMatch(/skip onto the free tier/i)
    // Re-emit still offers the single Connect CTA so the user can retry.
    expect(reemit.options).toHaveLength(1)
    expect(reemit.options[0]?.value).toBe('attach_max')
  })
})

describe('InterviewEngine — stale-client defensive paths still work', () => {
  let h: Harness
  beforeEach(() => {
    restoreEnvToken()
    setEnvTokenForTest(null)
  })
  afterEach(() => {
    teardown(h)
    restoreEnvToken()
  })

  test('stale `skip` value still routes to advanceFromMaxOauthOffered(\"free\")', async () => {
    const slug = 't-stale-skip-1'
    h = makeHarness({})
    await seedAtMaxOauthOffered(h, slug)
    // Emit the (new single-CTA) prompt so we have a valid prompt_id to
    // attach the stale `skip` choice to. The button registry doesn't
    // policy-validate `value` against the prompt's option set — it just
    // resolves the choice into consumeChoice.
    await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    const promptId = h.sentPrompts[0]!.prompt.prompt_id
    const r = await h.engine.advance({
      project_slug: slug,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: promptId,
        choice_value: 'skip',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r.state?.phase_state['max_substrate']).toBe('free')
    expect(r.state?.phase === 'wow_fired' || r.state?.phase === 'completed').toBe(true)
  })
})
