/**
 * 2026-05-13 — no-restart slug rename: engine.start lazy-rekey via
 * slug_history. Codex r2 BLOCKING finding on PR #85: after a rename +
 * gateway restart, `expected_project_slug` flips to NEW (from `.url_slug`)
 * but the onboarding-state row is still keyed under OLD — so the very
 * next `engine.start(NEW)` resets the user to S1.
 *
 * The fix is a lazy rekey at the top of `engine.start`: when no row
 * exists under the requested slug AND `slugHistory` + `internal_handle`
 * are wired, look up the old slugs for THIS instance (cross-project safety
 * is enforced by the internal_handle scope), find the row under any
 * old slug, and rekey it to the requested new slug.
 *
 * These three tests cover:
 *   1. RESTARTED gateway: row under OLD slug, lookup with NEW → rekey
 *      fires + row materialises under NEW on the next direct read.
 *   2. Persistence: a second start(NEW) hits the direct path with no
 *      slug-history lookup (the rekey is durable).
 *   3. Cross-project safety: same row + slug_history, but
 *      `internal_handle` mismatches → fallback returns nothing, the row
 *      stays under OLD, the wrong instance gets a fresh signup row.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { InterviewEngine, type SlugHistoryLookup } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

const INTERNAL_HANDLE = 't-aaaaaaaa'
const OLD_SLUG = 't-aaaaaaaa'
const NEW_SLUG = 'nova'
const WRONG_INTERNAL_HANDLE = 't-bbbbbbbb'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
let slugHistoryCalls: Array<string>

function makeSlugHistory(map: Record<string, string[]>): SlugHistoryLookup {
  return {
    async listOldSlugsForInternalHandle(ih: string): Promise<string[]> {
      slugHistoryCalls.push(ih)
      return map[ih] ?? []
    },
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-slughist-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  slugHistoryCalls = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('InterviewEngine.start — slug_history lazy-rekey (no-restart rename)', () => {
  test('RESTARTED gateway: row under OLD slug, start(NEW) rekeys to NEW', async () => {
    // Provision in-progress onboarding state under the OLD slug, past
    // signup so the start() guard treats it as a returning user.
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: OLD_SLUG,
      phase: 'work_interview_gap_fill',
      phase_state_patch: { agent_name: 'Athena', signup_via: 'telegram' },
      advanced_at: 1_000,
    })
    const before_old = await stateStore.get(OLD_SLUG, 'u-1')
    expect(before_old?.phase).toBe('work_interview_gap_fill')
    const before_new = await stateStore.get(NEW_SLUG, 'u-1')
    expect(before_new).toBeNull()

    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      internal_handle: INTERNAL_HANDLE,
      slugHistory: makeSlugHistory({ [INTERNAL_HANDLE]: [OLD_SLUG] }),
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })

    // Simulate the restarted gateway: JWT-shim collapsed everything to
    // NEW (per the prior fix), so the engine receives start(NEW). The
    // fallback should find the OLD row + rekey it to NEW.
    const out = await engine.start({
      project_slug: NEW_SLUG,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })

    // The engine surfaced the existing state (not a fresh signup row).
    expect(out.state.phase).toBe('work_interview_gap_fill')
    expect(out.state.project_slug).toBe(NEW_SLUG)
    expect(out.state.phase_state.agent_name).toBe('Athena')

    // The row now lives under NEW, not OLD.
    const after_new = await stateStore.get(NEW_SLUG, 'u-1')
    expect(after_new?.phase).toBe('work_interview_gap_fill')
    expect(after_new?.project_slug).toBe(NEW_SLUG)
    const after_old = await stateStore.get(OLD_SLUG, 'u-1')
    expect(after_old).toBeNull()

    // The fallback was consulted exactly once for THIS instance's handle.
    expect(slugHistoryCalls).toEqual([INTERNAL_HANDLE])
  })

  test('rekey is durable: a second start(NEW) finds the row directly without re-firing slug-history fallback (live-gateway WS-flow guard)', async () => {
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: OLD_SLUG,
      phase: 'work_interview_gap_fill',
      phase_state_patch: { agent_name: 'Athena', signup_via: 'telegram' },
      advanced_at: 1_000,
    })
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      internal_handle: INTERNAL_HANDLE,
      slugHistory: makeSlugHistory({ [INTERNAL_HANDLE]: [OLD_SLUG] }),
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })
    // First start(NEW): triggers the fallback, rekeys.
    await engine.start({
      project_slug: NEW_SLUG,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(slugHistoryCalls.length).toBe(1)
    expect((await stateStore.get(NEW_SLUG, 'u-1'))?.phase).toBe('work_interview_gap_fill')

    // Second start(NEW): hits the direct path (the row is under NEW
    // now). The slug-history fallback only fires when the direct
    // lookup misses, so it should NOT be consulted again.
    const second = await engine.start({
      project_slug: NEW_SLUG,
      topic_id: 'topic-2',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(second.state.phase).toBe('work_interview_gap_fill')
    expect(slugHistoryCalls.length).toBe(1)
  })

  test('CROSS-PROJECT safety: a different internal_handle cannot rekey-pull state from this project', async () => {
    // Set up THIS instance's in-progress row under OLD slug, with a
    // slug_history mapping scoped to THIS internal_handle.
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: OLD_SLUG,
      phase: 'work_interview_gap_fill',
      phase_state_patch: { agent_name: 'Athena', signup_via: 'telegram' },
      advanced_at: 1_000,
    })
    const slugHistoryMap = makeSlugHistory({ [INTERNAL_HANDLE]: [OLD_SLUG] })

    // The other instance's engine boots with a DIFFERENT internal_handle.
    // Even with the same slug-history adapter wired, the lookup for the
    // wrong internal_handle returns no old slugs → no rekey → the row
    // stays under OLD for THIS instance.
    const otherEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      internal_handle: WRONG_INTERNAL_HANDLE,
      slugHistory: slugHistoryMap,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })
    const out = await otherEngine.start({
      project_slug: NEW_SLUG,
      topic_id: 'topic-cross',
      user_id: 'u-evil',
      signup_via: 'web',
    })

    // The cross-project call did NOT pull this instance's state. It got
    // a fresh signup row keyed under NEW (the cross-project's
    // "project_slug" arg), and OLD-keyed state is untouched.
    expect(out.state.phase).toBe('signup')
    expect(out.state.project_slug).toBe(NEW_SLUG)
    const this_owner_state = await stateStore.get(OLD_SLUG, 'u-1')
    expect(this_owner_state?.phase).toBe('work_interview_gap_fill')
    expect(this_owner_state?.phase_state.agent_name).toBe('Athena')

    // The fallback WAS consulted (engine made the call), but with the
    // wrong internal_handle so the lookup returned [] → no rekey path.
    expect(slugHistoryCalls).toEqual([WRONG_INTERNAL_HANDLE])
  })

  test('back-compat: engine without slugHistory wired behaves exactly as before — no fallback, fresh signup row', async () => {
    // Old onboarding row exists under OLD slug, but the engine has no
    // slugHistory dep. start(NEW) must NOT find the OLD row and must
    // create a fresh signup row under NEW (matching pre-2026-05-13
    // behaviour — the failure mode this sprint fixes).
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: OLD_SLUG,
      phase: 'work_interview_gap_fill',
      phase_state_patch: { agent_name: 'Athena', signup_via: 'telegram' },
      advanced_at: 1_000,
    })
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      // No slugHistory, no internal_handle.
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })
    const out = await engine.start({
      project_slug: NEW_SLUG,
      topic_id: 'topic-bc',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(out.state.phase).toBe('signup')
    expect(out.state.project_slug).toBe(NEW_SLUG)
    expect(slugHistoryCalls.length).toBe(0)
  })
})
