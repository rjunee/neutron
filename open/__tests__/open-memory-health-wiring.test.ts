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
    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }
})
