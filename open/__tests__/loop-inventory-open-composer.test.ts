/**
 * §F2 — loop-inventory guard driven through the REAL Open composition boundary
 * (the ISSUE-#32 "assert the set, not archaeology" pattern applied to loops).
 *
 * Gateway boot runs the OPEN composer FIRST (it starts the `ChunkedUploadSweeper`
 * and, on the credentialed dispatch path, the `dispatch-lifecycle-watchdog`),
 * THEN `composeProductionGraph` (which starts reminders / trident / cron /
 * watchdog). Both boundaries register into the SAME `LoopRegistry` threaded via
 * `CompositionInput.loop_registry`, so the ONE boot line inventories the COMPLETE
 * running set. This test drives that exact sequence — the real composer, not a
 * stub — and pins the complete set:
 *
 *   chunked-upload-sweeper, cron, dispatch-lifecycle-watchdog,
 *   reminders, trident, watchdog
 *
 * A loop that silently stops starting (a wiring regression) OR a silently-added
 * new loop breaks this. MUTATION-VERIFIED: deleting any `loopRegistry.register`
 * call (sweeper in `wireUploads`, watchdog in `open/composer.ts`, or any gateway
 * module in `build-core-modules.ts`) drops that loop and turns this red.
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
import { composeProductionGraph, DORMANT_LOOPS } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The COMPLETE set of loops a credentialed single-owner Open boot starts. */
const EXPECTED_RUNNING_LOOPS = [
  'chunked-upload-sweeper',
  'cron',
  'dispatch-lifecycle-watchdog',
  'reminders',
  'trident',
  'watchdog',
] as const
/** The D-7 dormant loops (built, never started). */
const EXPECTED_DORMANT_LOOPS = ['agent-watcher', 'project-backup-scheduler'] as const

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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-loop-inventory-open-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  // Credentialed boot → the dispatch service (and its lifecycle watchdog) wire up.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-loop-inventory'
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

interface Harness {
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  composition: Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
  close(): Promise<void>
}

async function bootRealOpen(): Promise<Harness> {
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  // 1) REAL Open composer — starts the sweeper + (credentialed) lifecycle watchdog
  //    and registers them into `composition.loop_registry`.
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  const composition = await composer({ db, project_slug: 'owner' })
  // 2) The production graph — adds reminders / trident / cron / watchdog to the
  //    SAME registry threaded through `composition.loop_registry`.
  const graph = await composeProductionGraph(composition)
  return {
    graph,
    composition,
    close: async () => {
      await graph.shutdown()
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

let harness: Harness
beforeEach(async () => {
  harness = await bootRealOpen()
})
afterEach(async () => {
  await harness.close()
})

test('the real Open boundary starts EXACTLY the complete loop set', () => {
  expect(harness.graph.loopRegistry.names()).toEqual([...EXPECTED_RUNNING_LOOPS])
})

test('gateway + Open composer share ONE registry instance', () => {
  // The registry the composer threaded IS the one the graph inventories — so the
  // boot line covers loops from BOTH boundaries, not two disjoint registries.
  const threaded = harness.composition.loop_registry
  expect(threaded).toBeDefined()
  expect(harness.graph.loopRegistry).toBe(threaded as NonNullable<typeof threaded>)
})

test('every running loop exposes a live descriptor', () => {
  for (const name of EXPECTED_RUNNING_LOOPS) {
    const desc = harness.graph.loopRegistry.get(name)
    expect(desc, `loop '${name}' missing`).toBeDefined()
    if (desc === undefined) continue
    expect(desc.startedAt).toBeGreaterThan(0)
    const health = desc.health()
    expect('lastTickAt' in health).toBe(true)
    expect('lastError' in health).toBe(true)
  }
})

test('D-7 dormant loops are enumerated + NOT running (no silent dead loop)', () => {
  const dormantNames = DORMANT_LOOPS.map((d) => d.name).sort()
  expect(dormantNames).toEqual([...EXPECTED_DORMANT_LOOPS])
  for (const d of DORMANT_LOOPS) {
    expect(harness.graph.loopRegistry.has(d.name)).toBe(false)
  }
})

test('the ONE boot line names all six running loops + the dormant set', () => {
  const line = harness.graph.loopRegistry.bootLine('owner', DORMANT_LOOPS)
  expect(line).toContain('6 loop(s) running')
  for (const name of EXPECTED_RUNNING_LOOPS) expect(line).toContain(name)
  expect(line).toMatch(/cron \(\d+ jobs/)
  expect(line).toContain('2 dormant (deferred): [agent-watcher, project-backup-scheduler]')
})
