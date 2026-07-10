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
    // Seed a PRIOR process's in-flight dispatch directly into the project DB. It
    // MUST carry a boot id distinct from this process's CURRENT_BOOT_ID (which the
    // composer's sweep runs under) — a same-boot row would be correctly protected
    // and never reaped. That distinct boot id is exactly what marks it a prior orphan.
    const seed = new SubagentRegistryStore(db, 'boot-prior-dead-process')
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

    // Capture the REAL report surface the composer wires. `dispatchReport`
    // (composer.ts) — the sink `buildBootSweepReport(dispatchReport)` feeds the
    // sweep — writes each crashed report to `console.log` as an
    // `[agent-dispatch] … → crashed` line + markdown. Spying it proves the boot
    // sweep actually FIRES the report sink (not merely flips the durable row) —
    // P7's exact acceptance criterion ("a restart SURFACES the orphan"). The
    // durable-row assertion alone can't see this: `markCrashed` runs regardless,
    // so deleting `report: buildBootSweepReport(dispatchReport)` in composer.ts
    // would leave a row-only test green. This capture turns that mutation RED.
    const captured: string[] = []
    const realLog = console.log
    console.log = (...args: unknown[]): void => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    }
    try {
      // Boot the REAL composer (no credential needed — the boot reap runs
      // unconditionally). Firing it is fire-and-forget inside composition.
      const composer = buildOpenGraphComposer({ env: process.env })
      const composition = await composer({ db, project_slug: 'owner' })

      // Poll until the boot-reap REPORT line for THIS orphan is captured (the
      // report fires just after the durable claim inside the fire-and-forget
      // sweep). Matching on the wired `[agent-dispatch]` line + run_id.
      let reportLine: string | undefined
      for (let i = 0; i < 400; i++) {
        reportLine = captured.find(
          (l) => l.includes('[agent-dispatch]') && l.includes('prior-orphan'),
        )
        if (reportLine !== undefined) break
        // eslint-disable-next-line no-await-in-loop
        await Bun.sleep(5)
      }

      // The durable row was transitioned...
      expect(seed.get('prior-orphan')?.status).toBe('crashed')
      expect(seed.get('prior-orphan')?.failure_reason).toBe('process_dead')

      // ...AND the report sink actually FIRED for the orphan, with the mapped
      // fields (agent kind, terminal `crashed` status, failure_reason).
      expect(reportLine).toBeDefined()
      expect(reportLine).toContain('crashed') // mapped terminal status
      expect(reportLine).toContain('atlas') // mapped agent kind (a non-skipped kind)
      expect(reportLine).toContain('process_dead') // failure_reason surfaced

      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
    } finally {
      console.log = realLog
    }
  }, 20_000)
})
