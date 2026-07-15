/**
 * 2026-07-06 (K3 lost-coverage restoration, Fable audit §1.A2, unit FX2) —
 * composer-level regression for the Argus BLOCKER #3 the original
 * `build-import-resilience-wiring.test.ts` (PR #311 r1) pinned and that
 * survived K3's deletion of the dead per-chunk import pipeline (#216):
 *
 *   BLOCKER #3 — `ImportResumeReadinessProbe`. `buildOnboardingEnginePieces`
 *               default-builds the probe (`build-landing-stack.ts`, the
 *               `importResumeReadiness` const) so the engine renders the
 *               `resume_import` button on `import_analysis_presented` when
 *               a prior import is genuinely resumable. Without the
 *               default-build, the engine's `importResumeReadiness` dep
 *               stays unwired and `can_resume_import` is always false.
 *
 * The original BLOCKER #2 (`POST /api/import/<job_id>/resume` mount +
 * shared runner/resolver/stateStore) is restored SEPARATELY, against the
 * REAL Open route graph, in `open/__tests__/open-import-resume-wiring.test.ts`
 * — a composer-level `buildImportResumeHandler(...)` construction test would
 * pass even if `open/composer.ts` dropped the handler from its composition or
 * broke the shared-instance wiring, so that pin has to drive the composed
 * server (see that file's header for the mount/shared-instance mutations it
 * catches).
 *
 * K3 (2026-07-03, PR #216) deleted the ORIGINAL per-chunk `buildImportJobRunnerHook`
 * path (D-2 resolved: Managed always runs the vendored Open synthesis path,
 * never per-chunk). This file deliberately does NOT resurrect the deleted
 * BLOCKER #1 (entity-populator / per-chunk runner) test, which pinned dead
 * code K3 correctly removed.
 *
 * The probe assertions walk the shared `buildOnboardingEnginePieces` surface
 * — the same construction path production (`open/composer.ts`) hits — and
 * drive REAL DB rows + on-disk ZIP presence through `probe.isResumable(...)`
 * so a stubbed / always-true / always-false probe would trip red.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOnboardingEnginePieces } from '../build-landing-stack.ts'
import type { ImportSource } from '@neutronai/onboarding/history-import/types.ts'

const OWNER = 'alice'
const USER = 'u-alice'

let workdir: string
let ownerHome: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-import-resilience-wiring-'))
  ownerHome = join(workdir, 'project-home')
  mkdirSync(ownerHome, { recursive: true })
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// BLOCKER #3 — ImportResumeReadinessProbe default-built into the engine
// ---------------------------------------------------------------------------

test('BLOCKER #3 — composer default-builds a non-null ImportResumeReadinessProbe and threads real DB + filesystem behaviour through', async () => {
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    static_dir: workdir,
    internal_handle: 't-aaaaaaaa',
    // Deliberately omitted: importUseSynthesis / importResumeReadiness.
    // The probe default-build (build-landing-stack.ts, the
    // `importResumeReadiness` const) is unconditional — it does not
    // depend on the synthesis opt-in — so this proves the DEFAULT path
    // production hits when a caller supplies neither field.
  })
  // Construction-shape — the composer always default-builds the probe
  // when the caller omits the field. Before the original fix the
  // engine's `importResumeReadiness` dep was undefined and
  // `can_resume_import` was always false.
  expect(pieces.importResumeReadiness).not.toBeNull()
  const probe = pieces.importResumeReadiness!
  // Behavioural check — the probe walks the SAME gate the HTTP resume
  // handler does (RESUMABLE_STATUSES + on-disk ZIP), so this fails if a
  // future refactor swaps in a stub / always-true / always-false probe
  // rather than the real DB+fs-backed implementation.
  const importsDir = join(ownerHome, 'imports')
  mkdirSync(importsDir, { recursive: true })
  const zipPath = join(importsDir, 'chatgpt.zip')
  writeFileSync(zipPath, 'fake-zip-bytes')
  db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES ('j-resumable', ?, 'chatgpt-zip', 'cancelled', 0, 0, 0, 0, ?)`,
    [OWNER, 1_700_000_000_000],
  )
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-resumable',
    }),
  ).toBe(true)
  // Same row, ZIP gone → false (gate matches handler semantics).
  rmSync(zipPath)
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-resumable',
    }),
  ).toBe(false)
  // Status `completed` → false even when the ZIP exists.
  writeFileSync(zipPath, 'fake-zip-bytes')
  db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES ('j-completed', ?, 'chatgpt-zip', 'completed', 0, 0, 0, 0, ?)`,
    [OWNER, 1_700_000_000_000],
  )
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-completed',
    }),
  ).toBe(false)
  // Unknown job_id → false.
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-missing',
    }),
  ).toBe(false)
})

test('K11c (Codex r1) — a legacy non-zip source is NOT resumable even with a file on disk', async () => {
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    static_dir: workdir,
    internal_handle: 't-aaaaaaaa',
  })
  const probe = pieces.importResumeReadiness!
  // A legacy `gmail-oauth` row can still exist (migration 0040's
  // `import_jobs.source` CHECK constraint permits it), even though the
  // OAuth sources were purged. Place a same-named file on disk so the ONLY
  // thing keeping the probe from returning true is the non-zip source
  // guard — the UI must never advertise a resume for such a row.
  const importsDir = join(ownerHome, 'imports')
  mkdirSync(importsDir, { recursive: true })
  writeFileSync(join(importsDir, 'gmail-oauth.zip'), 'fake-bytes')
  db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES ('j-oauth', ?, 'gmail-oauth', 'cancelled', 0, 0, 0, 0, ?)`,
    [OWNER, 1_700_000_000_000],
  )
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'gmail-oauth' as unknown as ImportSource,
      job_id: 'j-oauth',
    }),
  ).toBe(false)
})

test('BLOCKER #3 — explicit null override still opts out of the probe (legacy back-compat)', async () => {
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    static_dir: workdir,
    internal_handle: 't-aaaaaaaa',
    importResumeReadiness: null,
  })
  expect(pieces.importResumeReadiness).toBeNull()
})
