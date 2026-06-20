/**
 * Admin-personality surface tests (2026-05-22).
 *
 * Covers the new /api/app/persona/* routes from
 * docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md.
 *
 * Mirrors the production-style harness used by app-admin-surface.test.ts:
 * dev-bypass `AppWsAuthResolver`, per-test `owner_home` tmpdir, route the
 * request through `composeHttpHandler` so the precedence chain is the
 * production one.
 *
 * Asserts:
 *   - GET /files lists the 3 persona files with mtime + size + exists.
 *   - GET /file?name=SOUL.md returns body + X-Mtime header.
 *   - GET on a missing file returns 200 + empty body + X-Mtime: 0.
 *   - PATCH /file?name=SOUL.md writes atomically + returns new mtime
 *     + fires the onReload hook.
 *   - PATCH with stale expected_mtime returns 409 + current_mtime.
 *   - PATCH with expected_mtime: -1 force-overwrites.
 *   - PATCH body > MAX_PERSONA_TEXT_LEN returns 413.
 *   - POST /restart-from-scratch deletes the 3 files + fires onReload
 *     once per deleted file + calls onRestartFromScratch when wired.
 *   - 401 missing bearer / 401 invalid bearer / 403 project_mismatch /
 *     403 filename_not_allowed / 405 method_not_allowed branches.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../../channels/index.ts'
import {
  ALLOWED_PERSONA_FILENAMES,
  MAX_PERSONA_FILE_BYTES,
  createAdminPersonalitySurface,
  type PersonaFilename,
} from '../admin-personality-surface.ts'
import { composeHttpHandler } from '../compose.ts'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  tmp: string
  owner_home: string
  reloadCalls: PersonaFilename[]
  restartCalls: number
  close(): Promise<void>
}

const PROJECT_SLUG = 'demo'
const OTHER_OWNER = 'someone-else'

interface StartOptions {
  withOnReload?: boolean
  withOnRestartFromScratch?: boolean | (() => Promise<void>)
}

async function startGateway(opts: StartOptions = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-admin-persona-'))
  const owner_home = join(tmp, 'owner_home')
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const reloadCalls: PersonaFilename[] = []
  const restartTracker = { calls: 0 }
  type FactoryArgs = Parameters<typeof createAdminPersonalitySurface>[0]
  const surfaceOpts: FactoryArgs = {
    auth,
    owner_home,
    project_slug: PROJECT_SLUG,
  }
  if (opts.withOnReload !== false) {
    surfaceOpts.onReload = (name): void => {
      reloadCalls.push(name)
    }
  }
  if (opts.withOnRestartFromScratch !== undefined) {
    if (typeof opts.withOnRestartFromScratch === 'function') {
      surfaceOpts.onRestartFromScratch = opts.withOnRestartFromScratch
    } else if (opts.withOnRestartFromScratch === true) {
      surfaceOpts.onRestartFromScratch = async (): Promise<void> => {
        restartTracker.calls += 1
      }
    }
  }
  const surface = createAdminPersonalitySurface(surfaceOpts)
  const composed = composeHttpHandler({
    appPersona: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    tmp,
    owner_home,
    reloadCalls,
    get restartCalls(): number {
      return restartTracker.calls
    },
    close: async (): Promise<void> => {
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function bearer(headers: HeadersInit = {}): Headers {
  const h = new Headers(headers)
  h.set('authorization', 'Bearer dev:test-user')
  return h
}

function seedFile(owner_home: string, name: PersonaFilename, body: string): void {
  const dir = join(owner_home, 'persona')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body, 'utf8')
}

let h: Harness
beforeEach(async () => {
  h = await startGateway()
})
afterEach(async () => {
  await h.close()
})

describe('GET /api/app/persona/files', () => {
  it('lists the 3 allow-listed files with exists/mtime/size when none exist yet', async () => {
    const res = await fetch(`${h.base}/api/app/persona/files`, { headers: bearer() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      files: Array<{ filename: string; exists: boolean; size_bytes: number; last_modified_iso: string | null }>
    }
    expect(body.ok).toBe(true)
    expect(body.files).toHaveLength(3)
    expect(body.files.map((f) => f.filename).sort()).toEqual(['SOUL.md', 'USER.md', 'priority-map.md'].sort())
    for (const f of body.files) {
      expect(f.exists).toBe(false)
      expect(f.size_bytes).toBe(0)
      expect(f.last_modified_iso).toBeNull()
    }
  })

  it('reports exists=true + size + iso mtime after a file is written on disk', async () => {
    seedFile(h.owner_home, 'SOUL.md', '# Personality\nHello world\n')
    const res = await fetch(`${h.base}/api/app/persona/files`, { headers: bearer() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      files: Array<{ filename: string; exists: boolean; size_bytes: number; last_modified_iso: string | null }>
    }
    const soul = body.files.find((f) => f.filename === 'SOUL.md')
    expect(soul?.exists).toBe(true)
    expect(soul?.size_bytes).toBeGreaterThan(0)
    expect(soul?.last_modified_iso).not.toBeNull()
  })
})

describe('GET /api/app/persona/file', () => {
  it('returns the file body + X-Mtime header for an existing file', async () => {
    seedFile(h.owner_home, 'USER.md', 'name: sam\n')
    const res = await fetch(`${h.base}/api/app/persona/file?name=USER.md`, { headers: bearer() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const mtime = Number(res.headers.get('x-mtime') ?? '0')
    expect(mtime).toBeGreaterThan(0)
    const text = await res.text()
    expect(text).toBe('name: sam\n')
  })

  it('returns 200 + empty body + X-Mtime: 0 when the file does not exist', async () => {
    const res = await fetch(
      `${h.base}/api/app/persona/file?name=priority-map.md`,
      { headers: bearer() },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-mtime')).toBe('0')
    const text = await res.text()
    expect(text).toBe('')
  })

  it('returns 403 filename_not_allowed for a name outside the allow-list', async () => {
    const res = await fetch(
      `${h.base}/api/app/persona/file?name=../etc/passwd`,
      { headers: bearer() },
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('filename_not_allowed')
  })

  it('returns 400 missing_name when ?name is absent', async () => {
    const res = await fetch(`${h.base}/api/app/persona/file`, { headers: bearer() })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('missing_name')
  })
})

describe('PATCH /api/app/persona/file', () => {
  it('creates the file when missing and returns the new mtime', async () => {
    const res = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
      method: 'PATCH',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: '# new soul\n', expected_mtime: 0 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; mtime: number }
    expect(body.ok).toBe(true)
    expect(body.mtime).toBeGreaterThan(0)
    const onDisk = readFileSync(join(h.owner_home, 'persona', 'SOUL.md'), 'utf8')
    expect(onDisk).toBe('# new soul\n')
    expect(h.reloadCalls).toEqual(['SOUL.md'])
  })

  it('returns 409 mtime_conflict + current_mtime when expected_mtime is stale', async () => {
    // First write — get a baseline mtime.
    const r1 = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
      method: 'PATCH',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: 'v1', expected_mtime: 0 }),
    })
    const { mtime: m1 } = (await r1.json()) as { mtime: number }
    // External mutation — bump mtime past m1.
    await Bun.sleep(20)
    seedFile(h.owner_home, 'SOUL.md', 'changed by ssh')
    // Stale PATCH using the original m1 — must 409.
    const r2 = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
      method: 'PATCH',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: 'v2', expected_mtime: m1 }),
    })
    expect(r2.status).toBe(409)
    const body = (await r2.json()) as { code: string; current_mtime: number }
    expect(body.code).toBe('mtime_conflict')
    expect(body.current_mtime).toBeGreaterThan(m1)
    // On-disk content must be the ssh edit, NOT v2.
    expect(readFileSync(join(h.owner_home, 'persona', 'SOUL.md'), 'utf8')).toBe('changed by ssh')
  })

  it('force-overwrites when expected_mtime is -1', async () => {
    seedFile(h.owner_home, 'SOUL.md', 'old')
    const res = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
      method: 'PATCH',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: 'forced', expected_mtime: -1 }),
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(h.owner_home, 'persona', 'SOUL.md'), 'utf8')).toBe('forced')
  })

  it('returns 413 payload_too_large when body exceeds MAX_PERSONA_FILE_BYTES', async () => {
    const big = 'x'.repeat(MAX_PERSONA_FILE_BYTES + 1)
    const res = await fetch(`${h.base}/api/app/persona/file?name=USER.md`, {
      method: 'PATCH',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: big, expected_mtime: 0 }),
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('payload_too_large')
  })

  it('returns 413 payload_too_large from the content-length preflight BEFORE parsing (Argus r1 Security P1-1)', async () => {
    // Bun's high-level `fetch` overrides Content-Length to match the
    // actual body bytes, so we hand-roll a Request to feed the
    // surface handler directly. This validates the preflight branch
    // (declared-length > cap → 413) without depending on the HTTP
    // server layer's header-rewriting behavior.
    const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
    const surface = createAdminPersonalitySurface({
      auth,
      owner_home: h.owner_home,
      project_slug: PROJECT_SLUG,
    })
    const huge_declared = MAX_PERSONA_FILE_BYTES + 10_000
    const req = new Request(
      'http://gw/api/app/persona/file?name=SOUL.md',
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer dev:test-user',
          'content-type': 'application/json',
          'content-length': String(huge_declared),
        },
        body: JSON.stringify({ content: 'x', expected_mtime: 0 }),
      },
    )
    const res = await surface.handler(req)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(413)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('payload_too_large')
  })

  it('returns 400 malformed_json when PATCH body is a JSON primitive (Argus r1 Security P2-2)', async () => {
    for (const primitive of ['42', '"x"', 'true', 'null', '[1,2]']) {
      const res = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
        method: 'PATCH',
        headers: bearer({ 'content-type': 'application/json' }),
        body: primitive,
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('malformed_json')
    }
  })

  it('returns 400 invalid_content when content is not a string', async () => {
    const res = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
      method: 'PATCH',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: 42, expected_mtime: 0 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_content')
  })

  it('returns 400 missing_expected_mtime when expected_mtime is absent', async () => {
    const res = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
      method: 'PATCH',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: 'x' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('missing_expected_mtime')
  })
})

describe('POST /api/app/persona/restart-from-scratch', () => {
  it('deletes existing persona files, fires onReload per file, and reports files_deleted + empty files_failed', async () => {
    seedFile(h.owner_home, 'SOUL.md', 'a')
    seedFile(h.owner_home, 'USER.md', 'b')
    seedFile(h.owner_home, 'priority-map.md', 'c')
    const res = await fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      files_deleted: string[]
      files_failed: Array<{ filename: string; code: string }>
      onboarding_reset: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.files_deleted.sort()).toEqual(['SOUL.md', 'USER.md', 'priority-map.md'].sort())
    expect(body.files_failed).toEqual([])
    expect(body.onboarding_reset).toBe(false) // no hook wired
    for (const f of ALLOWED_PERSONA_FILENAMES) {
      expect(existsSync(join(h.owner_home, 'persona', f))).toBe(false)
    }
    // onReload fires once per deleted file.
    expect(h.reloadCalls.slice().sort()).toEqual(
      (['SOUL.md', 'USER.md', 'priority-map.md'] as PersonaFilename[]).slice().sort(),
    )
  })

  it('returns 207 + files_failed when unlink fails with non-ENOENT (Codex r1 P2 fix — partial deletion)', async () => {
    // Simulate a permissions / type-mismatch failure by replacing one
    // persona file with a directory of the same name — unlink(dir) fails
    // with EISDIR or EPERM depending on platform; either way non-ENOENT.
    seedFile(h.owner_home, 'SOUL.md', 'a')
    seedFile(h.owner_home, 'USER.md', 'b')
    // Replace priority-map.md with a directory.
    const dirAsFile = join(h.owner_home, 'persona', 'priority-map.md')
    rmSync(dirAsFile, { force: true })
    mkdirSync(dirAsFile)
    const res = await fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(207)
    const body = (await res.json()) as {
      ok: boolean
      files_deleted: string[]
      files_failed: Array<{ filename: string; code: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.files_deleted.sort()).toEqual(['SOUL.md', 'USER.md'].sort())
    expect(body.files_failed).toHaveLength(1)
    expect(body.files_failed[0]?.filename).toBe('priority-map.md')
    // Directory still exists.
    expect(existsSync(dirAsFile)).toBe(true)
  })

  it('returns 400 malformed_json on restart when body is a JSON primitive (Argus r1 Security P2-2)', async () => {
    const res = await fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer({ 'content-type': 'application/json' }),
      body: '"hi"',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('malformed_json')
  })

  it('returns 400 confirm_required when confirm is missing or not true', async () => {
    const res = await fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('confirm_required')
  })

  it('calls onRestartFromScratch when wired + reports onboarding_reset: true', async () => {
    await h.close()
    h = await startGateway({ withOnRestartFromScratch: true })
    seedFile(h.owner_home, 'SOUL.md', 'a')
    const res = await fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { onboarding_reset: boolean }
    expect(body.onboarding_reset).toBe(true)
    expect(h.restartCalls).toBe(1)
  })

  it('reports onboarding_reset: false even when hook throws — file deletion succeeded', async () => {
    await h.close()
    h = await startGateway({
      withOnRestartFromScratch: async (): Promise<void> => {
        throw new Error('reset hook exploded')
      },
    })
    seedFile(h.owner_home, 'SOUL.md', 'a')
    const res = await fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { onboarding_reset: boolean; files_deleted: string[] }
    expect(body.onboarding_reset).toBe(false)
    expect(body.files_deleted).toContain('SOUL.md')
    expect(existsSync(join(h.owner_home, 'persona', 'SOUL.md'))).toBe(false)
  })

  it('is a no-op idempotent call when no files exist yet (200, empty files_deleted)', async () => {
    const res = await fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer({ 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files_deleted: string[] }
    expect(body.files_deleted).toEqual([])
  })
})

describe('auth + dispatch', () => {
  it('returns 401 missing_bearer when Authorization header is absent', async () => {
    const res = await fetch(`${h.base}/api/app/persona/files`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('missing_bearer')
  })

  it('returns 403 project_mismatch when the bearer resolves to a different project', async () => {
    // Mint a second harness whose auth resolver expects OTHER_OWNER,
    // then construct ITS request against THIS harness — auth resolves
    // OTHER_OWNER, surface compares to PROJECT_SLUG, 403.
    const otherAuth = createAppWsAuthResolver({ project_slug: OTHER_OWNER, bypass: true })
    type FactoryArgs = Parameters<typeof createAdminPersonalitySurface>[0]
    const otherSurface = createAdminPersonalitySurface({
      auth: otherAuth,
      owner_home: h.owner_home,
      project_slug: PROJECT_SLUG, // gateway instance != bearer instance
    } as FactoryArgs)
    const composed = composeHttpHandler({
      appPersona: { handler: otherSurface.handler },
      defaultHandler: () => new Response('nf', { status: 404 }),
    })
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => composed.fetch(req, srv),
      websocket: composed.websocket,
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/app/persona/files`, {
        headers: bearer(),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('project_mismatch')
    } finally {
      await server.stop(true)
    }
  })

  it('returns 405 method_not_allowed for an unsupported method on /file', async () => {
    const res = await fetch(`${h.base}/api/app/persona/file?name=SOUL.md`, {
      method: 'PUT',
      headers: bearer({ 'content-type': 'application/json' }),
      body: '{}',
    })
    expect(res.status).toBe(405)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('method_not_allowed')
  })

  it('returns 404 unknown_persona_route for an unmapped path under /persona', async () => {
    const res = await fetch(`${h.base}/api/app/persona/bogus`, { headers: bearer() })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('unknown_persona_route')
  })

  it('returns null (chain falls through) for paths outside /api/app/persona', async () => {
    const res = await fetch(`${h.base}/something/else`, { headers: bearer() })
    // composeHttpHandler's default handler returns 404 — the surface
    // disclaimed the path via `null`.
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found')
  })
})
