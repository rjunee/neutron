/**
 * F8 — `completeIfPhaseStateMatches` atomic compare-and-set completion.
 *
 * The finalizer's terminal write must be atomic against a concurrent durable
 * mutation: `completed` may be stamped ONLY when the row's phase_state is still
 * exactly what the finalizer composed + materialized. These pin that contract on
 * BOTH `InMemoryOnboardingStateStore` and `SqliteOnboardingStateStore`:
 *   - matches unchanged state → completes, returns true.
 *   - phase_state changed since the read → NO-OP, returns false.
 *   - already terminal (completed/failed) → NO-OP, returns false.
 *   - absent row → false.
 * Anti-pattern guard: every assert reads the store back.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { InMemoryOnboardingStateStore, type OnboardingStateStore } from '../state-store.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'

const OWNER = 't1'
const USER = 'user-A'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-cas-complete-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeImpls(): Array<{ name: string; store: OnboardingStateStore }> {
  return [
    { name: 'InMemory', store: new InMemoryOnboardingStateStore() },
    { name: 'Sqlite', store: new SqliteOnboardingStateStore({ db }) },
  ]
}

test('completes iff phase_state is unchanged since the read', async () => {
  for (const { name, store } of makeImpls()) {
    const row = await store.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'persona_reviewed',
      phase_state_patch: { primary_projects: ['Alpha'], agent_name: 'Atlas' },
    })

    const ok = await store.completeIfPhaseStateMatches({
      project_slug: OWNER,
      user_id: USER,
      expected_phase_state: row.phase_state,
      completed_at: 123,
    })
    expect(ok, `${name}: matched CAS completes`).toBe(true)
    const after = await store.get(OWNER, USER)
    expect(after?.phase, `${name}: phase flipped`).toBe('completed')
    expect(after?.completed_at, `${name}: completed_at stamped`).toBe(123)
    expect(after?.wow_fired, `${name}: wow_fired stamped`).toBe(true)

    await store.deleteByOwner(OWNER)
  }
})

test('does NOT complete when phase_state changed since the read (returns false, row untouched)', async () => {
  for (const { name, store } of makeImpls()) {
    const stale = await store.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'persona_reviewed',
      phase_state_patch: { primary_projects: ['Alpha'] },
    })
    // A concurrent write lands AFTER the caller captured `stale`.
    await store.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'persona_reviewed',
      phase_state_patch: { primary_projects: ['Alpha', 'Beta'] },
    })

    const ok = await store.completeIfPhaseStateMatches({
      project_slug: OWNER,
      user_id: USER,
      expected_phase_state: stale.phase_state, // the STALE snapshot
      completed_at: 123,
    })
    expect(ok, `${name}: stale CAS must NOT complete`).toBe(false)
    const after = await store.get(OWNER, USER)
    expect(after?.phase, `${name}: row stays non-terminal`).toBe('persona_reviewed')
    expect(after?.completed_at, `${name}: completed_at NOT stamped`).toBeNull()

    await store.deleteByOwner(OWNER)
  }
})

test('does NOT re-complete an already-terminal row; false for an absent row', async () => {
  for (const { name, store } of makeImpls()) {
    const row = await store.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'completed',
      phase_state_patch: { primary_projects: ['Alpha'] },
      completed_at: 1,
    })
    const ok = await store.completeIfPhaseStateMatches({
      project_slug: OWNER,
      user_id: USER,
      expected_phase_state: row.phase_state,
      completed_at: 999,
    })
    expect(ok, `${name}: already-terminal CAS is a no-op`).toBe(false)
    expect((await store.get(OWNER, USER))?.completed_at, `${name}: completed_at not overwritten`).toBe(1)

    const absent = await store.completeIfPhaseStateMatches({
      project_slug: OWNER,
      user_id: 'nobody',
      expected_phase_state: {},
      completed_at: 5,
    })
    expect(absent, `${name}: absent row → false`).toBe(false)

    await store.deleteByOwner(OWNER)
  }
})
