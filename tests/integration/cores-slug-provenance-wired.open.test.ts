/**
 * THE PRODUCTION HANDOFFS OF THE DIRECTION GUARD, DRIVEN THROUGH THE REAL GRAPH.
 *
 * WHAT WAS UNTESTED. The guard itself was covered from several angles, and every
 * one of those tests CONSTRUCTED the thing under test:
 * `gateway/__tests__/cores-integrations-surface.test.ts:85` calls
 * `createCoresIntegrationsSurface` directly, `gateway/cores/__tests__/
 * integrations-tools.test.ts:94` calls `buildIntegrationsTools` directly, and
 * `open/__tests__/composition-slug-provenance.test.ts:64` stops at the
 * composition field. The only two places that decide what the SHIPPED surfaces
 * receive are `gateway/composition/wire-cores-surfaces.ts:190` (HTTP) and `:222`
 * (the agent tool) — and hard-coding EITHER of them to `false` left every one of
 * those tests green while reopening the destructive migration on that surface.
 *
 * A test that builds the object cannot see a wiring bug, because the wiring is
 * the part it replaced. So this suite constructs nothing: it boots the real
 * `buildOpenGraphComposer`, runs the real `composeProductionGraph` (which is
 * what calls `wireCoresSurfaces`), and then asks the SERVED HTTP route and the
 * REGISTERED tool what they do.
 *
 * BOTH DIRECTIONS ARE PINNED, and that is the point. The failure is silent
 * whichever way it breaks: wired to `false` on a fallback boot, an anonymous
 * process quietly re-keys the owner's credential rows onto a handle nobody
 * chose; wired to `true`, a correctly-configured machine quietly refuses every
 * migration and the owner is told to fix something that is not broken. Neither
 * announces itself, so each needs its own assertion.
 *
 * ONLY THE PROVENANCE FLAG VARIES between the two harnesses — same slug, same
 * bearer, same fixture. A fallback boot would normally also carry the `'dev'`
 * handle, but changing two things at once would let a test pass for the wrong
 * reason.
 *
 * MUTATION TESTS — RE-RUN AND RE-MEASURED, not carried prose. A previous review
 * round declined to take this paragraph on trust ("prose is not mutation
 * evidence"), correctly: a claimed mutation and a performed one read identically
 * on the page. Each of the four below was performed, measured, and reverted, and
 * the tree was confirmed clean afterwards (`git status --porcelain` empty).
 *
 * BASELINE, all four files together: 26 pass / 0 fail / 94 expect() calls.
 *
 * Every run carried the three constructing suites above as the CONTROL, and all
 * three stayed green in every one — 22 pass / 0 fail. That green IS the finding:
 * it is the measurement of the blind spot, not a passing grade.
 *
 *   - `wire-cores-surfaces.ts:190` → `false` — reds ONLY "SERVED route: a
 *     fallback boot refuses to move the rows" (target 3 pass / 1 fail).
 *   - `:190` → `true` — reds ONLY "SERVED route: a configured boot DOES move
 *     the rows" (target 3 pass / 1 fail).
 *   - `:222` → `false` — reds ONLY "REGISTERED tool: a fallback boot refuses to
 *     move the rows" (target 3 pass / 1 fail).
 *   - `:222` → `true` — reds ONLY "REGISTERED tool: a configured boot DOES move
 *     the rows" (target 3 pass / 1 fail).
 *
 * Target + control together are the 25 pass / 1 fail quoted in the PR body. To
 * reproduce: change one of those two lines to a bare constant and run this file
 * plus the three named above.
 */

import { afterEach, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { seedMigratedDb } from '../support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { ToolCallContext } from '@neutronai/tools/registry.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The instance's own handle — what a migration would move rows ONTO. */
const OWNER = 'owner'
/** A handle the rows are scoped to now — what a migration would move them OFF. */
const PREVIOUS = asOwnerHandle('previous-handle')
const MIGRATE_PATH = '/api/cores/integrations/migrate-orphaned'
const MIGRATE_TOOL = 'integrations_migrate_orphaned'

const CTX: ToolCallContext = {
  project_slug: OWNER,
  project_id: null,
  topic_id: null,
  call_id: 'slug-provenance-wired',
  speaker_user_id: null,
}

let home: IsolatedHome

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'slug-provenance-wired',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

interface Harness {
  base: string
  db: ProjectDb
  secrets: SecretsStore
  tools: ToolRegistry
  close(): Promise<void>
}

const openHarnesses: Harness[] = []
afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop()!
    await h.close()
  }
  home.restore()
})

/**
 * Boot the REAL composer + the REAL production graph. `slug_is_fallback` is the
 * single input under test; it travels composer → composition →
 * `wireCoresSurfaces` → both surfaces, and nothing here short-circuits any leg.
 */
async function boot(slug_is_fallback: boolean | 'absent'): Promise<Harness> {
  home = createIsolatedHome({
    slug: OWNER,
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-slug-provenance',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
    },
  })

  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)

  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  // `'absent'` composes with the DANGEROUS value and then REMOVES the field, so
  // what reaches `wireCoresSurfaces` is a composition that never said. That is
  // the only way to reach the `?? true` fail-closed defaults there
  // (`wire-cores-surfaces.ts`): `open/composer.ts` normalises the field and
  // always sets it, so no input to the real composer can leave it undefined —
  // and a review mutated `?? true` to `?? false` and watched every test in this
  // file stay green. Composing with `false` first is deliberate: it proves the
  // refusal below comes from the DELETION and not from a `true` surviving
  // somewhere upstream.
  const composition = await composer({
    db,
    project_slug: OWNER,
    slug_is_fallback: slug_is_fallback === 'absent' ? false : slug_is_fallback,
  })
  if (slug_is_fallback === 'absent') {
    delete (composition as { slug_is_fallback?: boolean }).slug_is_fallback
    // The premise of the case, asserted rather than assumed — if a future
    // composition re-added the field downstream, the test below would pass for
    // the wrong reason.
    expect((composition as { slug_is_fallback?: boolean }).slug_is_fallback).toBeUndefined()
  }
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('composer produced no fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  const h: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    db,
    // A SECOND store over the same home + DB. The AES keyfile lives at
    // `<owner_home>/.neutron-aes-key` and is shared, so this reads and writes
    // exactly the rows the composed instance sees.
    secrets: new SecretsStore({ data_dir: home.dir, db }),
    tools: graph.get<ToolRegistry>('tools'),
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
    },
  }
  openHarnesses.push(h)
  return h
}

/** Seed one credential row scoped to a handle that is NOT this instance's. */
async function seedOrphan(h: Harness): Promise<void> {
  await h.secrets.put({
    owner_handle: PREVIOUS,
    kind: 'byo_api_key',
    label: 'tavily',
    plaintext: 'tvly-stale',
  })
}

/** The loopback owner bearer — the same credential the local web client uses. */
function authed(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer dev:${OWNER}`)
  return fetch(`${base}${path}`, { ...init, headers })
}

interface MigrateBody {
  ok: boolean
  /**
   * The refusal AS DATA. Both refusal assertions in this file used to read
   * `message).toContain('Refused')`, which made one English sentence in
   * `gateway/cores/integrations.ts` the sole evidence that a security guard had
   * fired on the served route and on the registered tool.
   */
  refused_direction?: true
  total_moved: number
  message: string
}

/** Read the rows back rather than trusting the reported counts. */
async function whereIsTheRow(h: Harness): Promise<{ stale: string | null; owner: string | null }> {
  return {
    stale: await h.secrets.get({
      owner_handle: PREVIOUS,
      kind: 'byo_api_key',
      label: 'tavily',
    }),
    owner: await h.secrets.get({
      owner_handle: asOwnerHandle(OWNER),
      kind: 'byo_api_key',
      label: 'tavily',
    }),
  }
}

test('SERVED route: a fallback boot refuses to move the rows', async () => {
  const h = await boot(true)
  await seedOrphan(h)

  const res = await authed(h.base, MIGRATE_PATH, { method: 'POST' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as MigrateBody
  expect(body.total_moved).toBe(0)
  expect(body.refused_direction).toBe(true)
  expect(body.message).not.toContain('tvly-stale')

  const rows = await whereIsTheRow(h)
  expect(rows.stale).toBe('tvly-stale')
  expect(rows.owner).toBeNull()
}, 120_000)

test('SERVED route: a configured boot DOES move the rows', async () => {
  // The half that catches a handoff pinned to `true`. Without it, a wiring that
  // refuses everything on every machine passes the test above perfectly.
  const h = await boot(false)
  await seedOrphan(h)

  const res = await authed(h.base, MIGRATE_PATH, { method: 'POST' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as MigrateBody
  expect(body.total_moved).toBeGreaterThan(0)
  expect(body.refused_direction).toBeUndefined()

  const rows = await whereIsTheRow(h)
  expect(rows.stale).toBeNull()
  expect(rows.owner).toBe('tvly-stale')
}, 120_000)

test('REGISTERED tool: a fallback boot refuses to move the rows', async () => {
  const h = await boot(true)
  await seedOrphan(h)

  // Off the composed graph's own ToolRegistry — the instance an agent's tool
  // call is dispatched against. Nothing here builds the tool.
  const tool = h.tools.get(MIGRATE_TOOL)
  expect(tool).toBeDefined()
  const out = (await tool!.handler({}, CTX)) as MigrateBody
  expect(out.total_moved).toBe(0)
  expect(out.refused_direction).toBe(true)

  const rows = await whereIsTheRow(h)
  expect(rows.stale).toBe('tvly-stale')
  expect(rows.owner).toBeNull()
}, 120_000)

test('REGISTERED tool: a configured boot DOES move the rows', async () => {
  const h = await boot(false)
  await seedOrphan(h)

  const tool = h.tools.get(MIGRATE_TOOL)
  expect(tool).toBeDefined()
  const out = (await tool!.handler({}, CTX)) as MigrateBody
  expect(out.total_moved).toBeGreaterThan(0)
  expect(out.refused_direction).toBeUndefined()

  const rows = await whereIsTheRow(h)
  expect(rows.stale).toBeNull()
  expect(rows.owner).toBe('tvly-stale')
}, 120_000)

/**
 * A COMPOSITION THAT NEVER SAID MUST REFUSE — THE THIRD CASE, WHICH WAS DEAD.
 *
 * `wire-cores-surfaces.ts` reads `input.slug_is_fallback ?? true` at BOTH
 * handoffs, and the comment above each one says forgetting fails closed. Review
 * mutated `?? true` to `?? false` and every test in this file, plus the three
 * constructing suites, stayed green — because `open/composer.ts` normalises the
 * field and always sets it, so the absent case simply never occurred in any
 * test. A default nothing exercises is a comment, and CLAUDE.md rule 3a is
 * exactly this shape: a docblock describing a mode no caller can enter.
 *
 * The absent case is not hypothetical — `slug_is_fallback` is OPTIONAL on
 * `CompositionInput` (`gateway/boot-composition-types.ts`,
 * `gateway/composition/input/misc-input.ts`), so ANY other composer, or a
 * future edit that drops the normalisation, produces it. Both handoffs are
 * asserted, because each has its own `??` and one can be changed without the
 * other.
 */
test('a composition that OMITS slug_is_fallback fails CLOSED on both surfaces', async () => {
  const h = await boot('absent')
  await seedOrphan(h)

  const res = await authed(h.base, MIGRATE_PATH, { method: 'POST' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as MigrateBody
  expect(body.refused_direction).toBe(true)
  expect(body.total_moved).toBe(0)

  const tool = h.tools.get(MIGRATE_TOOL)
  expect(tool).toBeDefined()
  const out = (await tool!.handler({}, CTX)) as MigrateBody
  expect(out.refused_direction).toBe(true)
  expect(out.total_moved).toBe(0)

  // The rows themselves, not the reported counts.
  const rows = await whereIsTheRow(h)
  expect(rows.stale).toBe('tvly-stale')
  expect(rows.owner).toBeNull()
}, 120_000)
