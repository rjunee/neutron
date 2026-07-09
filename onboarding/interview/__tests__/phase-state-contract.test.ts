/**
 * phase_state JSON MERGE contract (K4a verifier amendment; narrowed
 * K11a6-rem).
 *
 * The shared `phase_state` JSON object is written by ~113 test files and read
 * across the whole onboarding engine, yet its load-bearing MERGE invariant was
 * pinned by NO focused test:
 *
 *   MERGE  (state-store.ts / sqlite-state-store.ts `upsert`): every upsert
 *          SHALLOW-merges `phase_state_patch` over the existing `phase_state`
 *          — patch keys override, unlisted keys are preserved, and a `null`
 *          value in the patch is STORED as null (this is how the retained
 *          writers CLEAR `active_prompt_id`). Both the in-memory and the
 *          SQLite (JSON-column) stores MUST agree so the runtime can swap them.
 *
 * This half drives the REAL merge through the RETAINED writer seam
 * (`stateStore.upsert`) directly — the same literal-key upsert path the
 * post-K11b1 phase_state writers (`notifyImportUploadLocked`, the import cron,
 * `import-resume-handler`, the post-turn extractor `buildPhaseStatePatch`,
 * `on_session_open` re-arm) all funnel through. No mocks past the store seam;
 * both real stores run.
 *
 * NOTE (K11a6-rem re-anchor, decision D-K11-6): the sibling router-amend
 * WHITELIST half — which imported `ROUTER_AMEND_ALLOWED_KEYS` /
 * `ROUTER_AMEND_SUBSTRATE_VALUES` and drove `whitelistRouterStateDelta` through
 * `engine.advance` — was REMOVED here. That guard is part of the
 * conversational-drive router path (`dispatchRouterDecision` /
 * `whitelistRouterStateDelta`) that K11b1 deletes, so it pinned dead-in-prod
 * behavior. The MERGE contract below survives because it drives a retained
 * writer, not the interview engine.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  InMemoryOnboardingStateStore,
  type OnboardingStateStore,
} from '../state-store.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'

// ---------------------------------------------------------------------------
// Store MERGE contract (both real stores) — the retained writer seam.
// ---------------------------------------------------------------------------

describe('phase_state MERGE contract — both stores agree', () => {
  let tmp: string
  let db: ProjectDb
  let inMemory: InMemoryOnboardingStateStore
  let sqlite: SqliteOnboardingStateStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-phase-state-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    inMemory = new InMemoryOnboardingStateStore()
    sqlite = new SqliteOnboardingStateStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function eachStore(): ReadonlyArray<[string, OnboardingStateStore]> {
    return [
      ['in-memory', inMemory],
      ['sqlite', sqlite],
    ]
  }

  test('first upsert (no existing row) → phase_state === the patch', async () => {
    for (const [label, store] of eachStore()) {
      const out = await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { a: 1, b: 'x' },
        advanced_at: 1_000,
      })
      expect(out.phase_state, label).toEqual({ a: 1, b: 'x' })
    }
  })

  test('a patch SHALLOW-merges: patch keys override, unlisted keys are preserved', async () => {
    for (const [label, store] of eachStore()) {
      await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { keep: 'me', override: 'old' },
        advanced_at: 1_000,
      })
      const out = await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { override: 'new', added: true },
        advanced_at: 2_000,
      })
      expect(out.phase_state, label).toEqual({
        keep: 'me',
        override: 'new',
        added: true,
      })
    }
  })

  test('a null value in the patch is STORED as null (the active_prompt_id CLEAR contract) and does not drop sibling keys', async () => {
    for (const [label, store] of eachStore()) {
      await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { active_prompt_id: 'prompt-1', sibling: 'kept' },
        advanced_at: 1_000,
      })
      const out = await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { active_prompt_id: null },
        advanced_at: 2_000,
      })
      // The key survives with an explicit null (NOT deleted) so a
      // duplicate-start guard reads it as "no in-flight prompt".
      expect('active_prompt_id' in out.phase_state, label).toBe(true)
      expect(out.phase_state['active_prompt_id'], label).toBeNull()
      // The unrelated key is untouched.
      expect(out.phase_state['sibling'], label).toBe('kept')
    }
  })

  test('sqlite JSON column round-trips nested objects + arrays with fidelity', async () => {
    const nested = {
      auxiliary_facts: { likes: ['climbing', 'coffee'], meta: { tier: 2 } },
      primary_projects: ['Northwind', 'Acme'],
    }
    await sqlite.upsert({
      project_slug: 'p-json',
      user_id: 'u-1',
      phase: 'signup',
      phase_state_patch: nested,
      advanced_at: 1_000,
    })
    // Read back through a FRESH store instance so the value comes off disk
    // via JSON.parse, not an in-process cache.
    const fresh = new SqliteOnboardingStateStore({ db })
    const got = await fresh.get('p-json', 'u-1')
    expect(got?.phase_state['auxiliary_facts']).toEqual(nested.auxiliary_facts)
    expect(got?.phase_state['primary_projects']).toEqual(nested.primary_projects)
  })

  test('the two stores produce byte-identical merged phase_state for the same patch sequence', async () => {
    const sequence: ReadonlyArray<Record<string, unknown>> = [
      { user_first_name: 'Sam', active_prompt_id: 'p1' },
      { primary_projects: ['A', 'B'], active_prompt_id: null },
      { user_first_name: 'Sam Doe', extra: { nested: true } },
    ]
    for (let i = 0; i < sequence.length; i += 1) {
      await inMemory.upsert({
        project_slug: 'parity',
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: sequence[i]!,
        advanced_at: 1_000 + i,
      })
      await sqlite.upsert({
        project_slug: 'parity',
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: sequence[i]!,
        advanced_at: 1_000 + i,
      })
    }
    const a = await inMemory.get('parity', 'u-1')
    const b = await sqlite.get('parity', 'u-1')
    expect(a?.phase_state).toEqual(b?.phase_state ?? {})
  })
})
