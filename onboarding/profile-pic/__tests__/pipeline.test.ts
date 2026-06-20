/**
 * ProfilePicPipeline — async generation lifecycle.
 *
 * Per docs/plans/P2-onboarding.md § 2.7 + § 6 S4 (lines 2100).
 *
 *   - start → status('generating') → status('ready') with N candidates
 *   - 3-failure budget → status('fallback') with the 12-PNG default
 *   - pick(candidate_id) copies bytes to <home>/persona/profile-pic.png
 *   - acceptUpload writes upload bytes + flips to user_uploaded
 *   - status returns null for unknown job_id
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  GeminiImagenClient,
  GeminiImagenError,
  type GeminiImageCandidate,
  type GeminiImagenFn,
  type GeminiImagenOutput,
} from '../gemini-imagegen.ts'
import { FallbackGallery } from '../fallback-gallery.ts'
import { ProfilePicPipeline, ProfilePicError, archetypeHintToFallbackSlug } from '../pipeline.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function dummyPng(byte: number): Buffer {
  // Minimal 1x1 PNG signature + 1 IDAT byte for shape; pipeline doesn't
  // validate PNG bytes, so any non-empty buffer suffices.
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, byte])
}

function dummyCandidate(id: string, byte: number): GeminiImageCandidate {
  return {
    candidate_id: id,
    bytes: dummyPng(byte),
    width: 1,
    height: 1,
  }
}

function buildClient(fn: GeminiImagenFn): GeminiImagenClient {
  return new GeminiImagenClient({ generate: fn })
}

describe('ProfilePicPipeline lifecycle', () => {
  test('start → status starts at generating then ready after Gemini success', async () => {
    let calls = 0
    const fn: GeminiImagenFn = async () => {
      calls += 1
      const out: GeminiImagenOutput = {
        candidates: [
          dummyCandidate(`cand-${calls}-1`, 0xa1),
          dummyCandidate(`cand-${calls}-2`, 0xa2),
          dummyCandidate(`cand-${calls}-3`, 0xa3),
        ],
        dollars_billed: 0.05,
      }
      return out
    }
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'odin',
      prompt: 'A wise raven-keeper.',
    })
    await pipeline.awaitJob(job_id)
    const status = await pipeline.status(job_id)
    expect(status).not.toBeNull()
    expect(status!.status).toBe('ready')
    expect(status!.candidates.length).toBe(3)
    expect(status!.failure_count).toBe(0)
    expect(calls).toBe(1)
    // All three candidate files exist on disk.
    for (const c of status!.candidates) {
      expect(existsSync(c.path)).toBe(true)
      expect(c.source).toBe('gemini')
    }
  })

  test('2-of-3 mocked-success Gemini run lands 2 candidates + canonical pick (per § 6a integration spec)', async () => {
    // Per § 6a profile-pic-pipeline test: 2 of 3 succeed → 2 candidates
    // land + canonical pick. The pipeline calls .generate(...) per
    // attempt; we have it return 2 candidates from the first call (one
    // failure simulated upstream by short-count) and the loop accepts
    // partial-success.
    const fn: GeminiImagenFn = async () => ({
      candidates: [dummyCandidate('cand-A', 0xa1), dummyCandidate('cand-B', 0xa2)],
      dollars_billed: 0.04,
    })
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
      failure_budget: 3,
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'thoth',
      prompt: 'A scribe of the gods.',
    })
    await pipeline.awaitJob(job_id)
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('ready')
    expect(status!.candidates.length).toBe(2)
    // User picks one — canonical copy lands at <home>/persona/profile-pic.png.
    const pickedId = status!.candidates[0]!.id
    const { canonical_path } = await pipeline.pick(job_id, pickedId)
    expect(existsSync(canonical_path)).toBe(true)
    expect(canonical_path).toBe(join(home, 'persona', 'profile-pic.png'))
    // Re-status reflects picked_at on the chosen candidate.
    const after = await pipeline.status(job_id)
    expect(after!.candidates.find((c) => c.id === pickedId)!.picked_at).not.toBeNull()
  })

  test('exhausting failure budget falls back to 12-PNG gallery', async () => {
    let attempts = 0
    const fn: GeminiImagenFn = async () => {
      attempts += 1
      throw new GeminiImagenError('rate_limited', 'synthetic 429')
    }
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
      failure_budget: 3,
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'padmasambhava',
      prompt: 'A fearless lotus-born teacher.',
    })
    await pipeline.awaitJob(job_id)
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('fallback')
    expect(status!.fallback_used).toBe(true)
    expect(status!.failure_count).toBe(3)
    expect(attempts).toBe(3)
    expect(status!.candidates.length).toBe(1)
    expect(status!.candidates[0]!.source).toBe('fallback')
  })

  test('null Gemini client short-circuits to fallback', async () => {
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: null,
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'krishna',
      prompt: 'A pastoral charmer.',
    })
    await pipeline.awaitJob(job_id)
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('fallback')
    expect(status!.candidates.length).toBe(1)
    expect(status!.candidates[0]!.source).toBe('fallback')
  })

  test('pickFallback short-circuits Gemini at user request', async () => {
    const fn: GeminiImagenFn = async () => ({
      candidates: [dummyCandidate('would-not-land', 0xff)],
      dollars_billed: 0.01,
    })
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    // Do NOT await the background job — pretend the user tapped [B]
    // immediately.
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'athena',
      prompt: 'A wise weaver.',
    })
    await pipeline.awaitJob(job_id)
    const { candidate_id } = await pipeline.pickFallback(job_id)
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('fallback')
    const fallback = status!.candidates.find((c) => c.id === candidate_id)
    expect(fallback).toBeDefined()
    expect(fallback!.source).toBe('fallback')
  })

  test('acceptUpload lands user-supplied bytes at canonical path + marks user_uploaded', async () => {
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: null,
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'shiva',
      prompt: 'A dancer who dissolves the world.',
    })
    await pipeline.awaitJob(job_id)
    const userBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef])
    const { canonical_path } = await pipeline.acceptUpload(job_id, userBytes)
    expect(existsSync(canonical_path)).toBe(true)
    expect(readFileSync(canonical_path)).toEqual(userBytes)
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('user_uploaded')
    const upload = status!.candidates.find((c) => c.source === 'upload')
    expect(upload).toBeDefined()
    expect(upload!.picked_at).not.toBeNull()
  })

  test('user pickFallback DURING Gemini run preserves user-chosen state (Codex r1 P1)', async () => {
    // Race scenario: pickFallback is called BEFORE the worker has a
    // chance to flip 'ready'. Worker must observe the 'fallback'
    // terminal state and bail out without overwriting it.
    let release: () => void = () => undefined
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const fn: GeminiImagenFn = async () => {
      await blocker
      return {
        candidates: [dummyCandidate('would-not-land', 0xff)],
        dollars_billed: 0.01,
      }
    }
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'odin',
      prompt: 'p',
    })
    // User taps [B] BEFORE the Gemini call resolves.
    await pipeline.pickFallback(job_id)
    // Now release the Gemini call.
    release()
    await pipeline.awaitJob(job_id)
    const status = await pipeline.status(job_id)
    // Status must remain 'fallback' — the user's choice wins.
    expect(status!.status).toBe('fallback')
    expect(status!.fallback_used).toBe(true)
    // The fallback candidate is the only one that should be picked.
    const fallback = status!.candidates.find((c) => c.source === 'fallback')
    expect(fallback).toBeDefined()
  })

  test('user acceptUpload DURING Gemini run preserves user-chosen state (Codex r1 P1)', async () => {
    let release: () => void = () => undefined
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const fn: GeminiImagenFn = async () => {
      await blocker
      return {
        candidates: [dummyCandidate('would-not-land', 0xff)],
        dollars_billed: 0.01,
      }
    }
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'curie',
      prompt: 'p',
    })
    await pipeline.acceptUpload(job_id, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x33]))
    release()
    await pipeline.awaitJob(job_id)
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('user_uploaded')
  })

  test('blended archetype hint resolves to first matching slug, not default (Codex r1 P2)', async () => {
    // "Odin/Thoth/Padmasambhava" used to fall through to default
    // because the whole string was passed verbatim. Now it splits on
    // `/`, walks fragments, returns the first match (odin).
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: null,
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'Odin/Thoth/Padmasambhava',
      prompt: 'p',
    })
    await pipeline.awaitJob(job_id)
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('fallback')
    // The fallback PNG bytes must equal the on-disk odin.png.
    const fallback = status!.candidates.find((c) => c.source === 'fallback')!
    const candidateBytes = readFileSync(fallback.path)
    const odinPath = join(import.meta.dir, '..', 'data', 'odin.png')
    const odinBytes = readFileSync(odinPath)
    expect(candidateBytes.equals(odinBytes)).toBe(true)
  })

  test('archetypeHintToFallbackSlug delegates to fallback-gallery normalization', () => {
    // Public re-export consumed by `onboarding/index.ts`. Pinning the
    // contract here so the shim's signature does not silently drift —
    // unknown hints map to the default slug; canonical slugs round-trip.
    expect(archetypeHintToFallbackSlug('odin')).toBe('odin')
    expect(archetypeHintToFallbackSlug('not-a-real-archetype')).toBe('gandalf-the-white')
    expect(archetypeHintToFallbackSlug(undefined)).toBe('gandalf-the-white')
  })

  test('status returns null for unknown job_id', async () => {
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: join(tmp, 'home'),
      gemini: null,
    })
    expect(await pipeline.status('no-such-job')).toBeNull()
  })

  test('budget-exhausted gallery-missing path flips job to failed and surfaces ProfilePicError', async () => {
    // When Gemini fails N times AND the on-disk fallback gallery is also
    // unreachable (caller wired a FallbackGallery whose data_dir does not
    // exist), `applyFallback` flips the row to terminal 'failed' via the
    // setStatusAndComplete helper and re-throws as ProfilePicError so the
    // worker doesn't silently swallow a brick. Wiring a non-existent
    // data_dir is the cleanest way to trigger the catch arm without
    // touching the bundled gallery PNGs.
    const fn: GeminiImagenFn = async () => {
      throw new GeminiImagenError('rate_limited', 'synthetic 429')
    }
    const home = join(tmp, 'home')
    const missingDir = join(tmp, 'no-such-gallery')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
      failure_budget: 1,
      fallback: new FallbackGallery({ data_dir: missingDir }),
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      archetype_hint: 'odin',
      prompt: 'p',
    })
    let caught: unknown
    try {
      await pipeline.awaitJob(job_id)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProfilePicError)
    expect((caught as ProfilePicError).code).toBe('gallery_missing')
    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('failed')
    expect(status!.completed_at).not.toBeNull()
  })

  test('pick on unknown candidate throws candidate_not_found', async () => {
    const fn: GeminiImagenFn = async () => ({
      candidates: [dummyCandidate('cand-x', 0x10)],
      dollars_billed: 0.01,
    })
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: join(tmp, 'home'),
      gemini: buildClient(fn),
    })
    const { job_id } = await pipeline.start({
      project_slug: 't1',
      prompt: 'p',
    })
    await pipeline.awaitJob(job_id)
    let caught: unknown
    try {
      await pipeline.pick(job_id, 'no-such-candidate')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProfilePicError)
    expect((caught as ProfilePicError).code).toBe('candidate_not_found')
  })
})
