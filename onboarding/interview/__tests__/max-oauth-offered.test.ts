/**
 * @neutronai/onboarding/interview — T3 max_oauth_offered restore tests.
 *
 * Sprint: 2026-05-13 — restore the Claude Max attach question at
 * `max_oauth_offered` (per docs/plans/P2-onboarding.md § 2.4 fallback,
 * locked 2026-04-29). The body had been overwritten with the wow-fire
 * question ("Ready to fire your Day-1 brief?") and the three options
 * `[attach_max, byo_key, skip]` had been replaced with `[fire, defer]`,
 * leaving `auth/max-oauth.ts` unreachable from the user flow.
 *
 * These tests are PRODUCT-LOGIC assertions per the spec-conformance
 * audit (CLAUDE.md § "Spec is the source of truth"):
 *
 *   1. STATIC body must reference Claude Max — not the wow-fire question.
 *   2. STATIC options must be exactly the three substrate-choice values.
 *   3. attach_max choice must invoke `maxOauth.startHandoff(project_slug, user_id)`.
 *   4. After the Max handoff completes, the SecretsStore has a
 *      `max_oauth_refresh` row (the test stub simulates the upstream
 *      flow's write).
 *   5. byo_key + paste valid sk-ant- key must call
 *      `secrets.put({ kind: 'byo_api_key', ... })`.
 *   6. skip choice must set `phase_state.max_substrate = 'free'`.
 *   7. Regression: `wow_fired` must NOT contain a 'Fire it' question
 *      (it has no static body — the wow-dispatcher fires it).
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
import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'

interface SecretsPutRecord {
  internal_handle: string
  kind: 'byo_api_key' | 'max_oauth_refresh' | 'max_oauth_access'
  label: string
  plaintext: string
  expires_at?: number
}

interface SecretsListCall {
  internal_handle: string
  kind: string | undefined
}

interface Harness {
  tmp: string
  db: ProjectDb
  buttonStore: ButtonStore
  stateStore: InMemoryOnboardingStateStore
  transcript: TranscriptWriter
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
  startHandoffCalls: Array<{ project_slug: string; user_id: string }>
  startHandoffUrl: string
  startHandoffSideEffect: 'write_refresh_row' | 'noop' | 'throw'
  /**
   * Frozen identity the upstream paste-token write should key the
   * `max_oauth_refresh` row under (mirrors `auth/secrets-store.ts:11-26`
   * — production callers pass the frozen `internal_handle`, NEVER the
   * mutable `url_slug`). When non-null, the startHandoff side-effect
   * uses this value; when null, falls back to `input.project_slug` for
   * back-compat with pre-rename tests.
   */
  refreshRowInternalHandle: string | null
  putCalls: SecretsPutRecord[]
  listCalls: SecretsListCall[]
  listRows: Array<{ id: string; internal_handle: string; label: string; kind: string }>
  engine: InterviewEngine
}

function makeHarness(opts: {
  maxOauthWired: boolean
  secretsWired: boolean
  internal_handle?: string
}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-max-oauth-offered-'))
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
  const harness: Partial<Harness> = {
    tmp,
    db,
    buttonStore,
    stateStore,
    transcript,
    sentPrompts,
    startHandoffCalls,
    startHandoffUrl: 'https://anthropic-handoff.example/once-abc',
    startHandoffSideEffect: 'write_refresh_row',
    refreshRowInternalHandle: opts.internal_handle ?? null,
    putCalls,
    listCalls,
    listRows: [],
  }
  const secretsStub: MaxOauthSecretsStore = {
    async put(input) {
      putCalls.push({ ...input })
      return { id: `secret-${putCalls.length}` }
    },
    async list(input) {
      listCalls.push({ internal_handle: input.internal_handle, kind: input.kind })
      return harness.listRows!.filter(
        (r) =>
          r.internal_handle === input.internal_handle &&
          (input.kind === undefined || r.kind === input.kind),
      )
    },
  }
  const maxOauthStub: MaxOAuthEngineHook = {
    async startHandoff(input) {
      startHandoffCalls.push({ ...input })
      if (harness.startHandoffSideEffect === 'throw') {
        throw new Error('handoff blew up')
      }
      if (harness.startHandoffSideEffect === 'write_refresh_row' && opts.secretsWired) {
        // Simulate the upstream OAuth/paste flow completing: persist a
        // `max_oauth_refresh` row before returning. Production wires this
        // via `auth/max-oauth.ts:MaxOAuthClient.persistPasteToken`, which
        // MUST key the row under the FROZEN `internal_handle` per
        // `auth/secrets-store.ts:11-26`. When the harness is configured
        // with `refreshRowInternalHandle`, the stub keys under that
        // frozen value; otherwise falls back to `input.project_slug`
        // (pre-rename, the two are identical).
        const writerIh = harness.refreshRowInternalHandle ?? input.project_slug
        await secretsStub.put({
          internal_handle: writerIh,
          kind: 'max_oauth_refresh',
          label: 'default',
          plaintext: 'sk-ant-refresh-handoff-completed',
        })
        harness.listRows!.push({
          id: `secret-${putCalls.length}`,
          internal_handle: writerIh,
          label: 'default',
          kind: 'max_oauth_refresh',
        })
      }
      return { url: harness.startHandoffUrl! }
    },
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    ...(opts.maxOauthWired ? { maxOauth: maxOauthStub } : {}),
    ...(opts.secretsWired ? { secrets: secretsStub } : {}),
    ...(opts.internal_handle !== undefined ? { internal_handle: opts.internal_handle } : {}),
  })
  harness.engine = engine
  return harness as Harness
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

/**
 * Seed an instance at max_oauth_offered with an active_prompt_id by:
 *   1. Upsert phase=max_oauth_offered
 *   2. Call advance() with no choice → emits the initial 3-option prompt
 */
async function seedMaxOauthOffered(h: Harness, slug: string): Promise<void> {
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
  await h.engine.advance({
    project_slug: slug,
    topic_id: 'web:u-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: Date.now(),
  })
}

async function activePromptId(h: Harness, slug: string): Promise<string> {
  const state = await h.stateStore.get(slug, 'u-1')
  if (state === null) throw new Error('state missing')
  const apid = state.phase_state['active_prompt_id']
  if (typeof apid !== 'string') throw new Error('active_prompt_id missing')
  return apid
}

describe('STATIC_PHASE_SPECS.max_oauth_offered — body + options (Test 1, 2)', () => {
  test('Test 1: body references Claude Max and NOT the old wow-fire copy', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec).toBeDefined()
    expect(spec!.body).toContain('Claude Max')
    expect(spec!.body).not.toContain('Day-1 brief')
    expect(spec!.body).not.toContain('Fire it')
  })

  test('Test 2 (2026-05-28 single-CTA): options are exactly [attach_max] — BYO + skip dropped', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec).toBeDefined()
    expect(spec!.options).toHaveLength(1)
    expect(spec!.options[0]?.value).toBe('attach_max')
    expect(spec!.options[0]?.body).toBe('Connect Claude Max')
    expect(spec!.allow_freeform).toBe(false)
    expect(spec!.next_phase_on_default).toBe('wow_fired')
    // Regression: the legacy 3-way framing must not leak into the body
    // or option labels (Sam's 2026-05-28 stuck-loop incident — the
    // rejection text pointed at buttons that no longer existed).
    expect(spec!.body).not.toContain('API key')
    expect(spec!.body).not.toContain('skip')
    for (const opt of spec!.options) {
      expect(opt.value).not.toBe('byo_key')
      expect(opt.value).not.toBe('skip')
    }
  })
})

describe('InterviewEngine — max_oauth_offered routing (Tests 3-6)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('Test 3: attach_max → calls maxOauth.startHandoff({project_slug, user_id})', async () => {
    h = makeHarness({ maxOauthWired: true, secretsWired: true })
    await seedMaxOauthOffered(h, 't-project-3')
    const prompt_id = await activePromptId(h, 't-project-3')
    await h.engine.advance({
      project_slug: 't-project-3',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'attach_max',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.startHandoffCalls).toHaveLength(1)
    expect(h.startHandoffCalls[0]).toEqual({
      project_slug: 't-project-3',
      user_id: 'u-1',
    })
  })

  test('Test 4: after the Max handoff completes, secrets.put has been called with kind=max_oauth_refresh', async () => {
    h = makeHarness({ maxOauthWired: true, secretsWired: true })
    await seedMaxOauthOffered(h, 't-project-4')
    const prompt_id = await activePromptId(h, 't-project-4')
    await h.engine.advance({
      project_slug: 't-project-4',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'attach_max',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // The mock startHandoff simulates the upstream paste-token write
    // when invoked (matches `auth/max-oauth.ts:persistPasteToken`).
    const refreshPuts = h.putCalls.filter((p) => p.kind === 'max_oauth_refresh')
    expect(refreshPuts).toHaveLength(1)
    expect(refreshPuts[0]).toMatchObject({
      internal_handle: 't-project-4',
      kind: 'max_oauth_refresh',
      label: 'default',
    })
    expect(refreshPuts[0]!.plaintext).toContain('sk-ant-')
  })

  test('Test 5: byo_key + valid sk-ant- paste → secrets.put({kind: byo_api_key, ...})', async () => {
    h = makeHarness({ maxOauthWired: true, secretsWired: true })
    await seedMaxOauthOffered(h, 't-project-5')

    // Turn 1: tap byo_key — engine stashes awaiting_byo_paste=true and
    // re-emits with the paste body.
    const initialPromptId = await activePromptId(h, 't-project-5')
    const r1 = await h.engine.advance({
      project_slug: 't-project-5',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: initialPromptId,
        choice_value: 'byo_key',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r1.outcome).toBe('reemitted_current')
    expect(r1.state?.phase_state['awaiting_byo_paste']).toBe(true)

    // Turn 2: paste the API key freeform.
    const pastePromptId = await activePromptId(h, 't-project-5')
    const r2 = await h.engine.advance({
      project_slug: 't-project-5',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: pastePromptId,
        choice_value: '__freeform__',
        freeform_text: 'sk-ant-api03-project-5-test-key',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r2.outcome).toBe('advanced')
    expect(r2.state?.phase).toBe('wow_fired')

    const byoPuts = h.putCalls.filter((p) => p.kind === 'byo_api_key')
    expect(byoPuts).toHaveLength(1)
    expect(byoPuts[0]).toMatchObject({
      internal_handle: 't-project-5',
      kind: 'byo_api_key',
      label: 'anthropic:default',
      plaintext: 'sk-ant-api03-project-5-test-key',
    })
    expect(r2.state?.phase_state['max_substrate']).toBe('byo_api_key')
  })

  test('Test 6: skip → phase_state.max_substrate === "free" + advance to wow_fired', async () => {
    h = makeHarness({ maxOauthWired: false, secretsWired: false })
    await seedMaxOauthOffered(h, 't-project-6')
    const prompt_id = await activePromptId(h, 't-project-6')
    const r = await h.engine.advance({
      project_slug: 't-project-6',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'skip',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r.outcome).toBe('advanced')
    expect(r.state?.phase).toBe('wow_fired')
    expect(r.state?.phase_state['max_substrate']).toBe('free')
    // Skip path must NOT call the maxOauth hook or the SecretsStore.
    expect(h.startHandoffCalls).toHaveLength(0)
    expect(h.putCalls).toHaveLength(0)
  })
})

describe('STATIC_PHASE_SPECS.wow_fired — regression (Test 7)', () => {
  test('Test 7: wow_fired has no body containing the old "Fire it" wow-fire question', () => {
    const spec = STATIC_PHASE_SPECS['wow_fired']
    // wow_fired is driven externally (wow-dispatcher) — it intentionally
    // has no static spec entry. If a future commit DOES add one, it must
    // NOT carry the legacy wow-fire body (that lived on max_oauth_offered
    // before T3 restored it).
    if (spec === undefined) {
      expect(spec).toBeUndefined()
      return
    }
    expect(spec.body).not.toContain('Fire it')
    expect(spec.body).not.toContain('Day-1 brief')
    expect(spec.body).not.toContain('Ready to fire')
  })
})

/**
 * Argus r1 BLOCKER fix (2026-05-13): secrets MUST be keyed by the FROZEN
 * `internal_handle`, not the mutable `project_slug` (== `url_slug`). See
 * `auth/secrets-store.ts:11-26`. The 2026-05-12 rename-canonicalisation fix
 * mandated this; PR #96 r1 reintroduced the bug by passing
 * `input.project_slug` to `secrets.list` / `secrets.put`. These tests
 * exercise the post-rename code path end-to-end.
 */
describe('InterviewEngine — frozen internal_handle survives url_slug rename (Test 8, 9)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('Test 8: byo_key + paste after a slug rename → secrets.put keyed by FROZEN internal_handle, not the new url_slug', async () => {
    const FROZEN_HANDLE = 't-frozen-8'
    const ORIGINAL_SLUG = 't-frozen-8' // initial url_slug == frozen handle
    const RENAMED_SLUG = 'nova-renamed-8'
    h = makeHarness({
      maxOauthWired: true,
      secretsWired: true,
      internal_handle: FROZEN_HANDLE,
    })

    // Seed onboarding state at max_oauth_offered under the ORIGINAL slug,
    // then simulate a rename mid-onboarding by rekeying the state row to
    // the NEW url_slug. After this point the engine sees only the new
    // slug coming in over the wire, but its `deps.internal_handle` is
    // still the frozen value.
    await seedMaxOauthOffered(h, ORIGINAL_SLUG)
    await h.stateStore.rekey(ORIGINAL_SLUG, RENAMED_SLUG, 'u-1')
    const initialPromptId = await activePromptId(h, RENAMED_SLUG)

    // Turn 1: tap byo_key at the renamed slug.
    const r1 = await h.engine.advance({
      project_slug: RENAMED_SLUG,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: initialPromptId,
        choice_value: 'byo_key',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r1.outcome).toBe('reemitted_current')
    expect(r1.state?.phase_state['awaiting_byo_paste']).toBe(true)

    // Turn 2: paste the key.
    const pastePromptId = await activePromptId(h, RENAMED_SLUG)
    const r2 = await h.engine.advance({
      project_slug: RENAMED_SLUG,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: pastePromptId,
        choice_value: '__freeform__',
        freeform_text: 'sk-ant-api03-rename-survival-8',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r2.outcome).toBe('advanced')
    expect(r2.state?.phase).toBe('wow_fired')

    const byoPuts = h.putCalls.filter((p) => p.kind === 'byo_api_key')
    expect(byoPuts).toHaveLength(1)
    expect(byoPuts[0]!.internal_handle).toBe(FROZEN_HANDLE)
    expect(byoPuts[0]!.internal_handle).not.toBe(RENAMED_SLUG)
  })

  test('Test 9: attach_max → max_done after a slug rename → secrets.list/put use FROZEN internal_handle, read-back finds the persisted refresh row', async () => {
    const FROZEN_HANDLE = 't-frozen-9'
    const ORIGINAL_SLUG = 't-frozen-9'
    const RENAMED_SLUG = 'nova-renamed-9'
    h = makeHarness({
      maxOauthWired: true,
      secretsWired: true,
      internal_handle: FROZEN_HANDLE,
    })

    await seedMaxOauthOffered(h, ORIGINAL_SLUG)
    await h.stateStore.rekey(ORIGINAL_SLUG, RENAMED_SLUG, 'u-1')
    const initialPromptId = await activePromptId(h, RENAMED_SLUG)

    // Turn 1: tap attach_max. The stub simulates the upstream paste-token
    // write keyed under the FROZEN internal_handle (matches production
    // `auth/max-oauth.ts:persistPasteToken`), then returns the URL. Engine
    // re-emits with a Done button.
    const r1 = await h.engine.advance({
      project_slug: RENAMED_SLUG,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: initialPromptId,
        choice_value: 'attach_max',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r1.outcome).toBe('reemitted_current')
    expect(h.startHandoffCalls).toHaveLength(1)
    expect(h.startHandoffCalls[0]).toEqual({
      project_slug: RENAMED_SLUG,
      user_id: 'u-1',
    })

    // Refresh-row write went through under the FROZEN handle.
    const refreshPuts = h.putCalls.filter((p) => p.kind === 'max_oauth_refresh')
    expect(refreshPuts).toHaveLength(1)
    expect(refreshPuts[0]!.internal_handle).toBe(FROZEN_HANDLE)

    // Turn 2: tap Done — engine verifies via secrets.list. The list call
    // MUST be keyed by FROZEN_HANDLE for the read-back to find the row.
    const donePromptId = await activePromptId(h, RENAMED_SLUG)
    const r2 = await h.engine.advance({
      project_slug: RENAMED_SLUG,
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: donePromptId,
        choice_value: 'max_done',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r2.outcome).toBe('advanced')
    expect(r2.state?.phase).toBe('wow_fired')
    expect(r2.state?.phase_state['max_substrate']).toBe('max_oauth')

    // Verify: every secrets.list call used the FROZEN handle (not the
    // new url_slug). The harness's list stub filters by internal_handle
    // exactly, so the read-back success above also proves the round-trip.
    expect(h.listCalls.length).toBeGreaterThanOrEqual(1)
    for (const call of h.listCalls) {
      expect(call.internal_handle).toBe(FROZEN_HANDLE)
    }
  })
})

/**
 * Argus r1 IMPORTANT fix (2026-05-13): the awaiting-byo-paste spec emitted
 * zero options + allow_freeform=true, so a user who changed their mind
 * after picking BYO key had no escape hatch. Phase prompt now carries a
 * `Skip` button routed to substrate='free' via the same path as the
 * top-level skip.
 */
describe('buildMaxOauthOfferedPromptSpec — awaiting_byo_paste Skip option (Test 10)', () => {
  test('Test 10: awaiting_byo_paste spec carries a Skip option (Argus r1 IMPORTANT fix)', async () => {
    const { buildMaxOauthOfferedPromptSpec } = await import('../phase-prompts.ts')
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: true,
      rejection_reason: null,
    })
    expect(spec.options).toHaveLength(1)
    expect(spec.options[0]).toEqual({ label: 'A', body: 'Skip for now', value: 'skip' })
    expect(spec.allow_freeform).toBe(true)
  })
})

describe('InterviewEngine — BYO paste Skip escape hatch routing (Test 11)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('Test 11: byo_key → Skip on the paste prompt → advances to wow_fired with substrate="free"', async () => {
    h = makeHarness({ maxOauthWired: true, secretsWired: true })
    await seedMaxOauthOffered(h, 't-project-11')

    // Turn 1: tap byo_key — engine re-emits with the paste body + Skip
    // button.
    const initialPromptId = await activePromptId(h, 't-project-11')
    const r1 = await h.engine.advance({
      project_slug: 't-project-11',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: initialPromptId,
        choice_value: 'byo_key',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r1.outcome).toBe('reemitted_current')
    expect(r1.state?.phase_state['awaiting_byo_paste']).toBe(true)

    // Turn 2: tap Skip — engine MUST route through advanceFromMaxOauthOffered
    // with substrate='free' AND clear awaiting_byo_paste.
    const pastePromptId = await activePromptId(h, 't-project-11')
    const r2 = await h.engine.advance({
      project_slug: 't-project-11',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: pastePromptId,
        choice_value: 'skip',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(r2.outcome).toBe('advanced')
    expect(r2.state?.phase).toBe('wow_fired')
    expect(r2.state?.phase_state['max_substrate']).toBe('free')
    expect(r2.state?.phase_state['awaiting_byo_paste']).toBeNull()

    // Skip path must NOT have called the SecretsStore for a byo_api_key put.
    const byoPuts = h.putCalls.filter((p) => p.kind === 'byo_api_key')
    expect(byoPuts).toHaveLength(0)
  })
})

void beforeEach
