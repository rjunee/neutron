/**
 * THE ROUTE-SLOT COVERAGE GATE — is every declared HTTP surface actually served?
 *
 * `gateway/http/route-slots.ts` DECLARES the gateway's whole HTTP surface, one
 * `slot({...})` per rung. Declaring a slot is not serving it: a slot is only live
 * when a real composer puts its `composition` field on the `CompositionInput`.
 * When it does not, the route is simply absent — the ladder falls through and the
 * caller gets the default 404, indistinguishable from a typo'd path. That is how a
 * complete mobile reminders UI came to ship against endpoints that 404.
 *
 * WHY THIS IS A RUNTIME CHECK AND NOT A GREP. The obvious version of this gate is
 * a lexical scan for `<key>:` across the composers. It was written first and it
 * produced false positives in two ways that a reader cannot be expected to notice:
 *
 *   - SHORTHAND. `open/composer.ts:4565-4566` assigns `chat_topics_surface,` and
 *     `chat_history_surface,` — object shorthand, no colon, invisible to a
 *     `key: value` regex, so two MOUNTED surfaces were reported dead.
 *   - INDIRECTION. `cores_surface` is never written in a composer at all; it is
 *     filled in after the graph composes, by
 *     `gateway/composition/wire-cores-surfaces.ts:47`.
 *
 * A gate with false positives is worse than no gate — this repo has already had a
 * standing red check train everyone to merge past it, which then hid a second,
 * completely dead check for days. So this asks the QUESTION OF THE RUNNING
 * PRODUCT: build the real Open composition, run the real `composeProductionGraph`,
 * and read which slots the resulting composition actually carries. Shorthand and
 * post-compose mutation are both seen for free, because there is nothing to parse.
 *
 * IT IS A RATCHET, NOT A BLANKET ASSERT. Some slots are legitimately absent from
 * an Open boot (hosting-layer routes, credential-conditional ones). Blanket-
 * asserting all of them would be permanently red. So the currently-served set is
 * the baseline that may not shrink, and every absence is written down WITH ITS
 * REASON in `route-slot-coverage-inventory.ts`. An unexplained allowlist entry
 * rots into permission; a reason is a decision someone has to make again in
 * review. The cross-branch half of the ratchet — you may not widen the allowlist
 * by editing the baseline — is `scripts/ci/route-slot-ratchet-guard.sh`, because
 * a test that reads its own baseline cannot catch someone moving the baseline.
 *
 * ONE SLOT IS DECIDED BY STORED STATE, NOT BY THE COMPOSER. `telegram_webhook`
 * mounts iff the instance actually has Telegram secrets, because it is an
 * unauthenticated endpoint whose only auth is a stored secret and there is
 * nothing to compare against without one. The probe therefore SEEDS those
 * secrets (see `seedTelegramSecrets`) exactly as it already fakes an API key —
 * the boot below is meant to be the widest composition an Open instance
 * produces, and a probe that leaves a configurable surface unconfigured is
 * measuring its own fixture. What it must NOT do is assert the route is served
 * on an install that never configured a bot; that would be a false alarm about
 * a correct absence.
 *
 * MUTATION TEST: delete a mounted surface's assignment from `open/composer.ts` and
 * that surface's line appears in this file's failure output. Verified against
 * `app_tasks_surface`, and again 2026-08-02 against `telegram_webhook`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { ROUTE_SLOTS } from '@neutronai/gateway/http/route-slots.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import {
  MIN_EXPECTED_MOUNTED_SLOTS,
  MOUNTED_SLOTS,
  UNMOUNTED_SLOTS,
  type RouteSlotBaselineEntry,
} from './route-slot-coverage-inventory.ts'

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

/**
 * A substrate that answers immediately and starts no `claude` process. The graph
 * composes the same either way — this only keeps the boot off the network.
 */
function mockSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
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

/**
 * Give the instance a configured Telegram bot before the composer runs.
 *
 * `telegram_webhook` is the one slot whose mounting is decided by STORED STATE
 * rather than by the composer unconditionally setting a field: the surface
 * exists iff these three secrets do, because the endpoint is unauthenticated
 * and its only auth is comparing a header against the stored secret. An
 * instance holding no secret must serve nothing, and a default Open install
 * holds none — so without this seed the probe would report the slot absent
 * forever and the ratchet would be pinning the fixture instead of the product.
 *
 * Seeding is the same move this file already makes with `ANTHROPIC_API_KEY`
 * above, for the same stated reason: compose the WIDEST configuration an Open
 * instance produces, so that "absent here" means "absent everywhere".
 *
 * These are synthetic values, never a real bot. The token is shaped like a Bot
 * API token only so nothing downstream chokes on the format; nothing in this
 * test reaches the network.
 */
async function seedTelegramSecrets(db: ProjectDb): Promise<void> {
  const secrets = new SecretsStore({ data_dir: process.env['NEUTRON_HOME'] as string, db })
  const owner_handle = asOwnerHandle(process.env['NEUTRON_INSTANCE_SLUG'] as string)
  await secrets.put({ owner_handle, kind: 'bot_token', label: 'telegram', plaintext: '111111:synthetic-route-slot-coverage' })
  await secrets.put({ owner_handle, kind: 'webhook_secret', label: 'telegram', plaintext: 'synthetic-webhook-secret-route-slot-coverage' })
  await secrets.put({ owner_handle, kind: 'channel_metadata', label: 'telegram-bot-user-id', plaintext: '111111' })
}

/** rung → whether the composed production graph carries that slot's input. */
let served = new Map<string, boolean>()
/** Every slot the registry declares with a composition seam, in ladder order. */
const declared: RouteSlotBaselineEntry[] = ROUTE_SLOTS.filter(
  (s) => s.composition !== null,
).map((s) => ({ rung: s.rung, composition: s.composition as string }))

/**
 * Boot the REAL Open composition once and record which slots it carries.
 *
 * `graph.composition` is the same `CompositionInput` object the composer produced,
 * AFTER `composeProductionGraph`'s post-compose wiring has mutated it — which is
 * precisely why the check runs here and not on the composer's return value: the
 * Cores surfaces do not exist until that step.
 */
async function probeComposedSurfaces(): Promise<void> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH'] as string)
  applyMigrations(db.raw())
  await seedTelegramSecrets(db)
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => mockSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  try {
    const fields = graph.composition as unknown as Record<string, unknown>
    const seen = new Map<string, boolean>()
    for (const slot of declared) seen.set(slot.rung, fields[slot.composition] !== undefined)
    served = seen
  } finally {
    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
    await graph.shutdown()
    db.close()
  }
}

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-route-slot-coverage-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'route-slot-coverage-secret-0123456789'
  // A credentialed boot: the widest composition an Open instance produces, so a
  // surface that is absent HERE is absent everywhere.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-route-slot-coverage'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  await probeComposedSurfaces()
}, 120_000)

afterAll(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('route-slot coverage — every declared surface, against the composed product', () => {
  test('the probe is alive', () => {
    // Without this, a probe that composed nothing (a renamed field, a graph that
    // failed to build, an empty registry) would report every surface as absent —
    // or, worse, report an EMPTY declared set and pass every assertion below
    // vacuously. A dead gate that reads green is the failure mode this repo has
    // already paid for twice.
    expect(declared.length).toBeGreaterThanOrEqual(MIN_EXPECTED_MOUNTED_SLOTS)
    expect(served.size).toBe(declared.length)
    const mountedCount = [...served.values()].filter(Boolean).length
    expect(mountedCount).toBeGreaterThanOrEqual(MIN_EXPECTED_MOUNTED_SLOTS)
  })

  test('every slot the registry declares is classified in the inventory', () => {
    // A NEW slot must be classified deliberately — served (and thus ratcheted) or
    // written down as unserved WITH ITS REASON. Forgetting is not an option: an
    // unclassified slot fails here rather than shipping unnoticed.
    const classified = new Set<string>([
      ...MOUNTED_SLOTS.map((s) => s.rung),
      ...UNMOUNTED_SLOTS.map((s) => s.rung),
    ])
    const unclassified = declared.filter((s) => !classified.has(s.rung)).map((s) => s.rung)
    expect(unclassified).toEqual([])

    // And the inventory may not describe slots that no longer exist — a stale
    // entry is a baseline nobody is checking.
    const declaredRungs = new Set(declared.map((s) => s.rung))
    const phantom = [...classified].filter((r) => !declaredRungs.has(r)).sort()
    expect(phantom).toEqual([])
  })

  test('no surface the product serves today has stopped being served', () => {
    const lost = MOUNTED_SLOTS.filter((s) => served.get(s.rung) !== true)
    const report =
      lost.length === 0
        ? ''
        : [
            'Route slots that WERE served and no longer are — these paths now 404:',
            ...lost.map((s) => `  • ${s.rung} (${s.composition}) — ${s.serves}`),
            '',
            'A declared slot is only served when a real composer sets its',
            'CompositionInput field. Re-wire it in open/composer.ts, or delete the',
            'slot and its dead surface — do NOT move it into UNMOUNTED_SLOTS to get',
            'green (scripts/ci/route-slot-ratchet-guard.sh fails that).',
          ].join('\n')
    expect(report).toBe('')
  })

  test('an unserved slot that is now served has been promoted out of the allowlist', () => {
    // The allowlist only earns its keep while every line in it is still true. A
    // slot that someone wired but left listed as unserved is a line that has
    // stopped meaning anything, and the next reader inherits it as permission.
    const stale = UNMOUNTED_SLOTS.filter((s) => served.get(s.rung) === true)
    const report =
      stale.length === 0
        ? ''
        : [
            'These slots are listed as NOT served, but the composed product serves them:',
            ...stale.map((s) => `  • ${s.rung} (${s.composition})`),
            '',
            'Move them into MOUNTED_SLOTS so a future regression is caught.',
          ].join('\n')
    expect(report).toBe('')
  })
})
