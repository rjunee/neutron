/**
 * RB3 ([BEHAVIOR]) — the scheduled reflect-consolidation loop arms ONLY behind
 * the shared `NEUTRON_PERFECT_RECALL` flag.
 *
 * Driven through the REAL Open composer boundary (the same harness the
 * loop-inventory guard uses): booting the composer registers every composer-side
 * loop into `composition.loop_registry`. This test pins the flag semantics:
 *   - flag OFF (default) → `reflect-consolidation` is NOT registered (the loop
 *     never arms, zero LLM cost);
 *   - flag ON → `reflect-consolidation` IS registered + started, with a live
 *     descriptor and a daily cadence.
 *
 * `immediate` is false, so an armed loop fires NO tick (hence NO LLM call, NO
 * memory access) during boot — the arming is observable purely via the registry.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { DEFAULT_REFLECT_INTERVAL_MS } from '@neutronai/scribe/index.ts'
import { SupervisedLoop } from '@neutronai/loop'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const REFLECT_LOOP = 'reflect-consolidation'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
  'NEUTRON_PERFECT_RECALL',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string | undefined

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-reflect-arming-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-reflect-arming'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
  delete process.env['NEUTRON_PERFECT_RECALL']
})

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'token', text: 'ready' }
    yield {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: instanceId,
    }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

async function bootComposer(): Promise<{
  composition: Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
  close: () => Promise<void>
}> {
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  const composition = await composer({ db, project_slug: 'owner' })
  return {
    composition,
    close: async () => {
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          await cleanup()
        } catch {
          /* best-effort */
        }
      }
      db.close()
    },
  }
}

test('shutdown quiesces an in-flight reflect tick BEFORE memory close begins', async () => {
  // The composer registers the reflect loop's quiescing stop() cleanup BEFORE the
  // memory cleanups (which start gbrainMemory.close()), and realmode_cleanups drain
  // in forward order. So an in-flight tick must fully settle before memory close —
  // otherwise a tick mid-syncHook/deletePage could hit a closing GBrain. This
  // reproduces that exact ordering with a gated tick + a fake memory-close cleanup.
  const events: string[] = []
  let releaseTick!: () => void
  const gate = new Promise<void>((r) => {
    releaseTick = r
  })
  const loop = new SupervisedLoop({
    name: 'reflect-consolidation',
    intervalMs: 60_000,
    tick: async (): Promise<void> => {
      events.push('tick-start')
      await gate // hold the tick "in flight" (mid syncHook/deletePage)
      events.push('tick-end')
    },
  })
  loop.start()
  void loop.runOnce() // drive one tick; it now parks on the gate

  // The composer's registration order: loop stop FIRST, then the memory close.
  const cleanups: Array<() => void | Promise<void>> = [
    async () => {
      await loop.stop()
    },
    () => {
      events.push('memory-close')
    },
  ]
  // Release the tick shortly after the drain starts awaiting stop().
  setTimeout(() => releaseTick(), 10)
  for (const c of cleanups) await c() // forward-order drain (drainRealmodeCleanups)

  expect(events).toEqual(['tick-start', 'tick-end', 'memory-close'])
})

test('flag OFF (default) → reflect-consolidation is NOT armed', async () => {
  const { composition, close } = await bootComposer()
  try {
    expect(composition.loop_registry?.has(REFLECT_LOOP)).toBe(false)
  } finally {
    await close()
  }
})

test('flag ON → reflect-consolidation is armed with a live daily-cadence descriptor', async () => {
  process.env['NEUTRON_PERFECT_RECALL'] = '1'
  const { composition, close } = await bootComposer()
  try {
    const reg = composition.loop_registry
    expect(reg?.has(REFLECT_LOOP)).toBe(true)
    const desc = reg?.get(REFLECT_LOOP)
    expect(desc).toBeDefined()
    if (desc !== undefined) {
      expect(desc.cadenceMs).toBe(DEFAULT_REFLECT_INTERVAL_MS)
      expect(desc.startedAt).toBeGreaterThan(0) // start() was called
      const health = desc.health()
      // No tick fired at boot (immediate:false) → never-ticked, healthy.
      expect(health.lastTickAt).toBeNull()
      expect(health.lastError).toBeNull()
    }
  } finally {
    await close()
  }
})
