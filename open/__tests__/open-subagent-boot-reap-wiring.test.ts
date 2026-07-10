/**
 * Open subagent boot-reap prod-boot wiring — the anti-"built-but-not-wired" gate
 * for P7 (subagent-registry persistence + boot reap).
 *
 * THE GAP: `runtime/subagent/registry.ts` promised (S4) a SQLite-backed table so
 * a gateway restart could reap orphaned dispatches. The primitive + boot sweep
 * exist, but the value only lands if `open/composer.ts` actually (a) wires the
 * store as the registry's persistence and (b) FIRES `sweepOrphanedDispatchesOnBoot`
 * during composition. Per CLAUDE.md's "built but never invoked" rule this boots
 * the REAL Open composer and proves it: a LIVE row left by a prior process (seeded
 * directly into the project DB) is transitioned to `crashed` during boot. Delete
 * the sweep invocation in `composer.ts` and this test fails.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SubagentRegistryStore } from '@neutronai/runtime/subagent/store.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-bootreap-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-bootreap-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Open subagent boot-reap prod-boot wiring', () => {
  test('a LIVE registry row left by a prior process is reaped to crashed during boot', async () => {
    // Seed a prior process's in-flight dispatch directly into the project DB.
    const seed = new SubagentRegistryStore(db)
    await seed.persist({
      run_id: 'prior-orphan',
      instance_key: 'owner',
      agent_kind: 'atlas',
      spawn_depth: 0,
      status: 'running',
      started_at: 1_000,
      last_event_at: 1_000,
    })
    expect(seed.get('prior-orphan')?.status).toBe('running')

    // Boot the REAL composer (no credential needed — the boot reap runs
    // unconditionally). Firing it is fire-and-forget inside composition.
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    // The fire-and-forget sweep transitions the orphan to crashed shortly after
    // composition returns; poll the durable row until it flips.
    let reaped = false
    for (let i = 0; i < 400; i++) {
      if (seed.get('prior-orphan')?.status === 'crashed') {
        reaped = true
        break
      }
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(5)
    }
    expect(reaped).toBe(true)
    expect(seed.get('prior-orphan')?.failure_reason).toBe('process_dead')

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)
})
