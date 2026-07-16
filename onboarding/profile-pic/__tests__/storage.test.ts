/**
 * Sprint 28 — onboarding/profile-pic/storage.ts unit tests.
 *
 *   - persistChosenAvatar verifies the canonical disk path, fans out
 *     to the registry pointer + Telegram bot avatar, and surfaces
 *     partial-success accurately.
 *   - The registry write throws ProfilePicStorageError on failure.
 *   - The bot avatar push fails non-fatally (logs a warning, returns
 *     bot_avatar_pushed=false).
 *   - buildAvatarRouteHandler serves bytes / 404s missing / 500s on
 *     read failure.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAvatarRouteHandler,
  CANONICAL_AVATAR_FILENAME,
  persistChosenAvatar,
  ProfilePicStorageError,
  type ProfilePicStorageDeps,
  // Argus PR #440 r2 (IMPORTANT 3) — use storage.ts's OWN structural
  // mirrors of the Managed pusher types instead of importing them from
  // the managed provisioning package (an Open test must not carry a
  // Managed import edge into the public carve).
  type SetBotAvatarInput,
  type SetBotAvatarResult,
} from '../storage.ts'

let tmp: string
let ownerHome: string
let canonical: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-storage-'))
  ownerHome = join(tmp, 'home')
  mkdirSync(join(ownerHome, 'persona'), { recursive: true })
  canonical = join(ownerHome, 'persona', CANONICAL_AVATAR_FILENAME)
  writeFileSync(canonical, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x42, 0x42, 0x42]))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('persistChosenAvatar', () => {
  test('throws canonical_missing when the disk path is absent', async () => {
    rmSync(canonical, { force: true })
    let caught: unknown
    try {
      await persistChosenAvatar(
        { owner_handle: 't-22222222', owner_home: ownerHome, bot_token: null },
        {},
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProfilePicStorageError)
    expect((caught as ProfilePicStorageError).code).toBe('canonical_missing')
  })

  test('updates the registry pointer when wired AND handle is non-null', async () => {
    const calls: Array<{ handle: string; path: string | null }> = []
    const deps: ProfilePicStorageDeps = {
      setAgentAvatarPath: async (handle, path) => {
        calls.push({ handle, path })
      },
    }
    const result = await persistChosenAvatar(
      { owner_handle: 't-22222222', owner_home: ownerHome, bot_token: null },
      deps,
    )
    expect(result.canonical_path).toBe(canonical)
    expect(result.registry_updated).toBe(true)
    expect(result.bot_avatar_pushed).toBe(false)
    expect(calls).toEqual([{ handle: 't-22222222', path: canonical }])
  })

  test('skips the registry write when handle is null', async () => {
    let called = false
    const deps: ProfilePicStorageDeps = {
      setAgentAvatarPath: async () => {
        called = true
      },
    }
    const result = await persistChosenAvatar(
      { owner_handle: null, owner_home: ownerHome, bot_token: null },
      deps,
    )
    expect(result.registry_updated).toBe(false)
    expect(called).toBe(false)
  })

  test('soft-fail registry write (returns false) reports registry_updated=false (Codex r4 P2)', async () => {
    const deps: ProfilePicStorageDeps = {
      setAgentAvatarPath: async () => false, // soft-fail signal
    }
    const result = await persistChosenAvatar(
      { owner_handle: 't-22222222', owner_home: ownerHome, bot_token: null },
      deps,
    )
    expect(result.canonical_path).toBe(canonical)
    expect(result.registry_updated).toBe(false)
  })

  test('throws registry_failed when the registry write throws', async () => {
    const deps: ProfilePicStorageDeps = {
      setAgentAvatarPath: async () => {
        throw new Error('synthetic registry RW down')
      },
    }
    let caught: unknown
    try {
      await persistChosenAvatar(
        { owner_handle: 't-22222222', owner_home: ownerHome, bot_token: null },
        deps,
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProfilePicStorageError)
    expect((caught as ProfilePicStorageError).code).toBe('registry_failed')
  })

  test('pushes bot avatar with PNG bytes when wired AND token is non-null', async () => {
    const captured: Array<SetBotAvatarInput> = []
    const fakeFetcher = mock(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const deps: ProfilePicStorageDeps = {
      setBotAvatar: async (input): Promise<SetBotAvatarResult> => {
        captured.push(input)
        return { ok: true }
      },
      fetcher: fakeFetcher as unknown as typeof fetch,
    }
    const result = await persistChosenAvatar(
      { owner_handle: null, owner_home: ownerHome, bot_token: 'BOT_TOKEN' },
      deps,
    )
    expect(result.bot_avatar_pushed).toBe(true)
    expect(captured.length).toBe(1)
    expect(captured[0]!.bot_token).toBe('BOT_TOKEN')
    expect(Buffer.isBuffer(captured[0]!.png_bytes)).toBe(true)
    expect(captured[0]!.png_bytes.length).toBeGreaterThan(0)
  })

  test('bot avatar failure logs + returns bot_avatar_pushed=false (does NOT throw)', async () => {
    const deps: ProfilePicStorageDeps = {
      setBotAvatar: async (): Promise<SetBotAvatarResult> => {
        throw new Error('telegram 429')
      },
    }
    const result = await persistChosenAvatar(
      { owner_handle: null, owner_home: ownerHome, bot_token: 'BOT_TOKEN' },
      deps,
    )
    expect(result.bot_avatar_pushed).toBe(false)
    expect(result.bot_avatar_error).toContain('telegram 429')
    expect(result.canonical_path).toBe(canonical)
  })

  test('skips bot push when token is null', async () => {
    let called = false
    const deps: ProfilePicStorageDeps = {
      setBotAvatar: async (): Promise<SetBotAvatarResult> => {
        called = true
        return { ok: true }
      },
    }
    const result = await persistChosenAvatar(
      { owner_handle: null, owner_home: ownerHome, bot_token: null },
      deps,
    )
    expect(result.bot_avatar_pushed).toBe(false)
    expect(called).toBe(false)
  })

  test('happy path with both sinks wired sets registry + bot, returns canonical', async () => {
    const registryCalls: Array<[string, string | null]> = []
    const botCalls: SetBotAvatarInput[] = []
    const deps: ProfilePicStorageDeps = {
      setAgentAvatarPath: async (h, p) => {
        registryCalls.push([h, p])
      },
      setBotAvatar: async (input) => {
        botCalls.push(input)
        return { ok: true }
      },
    }
    const result = await persistChosenAvatar(
      {
        owner_handle: 't-22222222',
        owner_home: ownerHome,
        bot_token: 'BOT_TOKEN',
      },
      deps,
    )
    expect(result.canonical_path).toBe(canonical)
    expect(result.registry_updated).toBe(true)
    expect(result.bot_avatar_pushed).toBe(true)
    expect(registryCalls).toEqual([['t-22222222', canonical]])
    expect(botCalls.length).toBe(1)
  })
})

describe('buildProfilePicEngineHook', () => {
  test('factory wraps pipeline + storage into a working ProfilePicEngineHook', async () => {
    // Build a minimal pipeline (gemini=null → fallback gallery served)
    const { ProjectDb } = await import('@neutronai/persistence/index.ts')
    const { applyMigrations } = await import('@neutronai/migrations/runner.ts')
    const { ProfilePicPipeline } = await import('../pipeline.ts')
    const { buildProfilePicEngineHook } = await import('../storage.ts')

    const localTmp = mkdtempSync(join(tmpdir(), 'pp-factory-'))
    const db = ProjectDb.open(join(localTmp, 'project.db'))
    applyMigrations(db.raw())
    const owner_home = join(localTmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home,
      gemini: null, // forces fallback gallery
    })

    const registryCalls: Array<[string, string | null]> = []
    const botCalls: SetBotAvatarInput[] = []

    const hook = buildProfilePicEngineHook({
      pipeline,
      owner_handle: 't-22222222',
      owner_home,
      setAgentAvatarPath: async (h, p) => {
        registryCalls.push([h, p])
      },
      setBotAvatar: async (i) => {
        botCalls.push(i)
        return { ok: true }
      },
      getBotToken: () => 'BOT_TOKEN',
      imageUrlBuilder: (c) => `/profile-pic/candidate/${c.candidate_id}.png`,
      buildPromptForCandidates: () => 'A wise agent.',
      wait_for_candidates: true, // test seam
    })

    const ensure = await hook.ensureCandidates({
      project_slug: 't-22222222',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      agent_name: 'Nova',
      archetype_hint: 'odin',
    })
    expect(ensure.kind).toBe('ready')
    if (ensure.kind !== 'ready') throw new Error('unreachable')
    expect(ensure.from_fallback).toBe(true) // gemini=null → fallback path
    expect(ensure.candidates.length).toBe(1)
    expect(ensure.candidates[0]?.image_url).toBe(
      `/profile-pic/candidate/${ensure.candidates[0]?.candidate_id}.png`,
    )

    const commit = await hook.commitPick({
      project_slug: 't-22222222',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      job_id: ensure.job_id,
      candidate_id: ensure.candidates[0]!.candidate_id,
    })
    expect(commit.kind).toBe('committed')
    if (commit.kind !== 'committed') throw new Error('unreachable')
    expect(commit.registry_updated).toBe(true)
    expect(commit.bot_avatar_pushed).toBe(true)
    expect(registryCalls.length).toBe(1)
    expect(botCalls.length).toBe(1)

    db.close()
    rmSync(localTmp, { recursive: true, force: true })
  })

  test('factory returns pending immediately when pipeline has not landed candidates yet (Codex r1 P1)', async () => {
    const { ProjectDb } = await import('@neutronai/persistence/index.ts')
    const { applyMigrations } = await import('@neutronai/migrations/runner.ts')
    const { ProfilePicPipeline } = await import('../pipeline.ts')
    const { buildProfilePicEngineHook } = await import('../storage.ts')
    const { GeminiImagenClient } = await import('../gemini-imagegen.ts')

    const localTmp = mkdtempSync(join(tmpdir(), 'pp-pending-'))
    const db = ProjectDb.open(join(localTmp, 'project.db'))
    applyMigrations(db.raw())
    const owner_home = join(localTmp, 'home')

    // Block the Gemini call on a never-resolving promise so the
    // pipeline stays in `'queued'` / `'generating'`.
    let release: () => void = () => undefined
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const gemini = new GeminiImagenClient({
      generate: async () => {
        await blocker
        return {
          candidates: [
            {
              candidate_id: 'cand-A',
              bytes: Buffer.from([0x89]),
              width: 1,
              height: 1,
            },
          ],
          dollars_billed: 0.01,
        }
      },
    })
    const pipeline = new ProfilePicPipeline({ db, owner_home, gemini })
    const hook = buildProfilePicEngineHook({
      pipeline,
      owner_handle: null,
      owner_home,
      getBotToken: () => null,
      imageUrlBuilder: (c) => `/x/${c.candidate_id}.png`,
      buildPromptForCandidates: () => 'p',
      // NOTE: wait_for_candidates is NOT set; await_timeout_ms=0
      // disables the soft-wait race so the factory returns the
      // current pipeline status immediately.
      await_timeout_ms: 0,
    })

    const start = Date.now()
    const ensure = await hook.ensureCandidates({
      project_slug: 't-22222222',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      agent_name: 'Nova',
      archetype_hint: 'odin',
    })
    const elapsed = Date.now() - start
    // Must not have waited for the (blocked) Gemini call.
    expect(elapsed).toBeLessThan(100)
    expect(ensure.kind).toBe('pending')
    if (ensure.kind === 'pending') {
      expect(typeof ensure.job_id).toBe('string')
    }
    // Now release the pipeline + wait for it to finish; a SECOND
    // call to ensureCandidates picks up `ready`.
    release()
    // Drive the pipeline to completion via a fresh (waiting) hook
    // because the bg job is the same db row.
    await pipeline.awaitJob(ensure.kind === 'pending' ? ensure.job_id : '')
    db.close()
    rmSync(localTmp, { recursive: true, force: true })
  })

  test('factory propagates pipeline failures as kind=failed', async () => {
    const { ProjectDb } = await import('@neutronai/persistence/index.ts')
    const { applyMigrations } = await import('@neutronai/migrations/runner.ts')
    const { ProfilePicPipeline } = await import('../pipeline.ts')
    const { FallbackGallery } = await import('../fallback-gallery.ts')
    const { buildProfilePicEngineHook } = await import('../storage.ts')

    const localTmp = mkdtempSync(join(tmpdir(), 'pp-factory-fail-'))
    const db = ProjectDb.open(join(localTmp, 'project.db'))
    applyMigrations(db.raw())
    const owner_home = join(localTmp, 'home')
    // Wire a fallback gallery pointing at a nonexistent dir so the
    // pipeline throws gallery_missing.
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home,
      gemini: null,
      fallback: new FallbackGallery({ data_dir: join(localTmp, 'no-such-dir') }),
    })
    const hook = buildProfilePicEngineHook({
      pipeline,
      owner_handle: null,
      owner_home,
      getBotToken: () => null,
      imageUrlBuilder: () => '/x.png',
      buildPromptForCandidates: () => 'p',
      wait_for_candidates: true,
    })
    const ensure = await hook.ensureCandidates({
      project_slug: 't-22222222',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      agent_name: 'Nova',
      archetype_hint: 'odin',
    })
    expect(ensure.kind).toBe('failed')
    db.close()
    rmSync(localTmp, { recursive: true, force: true })
  })
})

describe('buildAvatarRouteHandler', () => {
  test('serves canonical bytes with image/png + cache headers', async () => {
    const handler = buildAvatarRouteHandler({ owner_home: ownerHome })
    const res = handler(new Request('https://example.test/avatar.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBeGreaterThan(0)
  })

  test('404s when canonical file is missing', () => {
    rmSync(canonical, { force: true })
    const handler = buildAvatarRouteHandler({ owner_home: ownerHome })
    const res = handler(new Request('https://example.test/avatar.png'))
    expect(res.status).toBe(404)
  })
})

describe('buildCandidateRouteHandler (Codex r2 P2)', () => {
  test('serves a candidate PNG by id', async () => {
    const { buildCandidateRouteHandler } = await import('../storage.ts')
    const candidateBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xc1, 0xc2, 0xc3])
    const candidatesDir = join(ownerHome, 'persona', 'profile-pic-candidates')
    mkdirSync(candidatesDir, { recursive: true })
    const candId = 'cand-A123'
    const candPath = join(candidatesDir, `${candId}.png`)
    writeFileSync(candPath, candidateBytes)
    const handler = buildCandidateRouteHandler({ owner_home: ownerHome })
    const res = await handler(
      new Request(`https://example.test/profile-pic/candidate/${candId}.png`),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
    const body = new Uint8Array(await (res as Response).arrayBuffer())
    expect(body.length).toBe(candidateBytes.length)
  })

  test('404s on unknown candidate id', async () => {
    const { buildCandidateRouteHandler } = await import('../storage.ts')
    const handler = buildCandidateRouteHandler({ owner_home: ownerHome })
    const res = await handler(
      new Request('https://example.test/profile-pic/candidate/no-such-id.png'),
    )
    expect((res as Response).status).toBe(404)
  })

  test('rejects path-traversal attempt', async () => {
    const { buildCandidateRouteHandler } = await import('../storage.ts')
    const handler = buildCandidateRouteHandler({ owner_home: ownerHome })
    const res = await handler(
      new Request('https://example.test/profile-pic/candidate/..%2Fetc%2Fpasswd.png'),
    )
    expect((res as Response).status).toBe(404)
  })

  test('rejects non-png suffixes', async () => {
    const { buildCandidateRouteHandler } = await import('../storage.ts')
    const handler = buildCandidateRouteHandler({ owner_home: ownerHome })
    const res = await handler(
      new Request('https://example.test/profile-pic/candidate/cand-A.jpg'),
    )
    expect((res as Response).status).toBe(404)
  })
})
