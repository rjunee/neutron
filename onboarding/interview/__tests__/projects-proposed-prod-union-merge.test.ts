/**
 * ISSUES #117 — GAP1 union on the PROD-wired path at `projects_proposed`.
 *
 * The r1 GAP1 additive merge (`union(seeded, extracted) minus removals`) was
 * wired into `consumeProjectsProposedChoice`, which reads
 * `drainPendingExtractedFieldsRaw` — populated ONLY by the `promptDriver`
 * engine dep. PRODUCTION wires `phaseSpecResolver` (which by contract "cannot
 * produce extracted_fields") + `llmRouter`, NOT `promptDriver`, so the drain is
 * never populated and that union is PROD-DEAD.
 *
 * On the live import flow this is harmless: `projects_proposed` is
 * auto-collapsed by `autoConfirmProjectsProposedAndAdvance`, and the live
 * `import_analysis_presented` router path got the additive union in #118/v165.
 * BUT a non-import (DTC) signup that reaches `projects_proposed` for real
 * surfaces a freeform edit there. The `projects_proposed` knowledge pack
 * (PACK_PROJECTS_PROPOSED) classifies "drop X" / "add Y" / "rename Z" as an
 * `amend` — so the live router routes it to the generic amend branch, which
 * `whitelistRouterStateDelta` → PLAIN-OVERWRITES `primary_projects` with the
 * router's extraction. When that extraction ANCHORS to the proposed list and
 * returns a SHORTER set (the exact 7→3 shrink Sam hit), the seeded additions
 * are silently lost and the `removed_projects` signal is whitelist-stripped.
 *
 * These tests drive the ACTUAL prod path — a freeform reply at
 * `projects_proposed` through the REAL
 * `engine.advance → llmRouter.route → dispatchRouterDecision` amend branch
 * (NOT a `promptDriver` stub, NOT a SQL-stub) — and assert the edit produces
 * the union `(seeded ∪ adds) minus removals` in `primary_projects`. That field
 * is the prod source of truth for project shells:
 * `autoConfirmProjectsProposedAndAdvance` copies `primary_projects` →
 * `primary_projects_confirmed`, and `03-project-shells.ts` builds one shell per
 * confirmed project.
 *
 * The engine is wired WITHOUT a `promptDriver` (mirroring production) so the
 * fix is proven on the prod-functional router path, not the dead drain.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { RouterDecision } from '../llm-router.ts'
import {
  stubRouter,
  stubPlatform,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

const OWNER = 't1'
const USER = 'u-1'
const TOPIC = 'topic-1'

const SEVEN = [
  'Topline',
  'Northwind',
  'Acme Studio',
  'Acme',
  'Info Product Playbooks',
  'Buddhism',
  'Biohacking',
]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-pp-union-'))
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

/** An `amend` edit whose extracted `primary_projects` ANCHORS to a SHORTER
 *  subset (the exact production shrink). The pack classifies "add/drop/rename"
 *  edits at projects_proposed as `amend`, so this is the realistic prod shape. */
function amendDecision(
  freeform_text: string,
  extracted: ReadonlyArray<string>,
  removed?: ReadonlyArray<string>,
): RouterDecision {
  return {
    action: 'amend',
    confidence: 0.95,
    choice_value: null,
    freeform_text: null,
    response: null,
    state_delta:
      removed !== undefined
        ? { primary_projects: [...extracted], removed_projects: [...removed] }
        : { primary_projects: [...extracted] },
    reasoning: 'test: projects_proposed freeform edit, anchored extraction',
  }
}

function makeEngine(decisions: ReadonlyArray<RouterDecision>): InterviewEngine {
  const { router } = stubRouter(decisions)
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    // NB no `promptDriver` — mirrors production (the drain path is dead).
    llmRouter: router,
    platform: stubPlatform('all'),
  })
}

/** Seed state at projects_proposed with the 7-project list + emit the (static)
 *  confirm prompt so the freeform reply resolves against a live allow_freeform
 *  button row, exactly as the live web client would on a DTC signup. */
async function seedAtProjectsProposed(engine: InterviewEngine): Promise<string> {
  await stateStore.upsert({
    project_slug: OWNER,
    user_id: USER,
    phase: 'projects_proposed',
    phase_state_patch: {
      primary_projects: [...SEVEN],
    },
    advanced_at: 1_700_000_000_000,
  })
  await engine.emitCurrentPhasePrompt({
    project_slug: OWNER,
    user_id: USER,
    topic_id: TOPIC,
    observed_at: 1_700_000_000_500,
  })
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) {
    throw new Error('no projects_proposed prompt emitted')
  }
  return sent.prompt.prompt_id
}

async function replyFreeform(
  engine: InterviewEngine,
  text: string,
  observed_at: number,
): Promise<void> {
  // Drive the REAL freeform path: a typed reply with NO matching ButtonChoice,
  // so normalAdvance hits the `freeform` interaction-mode branch → consults the
  // llmRouter → dispatchRouterDecision (amend branch for an edit).
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    freeform_text: text,
    observed_at,
  })
}

async function readState() {
  return await stateStore.get(OWNER, USER)
}

async function readPrimaryProjects(): Promise<ReadonlyArray<string>> {
  const s = await readState()
  const v = s?.phase_state['primary_projects']
  return Array.isArray(v) ? (v as string[]) : []
}

/** The projects_proposed LIST prompts actually handed to the channel sender
 *  (the enumerated body + the "Good to go" button row). Router acks emitted
 *  via `sendAgentText` carry `options: []`, so filtering on a non-empty
 *  button row isolates the list emissions from the ack lines. */
function sentListPrompts(): ReadonlyArray<ButtonPrompt> {
  return sentPrompts.filter((p) => p.prompt.options.length > 0).map((p) => p.prompt)
}

/** Argus r1 BLOCKER 2 (2026-06-10) — assert the post-edit list re-emit is
 *  USER-VISIBLE: a fresh prompt row actually handed to the sender (not a
 *  `reEmitKeyboard` of the stale body, not a dedupe-collapsed skip), with a
 *  FRESH prompt_id (the web client dedupes by prompt_id, so a same-id
 *  re-send renders NOTHING), and `active_prompt_id` rotated onto it so the
 *  next "Good to go" tap resolves against the live prompt. */
async function expectFreshListReEmit(
  seeded_prompt_id: string,
): Promise<ButtonPrompt> {
  const lists = sentListPrompts()
  expect(lists.length).toBe(2) // the seed emit + the post-edit re-emit
  const reemit = lists[1]!
  expect(reemit.prompt_id).not.toBe(seeded_prompt_id)
  const s = await readState()
  expect(s?.phase_state['active_prompt_id']).toBe(reemit.prompt_id)
  return reemit
}

describe('GAP1 prod-wired union at projects_proposed (router amend path, no promptDriver)', () => {
  test('an "add Y" edit whose extraction ANCHORS shorter keeps the full seeded list + the add (no silent shrink)', async () => {
    // Reproduce-first: user "also add Marathon Training"; the router anchors and
    // returns only [Topline, Northwind, Marathon Training] — dropping 5 seeded
    // projects (the 7→3 shrink). Pre-fix: plain overwrite → 3. Post-fix: union.
    const engine = makeEngine([
      amendDecision('also add Marathon Training', [
        'Topline',
        'Northwind',
        'Marathon Training',
      ]),
    ])
    const seeded_prompt_id = await seedAtProjectsProposed(engine)
    await replyFreeform(engine, 'also add Marathon Training', 1_700_000_001_000)
    const primary = await readPrimaryProjects()
    // Union with the seeded 7 → all 7 survive + the net-new add → 8.
    expect(primary.length).toBe(8)
    for (const p of SEVEN) expect(primary).toContain(p)
    expect(primary).toContain('Marathon Training')
    // The merged list must be re-rendered AND re-sent — a `reEmitKeyboard`
    // swap would re-send the STALE pre-edit body under the SAME prompt_id
    // (rendering nothing client-side); this fails on both axes.
    const reemit = await expectFreshListReEmit(seeded_prompt_id)
    expect(reemit.body).toContain('Marathon Training')
  })

  test('a "drop X" edit drops exactly the named project via removed_projects (anchored restate does not shrink the rest)', async () => {
    // user "drop Biohacking"; router anchors the restated kept list to just
    // [Topline, Northwind] but names the removal explicitly. Pre-fix: plain
    // overwrite → 2 (4 others silently lost). Post-fix: union minus removal → 6.
    const engine = makeEngine([
      amendDecision('drop Biohacking', ['Topline', 'Northwind'], ['Biohacking']),
    ])
    const seeded_prompt_id = await seedAtProjectsProposed(engine)
    await replyFreeform(engine, 'drop Biohacking', 1_700_000_001_000)
    const primary = await readPrimaryProjects()
    expect(primary).not.toContain('Biohacking')
    for (const p of SEVEN.filter((p) => p !== 'Biohacking')) {
      expect(primary).toContain(p)
    }
    expect(primary.length).toBe(6)
    const reemit = await expectFreshListReEmit(seeded_prompt_id)
    expect(reemit.body).not.toContain('Biohacking')
  })

  test('a combined "drop X, add Y" edit → (seeded ∪ adds) minus removals', async () => {
    const engine = makeEngine([
      amendDecision(
        'drop Biohacking and add Marathon Training',
        ['Topline', 'Marathon Training'],
        ['Biohacking'],
      ),
    ])
    const seeded_prompt_id = await seedAtProjectsProposed(engine)
    await replyFreeform(
      engine,
      'drop Biohacking and add Marathon Training',
      1_700_000_001_000,
    )
    const primary = await readPrimaryProjects()
    expect(primary).not.toContain('Biohacking')
    expect(primary).toContain('Marathon Training')
    for (const p of SEVEN.filter((p) => p !== 'Biohacking')) {
      expect(primary).toContain(p)
    }
    // 7 seeded − Biohacking + Marathon Training = 7.
    expect(primary.length).toBe(7)
    const reemit = await expectFreshListReEmit(seeded_prompt_id)
    expect(reemit.body).toContain('Marathon Training')
    expect(reemit.body).not.toContain('Biohacking')
  })

  test('a rename ("rename CC to Contemplative Crossfit") replaces the old name (removed_projects:[old] + primary_projects:[new]) — Codex r1 P2', async () => {
    // The router emits the NEW name in primary_projects AND the OLD name in
    // removed_projects (per the PACK_PROJECTS_PROPOSED rename contract). The
    // union keeps the rest, adds the new name, and subtracts the old — no
    // duplicate shell for both names.
    const renameSeed = ['Topline', 'Northwind', 'CC', 'Acme']
    await stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'projects_proposed',
      phase_state_patch: { primary_projects: [...renameSeed] },
      advanced_at: 1_700_000_000_000,
    })
    const engine = makeEngine([
      amendDecision(
        'rename CC to Contemplative Crossfit',
        ['Contemplative Crossfit'],
        ['CC'],
      ),
    ])
    await engine.emitCurrentPhasePrompt({
      project_slug: OWNER,
      user_id: USER,
      topic_id: TOPIC,
      observed_at: 1_700_000_000_500,
    })
    const seeded = sentListPrompts()
    expect(seeded.length).toBe(1)
    await replyFreeform(
      engine,
      'rename CC to Contemplative Crossfit',
      1_700_000_001_000,
    )
    const primary = await readPrimaryProjects()
    expect(primary).not.toContain('CC')
    expect(primary).toContain('Contemplative Crossfit')
    for (const p of ['Topline', 'Northwind', 'Acme']) {
      expect(primary).toContain(p)
    }
    // 4 seeded − CC + Contemplative Crossfit = 4 (no duplicate).
    expect(primary.length).toBe(4)
    const reemit = await expectFreshListReEmit(seeded[0]!.prompt_id)
    expect(reemit.body).toContain('Contemplative Crossfit')
    // The OLD standalone name must be gone from the rendered list ("CC" as a
    // whole list entry, not the substring inside other words).
    expect(reemit.body).not.toMatch(/^\d+\. CC$/m)
  })

  test('a NO-OP edit whose re-render is BYTE-IDENTICAL to the delivered prompt still SENDS a fresh prompt row (Argus r1 BLOCKER 1 — dedupe-collapse send-skip)', async () => {
    // "keep Topline" anchors to ['Topline'] ⊆ the seeded 7 with no removals → the
    // additive union is EXACTLY the seeded list (same order), so
    // `buildProjectsProposedPromptSpec` renders a body byte-identical to the
    // already-delivered seed prompt. Without a `seed_suffix` folded into the
    // emit's idempotency seed, the key collapses onto that delivered row
    // (was_new=false, was_delivered=true) and `sendButtonPrompt` is SKIPPED —
    // the user gets the ack but the list never re-renders (the client dedupes
    // by prompt_id; same idempotency bug class as #115/#116). This test is
    // RED against the seed-suffix-less re-emit and GREEN with it.
    const engine = makeEngine([amendDecision('keep Topline', ['Topline'])])
    const seeded_prompt_id = await seedAtProjectsProposed(engine)
    await replyFreeform(engine, 'keep Topline', 1_700_000_001_000)
    const primary = await readPrimaryProjects()
    expect(primary.length).toBe(7) // union no-op — list unchanged
    for (const p of SEVEN) expect(primary).toContain(p)
    await expectFreshListReEmit(seeded_prompt_id)
  })

  test('the transient removed_projects signal never persists into phase_state, and the phase stays projects_proposed', async () => {
    const engine = makeEngine([
      amendDecision('drop Biohacking', ['Topline', 'Northwind'], ['Biohacking']),
    ])
    await seedAtProjectsProposed(engine)
    await replyFreeform(engine, 'drop Biohacking', 1_700_000_001_000)
    const s = await readState()
    expect(s?.phase).toBe('projects_proposed')
    expect(s?.phase_state['removed_projects']).toBeUndefined()
  })

  test('router UNAVAILABLE: a populated-list edit keeps the buttons-only nudge — it must NOT silently confirm/advance (Codex r1 P2)', async () => {
    // Without an `llmRouter` wired (a non-router deployment), the interaction-mode
    // override must NOT fire — otherwise the edit would fall through the freeform
    // branch to the synthetic `__freeform__` → consumeProjectsProposedChoice path,
    // which treats it as a CONFIRM and advances to persona synthesis with the
    // UNCHANGED list (worse than the prior nudge). The guard keeps it buttons-only.
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      // NB no `llmRouter` and no `promptDriver` — a non-router deployment.
      platform: stubPlatform('all'),
    })
    await seedAtProjectsProposed(engine)
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'drop Biohacking',
      observed_at: 1_700_000_001_000,
    })
    // Stays on the phase (nudge), NEVER auto-advances to persona_synthesizing.
    expect(out.state?.phase).toBe('projects_proposed')
    const primary = await readPrimaryProjects()
    expect(primary.length).toBe(7)
    for (const p of SEVEN) expect(primary).toContain(p)
  })

  test('a non-project amend (no primary_projects / removed_projects signal) leaves the seeded list untouched', async () => {
    const engine = makeEngine([
      {
        action: 'amend',
        confidence: 0.95,
        choice_value: null,
        freeform_text: null,
        response: null,
        state_delta: { non_work_interests: ['climbing'] },
        reasoning: 'test: off-screen fact, no project delta',
      },
    ])
    const seeded_prompt_id = await seedAtProjectsProposed(engine)
    await replyFreeform(engine, 'btw I climb on weekends', 1_700_000_001_000)
    const primary = await readPrimaryProjects()
    expect(primary.length).toBe(7)
    for (const p of SEVEN) expect(primary).toContain(p)
    // The untouched list re-renders byte-identical — the same dedupe-collapse
    // class as the no-op edit above; the re-emit must still reach the user.
    await expectFreshListReEmit(seeded_prompt_id)
  })
})
