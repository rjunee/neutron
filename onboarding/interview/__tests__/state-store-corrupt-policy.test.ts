/**
 * P11 (world-class refactor, 2026-07) — corrupt-policy pin for the
 * `onboarding_state.phase_state_json` codec routing.
 *
 * The store now decodes `phase_state_json` through the shared
 * `parseJsonColumn` codec (persistence/sidecar.ts) instead of a hand-rolled
 * `JSON.parse`. This test pins the column's PRE-EXISTING corrupt-policy
 * BYTE-FOR-BYTE: a malformed `phase_state_json` silently resets to `{}` on
 * read (the exact behaviour the refactor plan §P11 calls out at the old
 * sqlite-state-store.ts:293-303 site). Parse-ok round-trips unchanged.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'

const OWNER = 't1'
const USER = 'user-A'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-p11-state-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('parse-ok: valid phase_state_json round-trips through the codec', async () => {
  const store = new SqliteOnboardingStateStore({ db })
  await store.upsert({
    owner_slug: OWNER,
    user_id: USER,
    phase: 'signup',
    phase_state_patch: { topic_id: 't-123', step: 2 },
  })
  const got = await store.get(OWNER, USER)
  expect(got).not.toBeNull()
  expect(got!.phase_state).toEqual({ topic_id: 't-123', step: 2 })
})

test('corrupt-policy: malformed phase_state_json silently resets to {} on read', async () => {
  const store = new SqliteOnboardingStateStore({ db })
  await store.upsert({
    owner_slug: OWNER,
    user_id: USER,
    phase: 'signup',
    phase_state_patch: { topic_id: 't-123' },
  })
  // Poison the column with unparseable text (simulating on-disk corruption).
  await db.run(
    `UPDATE onboarding_state SET phase_state_json = '{oops' WHERE project_slug = ? AND user_id = ?`,
    [OWNER, USER],
  )
  const got = await store.get(OWNER, USER)
  expect(got).not.toBeNull()
  // Silent reset to {} — NOT a throw, NOT the poisoned text.
  expect(got!.phase_state).toEqual({})
})

test('corrupt-policy: a non-object phase_state_json also resets to {} (shape guard)', async () => {
  const store = new SqliteOnboardingStateStore({ db })
  await store.upsert({
    owner_slug: OWNER,
    user_id: USER,
    phase: 'signup',
    phase_state_patch: { topic_id: 't-123' },
  })
  // Valid JSON, wrong shape (array, not object) — codec parses, store rejects.
  await db.run(
    `UPDATE onboarding_state SET phase_state_json = '[1,2,3]' WHERE project_slug = ? AND user_id = ?`,
    [OWNER, USER],
  )
  const got = await store.get(OWNER, USER)
  expect(got!.phase_state).toEqual({})
})
