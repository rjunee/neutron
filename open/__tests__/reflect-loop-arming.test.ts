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

test('the REAL composer wires the reflect-stop cleanup into realmode_cleanups', async () => {
  // Composer-boundary proof (not a fabricated loop): boot the real flagged Open
  // composer, then drain the ACTUAL `composition.realmode_cleanups`. The reflect
  // loop must go active → inactive as a result — i.e. the composer genuinely
  // registered the loop's quiescing stop() into the cleanup set. Fails if that
  // cleanup is ever dropped (the loop would stay active after the drain).
  process.env['NEUTRON_PERFECT_RECALL'] = '1'
  const { composition, close } = await bootComposer()
  try {
    const reg = composition.loop_registry
    expect(reg?.get(REFLECT_LOOP)?.isActive?.()).toBe(true) // armed before shutdown
    // Drain the cleanups the COMPOSER actually registered (forward order, the
    // same order the gateway shutdown runner uses).
    for (const cleanup of composition.realmode_cleanups ?? []) {
      await cleanup()
    }
    expect(reg?.get(REFLECT_LOOP)?.isActive?.()).toBe(false) // real stop cleanup ran
  } finally {
    await close()
  }
})

test('SupervisedLoop.stop quiesces an in-flight tick (the mechanism the composer relies on)', async () => {
  // The composer registers the reflect loop's quiescing stop() BEFORE the memory
  // cleanups, and realmode_cleanups drain in forward order — so an in-flight tick
  // fully settles before gbrainMemory.close() is even called. This pins the
  // underlying quiesce mechanism: stop() does not resolve until a running tick ends.
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

  let stopResolved = false
  const stopping = loop.stop().then(() => {
    stopResolved = true
  })
  await Promise.resolve() // let microtasks flush; stop() must still be pending
  expect(stopResolved).toBe(false) // stop() is BLOCKED on the in-flight tick
  expect(events).toEqual(['tick-start'])

  releaseTick()
  await stopping
  expect(stopResolved).toBe(true)
  expect(events).toEqual(['tick-start', 'tick-end']) // tick settled before stop() returned
})

test('a composer failure after the memory wiring does NOT leak the reflect interval', async () => {
  // The reflect loop is armed LAST (after every failure-prone validation), so a
  // composer throw can't leave a running interval that boot() never gets a cleanup
  // for. Force a failure (remove the cookie secret → the composer rejects during a
  // later validation) with the flag ON, and prove — via a setInterval spy keyed on
  // the reflect loop's unique 24h cadence — that the loop never armed.
  process.env['NEUTRON_PERFECT_RECALL'] = '1'
  delete process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET']
  const realSetInterval = globalThis.setInterval
  let reflectIntervalArmed = 0
  globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === DEFAULT_REFLECT_INTERVAL_MS) reflectIntervalArmed += 1
    return (realSetInterval as (...a: unknown[]) => unknown)(fn, ms, ...rest)
  }) as unknown as typeof globalThis.setInterval
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  try {
    const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
    await expect(composer({ db, project_slug: 'owner' })).rejects.toThrow()
    expect(reflectIntervalArmed).toBe(0) // the loop never armed → no leaked timer
  } finally {
    globalThis.setInterval = realSetInterval
    db.close()
  }
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
