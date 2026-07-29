/**
 * RB3 ([BEHAVIOR]) — the scheduled reflect-consolidation loop arms
 * UNCONDITIONALLY. Memory consolidation is ON by default (managed SPEC Decisions
 * Log 2026-07-20, P0-4 — the perfect-recall lane is BASE, not a flag).
 *
 * Driven through the REAL Open composer boundary (the same harness the
 * loop-inventory guard uses): booting the composer registers every composer-side
 * loop into `composition.loop_registry`. This test pins the arming semantics with
 * NO env var set:
 *   - `reflect-consolidation` IS registered + started, with a live descriptor and
 *     the 6h cadence (`DEFAULT_REFLECT_INTERVAL_MS === 6 * 60 * 60 * 1000`);
 *   - its quiescing stop() is wired into `realmode_cleanups`.
 *
 * `immediate` is false, so the armed loop fires NO tick (hence NO LLM call, NO
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
  // Composer-boundary proof (not a fabricated loop): boot the real Open
  // composer, then drain the ACTUAL `composition.realmode_cleanups`. The reflect
  // loop must go active → inactive as a result — i.e. the composer genuinely
  // registered the loop's quiescing stop() into the cleanup set. Fails if that
  // cleanup is ever dropped (the loop would stay active after the drain).
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
  // later validation) and prove — by spying on `SupervisedLoop.start` keyed on the
  // loop's IDENTITY (its `name`, not its cadence) — that the reflect loop never
  // armed. Keying on identity is deliberate: the 6h cadence is no longer unique
  // (other schedulers share it), so a raw `ms === DEFAULT_REFLECT_INTERVAL_MS`
  // spy would be fragile against an unrelated 6h loop arming in the same boot.
  delete process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET']
  const realStart = SupervisedLoop.prototype.start
  const startedLoopNames: string[] = []
  SupervisedLoop.prototype.start = function patchedStart(this: SupervisedLoop): void {
    startedLoopNames.push((this as unknown as { name: string }).name)
    return realStart.call(this)
  }
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  try {
    const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
    await expect(composer({ db, project_slug: 'owner' })).rejects.toThrow()
    // The reflect loop (identity `reflect-consolidation`) never started → no leaked timer.
    expect(startedLoopNames).not.toContain(REFLECT_LOOP)
  } finally {
    SupervisedLoop.prototype.start = realStart
    db.close()
  }
})

test('arming rollback: a throwing timer leaves the loop stopped (composer failure-atomicity)', async () => {
  // The composer arms the reflect loop as `register(...); try { start() } catch {
  // await stop(); throw }`. This pins the rollback mechanism it relies on: a loop
  // whose timer constructor throws surfaces the throw, and stop() afterwards is a
  // clean no-op that leaves the loop inactive (no dangling timer).
  const loop = new SupervisedLoop({
    name: 'reflect-consolidation',
    intervalMs: 60_000,
    tick: async (): Promise<void> => {},
    setTimer: () => {
      throw new Error('timer creation failed')
    },
  })
  // Mirror the composer: start() throws → roll back with stop() → re-throw.
  let threw = false
  try {
    loop.start()
  } catch {
    threw = true
    await loop.stop() // rollback must not throw
  }
  expect(threw).toBe(true)
  expect(loop.describe().isActive?.()).toBe(false) // no live/dangling timer
})

test('reflect-consolidation is armed UNCONDITIONALLY (no env var) with a live 6h-cadence descriptor', async () => {
  // No perfect-recall env var exists anymore (the flag was deleted). The loop must
  // still register + start (memory consolidation is ON by default).
  const { composition, close } = await bootComposer()
  try {
    const reg = composition.loop_registry
    expect(reg?.has(REFLECT_LOOP)).toBe(true)
    const desc = reg?.get(REFLECT_LOOP)
    expect(desc).toBeDefined()
    if (desc !== undefined) {
      // The cadence is the 6h default, pinned to the literal so a regression to
      // the old 24h value fails HERE.
      expect(DEFAULT_REFLECT_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
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
