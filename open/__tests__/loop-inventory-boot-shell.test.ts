/**
 * §F2 defect #1 — the COMPLETE loop inventory, driven through the real
 * `boot()` shell (gateway/index.ts), which is the ONLY boundary that starts the
 * gateway-liveness loop (the sd_notify systemd watchdog + `onGatewayTick` pulse
 * at `gateway/index.ts`). The composer/graph boundary starts 6 loops; the boot
 * shell adds the 7th and emits the ONE complete boot inventory line.
 *
 * This test boots the REAL Open server in-process (real Bun.serve, real
 * `buildOpenGraphComposer`, credentialed via a canned substrate so the dispatch
 * service + its lifecycle watchdog wire up) and asserts `graph.loopRegistry`
 * holds the truly-complete set including `gateway-liveness`:
 *
 *   chunked-upload-sweeper, cron, dispatch-lifecycle-watchdog,
 *   gateway-liveness, reminders, trident, watchdog
 *
 * MUTATION-VERIFIED: deleting the gateway-liveness registration in
 * `gateway/index.ts` drops it from the set and this test goes red.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, type BootHandle } from '@neutronai/gateway/index.ts'
import type { ComposedProductionGraph } from '@neutronai/gateway/composition.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { createIsolatedHome, type IsolatedHome } from '../../tests/support/test-isolation.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { __resetAmbientAuthCacheForTests } from '../ambient-claude-auth.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** COMPLETE set through the boot shell — 6 composer/graph loops + gateway-liveness. */
const EXPECTED_RUNNING_LOOPS = [
  'chunked-upload-sweeper',
  'cron',
  'dispatch-lifecycle-watchdog',
  'gateway-liveness',
  'reminders',
  'trident',
  'watchdog',
] as const

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
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      // Credentialed → the dispatch service (and its lifecycle watchdog) wire up.
      ANTHROPIC_API_KEY: 'sk-ant-test-loop-inventory-boot',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1',
      NOTIFY_SOCKET: undefined,
      NEUTRON_GRAPH_COMPOSER_MODULE: undefined,
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

async function bootOpen(): Promise<BootHandle> {
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  handle = await boot({ composer, port: 0 })
  return handle
}

function registry(h: BootHandle): ComposedProductionGraph['loopRegistry'] {
  const graph = h.graph as ComposedProductionGraph | null
  if (graph?.loopRegistry === undefined) {
    throw new Error('boot did not expose graph.loopRegistry')
  }
  return graph.loopRegistry
}

test('the real boot shell starts EXACTLY the complete set incl gateway-liveness', async () => {
  const h = await bootOpen()
  expect(registry(h).names()).toEqual([...EXPECTED_RUNNING_LOOPS])
}, 30_000)

test('gateway-liveness is a live descriptor with the watchdog cadence', async () => {
  const h = await bootOpen()
  const desc = registry(h).get('gateway-liveness')
  expect(desc).toBeDefined()
  if (desc === undefined) return
  expect(desc.cadenceMs).toBe(5_000)
  expect(desc.startedAt).toBeGreaterThan(0)
  const health = desc.health()
  expect('lastTickAt' in health).toBe(true)
  expect('lastError' in health).toBe(true)
}, 30_000)

test('the real boot EMITS exactly ONE complete boot-inventory line (captured from console.log)', async () => {
  // Capture the PRODUCTION console.log emission during the real boot — NOT a
  // re-call of bootLine() — so deleting/duplicating the real emission fails here.
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  try {
    await bootOpen()
  } finally {
    console.log = orig
  }
  const inventoryLines = lines.filter((l) => l.includes('[loop-registry]'))
  expect(inventoryLines).toHaveLength(1) // exactly one, emitted by the boot shell
  const line = inventoryLines[0]!
  expect(line).toContain('7 loop(s) running')
  for (const name of EXPECTED_RUNNING_LOOPS) expect(line).toContain(name)
  expect(line).toContain('2 dormant (deferred): [agent-watcher, project-backup-scheduler]')
}, 30_000)
