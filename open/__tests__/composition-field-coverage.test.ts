/**
 * THE COMPOSITION-FIELD COVERAGE GATE — is every declared composition field
 * actually SET by the product?
 *
 * `CompositionInput` is the seam between "a module exists" and "a module runs".
 * A field on it is only live when a real composer assigns it; when no composer
 * does, the consumer takes its `if (input.x !== undefined)` branch the other
 * way and the capability is simply absent, with nothing anywhere reporting a
 * problem. That is how `push_dispatcher` came to be declared in
 * `gateway/composition/input/misc-input.ts`, consumed in
 * `gateway/composition/build-core-modules.ts`, covered by tests, and set by
 * nobody — so the app registered device push tokens and delivered to none of them.
 * (That field is gone as of 2026-08-09; the incident is what this gate is for.)
 *
 * WHY NEITHER EXISTING GATE CATCHES THAT.
 *   - `scripts/ci/composition-wiring-gate.sh` is lexical and covers `enable_*`
 *     BOOLEANS only. It works precisely because you cannot write a boolean
 *     literal in ES object shorthand, so `enable_x: true` always has a colon to
 *     match. `push_dispatcher` was an object, and `push_dispatcher,` in shorthand
 *     was invisible to it — as any object-valued field still is.
 *   - `open/__tests__/route-slot-coverage.test.ts` is runtime and correct, but
 *     it only asks about fields that back an HTTP route slot.
 *     `push_dispatcher` was not a route slot, so route-slot-coverage could not
 *     see it — and neither can any other object-valued field.
 *
 * This file covers the complement: the 29 optional `CompositionInput` fields
 * that are neither. The 8 REQUIRED fields need no gate — the compiler already
 * refuses to omit them.
 *
 * WHY THIS IS A RUNTIME CHECK AND NOT A GREP. The lexical version of this gate
 * was written first, for the route-slot problem, and it produced false positives
 * two ways a reader cannot be expected to notice: SHORTHAND (`open/composer.ts`
 * assigns `chat_history_surface,` with no colon, invisible to a `key: value`
 * regex) and INDIRECTION (`cores_surface` is never written in a composer at all
 * — `gateway/composition/wire-cores-surfaces.ts:49` fills it after the graph
 * composes). A gate with false positives is worse than no gate: this repo has
 * already had a standing red check train everyone to merge past it, which then
 * hid a second, completely dead check for days. So the WIRED question is asked
 * of the running product — build the real composition and read `Object.keys`.
 * Shorthand and post-compose mutation are both seen for free, because there is
 * nothing to parse.
 *
 * The DECLARED question cannot be asked that way, because an unset field is
 * `undefined` and therefore indistinguishable from a field that does not exist —
 * which is the entire defect. That half reads the TypeScript source through the
 * compiler's own parser; see `declared-composition-fields.ts` for why it parses
 * rather than greps, and `declared-composition-fields.test.ts` for the proof
 * that its answer equals the full type checker's.
 *
 * IT IS A RATCHET, NOT A BLANKET ASSERT. Some fields are legitimately unset —
 * override seams production must leave open, test seams with correct defaults,
 * fields the boot shell rather than the composer fills. Blanket-asserting all 29
 * would be permanently red. So the currently-set set is the baseline that may
 * not shrink, and every absence is written down WITH ITS REASON in
 * `composition-field-coverage-inventory.ts`. The cross-branch half — you may not
 * widen the allowlist by editing the baseline — is
 * `scripts/ci/composition-field-ratchet-guard.sh`, because a test that reads its
 * own baseline cannot catch someone moving the baseline.
 *
 * MUTATION TEST: delete a wired field's assignment from `open/composer.ts` and
 * that field's line appears in this file's failure output. Verified 2026-08-02
 * against `push_dispatcher` and `work_board`; confirmed in the same run that the
 * five legitimately-unset fields do NOT red.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { readDeclaredCompositionFields } from './declared-composition-fields.ts'
import {
  MIN_EXPECTED_WIRED_FIELDS,
  UNWIRED_FIELDS,
  WIRED_FIELDS,
} from './composition-field-coverage-inventory.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const LANDING_DIR = join(REPO_ROOT, 'landing')

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
 * Give the instance a configured Telegram bot before the composer runs, exactly
 * as `route-slot-coverage.test.ts` does and for the same reason: compose the
 * WIDEST configuration an Open instance produces, so that "unset HERE" means
 * "unset everywhere" rather than "unset in this fixture". Synthetic values; this
 * test never reaches the network.
 */
async function seedTelegramSecrets(db: ProjectDb): Promise<void> {
  const secrets = new SecretsStore({ data_dir: process.env['NEUTRON_HOME'] as string, db })
  const owner_handle = asOwnerHandle(process.env['NEUTRON_INSTANCE_SLUG'] as string)
  await secrets.put({ owner_handle, kind: 'bot_token', label: 'telegram', plaintext: '111111:synthetic-composition-field-coverage' })
  await secrets.put({ owner_handle, kind: 'webhook_secret', label: 'telegram', plaintext: 'synthetic-webhook-secret-composition-field-coverage' })
  await secrets.put({ owner_handle, kind: 'channel_metadata', label: 'telegram-bot-user-id', plaintext: '111111' })
}

/** Composition fields that back an HTTP route slot — owned by the route-slot ratchet. */
const ROUTE_SLOT_FIELDS = new Set(
  ROUTE_SLOTS.filter((s) => s.composition !== null).map((s) => s.composition as string),
)

/**
 * The fields THIS gate owns: declared, optional, and not already ratcheted as a
 * route slot. Required fields are excluded because the compiler enforces them.
 */
const IN_SCOPE = readDeclaredCompositionFields(REPO_ROOT).filter(
  (f) => f.optional && !ROUTE_SLOT_FIELDS.has(f.name),
)

/** field name → whether the composed production graph carries it. */
let wired = new Map<string, boolean>()

/**
 * Boot the REAL Open composition once and record which fields it carries.
 *
 * `graph.composition` is the same `CompositionInput` object the composer
 * produced, AFTER `composeProductionGraph`'s post-compose wiring has mutated it
 * — which is why the read happens here and not on the composer's return value.
 */
async function probeComposedFields(): Promise<void> {
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
    for (const f of IN_SCOPE) seen.set(f.name, fields[f.name] !== undefined)
    wired = seen
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-composition-field-coverage-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'composition-field-coverage-secret-0123456789'
  // A credentialed boot: the widest composition an Open instance produces, so a
  // field that is unset HERE is unset everywhere.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-composition-field-coverage'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  await probeComposedFields()
}, 120_000)

afterAll(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('composition-field coverage — every declared field, against the composed product', () => {
  test('the probe is alive', () => {
    // Without this, a probe that composed nothing (a renamed field, a graph that
    // failed to build, a declared set that read empty) would report every field
    // as unset — or, worse, report an EMPTY in-scope set and pass every
    // assertion below vacuously. A dead gate that reads green is the failure
    // mode this repo has already paid for twice.
    expect(ROUTE_SLOT_FIELDS.size).toBeGreaterThan(0)
    expect(IN_SCOPE.length).toBeGreaterThanOrEqual(MIN_EXPECTED_WIRED_FIELDS)
    expect(wired.size).toBe(IN_SCOPE.length)
    const wiredCount = [...wired.values()].filter(Boolean).length
    expect(wiredCount).toBeGreaterThanOrEqual(MIN_EXPECTED_WIRED_FIELDS)
  })

  test('every in-scope field is classified in the inventory', () => {
    // A NEW composition field must be classified deliberately — wired (and thus
    // ratcheted) or written down as unwired WITH ITS REASON. Forgetting is not
    // an option: an unclassified field fails here rather than shipping as a
    // capability nobody ever turned on.
    const classified = new Set<string>([
      ...WIRED_FIELDS.map((f) => f.field),
      ...UNWIRED_FIELDS.map((f) => f.field),
    ])
    const inScopeNames = new Set(IN_SCOPE.map((f) => f.name))
    const unclassified = IN_SCOPE.filter((f) => !classified.has(f.name)).map(
      (f) => `${f.name} (declared ${f.file}:${f.line})`,
    )
    const report =
      unclassified.length === 0
        ? ''
        : [
            'These CompositionInput fields are declared but classified nowhere:',
            ...unclassified.map((s) => `  • ${s}`),
            '',
            'Add each to WIRED_FIELDS (if a composer sets it) or to UNWIRED_FIELDS',
            'WITH ITS REASON, in composition-field-coverage-inventory.ts.',
          ].join('\n')
    expect(report).toBe('')

    // And the inventory may not describe fields that are no longer in scope — a
    // stale entry is a baseline nobody is checking. A field that GAINED a route
    // slot lands here too, correctly: it moved to the other inventory.
    const phantom = [...classified].filter((f) => !inScopeNames.has(f)).sort()
    expect(phantom).toEqual([])
  })

  test('no field the product wires today has stopped being wired', () => {
    const lost = WIRED_FIELDS.filter((f) => wired.get(f.field) !== true)
    const report =
      lost.length === 0
        ? ''
        : [
            'Composition fields that WERE set by the product and no longer are:',
            ...lost.map((f) => `  • ${f.field} — ${f.provides}`),
            '',
            'A declared field is only live when a real composer assigns it. Its',
            'consumer takes the `!== undefined` branch the other way and the',
            'capability is absent with nothing reporting a problem. Re-wire it in',
            'open/composer.ts, or delete the field and its dead consumer — do NOT',
            'move it into UNWIRED_FIELDS to get green',
            '(scripts/ci/composition-field-ratchet-guard.sh fails that).',
          ].join('\n')
    expect(report).toBe('')
  })

  test('an unwired field that is now wired has been promoted out of the allowlist', () => {
    // The allowlist only earns its keep while every line in it is still true. A
    // field someone wired but left listed as unwired is a line that has stopped
    // meaning anything, and the next reader inherits it as permission.
    const stale = UNWIRED_FIELDS.filter((f) => wired.get(f.field) === true)
    const report =
      stale.length === 0
        ? ''
        : [
            'These fields are listed as NOT wired, but the composed product sets them:',
            ...stale.map((f) => `  • ${f.field}`),
            '',
            'Move them into WIRED_FIELDS so a future regression is caught.',
          ].join('\n')
    expect(report).toBe('')
  })

  test('this inventory does not duplicate the route-slot baseline', () => {
    // Two baselines for one fact drift apart, and then one of them is wrong
    // without being red. The route-slot ratchet owns every field backing an HTTP
    // slot, with richer per-rung detail; this file owns strictly the complement.
    const overlap = [...WIRED_FIELDS, ...UNWIRED_FIELDS]
      .map((f) => f.field)
      .filter((f) => ROUTE_SLOT_FIELDS.has(f))
      .sort()
    expect(overlap).toEqual([])
  })
})
