/**
 * ISSUES #2 (2026-05-19) — state-store composite-key unit coverage.
 *
 * Isolation spec § 6.1 #3 — composite-key contract for onboarding state.
 *
 * Verifies that BOTH `InMemoryOnboardingStateStore` and
 * `SqliteOnboardingStateStore` honour the new (project_slug, user_id) PK
 * contract:
 *
 *   - `get(slug, userA)` returns null when only `(slug, userB)` row exists.
 *   - `upsert({slug, userA, ...})` does NOT overwrite an existing
 *     `(slug, userB)` row.
 *   - `delete(slug, userA)` does NOT delete `(slug, userB)`.
 *   - `rekey(oldSlug, newSlug)` rekeys EVERY row whose project_slug=oldSlug.
 *   - rekey collision check is per-(new_slug, user_id).
 *
 * Anti-pattern guard: every assert reads the actual store contents back.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
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

const OWNER = 't1'
const USER_A = 'user-A'
const USER_B = 'user-B'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-composite-key-'))
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

test('get(project, userA) returns null when only (project, userB) row exists', async () => {
  for (const { name, store } of makeImpls()) {
    await store.upsert({ project_slug: OWNER, user_id: USER_B, phase: 'signup' })
    const a = await store.get(OWNER, USER_A)
    const b = await store.get(OWNER, USER_B)
    expect(a, `${name}: userA must be null`).toBeNull()
    expect(b, `${name}: userB must exist`).not.toBeNull()
    // Clean up so the next impl starts fresh.
    await store.deleteByOwner(OWNER)
  }
})

test('upsert({project, userA}) does NOT overwrite an existing (project, userB) row', async () => {
  for (const { name, store } of makeImpls()) {
    await store.upsert({
      project_slug: OWNER,
      user_id: USER_B,
      phase: 'projects_proposed',
      phase_state_patch: { primary_projects: ['Topline'] },
    })
    await store.upsert({
      project_slug: OWNER,
      user_id: USER_A,
      phase: 'signup',
    })
    const a = await store.get(OWNER, USER_A)
    const b = await store.get(OWNER, USER_B)
    expect(a?.phase, `${name}: userA phase`).toBe('signup')
    expect(b?.phase, `${name}: userB phase preserved`).toBe('projects_proposed')
    expect(
      b?.phase_state['primary_projects'],
      `${name}: userB phase_state preserved`,
    ).toEqual(['Topline'])
    await store.deleteByOwner(OWNER)
  }
})

test('delete(project, userA) does NOT delete (project, userB)', async () => {
  for (const { name, store } of makeImpls()) {
    await store.upsert({ project_slug: OWNER, user_id: USER_A, phase: 'signup' })
    await store.upsert({ project_slug: OWNER, user_id: USER_B, phase: 'signup' })
    await store.delete(OWNER, USER_A)
    expect(await store.get(OWNER, USER_A), `${name}: userA gone`).toBeNull()
    expect(await store.get(OWNER, USER_B), `${name}: userB intact`).not.toBeNull()
    await store.deleteByOwner(OWNER)
  }
})

test('rekey rekeys EVERY row whose project_slug=oldSlug regardless of user_id', async () => {
  for (const { name, store } of makeImpls()) {
    await store.upsert({ project_slug: 'old', user_id: USER_A, phase: 'signup' })
    await store.upsert({
      project_slug: 'old',
      user_id: USER_B,
      phase: 'projects_proposed',
    })

    const rekeyed = await store.rekey('old', 'new', USER_A)
    expect(rekeyed?.project_slug, `${name}: rekeyed slug`).toBe('new')
    expect(rekeyed?.user_id, `${name}: rekeyed user`).toBe(USER_A)
    expect(await store.get('old', USER_A), `${name}: old userA gone`).toBeNull()
    expect(await store.get('old', USER_B), `${name}: old userB gone`).toBeNull()
    expect(await store.get('new', USER_A), `${name}: new userA exists`).not.toBeNull()
    expect(
      (await store.get('new', USER_B))?.phase,
      `${name}: new userB phase preserved`,
    ).toBe('projects_proposed')

    await store.deleteByOwner('new')
  }
})

test('rekey throws when (newSlug, userA) already exists', async () => {
  for (const { name, store } of makeImpls()) {
    await store.upsert({ project_slug: 'old', user_id: USER_A, phase: 'signup' })
    await store.upsert({ project_slug: 'new', user_id: USER_A, phase: 'signup' })
    await expect(store.rekey('old', 'new', USER_A), `${name}: collision`).rejects.toThrow(/collision/)
    // Both rows still exist (atomic rejection).
    expect(await store.get('old', USER_A), `${name}: old row intact`).not.toBeNull()
    expect(await store.get('new', USER_A), `${name}: new row intact`).not.toBeNull()
    await store.deleteByOwner('old')
    await store.deleteByOwner('new')
  }
})

test('rekey succeeds when (newSlug, userOther) exists but the rekey moves (oldSlug, userA)', async () => {
  for (const { name, store } of makeImpls()) {
    await store.upsert({ project_slug: 'old', user_id: USER_A, phase: 'signup' })
    await store.upsert({ project_slug: 'new', user_id: USER_B, phase: 'signup' })
    const rekeyed = await store.rekey('old', 'new', USER_A)
    expect(rekeyed?.project_slug, `${name}: rekeyed`).toBe('new')
    expect(rekeyed?.user_id, `${name}: rekeyed user`).toBe(USER_A)
    // Both users now under 'new'.
    expect(await store.get('new', USER_A), `${name}: new userA`).not.toBeNull()
    expect(await store.get('new', USER_B), `${name}: new userB`).not.toBeNull()
    await store.deleteByOwner('new')
  }
})

test('Sqlite: concurrent upserts on the same project_slug but different user_ids both land', async () => {
  const store = new SqliteOnboardingStateStore({ db })
  // SQLite serializes writes per-connection — both upserts complete.
  await Promise.all([
    store.upsert({ project_slug: OWNER, user_id: USER_A, phase: 'signup' }),
    store.upsert({ project_slug: OWNER, user_id: USER_B, phase: 'signup' }),
  ])
  expect(await store.get(OWNER, USER_A)).not.toBeNull()
  expect(await store.get(OWNER, USER_B)).not.toBeNull()
  const all = db
    .prepare<{ c: number }, [string]>(
      'SELECT COUNT(*) AS c FROM onboarding_state WHERE project_slug = ?',
    )
    .all(OWNER)
  expect(all[0]?.c).toBe(2)
})
