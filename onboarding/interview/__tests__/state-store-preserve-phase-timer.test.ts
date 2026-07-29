/**
 * Argus r2 blocker — `upsert({ preservePhaseAndTimer: true })` must NOT regress a
 * phase transition or reset the resume-window timer.
 *
 * A fire-and-forget writer (the live personality suggester) reads state, then upserts
 * a `phase_state` patch up to 45 s later. Its old call stamped `phase` +
 * `last_advanced_at` UNCONDITIONALLY from its stale read — so a phase advance a
 * concurrent turn committed in between was silently rolled back (a lost update). The
 * `preservePhaseAndTimer` flag makes the write preserve the row's CURRENT phase +
 * timer (read inside the write) while still landing the patch. Pinned on BOTH
 * `InMemoryOnboardingStateStore` and `SqliteOnboardingStateStore`. Every assert reads
 * the store back.
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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-preserve-phase-'))
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

test('preservePhaseAndTimer: a stale background write does NOT regress a concurrent phase advance', async () => {
  for (const { name, store } of makeImpls()) {
    // The suggester reads state at `personality_offered`, timer at 1000.
    const stale = await store.upsert({
      owner_slug: OWNER,
      user_id: USER,
      phase: 'personality_offered',
      phase_state_patch: { agent_name: 'Atlas' },
      advanced_at: 1000,
    })
    expect(stale.phase).toBe('personality_offered')

    // A concurrent turn advances the phase + timer while the 45 s LLM call is in flight.
    await store.upsert({
      owner_slug: OWNER,
      user_id: USER,
      phase: 'agent_name_chosen',
      phase_state_patch: { agent_name_confirmed: true },
      advanced_at: 2000,
    })

    // The background memo write lands its patch using the STALE phase/timer as input,
    // but with the preserve flag set.
    await store.upsert({
      owner_slug: OWNER,
      user_id: USER,
      phase: stale.phase, // stale 'personality_offered' — MUST be ignored
      phase_state_patch: { agent_personality_suggestions: ['a', 'b'] },
      advanced_at: stale.last_advanced_at, // stale 1000 — MUST be ignored
      preservePhaseAndTimer: true,
    })

    const after = await store.get(OWNER, USER)
    // Phase + timer stay at the concurrent turn's values — NOT rolled back.
    expect(after?.phase, `${name}: phase not regressed`).toBe('agent_name_chosen')
    expect(after?.last_advanced_at, `${name}: timer not reset`).toBe(2000)
    // …and the patch DID land, merged over the concurrent turn's phase_state.
    expect(after?.phase_state['agent_personality_suggestions'], `${name}: patch landed`).toEqual(['a', 'b'])
    expect(after?.phase_state['agent_name_confirmed'], `${name}: concurrent state preserved`).toBe(true)
    expect(after?.phase_state['agent_name'], `${name}: original state preserved`).toBe('Atlas')

    await store.deleteByOwner(OWNER)
  }
})

test('WITHOUT the flag, the same stale write DOES clobber phase + timer (proves the flag is load-bearing)', async () => {
  for (const { name, store } of makeImpls()) {
    const stale = await store.upsert({
      owner_slug: OWNER,
      user_id: USER,
      phase: 'personality_offered',
      advanced_at: 1000,
    })
    await store.upsert({
      owner_slug: OWNER,
      user_id: USER,
      phase: 'agent_name_chosen',
      advanced_at: 2000,
    })
    // No preserve flag → the stale phase/timer are written unconditionally (the bug).
    await store.upsert({
      owner_slug: OWNER,
      user_id: USER,
      phase: stale.phase,
      phase_state_patch: { agent_personality_suggestions: ['a'] },
      advanced_at: stale.last_advanced_at,
    })
    const after = await store.get(OWNER, USER)
    expect(after?.phase, `${name}: regressed without the flag`).toBe('personality_offered')
    expect(after?.last_advanced_at, `${name}: timer reset without the flag`).toBe(1000)

    await store.deleteByOwner(OWNER)
  }
})

test('preservePhaseAndTimer on an ABSENT row falls back to INSERT with the given phase/timer', async () => {
  for (const { name, store } of makeImpls()) {
    // No row yet — preserve has nothing to preserve, so the INSERT uses the input.
    const created = await store.upsert({
      owner_slug: OWNER,
      user_id: USER,
      phase: 'personality_offered',
      phase_state_patch: { agent_personality_suggestions: ['a'] },
      advanced_at: 1500,
      preservePhaseAndTimer: true,
    })
    expect(created.phase, `${name}: absent-row insert phase`).toBe('personality_offered')
    const after = await store.get(OWNER, USER)
    expect(after?.phase, `${name}: row created`).toBe('personality_offered')
    expect(after?.last_advanced_at, `${name}: timer stamped from input`).toBe(1500)
    expect(after?.phase_state['agent_personality_suggestions'], `${name}: patch landed`).toEqual(['a'])

    await store.deleteByOwner(OWNER)
  }
})
