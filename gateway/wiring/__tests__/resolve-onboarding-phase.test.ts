/**
 * @neutronai/gateway/wiring — resolve-onboarding-phase tests.
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

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
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
    await store.upsert({ owner_slug: 't', user_id: 'test-user', phase: 'signup' })
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
    await store.upsert({ owner_slug: 'old-slug', user_id: 'test-user', phase: 'signup' })
    const store2 = new SqliteOnboardingStateStore({ db, now: () => 2_000 })
    // Note: this row's last_advanced_at is LATER than the old-slug
    // row, so an unscoped ORDER BY would surface it. With the slug
    // filter we still get null when probing for the original slug.
    //
    // K11e (2026-07-07): the rogue row carries the LEGACY phase string
    // `max_oauth_offered` — a stranded pre-#243 value that is no longer an
    // `OnboardingPhase` member. The typed `upsert` can't write it, so we
    // seed a placeholder then patch the raw `phase` column, exactly as a
    // stale on-disk row would still carry it.
    await store2.upsert({ owner_slug: 'rogue-slug', user_id: 'test-user', phase: 'persona_reviewed' })
    db.raw().exec(`UPDATE onboarding_state SET phase = 'max_oauth_offered' WHERE project_slug = 'rogue-slug'`)
    expect(loadCurrentOnboardingPhase(db, 'old-slug', 'test-user')).toBe('signup')
    expect(loadCurrentOnboardingPhase(db, 'new-slug-no-row', 'test-user')).toBeNull()
  })

  test('K11e legacy-string compat — a stranded `wow_fired` DB row still gates (post-max)', async () => {
    // Pre-#243 managed deployments walked owners through `max_oauth_offered`
    // → `wow_fired`. Those strings are no longer `OnboardingPhase` members,
    // but a stranded `onboarding_state.phase` row can still hold them. The
    // gate MUST classify such a row as post-max so a credential-less owner
    // sees the Max-OAuth gate, not a regressed real-landing mount. Seed a
    // placeholder row, patch the raw column to the legacy string, then prove
    // it flows load → gate correctly.
    const store = new SqliteOnboardingStateStore({ db })
    await store.upsert({ owner_slug: 't', user_id: 'legacy-user', phase: 'persona_reviewed' })
    db.raw().exec(`UPDATE onboarding_state SET phase = 'wow_fired' WHERE project_slug = 't' AND user_id = 'legacy-user'`)
    const loaded = loadCurrentOnboardingPhase(db, 't', 'legacy-user')
    expect(loaded).toBe('wow_fired')
    expect(shouldMountRealLandingWithoutCreds(loaded)).toBe(false)
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
