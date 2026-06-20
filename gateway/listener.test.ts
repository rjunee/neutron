import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boot,
  defaultHealthzHandler,
  resolveListenPort,
  resolveOwnerSlug,
} from './index.ts'

let ownerDir: string
const ORIG_DB_PATH = process.env['NEUTRON_DB_PATH']
const ORIG_PORT = process.env['NEUTRON_PORT']
const ORIG_NOTIFY = process.env['NOTIFY_SOCKET']

beforeAll(() => {
  ownerDir = mkdtempSync(join(tmpdir(), 'neutron-listener-'))
  process.env['NEUTRON_DB_PATH'] = join(ownerDir, 'owner.db')
})

afterAll(() => {
  if (ORIG_DB_PATH === undefined) delete process.env['NEUTRON_DB_PATH']
  else process.env['NEUTRON_DB_PATH'] = ORIG_DB_PATH
  rmSync(ownerDir, { recursive: true, force: true })
})

afterEach(() => {
  if (ORIG_PORT === undefined) delete process.env['NEUTRON_PORT']
  else process.env['NEUTRON_PORT'] = ORIG_PORT
  if (ORIG_NOTIFY === undefined) delete process.env['NOTIFY_SOCKET']
  else process.env['NOTIFY_SOCKET'] = ORIG_NOTIFY
})

describe('resolveListenPort', () => {
  test('explicit override wins over CLI flag and env', () => {
    expect(resolveListenPort(['--port=9000'], { NEUTRON_PORT: '8000' }, 7_000)).toBe(7_000)
  })
  test('CLI --port=N wins over env', () => {
    expect(resolveListenPort(['--port=9000'], { NEUTRON_PORT: '8000' })).toBe(9_000)
  })
  test('env NEUTRON_PORT used when no flag', () => {
    expect(resolveListenPort([], { NEUTRON_PORT: '8000' })).toBe(8_000)
  })
  test('falls back to default 7800 when neither set', () => {
    expect(resolveListenPort([], {})).toBe(7_800)
  })
  test('rejects invalid CLI port (non-integer)', () => {
    expect(() => resolveListenPort(['--port=abc'], {})).toThrow(/invalid --port=abc/)
  })
  test('rejects invalid env port', () => {
    expect(() => resolveListenPort([], { NEUTRON_PORT: 'banana' })).toThrow(/invalid NEUTRON_PORT/)
  })
  test('rejects out-of-range port', () => {
    expect(() => resolveListenPort(['--port=70000'], {})).toThrow(/must be an integer in/)
  })
  test('accepts port 0 (random)', () => {
    expect(resolveListenPort([], {}, 0)).toBe(0)
  })
})

describe('resolveOwnerSlug — Argus r1 file-based override', () => {
  test('falls back to env when no OWNER_HOME / no .url_slug file', () => {
    expect(
      resolveOwnerSlug({ NEUTRON_INSTANCE_SLUG: 'env-slug' } as NodeJS.ProcessEnv),
    ).toBe('env-slug')
  })

  test('returns "dev" when neither file nor env are set', () => {
    expect(resolveOwnerSlug({} as NodeJS.ProcessEnv)).toBe('dev')
  })

  // C4-a2 (SD1): NEUTRON_INSTANCE_SLUG is the only env key the resolver reads.
  test('reads canonical NEUTRON_INSTANCE_SLUG', () => {
    expect(
      resolveOwnerSlug({ NEUTRON_INSTANCE_SLUG: 'inst-slug' } as NodeJS.ProcessEnv),
    ).toBe('inst-slug')
  })

  test('.url_slug file still wins over the env key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-slug-'))
    try {
      writeFileSync(join(dir, '.url_slug'), 'file-slug\n')
      expect(
        resolveOwnerSlug({
          OWNER_HOME: dir,
          NEUTRON_INSTANCE_SLUG: 'inst-slug',
        } as NodeJS.ProcessEnv),
      ).toBe('file-slug')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reads <OWNER_HOME>/.url_slug when present (rename target)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-slug-'))
    try {
      writeFileSync(join(dir, '.url_slug'), 'nova\n')
      expect(
        resolveOwnerSlug({
          OWNER_HOME: dir,
          NEUTRON_INSTANCE_SLUG: 'install-time-slug',
        } as NodeJS.ProcessEnv),
      ).toBe('nova')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('empty file falls through to env (defensive — never return "")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-slug-'))
    try {
      writeFileSync(join(dir, '.url_slug'), '   \n\n')
      expect(
        resolveOwnerSlug({
          OWNER_HOME: dir,
          NEUTRON_INSTANCE_SLUG: 'fallback',
        } as NodeJS.ProcessEnv),
      ).toBe('fallback')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('strips trailing whitespace from file contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-slug-'))
    try {
      writeFileSync(join(dir, '.url_slug'), 'nova\n')
      expect(
        resolveOwnerSlug({ OWNER_HOME: dir } as NodeJS.ProcessEnv),
      ).toBe('nova')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('defaultHealthzHandler', () => {
  test('returns ok JSON with project_slug + uptime_ms on /healthz', async () => {
    const handler = defaultHealthzHandler({
      project_slug: 'unit-test',
      bootedAt: Date.now() - 50,
    })
    const res = await handler(new Request('http://localhost/healthz'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; project_slug: string; uptime_ms: number }
    expect(body.status).toBe('ok')
    expect(body.project_slug).toBe('unit-test')
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
  })
  test('404 on unknown path', async () => {
    const handler = defaultHealthzHandler({ project_slug: 't', bootedAt: Date.now() })
    const res = await handler(new Request('http://localhost/somewhere'))
    expect(res.status).toBe(404)
  })
})

describe('boot opens Bun.serve on resolved port', () => {
  test('GET /healthz returns 200 + JSON body with the project slug', async () => {
    delete process.env['NOTIFY_SOCKET']
    process.env['NEUTRON_INSTANCE_SLUG'] = 'listener-test'
    const handle = await boot({ port: 0 })
    try {
      expect(handle.server.port).toBeGreaterThan(0)
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string; project_slug: string }
      expect(body.status).toBe('ok')
      expect(body.project_slug).toBe('listener-test')
    } finally {
      await handle.shutdown()
    }
  })

  test('shutdown closes the listener (subsequent fetch fails)', async () => {
    delete process.env['NOTIFY_SOCKET']
    const handle = await boot({ port: 0 })
    const port = handle.server.port
    await handle.shutdown()
    let connectFailed = false
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      })
    } catch {
      connectFailed = true
    }
    expect(connectFailed).toBe(true)
  })

  test('explicit BootOptions.httpHandler overrides default', async () => {
    delete process.env['NOTIFY_SOCKET']
    const handle = await boot({
      port: 0,
      httpHandler: (req: Request): Response => {
        const url = new URL(req.url)
        if (url.pathname === '/custom') return new Response('custom-ok', { status: 200 })
        return new Response('not-found', { status: 404 })
      },
    })
    try {
      const ok = await fetch(`http://127.0.0.1:${handle.server.port}/custom`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('custom-ok')
      // /healthz no longer matches because we replaced the default handler.
      const hz = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
      expect(hz.status).toBe(404)
    } finally {
      await handle.shutdown()
    }
  })

  test('BootOptions.port wins over CLI/env', async () => {
    delete process.env['NOTIFY_SOCKET']
    process.env['NEUTRON_PORT'] = '8765'
    // `port: 0` requests a random free port; we just verify the override
    // takes precedence over the env (random port != 8765 in practice).
    const handle = await boot({ port: 0 })
    try {
      expect(handle.server.port).not.toBe(8_765)
    } finally {
      await handle.shutdown()
    }
  })

  test('handler exception is caught and surfaces as 500', async () => {
    delete process.env['NOTIFY_SOCKET']
    const handle = await boot({
      port: 0,
      httpHandler: (): Response => {
        throw new Error('boom')
      },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.server.port}/anything`)
      expect(res.status).toBe(500)
    } finally {
      await handle.shutdown()
    }
  })
})
