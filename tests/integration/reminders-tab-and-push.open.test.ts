/**
 * REMINDERS — the two links that were still broken after the backend mounted.
 *
 * `app_reminders_surface` landing made the routes answer. It did not make the
 * feature usable, because the chain is three links long and only the middle one
 * worked:
 *
 *   LINK 2 — THE TAB WAS DROPPED. `cores/free/reminders/package.json` declared
 *   an `app_tab` ui_component with NO `props_schema`, and the resolver takes the
 *   route from `props_schema.properties.path.const` and skips the contribution
 *   when it is absent (`gateway/http/app-tabs-surface.ts:243-247`). So the
 *   Reminders tab existed only in the mobile PRE-FETCH placeholder
 *   (`app/lib/project-tabs.ts:44-51`) and vanished the moment `/tabs` answered.
 *
 *   LINK 3 — PUSH HAD NO PRODUCER. Registering a device is half of push;
 *   delivery needs the `push_dispatcher` composition field, which
 *   `gateway/composition/build-core-modules.ts:396-398` attaches to the reminder
 *   tick's `on_fired`. No composer set it, so `createPushDispatcher`
 *   (`gateway/push/dispatcher.ts:133`) had no non-test call site and the reminder
 *   deep link (`app/lib/push-deep-link-dispatch.ts:93-108`) was unreachable.
 *
 * WHY THIS SHAPE OF TEST. Asserting the manifest has a `props_schema` key is
 * exactly what "declared but never served" looks like — the manifest had the
 * `app_tab` entry all along. So the tab half boots the WHOLE stack (real
 * composer, real production graph, real HTTP) and reads the payload a client
 * fetches over the wire, per the `tasks-tab-served.open.test.ts` precedent.
 *
 * `push_dispatcher` is NOT a route slot, so `route-slot-coverage.test.ts` cannot
 * see it. The push half therefore asserts against the REAL composer's output and
 * then drives the dispatcher it produced — over a stubbed `globalThis.fetch`, so
 * the suite never reaches `exp.host`, and so the assertions can prove the safety
 * properties that made it defensible to ship this ON:
 *
 *   - zero registered devices (the state of every fresh install) makes NO
 *     network call whatsoever
 *   - the dispatcher reads the SAME rows `/api/app/devices/register` writes
 *   - a `DeviceNotRegistered` token is DELETED, not retried forever
 *
 * MUTATION TEST (each verified by deleting the wiring and re-running):
 *   - drop `props_schema` from `cores/free/reminders/package.json` → the two tab
 *     tests red ("Reminders tab survives the real resolver").
 *   - drop `push_dispatcher` from the `open/composer.ts` composition object →
 *     all four push tests red, plus
 *     `open/__tests__/open-composition-fields-characterization.test.ts`.
 *   - drop the `pruneUnregistered` call in `gateway/push/dispatcher.ts` → the
 *     stale-token test reds.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

/** The descriptor wire shape, declared locally — this suite asserts on the JSON
 *  a client receives, so it deliberately does not import the engine's type. */
interface TabDescriptor {
  key: string
  label: string
  scope: string
  source: string
  core_slug?: string
  order: number
  mount: { kind: string; target: string }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const PROJECT_ID = 'proj-1'
const OWNER_BEARER = 'owner'

/** What the REAL Open composer returns. */
type OpenComposition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
/**
 * The reminder row the tick loop hands `on_fired`. Derived from the composition
 * field's own signature rather than imported: `@neutronai/reminders` is a
 * workspace but not a ROOT dependency, so a direct import does not resolve under
 * the root tsconfig that covers `tests/integration/`.
 */
type FiredReminder = Parameters<NonNullable<OpenComposition['push_dispatcher']>['onFired']>[0]

let home: IsolatedHome

interface Harness {
  base: string
  /** The composition the REAL Open composer returned — the push assertions
   *  read `push_dispatcher` straight off it. */
  composition: OpenComposition
  close(): Promise<void>
}

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'reminders-tab-and-push',
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

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
      'EXPO_ACCESS_TOKEN',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-reminders-tab-push',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
      EXPO_ACCESS_TOKEN: undefined,
    },
  })
})

const openHarnesses: Harness[] = []
afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop()!
    await h.close()
  }
  home.restore()
})

async function boot(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('no fetch/ws')
  }
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => graph.fetch!(req, srv),
    websocket: graph.websocket,
  })
  const h: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    composition,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      try {
        db.close()
      } catch {
        /* already closed */
      }
    },
  }
  openHarnesses.push(h)
  return h
}

interface TabsBody {
  ok: boolean
  scope: string
  project_id?: string
  tabs: TabDescriptor[]
}

async function tabs(base: string): Promise<TabsBody> {
  const res = await fetch(`${base}/api/app/projects/${PROJECT_ID}/tabs`, {
    headers: { authorization: `Bearer ${OWNER_BEARER}` },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as TabsBody
}

describe('LINK 2 — the Reminders tab survives the real resolver', () => {
  test('the engine-resolved tab set contains a navigable Reminders tab', async () => {
    const h = await boot()
    const body = await tabs(h.base)
    expect(body.ok).toBe(true)

    const tab = body.tabs.find((t) => t.core_slug === 'reminders_core')
    expect(tab).toBeDefined()
    expect(tab!.source).toBe('core')
    expect(tab!.label).toBe('Reminders')
    // A CLIENT ROUTE with `<project_id>` substituted — never the manifest's
    // `entry_point`, which is a TypeScript source file inside the Core package.
    expect(tab!.mount).toEqual({
      kind: 'app_route',
      target: `/projects/${PROJECT_ID}/reminders`,
    })
  })

  test('the tab target is the route the app actually registers, and its backend answers', async () => {
    const h = await boot()
    const body = await tabs(h.base)
    const tab = body.tabs.find((t) => t.core_slug === 'reminders_core')
    expect(tab).toBeDefined()

    // The screen is `app/app/projects/[id]/reminders.tsx` and the push deep link
    // builds `/projects/<id>/reminders` (`app/lib/push-deep-link-dispatch.ts:105-108`).
    // A tab pointing anywhere else renders an error screen, which is worse than
    // the missing tab this change fixes.
    expect(tab!.mount.target).toBe(`/projects/${PROJECT_ID}/reminders`)

    // And the data behind it answers — a seated tab over a 404 is not a feature.
    const res = await fetch(`${h.base}/api/app/projects/${PROJECT_ID}/reminders`, {
      headers: { authorization: `Bearer ${OWNER_BEARER}` },
    })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { ok: boolean; reminders: unknown[] }
    expect(payload.ok).toBe(true)
    expect(Array.isArray(payload.reminders)).toBe(true)
  })

  test('Reminders sorts after Tasks, per the order const both manifests declare', async () => {
    const h = await boot()
    const body = await tabs(h.base)
    const keys = body.tabs.map((t) => t.key)
    const tasksAt = keys.indexOf('core:tasks_core')
    const remindersAt = keys.indexOf('core:reminders_core')
    expect(tasksAt).toBeGreaterThanOrEqual(0)
    expect(remindersAt).toBeGreaterThan(tasksAt)
  })
})

/** A plain (non-ritual) pending nudge row — the exact shape the tick loop hands
 *  `on_fired` after a successful dispatch. */
function reminderRow(overrides: Partial<FiredReminder> = {}): FiredReminder {
  return {
    id: 'rem-1',
    owner_slug: 'owner',
    topic_id: `app-project:${PROJECT_ID}`,
    fire_at: 1_700_000_000,
    message: 'stretch',
    status: 'fired',
    recurrence: null,
    recurrence_spec: null,
    ritual_id: null,
    source: null,
    created_at: 1_699_999_000,
    fired_at: 1_700_000_000,
    cancelled_at: null,
    ...overrides,
  }
}

interface CapturedSend {
  url: string
  body: unknown
}

/**
 * Run `fn` with `globalThis.fetch` intercepted for `exp.host` ONLY — every other
 * request (the harness's own HTTP calls) passes through to the real fetch. The
 * suite must never actually contact Expo.
 */
async function withExpoStub<T>(
  tickets: Array<{ status: 'ok' | 'error'; details?: { error?: string } }>,
  fn: (sent: CapturedSend[]) => Promise<T>,
): Promise<T> {
  const sent: CapturedSend[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input)
    if (!url.includes('exp.host')) {
      return await (real as (i: unknown, n?: unknown) => Promise<Response>)(input, init)
    }
    sent.push({ url, body: init?.body === undefined ? null : JSON.parse(init.body) })
    return new Response(JSON.stringify({ data: tickets }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  try {
    return await fn(sent)
  } finally {
    globalThis.fetch = real
  }
}

async function registerDevice(base: string, device_token: string): Promise<void> {
  const res = await fetch(`${base}/api/app/devices/register`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OWNER_BEARER}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ device_token, platform: 'ios' }),
  })
  expect(res.status).toBe(200)
}

describe('LINK 3 — push has a producer', () => {
  test('the REAL composer populates push_dispatcher', async () => {
    const h = await boot()
    // The field build-core-modules.ts:396-398 reads to install the tick's
    // `on_fired`. Absent → a fired reminder never leaves the chat topic.
    expect(h.composition.push_dispatcher).toBeDefined()
    expect(typeof h.composition.push_dispatcher!.onFired).toBe('function')
  })

  test('SAFETY — zero registered devices makes no network call and does not throw', async () => {
    const h = await boot()
    // The state every fresh install boots in. `dispatch` returns before any
    // fetch when the message list is empty (`gateway/push/dispatcher.ts:145-147`),
    // which is what makes it defensible to ship this ON with no flag.
    await withExpoStub([], async (sent) => {
      await h.composition.push_dispatcher!.onFired(reminderRow())
      expect(sent).toHaveLength(0)
    })
  })

  test('a device registered over HTTP is the device the fired reminder reaches', async () => {
    const h = await boot()
    const token = 'ExponentPushToken[live-device]'
    await registerDevice(h.base, token)

    await withExpoStub([{ status: 'ok' }], async (sent) => {
      await h.composition.push_dispatcher!.onFired(reminderRow({ message: 'drink water' }))
      // ONE batch, to the token the register route persisted — proof the
      // dispatcher reads the same rows that surface writes, not a second store.
      expect(sent).toHaveLength(1)
      const batch = sent[0]!.body as Array<{
        to: string
        body: string
        data: { kind: string; reminder_id: string; topic_id?: string }
      }>
      expect(batch).toHaveLength(1)
      expect(batch[0]!.to).toBe(token)
      expect(batch[0]!.body).toBe('drink water')
      // The payload the tap handler resolves to `/projects/<id>/reminders`
      // (`app/lib/push-deep-link-dispatch.ts:93-108` recovers the project from
      // `topic_id`'s `app-project:` prefix).
      expect(batch[0]!.data.kind).toBe('reminder')
      expect(batch[0]!.data.reminder_id).toBe('rem-1')
      expect(batch[0]!.data.topic_id).toBe(`app-project:${PROJECT_ID}`)
    })
  })

  test('SAFETY — a DeviceNotRegistered token is pruned, not retried forever', async () => {
    const h = await boot()
    await registerDevice(h.base, 'ExponentPushToken[dead-device]')

    await withExpoStub(
      [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      async (sent) => {
        await h.composition.push_dispatcher!.onFired(reminderRow())
        expect(sent).toHaveLength(1)
      },
    )

    // Second fire: the row is gone, so there is nothing to send and no HTTP call
    // at all. Without pruning this token would be re-sent on every reminder for
    // the life of the install.
    await withExpoStub([{ status: 'ok' }], async (sent) => {
      await h.composition.push_dispatcher!.onFired(reminderRow({ id: 'rem-2' }))
      expect(sent).toHaveLength(0)
    })
  })

  test('SAFETY — a transient ticket error does NOT prune the owner’s live device', async () => {
    const h = await boot()
    const token = 'ExponentPushToken[rate-limited]'
    await registerDevice(h.base, token)

    await withExpoStub(
      [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
      async (sent) => {
        await h.composition.push_dispatcher!.onFired(reminderRow())
        expect(sent).toHaveLength(1)
      },
    )

    // Still registered — a rate limit must never silently end push for the
    // owner's phone until their next sign-in.
    await withExpoStub([{ status: 'ok' }], async (sent) => {
      await h.composition.push_dispatcher!.onFired(reminderRow({ id: 'rem-2' }))
      expect(sent).toHaveLength(1)
      const batch = sent[0]!.body as Array<{ to: string }>
      expect(batch[0]!.to).toBe(token)
    })
  })
})
