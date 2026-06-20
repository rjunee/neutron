/**
 * @neutronai/gateway/realmode-composer — resolve-onboarding-phase tests.
 *
 * Covers the helper that the composer uses to decide between the real
 * chat surface and the Max-OAuth gate page when an instance has no
 * Anthropic credentials (2026-05-12 phase-aware gate fix).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { SqliteOnboardingStateStore } from '../../../onboarding/interview/sqlite-state-store.ts'
import {
  loadCurrentOnboardingPhase,
  shouldMountRealLandingWithoutCreds,
  POST_MAX_OAUTH_PHASES,
} from '../resolve-onboarding-phase.ts'

let tmp: string
let db: ProjectDb

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'resolve-onboarding-phase-'))
  const dbPath = join(tmp, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('loadCurrentOnboardingPhase', () => {
  test('returns null when no onboarding_state row exists (brand-new instance)', () => {
    expect(loadCurrentOnboardingPhase(db, 't', 'test-user')).toBeNull()
  })

  test('returns the phase string when a row exists for THIS project slug', async () => {
    const store = new SqliteOnboardingStateStore({ db })
    await store.upsert({ project_slug: 't', user_id: 'test-user', phase: 'signup' })
    expect(loadCurrentOnboardingPhase(db, 't', 'test-user')).toBe('signup')
  })

  test('Codex r1 P2 — IGNORES rows under a different project_slug (rename-without-rekey safety)', async () => {
    // Per-project DBs ARE keyed by slug — `state-store.rekey()` updates
    // the row on a rename. But if rekey failed (or hasn't run yet),
    // a stale row could remain under the OLD slug while the composer
    // boots under the NEW slug. The helper must filter by the boot
    // project_slug so the stale row does NOT outrank the missing-row
    // path. Without this filter, a stale post-`max_oauth_offered`
    // phase under the old slug would gate `/chat` on the new slug
    // incorrectly.
    const store = new SqliteOnboardingStateStore({ db, now: () => 1_000 })
    await store.upsert({ project_slug: 'old-slug', user_id: 'test-user', phase: 'signup' })
    const store2 = new SqliteOnboardingStateStore({ db, now: () => 2_000 })
    // Note: this row's last_advanced_at is LATER than the old-slug
    // row, so an unscoped ORDER BY would surface it. With the slug
    // filter we still get null when probing for the original slug.
    await store2.upsert({ project_slug: 'rogue-slug', user_id: 'test-user', phase: 'max_oauth_offered' })
    expect(loadCurrentOnboardingPhase(db, 'old-slug', 'test-user')).toBe('signup')
    expect(loadCurrentOnboardingPhase(db, 'new-slug-no-row', 'test-user')).toBeNull()
  })

  test('returns null on a missing onboarding_state table (defensive)', () => {
    // Drop the table to simulate a pre-migration DB. The helper must
    // swallow the SQLite error and return null — never crash the
    // composer.
    db.raw().exec('DROP TABLE onboarding_state')
    expect(loadCurrentOnboardingPhase(db, 't', 'test-user')).toBeNull()
  })
})

describe('shouldMountRealLandingWithoutCreds', () => {
  test('null phase → true (pre-bootstrap mounts real surface)', () => {
    expect(shouldMountRealLandingWithoutCreds(null)).toBe(true)
  })

  test('every pre-max_oauth_offered phase → true', () => {
    const prePhases = [
      'signup',
      'identity_oauth',
      'instance_provisioned',
      'ai_substrate_offered',
      'import_upload_pending',
      'import_running',
      'import_analysis_presented',
      'work_interview_gap_fill',
      'personality_offered',
      'agent_name_chosen',
      'slug_chosen',
      'projects_proposed',
      'persona_synthesizing',
      'persona_reviewed',
    ] as const
    for (const phase of prePhases) {
      expect(shouldMountRealLandingWithoutCreds(phase)).toBe(true)
    }
  })

  test('max_oauth_offered + wow_fired + completed → false (gate page)', () => {
    expect(shouldMountRealLandingWithoutCreds('max_oauth_offered')).toBe(false)
    expect(shouldMountRealLandingWithoutCreds('wow_fired')).toBe(false)
    expect(shouldMountRealLandingWithoutCreds('completed')).toBe(false)
  })

  test('failed → true (mount real so user can see the error surface, not the gate)', () => {
    expect(shouldMountRealLandingWithoutCreds('failed')).toBe(true)
  })

  test('POST_MAX_OAUTH_PHASES is exactly { max_oauth_offered, wow_fired, completed }', () => {
    expect([...POST_MAX_OAUTH_PHASES].sort()).toEqual(
      ['completed', 'max_oauth_offered', 'wow_fired'],
    )
  })
})
