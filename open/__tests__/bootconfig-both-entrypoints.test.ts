/**
 * C1 — both-entrypoints boot test (the dual-entrypoint-trap regression).
 *
 * Before C1 the two entrypoints resolved `NEUTRON_DB_PATH` with DIFFERENT
 * defaults:
 *   - `gateway/index.ts` → `~/.local/share/neutron/owner.db`
 *   - `open/server.ts`   → `<NEUTRON_HOME>/project.db`
 * So `bun start:gateway` on a box whose Open DB lives at
 * `<NEUTRON_HOME>/project.db` silently booted a healthz-only shell against a
 * FRESH empty `owner.db` — the wrong DB. C1 routes BOTH through the frozen
 * `BootConfig.dbPath` (the single-source `migrations/db-path.ts` precedence).
 *
 * This test boots BOTH entrypoints with `NEUTRON_DB_PATH` UNSET and asserts
 * each opens the SAME `<NEUTRON_HOME>/project.db`, never `owner.db`, and that
 * role resolves correctly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../../tests/support/test-isolation.ts'
import { boot, type BootHandle } from '../../gateway/index.ts'
import { resolveBootConfig, envShimFromBootConfig } from '../../config/index.ts'
import { startOpenServer } from '../server.ts'
import { __resetAmbientAuthCacheForTests } from '../ambient-claude-auth.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

let home: IsolatedHome
let handle: BootHandle | null = null

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
      'NOTIFY_SOCKET',
      'NEUTRON_GRAPH_COMPOSER_MODULE',
      'NEUTRON_ROLE',
      'NEUTRON_PORT',
    ],
    env: {
      // The crux: NEUTRON_DB_PATH UNSET so DEFAULT resolution is exercised.
      NEUTRON_DB_PATH: undefined,
      // startOpenServer has no port arg — force a random free port so this test
      // never collides with a real server on the fixed 7800 default.
      NEUTRON_PORT: '0',
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'both-entrypoints-secret-0123456789',
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1',
      NOTIFY_SOCKET: undefined,
      NEUTRON_GRAPH_COMPOSER_MODULE: undefined,
      NEUTRON_ROLE: undefined,
    },
  })
  __resetAmbientAuthCacheForTests()
})

afterEach(async () => {
  if (handle !== null) {
    await handle.shutdown({ force: true })
    handle = null
  }
  home.restore()
}, 30_000)

describe('C1 — both entrypoints boot against the SAME DB (dual-entrypoint fix)', () => {
  test('gateway entrypoint: config.dbPath is <NEUTRON_HOME>/project.db, NOT owner.db', () => {
    const config = resolveBootConfig(process.env)
    expect(config.dbPath).toBe(join(home.dir, 'project.db'))
    expect(config.dbPath).not.toContain('owner.db')
    expect(config.dbPath).not.toContain('.local/share/neutron')
    expect(config.role).toBe('open')
  })

  test('gateway entrypoint boot (no composer) opens the correct DB + serves /healthz', async () => {
    const config = resolveBootConfig(process.env)
    handle = await boot({ config, port: 0 }) // no composer → the /healthz shell
    const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; project_slug: string }
    expect(body.status).toBe('ok')
    expect(body.project_slug).toBe('owner') // NEUTRON_INSTANCE_SLUG from isolation
    // The DB file must have been created at the Open project.db path.
    expect(existsSync(join(home.dir, 'project.db'))).toBe(true)
    expect(existsSync(join(home.dir, 'owner.db'))).toBe(false)
  }, 30_000)

  test('open entrypoint (startOpenServer) boots the full product against the SAME DB', async () => {
    handle = await startOpenServer()
    const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
    expect(res.status).toBe(200)
    // The shim wrote the resolved DB path back onto process.env for below-seam
    // readers, and it must equal the gateway entrypoint's resolution.
    expect(process.env['NEUTRON_DB_PATH']).toBe(join(home.dir, 'project.db'))
    expect(existsSync(join(home.dir, 'project.db'))).toBe(true)
  }, 30_000)

  test('both entrypoints resolve the identical dbPath', () => {
    const gatewayDbPath = resolveBootConfig(process.env).dbPath
    const openShimDbPath = envShimFromBootConfig(resolveBootConfig(process.env))['NEUTRON_DB_PATH']
    expect(openShimDbPath).toBe(gatewayDbPath)
    expect(gatewayDbPath).toBe(join(home.dir, 'project.db'))
  })

  test('role is resolved from BootConfig (open default; managed when set)', () => {
    expect(resolveBootConfig(process.env).role).toBe('open')
    process.env['NEUTRON_ROLE'] = 'managed'
    expect(resolveBootConfig(process.env).role).toBe('managed')
  })
})
