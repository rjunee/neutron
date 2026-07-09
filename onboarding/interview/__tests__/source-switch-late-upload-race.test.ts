/**
 * Integration tests — explicit source-switch vs late upload of the
 * ABANDONED source (ISSUES #98).
 *
 * Symptom this reproduces: a user is mid-ChatGPT-upload at
 * `import_upload_pending` and types an explicit switch ("can I do Claude
 * instead?"). The freeform reroutes to the source picker
 * (`ai_substrate_offered`), preserving `ai_substrate_used=chatgpt`
 * (non-destructive re-emit, Argus r2). The ChatGPT upload then completes
 * BEFORE the user taps Claude and lands at `ai_substrate_offered`. The
 * pre-fix late-upload-tolerance branch auto-imported the ABANDONED ChatGPT
 * source because `ai_substrate_used` still read `chatgpt` and matched the
 * upload — silently honoring the source the user was leaving.
 *
 * The fix (ISSUES #98): the reroute records `source_switch_intent` when the
 * freeform UNAMBIGUOUSLY names a DIFFERENT source than the staged one. The
 * late-upload path refuses to auto-honor an upload of the abandoned source
 * once an intent points elsewhere, surfacing the visible re-pick notice
 * instead. A bare clarification (no source token) records NO intent, so the
 * legitimate concurrent-upload auto-honor (Argus r1) is preserved.
 *
 * K11a6 re-anchor (2026-07-06): the RETAINED half these tests pin is
 * `notifyImportUpload`'s late-upload arbitration — given a
 * `ai_substrate_offered` state carrying `ai_substrate_used` (+ optionally
 * `source_switch_intent`), does a late upload of source X get honored
 * (→ `import_running`) or refused (→ `no_active_prompt` + the "switching
 * services" notice)? That decision is a pure function of the persisted
 * state, and `notifyImportUpload` is the RETAINED entry point (the upload
 * POST route). The freeform DRIVE that WROTE `source_switch_intent`
 * (`engine.advance` → `normalAdvance` → the router reroute) is the
 * dead-in-prod interview-engine conversational drive K11b1 deletes, so we
 * no longer drive it: we seed the exact post-reroute state via
 * `stateStore.upsert` and assert `notifyImportUpload`'s arbitration
 * directly. The source-token DETECTOR half already split out to
 * `./import-source-copy.test.ts` beside `../import-source-copy.ts`.
 *
 * The still-live-at-HEAD intent WRITE/CLEAR path those tests also carried
 * (`reEmitImportSourceSelection` computes+persists `source_switch_intent`;
 * `reconcileSwitchIntentFromFreeform` clears/updates it — both via the dying
 * `engine.advance`/`normalAdvance`) is preserved, driven through the real
 * path, in `./source-switch-intent-write.die.test.ts` (co-deletes in K11b1),
 * so this seeded re-anchor does not un-pin that code before K11b1 deletes it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '../engine.ts'
import type { ImportJob } from '../../history-import/types.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { OnboardingPhase } from '../phase.ts'

const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

function buildEngine(opts: {
  importJobRunner?: ImportJobRunnerHook
  importPayloadResolver?: ImportPayloadResolver
}): InterviewEngine {
  const deps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  }
  if (opts.importJobRunner !== undefined) deps.importJobRunner = opts.importJobRunner
  if (opts.importPayloadResolver !== undefined)
    deps.importPayloadResolver = opts.importPayloadResolver
  return new InterviewEngine(deps)
}

/** A runner + resolver that record the sources they're asked to import, so
 *  a test can assert the staged source was (or was NOT) actually imported. */
function stubImportStack(): {
  importJobRunner: ImportJobRunnerHook
  importPayloadResolver: ImportPayloadResolver
  startedSources: string[]
} {
  const startedSources: string[] = []
  let jobSeq = 0
  const importJobRunner: ImportJobRunnerHook = {
    start: async (input) => {
      startedSources.push(input.source)
      jobSeq += 1
      return { job_id: `job-${jobSeq}` }
    },
    status: async (): Promise<ImportJob | null> => null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const importPayloadResolver: ImportPayloadResolver = {
    // `ChunkerInput` is a `Buffer`; a non-null payload routes the
    // engine into the import-running path (a null would re-emit "I don't see
    // your export yet"). An empty buffer suffices — the stub runner ignores it.
    resolve: async () => Buffer.from(''),
  }
  return { importJobRunner, importPayloadResolver, startedSources }
}

const NOW_MS = Date.now()

/**
 * K11a6 — seed the exact state the (now-deleted) freeform reroute would have
 * left behind, so `notifyImportUpload`'s late-upload arbitration is driven by
 * persisted state alone. `phase` is the post-reroute phase
 * (`ai_substrate_offered` for a reroute, `import_upload_pending` for a settled
 * tap); `patch` carries `ai_substrate_used` (the staged/non-destructively
 * preserved source) and optionally `source_switch_intent` (the source the user
 * moved TO). Clears `sentPrompts` so a test only sees the upload's own sends.
 */
async function seedState(
  phase: OnboardingPhase,
  patch: Record<string, unknown>,
): Promise<void> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase,
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
      ...patch,
    },
    advanced_at: NOW_MS,
  })
  sentPrompts.length = 0
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-source-switch-race-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// K11a3: the `detectImportSourceMention` — deterministic source-token
// detector` unit-test describe block moved verbatim to
// `./import-source-copy.test.ts` beside the new leaf module
// (`../import-source-copy.ts`). This file keeps the late-upload arbitration
// half, re-anchored (K11a6) onto notifyImportUpload + stateStore.
describe('ISSUES #98 — explicit switch must not auto-import the abandoned source', () => {
  /** THE core reproduce: after an explicit Claude switch (state at
   *  `ai_substrate_offered` with `source_switch_intent=claude` while the
   *  staged `ai_substrate_used=chatgpt` was preserved), a late ChatGPT upload
   *  must NOT auto-import chatgpt. */
  test('explicit Claude switch then late ChatGPT upload does NOT auto-import chatgpt', async () => {
    const stack = stubImportStack()
    const engine = buildEngine(stack)

    // Post-reroute state: the user typed an explicit switch to Claude, so the
    // reroute recorded switch-intent=claude but preserved the staged chatgpt.
    await seedState('ai_substrate_offered', {
      ai_substrate_used: 'chatgpt',
      source_switch_intent: 'claude',
    })

    // The abandoned ChatGPT upload completes AFTER the switch but BEFORE a tap.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'chatgpt',
      observed_at: NOW_MS + 2_000,
    })

    // It must NOT be auto-imported.
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
    // The phase did not advance to import_running.
    const after = await stateStore.get(OWNER, USER)
    expect(after?.phase).toBe('ai_substrate_offered')
    // A visible re-pick notice was surfaced (not a silent drop).
    const texts = sentPrompts.map((p) => p.prompt.body)
    expect(texts.some((b) => /switching services/i.test(b))).toBe(true)
  })

  /** Argus r1 regression guard: a BARE clarification (no source token) records
   *  no switch-intent, so a matching late upload IS still auto-honored — the
   *  concurrent-upload race fix must survive ISSUES #98. */
  test('bare clarification then matching late upload still auto-imports (Argus r1 preserved)', async () => {
    const stack = stubImportStack()
    const engine = buildEngine(stack)

    // Post-reroute state after a non-switch clarification: rerouted to the
    // picker but NO intent recorded, staged chatgpt preserved.
    await seedState('ai_substrate_offered', {
      ai_substrate_used: 'chatgpt',
    })

    // The user's own ChatGPT upload lands → honored, not orphaned.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'chatgpt',
      observed_at: NOW_MS + 2_000,
    })

    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['chatgpt-zip'])
    expect(out.state?.phase).toBe('import_running')
  })

  /** If the user switches AND then their NEW source's upload lands, it is also
   *  not auto-run without a fresh tap (the staged `ai_substrate_used` still
   *  points at the old source), and is surfaced rather than dropped. */
  test('explicit switch then late NEW-source upload is surfaced, not auto-run', async () => {
    const stack = stubImportStack()
    const engine = buildEngine(stack)

    await seedState('ai_substrate_offered', {
      ai_substrate_used: 'chatgpt',
      source_switch_intent: 'claude',
    })

    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 2_000,
    })

    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
  })

  /** A real source tap CLEARS the recorded intent and re-stages
   *  `ai_substrate_used=claude` at `import_upload_pending`: a subsequent Claude
   *  upload is then honored normally. */
  test('tapping the new source clears switch-intent so its upload is honored', async () => {
    const stack = stubImportStack()
    const engine = buildEngine(stack)

    // Settled post-tap state: tapping Claude resolved the intent (cleared) and
    // set ai_substrate_used=claude, parking at import_upload_pending.
    await seedState('import_upload_pending', {
      ai_substrate_used: 'claude',
    })

    // Now the Claude upload lands → honored.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 3_000,
    })
    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['claude-zip'])
    expect(out.state?.phase).toBe('import_running')
  })

  /** Argus r1b IMPORTANT — negation-blind detector regression guard. A NEGATED
   *  mention of the other source ("I don't have a GPT export") mid Claude-upload
   *  records NO switch-intent, so the rerouted state carries the staged
   *  `ai_substrate_used=claude` with no intent — and the user's own legitimate
   *  Claude upload is still honored, not falsely refused. (The negation
   *  detection itself is pinned in ./import-source-copy.test.ts.) */
  test('negated other-source mention does NOT refuse the in-flight upload', async () => {
    const stack = stubImportStack()
    const engine = buildEngine(stack)

    // Rerouted with NO intent (the mention was negated), staged claude preserved.
    await seedState('ai_substrate_offered', {
      ai_substrate_used: 'claude',
    })

    // The user's own Claude upload lands → honored, NOT refused.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 2_000,
    })

    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['claude-zip'])
    expect(out.state?.phase).toBe('import_running')
  })

  /** Argus r1b MINOR — stale intent cleared on a freeform "undo" at
   *  ai_substrate_offered. After an explicit Claude switch, a restated
   *  "no, keep chatgpt" reconciles the intent back to the staged source
   *  (cleared), so the in-flight ChatGPT upload is honored rather than
   *  refused. */
  test('restated "keep chatgpt" at picker clears stale intent so its upload runs', async () => {
    const stack = stubImportStack()
    const engine = buildEngine(stack)

    // Reconciled state: the restated "keep chatgpt" cleared the stale
    // source_switch_intent back to the staged chatgpt.
    await seedState('ai_substrate_offered', {
      ai_substrate_used: 'chatgpt',
    })

    // The in-flight ChatGPT upload lands → honored, not refused.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'chatgpt',
      observed_at: NOW_MS + 2_000,
    })

    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['chatgpt-zip'])
    expect(out.state?.phase).toBe('import_running')
  })
})
