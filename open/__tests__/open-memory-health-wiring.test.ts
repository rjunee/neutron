/**
 * RA2 (gbrain live-or-loud) — Open composition wires `memory_health`.
 *
 * The composer→boot→`/healthz` seam has three links:
 *   1. `buildGBrainMemory` exposes `bootHealth` (unit-tested in
 *      `gateway/wiring/__tests__/build-gbrain-memory.test.ts`).
 *   2. `defaultHealthzHandler` folds a `memoryHealth` provider into the liveness
 *      body (unit-tested in `gateway/listener.test.ts`).
 *   3. THIS test — the Open composer actually SETS `composition.memory_health`
 *      to a working thunk sourced from the memory wiring, so `boot()` has
 *      something to fold in. Without this the degraded `/healthz` is dead wiring.
 *
 * Boots the REAL Open composition (`buildOpenGraphComposer`, the same the boot
 * shell runs) LLM-less over a temp home, and asserts the thunk returns a valid
 * `MemoryHealthSummary` — and that its `available`/`detail` branches are
 * internally consistent (a DOWN backend carries a coarse, non-sensitive detail;
 * a healthy one carries none).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { buildGBrainMemory } from '@neutronai/gateway/wiring/build-gbrain-memory.ts'
import { boot } from '@neutronai/gateway/index.ts'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-mem-health-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(() => {
  db?.close()
  db = null
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

test('RA2: the Open composition sets memory_health with a consistent, non-sensitive summary', async () => {
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  try {
    // The composer wired the thunk (not left it undefined → dead degraded path).
    expect(typeof composition.memory_health).toBe('function')
    const summary = composition.memory_health!()
    expect(typeof summary.available).toBe('boolean')
    // SOURCE check: the thunk must reflect buildGBrainMemory's bootHealth, not a
    // constant. Probe the SAME env independently and assert equality — a stubbed
    // `() => ({ available: true })` wiring would mismatch on any host whose real
    // value differs (e.g. CI without gbrain → false), catching dead wiring.
    const independent = buildGBrainMemory({ owner_home: tmpDir, project_slug: 'owner', env: process.env })
    expect(summary.available).toBe(independent.bootHealth.binaryPresent)
    try {
      await independent.close()
    } catch {
      /* best-effort */
    }
    if (summary.available) {
      // Healthy backend → no degraded detail.
      expect(summary.detail).toBeUndefined()
    } else {
      // DOWN backend → a coarse, non-sensitive one-liner (no owner path leak),
      // exactly what rides the unauthenticated /healthz body.
      expect(typeof summary.detail).toBe('string')
      expect(summary.detail).not.toContain(tmpDir)
      expect(summary.detail).toContain('gbrain')
    }
  } finally {
    // Await async cleanups — realmode_cleanups may return Promise<void> (GBrain /
    // client shutdown); not awaiting races the afterEach db.close()/rmSync.
    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        await cleanup()
      } catch {
        /* best-effort */
      }
    }
  }
})

test('RA2: boot() folds the REAL Open composition memory_health into the SERVED /healthz (chained path, degraded)', async () => {
  // End-to-end over the PRODUCTION chained path: boot the REAL Open composer (which
  // stands up chained HTTP surfaces → composeProductionGraph's chain, NOT the dev
  // healthz-only fallback), overriding only memory_health to a deterministic DOWN
  // backend. Proves boot() folds it into the terminal /healthz. Deleting the chained
  // fold in gateway/index.ts turns this red.
  {
    // Migrate the DB the composer/boot will open, then hand boot() the path.
    const seed = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
    applyMigrations(seed.raw())
    seed.close()
  }
  const realComposer = buildOpenGraphComposer({ env: process.env })
  const handle = await boot({
    port: 0,
    composer: async (args) => {
      const c = await realComposer(args)
      return { ...c, memory_health: () => ({ available: false, detail: 'gbrain binary not found on PATH' }) }
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; memory?: string; memory_detail?: string }
    expect(body.status).toBe('degraded')
    expect(body.memory).toBe('unavailable')
    expect(body.memory_detail).toBe('memory backend unavailable')
  } finally {
    await handle.shutdown()
  }
})
