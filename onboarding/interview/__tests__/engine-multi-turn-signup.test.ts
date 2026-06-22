/**
 * Argus r1 (2026-05-10) — end-to-end signup integration.
 *
 * 2026-06-21 (onboarding-engine consolidation) — the dead `promptDriver`
 * extraction seam (never wired in production) was removed. The original
 * suite's headline test replayed a 4-turn conversation that STAYED on
 * signup for three turns and advanced on the fourth, driven entirely by
 * the scripted driver's `next_phase_on_default: 'signup'` stay signal.
 * That multi-turn-stay capability was a pure driver-internal behavior; the
 * surviving engine advances signup on the FIRST name-bearing reply (the
 * 2026-06-19 BUG 1 double-ask fix), so there is no seam that can keep
 * signup parked across multiple name-bearing turns. That test had no
 * analog under the surviving wiring and was removed (see git history /
 * `signup-router-prod-path.test.ts` + `engine-router-integration.test.ts`
 * for the router-driven signup-advance contract that replaced it).
 *
 * What survives here is the static-fallback contract: with NO `platform`
 * adapter wired, `shouldConsultRouter` short-circuits to false, so the
 * engine runs the deterministic STATIC heuristic capture path. The first
 * user reply advances signup → instance_provisioned → (auto-skip) →
 * import_offered and the captured first name lands on
 * `phase_state.user_first_name`.
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

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-multi-turn-'))
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

describe('InterviewEngine — signup end-to-end (static heuristic path)', () => {
  test('static fallback (no router) advances signup → instance_provisioned → (auto-skip) → import_offered on first reply', async () => {
    // With no `platform` adapter wired, `shouldConsultRouter`
    // short-circuits to false, so the engine runs the STATIC heuristic
    // path: STATIC_PHASE_SPECS.signup returns
    // next_phase_on_default='instance_provisioned' (post-T9). The very
    // first user reply advances and the AUTO_SKIP_PHASES walker chains
    // through instance_provisioned to import_offered (the first
    // interactive prompt after signup per § 2.3). This preserves the
    // LLM-unwired safety net while routing through every spec'd phase.
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })
    const project = 't1'
    const topic = 'web:u-1'
    await engine.start({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      signup_via: 'web',
    })
    await engine.advance({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: 'Sam',
    })
    const state = await stateStore.get(project, 'u-1')
    expect(state!.phase).toBe('ai_substrate_offered')
    // P2 v2 S3 (2026-05-16, Codex r1 P1) — signup writes the user's
    // first name to `phase_state.user_first_name`, not `agent_name`.
    // The agent's name is collected later at the dedicated
    // `agent_name_chosen` phase (§ 3.10). Pre-S3 the static-fallback
    // heuristic conflated the two; v2 separates them.
    expect(state!.phase_state['user_first_name']).toBe('Sam')
    expect(state!.phase_state['agent_name']).toBeUndefined()
  })
})
