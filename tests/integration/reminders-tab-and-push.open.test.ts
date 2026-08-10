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
 *   LINK 3 — PUSH HAD NO PRODUCER. Registering a device is half of push; delivery
 *   needs a sender, and no composer built one, so `createPushDispatcher` had no
 *   non-test call site and the deep link was unreachable. (The seam has since moved:
 *   the notification is composed at DELIVERY rather than on the reminder tick —
 *   2026-08-09, because a tick-composed notification can only see the reminder ROW,
 *   which for a ritual is the dispatch token `ritual:<id>`. See the LINK 3 block.)
 *
 * WHY THIS SHAPE OF TEST. Asserting the manifest has a `props_schema` key is
 * exactly what "declared but never served" looks like — the manifest had the
 * `app_tab` entry all along. So the tab half boots the WHOLE stack (real
 * composer, real production graph, real HTTP) and reads the payload a client
 * fetches over the wire, per the `tasks-tab-served.open.test.ts` precedent.
 *
 * Neither the push sender nor the fire-time dispatcher is a route slot, so
 * `route-slot-coverage.test.ts` cannot see either. The push half therefore asserts
 * against the REAL composer's output and then FIRES A REMINDER through it — over a
 * stubbed `globalThis.fetch`, so the suite never reaches `exp.host`, and so the
 * assertions can prove the safety properties that made it defensible to ship ON:
 *
 *   - zero registered devices (the state of every fresh install) makes NO
 *     network call whatsoever
 *   - the dispatcher reads the SAME rows `/api/app/devices/register` writes
 *   - a `DeviceNotRegistered` token is DELETED, not retried forever
 *
 * MUTATION TEST (each verified by deleting the wiring and re-running):
 *   - drop `props_schema` from `cores/free/reminders/package.json` → the two tab
 *     tests red ("Reminders tab survives the real resolver").
 *   - drop `chat_push` from `buildButtonStoreReminderOutbound(...)` in
 *     `open/composer.ts` → every push test below reds (no notification is sent).
 *   - compose the notification from `reminder.message` instead of the posted body →
 *     the ritual test reds on the `ritual:` token.
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
 * The reminder row the tick loop hands the dispatcher. Derived from the composition
 * field's own signature rather than imported: `@neutronai/reminders` is a workspace
 * but not a ROOT dependency, so a direct import does not resolve under the root
 * tsconfig that covers `tests/integration/`.
 */
type FiredReminder = Parameters<NonNullable<OpenComposition['reminder_dispatcher']>['dispatch']>[0]

let home: IsolatedHome

interface Harness {
  base: string
  /** The composition the REAL Open composer returned — the push assertions drive
   *  `reminder_dispatcher` off it, which is the seam the tick loop uses. */
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
 *  `reminder_dispatcher.dispatch`. */
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

describe('LINK 3 — push has a producer, and it is the DELIVERED MESSAGE', () => {
  /**
   * DRIVEN THROUGH `reminder_dispatcher`, not through a push hook, and that is the
   * change this rewrite records.
   *
   * The push used to hang off `push_dispatcher` → `ReminderTickLoop.on_fired`, which
   * composed the notification from the reminder ROW. For a ritual the row's
   * `message` is the dispatch token `ritual:<id>`, so the owner's phone said
   * `ritual:kaizen` (2026-08-09). The tick cannot see the message a fire posts, so
   * the notification is now composed where the message is DELIVERED
   * (`gateway/proactive/reminder-outbound.ts`), and the only honest way to assert it
   * end to end is to fire a reminder through the real dispatcher and read what
   * reaches Expo. That is strictly MORE coverage than before: the old test could
   * assert the payload without the message ever being posted at all.
   */
  test('the REAL composer wires a fire-time dispatcher', async () => {
    const h = await boot()
    expect(h.composition.reminder_dispatcher).toBeDefined()
    expect(typeof h.composition.reminder_dispatcher!.dispatch).toBe('function')
  })

  test('SAFETY — zero registered devices makes no network call and does not throw', async () => {
    const h = await boot()
    // The state every fresh install boots in. Every send reads the token table
    // first and returns before any fetch when the list is empty, which is what
    // makes it defensible to ship this ON with no flag.
    await withExpoStub([], async (sent) => {
      await h.composition.reminder_dispatcher!.dispatch(reminderRow())
      expect(sent).toHaveLength(0)
    })
  })

  test('a device registered over HTTP receives the POSTED message, as a chat notification', async () => {
    const h = await boot()
    const token = 'ExponentPushToken[live-device]'
    await registerDevice(h.base, token)

    await withExpoStub([{ status: 'ok' }], async (sent) => {
      await h.composition.reminder_dispatcher!.dispatch(reminderRow({ message: 'drink water' }))
      // ONE batch, to the token the register route persisted — proof the sender
      // reads the same rows that surface writes, not a second store.
      expect(sent).toHaveLength(1)
      const batch = sent[0]!.body as Array<{
        to: string
        title: string
        body: string
        data: { kind: string; message_id?: string; project_id?: string }
      }>
      expect(batch).toHaveLength(1)
      expect(batch[0]!.to).toBe(token)
      // THE REPORTED DEFECT. The body is the text that reached chat.
      expect(batch[0]!.body).toBe('drink water')
      expect(batch[0]!.title).toBe('General')
      // And the tap payload is a CHAT-message payload carrying the durable row id
      // the transcript anchors on — not a reminder id, and not the owner slug.
      expect(batch[0]!.data.kind).toBe('agent_message')
      expect(typeof batch[0]!.data.message_id).toBe('string')
      expect(batch[0]!.data.message_id!.length).toBeGreaterThan(0)
      // General names itself. An app bundle already on a device reads a payload
      // with no project as malformed and refuses to route at all.
      expect(batch[0]!.data.project_id).toBe('~general')
    })
  })

  test('an UNAPPROVED ritual row notifies NOTHING — fail-closed, all the way to Expo', async () => {
    // A ritual row carries its dispatch token in `message`, and on a box with no
    // approval grant the planner refuses to compose it. So the honest assertion
    // here is that NOTHING was sent — stated as an empty collection.
    //
    // It used to be written as `for (const msg of sent) expect(msg.body).not.toContain('ritual:')`,
    // which passed over zero notifications and therefore proved nothing at all
    // about the reported bug. The positive case — an APPROVED ritual whose
    // notification carries the COMPOSED report and never the token — needs a
    // granted approval and a composing turn, so it lives where those can be wired:
    // `gateway/push/__tests__/ritual-post-notifies-as-a-chat-message.test.ts`,
    // which drives the real planner, dispatcher, outbound, deliver and sink.
    const h = await boot()
    await registerDevice(h.base, 'ExponentPushToken[ritual-device]')

    await withExpoStub([{ status: 'ok' }], async (sent) => {
      await h.composition.reminder_dispatcher!.dispatch(
        reminderRow({ id: 'rem-ritual', message: 'ritual:kaizen', ritual_id: 'kaizen' }),
      )
      expect(sent).toEqual([])
    })
  })

  test('a NON-REMINDER post notifies too — the notification is not a reminder feature', async () => {
    // THE GAP THE FIRST ROUND OF THIS FIX LEFT. The morning brief, the idle nudge,
    // the overnight report and the system notices do not go through the reminder
    // outbound at all — they post through other sinks over the SAME `deliver` — so
    // a notification wired to the reminder path left every one of them silent.
    //
    // Driven through `POST /api/app/system-notice`, a REAL out-of-turn producer
    // that is not a reminder and whose durability is `'inert'` rather than
    // `'reply'`. It reaches the same `deliver` the proactive sink is built over
    // (`open/composer.ts` — `buildButtonStoreProactiveSink({ deliver })`), so it
    // proves the notification is a property of the SEAM and not of one producer.
    const h = await boot()
    const token = 'ExponentPushToken[notice-device]'
    await registerDevice(h.base, token)

    await withExpoStub([{ status: 'ok' }], async (sent) => {
      const res = await fetch(`${h.base}/api/app/system-notice`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${OWNER_BEARER}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: 'Morning brief: three things today.' }),
      })
      expect(res.status).toBe(200)

      expect(sent).toHaveLength(1)
      const batch = sent[0]!.body as Array<{
        to: string
        title: string
        body: string
        data: { kind: string; message_id?: string; project_id?: string }
      }>
      expect(batch).toHaveLength(1)
      expect(batch[0]!.to).toBe(token)
      expect(batch[0]!.body).toBe('Morning brief: three things today.')
      expect(batch[0]!.title).toBe('General')
      expect(batch[0]!.data.kind).toBe('agent_message')
      expect(batch[0]!.data.project_id).toBe('~general')
      expect(typeof batch[0]!.data.message_id).toBe('string')
    })
  })

  test('SAFETY — a DeviceNotRegistered token is pruned, not retried forever', async () => {
    const h = await boot()
    await registerDevice(h.base, 'ExponentPushToken[dead-device]')

    await withExpoStub(
      [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      async (sent) => {
        await h.composition.reminder_dispatcher!.dispatch(reminderRow())
        expect(sent).toHaveLength(1)
      },
    )

    // Second fire: the row is gone, so there is nothing to send and no HTTP call
    // at all. Without pruning this token would be re-sent on every reminder for
    // the life of the install.
    await withExpoStub([{ status: 'ok' }], async (sent) => {
      await h.composition.reminder_dispatcher!.dispatch(reminderRow({ id: 'rem-2' }))
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
        await h.composition.reminder_dispatcher!.dispatch(reminderRow())
        expect(sent).toHaveLength(1)
      },
    )

    // Still registered — a rate limit must never silently end push for the
    // owner's phone until their next sign-in.
    await withExpoStub([{ status: 'ok' }], async (sent) => {
      await h.composition.reminder_dispatcher!.dispatch(reminderRow({ id: 'rem-2' }))
      expect(sent).toHaveLength(1)
      const batch = sent[0]!.body as Array<{ to: string }>
      expect(batch[0]!.to).toBe(token)
    })
  })
})
