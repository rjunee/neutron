/**
 * The dispatch-hold DRAIN wire at the Open composition boundary.
 *
 * WHAT THIS PROVES AND WHY IT BOOTS THE COMPOSER.
 * `gateway/composition/build-core-modules-trident-fire-evidence-wiring.test.ts`
 * proves that a `drain_dispatch_holds` callback HANDED TO `buildCoreModules` is
 * called on the tick's cadence — it injects its own callback, so it says nothing
 * about whether production hands one over at all. That gap is not theoretical:
 * Argus r4 deleted `drain_dispatch_holds: () => tridentHoldSweep()` from
 * `open/composer.ts` and every test in the repo stayed green. That one line is
 * the ONLY trigger a worktree-only `branch_live` hold can ever have — the hold
 * waits on a bare pid, and a pid exiting fires no terminal observer, so without
 * the cadence drain the card queues forever on a quiet instance.
 *
 * THIS FILE USED TO BE `readFileSync` + `SRC.includes(…)`, and Argus r6 was
 * right to call that green-when-dead: string matching does not parse comments,
 * so commenting the wire out satisfied every assertion, and an exact
 * occurrence-count assertion broke on benign refactors while proving nothing
 * about behaviour. So it now composes the REAL Open graph input and CALLS the
 * callback the product actually supplies, against the product's own stores: a
 * queued hold whose card no longer exists is dropped by
 * `buildDispatchHoldSweep`, which is the cheapest observable the real sweep has
 * (no dispatch, no git, no worktree). Delete or comment out the wire and
 * `drain_dispatch_holds` is `undefined` and this test fails.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { DispatchHoldStore } from '@neutronai/trident/dispatch-holds.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb
let drain: (() => Promise<void>) | undefined
let cleanups: Array<() => void> = []

/** Answers immediately and starts no `claude` process; the graph composes the same. */
function mockSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-dispatch-hold-drain-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'dispatch-hold-drain-secret-0123456789'
  // A CREDENTIALED boot. The whole `trident` wiring block — this drain included
  // — is composed only when a credential resolves, so an LLM-less fixture would
  // report the wire missing for the wrong reason.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-dispatch-hold-drain'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']

  seedMigratedDb(process.env['NEUTRON_DB_PATH'] as string)
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'] as string)
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => mockSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  cleanups = composition.realmode_cleanups ?? []
  drain = composition.trident?.drain_dispatch_holds
}, 120_000)

afterAll(() => {
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch {
      /* best-effort */
    }
  }
  db?.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('open/composer.ts hands the trident tick a real dispatch-hold drain', () => {
  test('the composed product supplies drain_dispatch_holds at all', () => {
    expect(typeof drain).toBe('function')
  })

  test('calling it runs the REAL sweep over the product’s own hold store', async () => {
    expect(typeof drain).toBe('function')
    if (typeof drain !== 'function') return
    const holds = new DispatchHoldStore(db)
    await holds.upsert({
      project_slug: 'owner',
      board_item_id: 'a-card-that-is-not-on-any-board',
      task: 'the queued card whose board item no longer exists',
      hold_kind: 'path',
      hold_reason: 'queued behind a live worktree lock, whose pid then exited silently',
    })
    expect(holds.getByItem('owner', 'a-card-that-is-not-on-any-board')).not.toBeNull()

    // NO RUN ARGUMENT — the tick's cadence trigger, which is the one a
    // worktree-only hold depends on. The sweep drops a hold whose card is gone.
    await drain()

    expect(holds.getByItem('owner', 'a-card-that-is-not-on-any-board')).toBeNull()
  })
})
