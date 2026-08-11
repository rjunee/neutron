/**
 * A BOARD ACK NAMES THE BOARD — asserted through a REAL Open boot.
 *
 * WHY THIS FILE EXISTS (and why the unit tests were not enough)
 * ------------------------------------------------------------
 * The fix has two halves that only meet inside `open/composer.ts`:
 *
 *   1. the DB → NAME seam. The owner-visible board name is `projects.name`, read
 *      by the composer's `readProjectName` single-row query and handed to the ack
 *      as its `project_name` lookup.
 *   2. the SCOPE → TOPIC seam. The same normalized scope that picks the name also
 *      picks the chat topic the ack is delivered to (`tridentDeliveryChatId`).
 *
 * Every unit test of half 1 supplies its own hand-built `{ id: name }` map, so
 * the mutation `project_name: (id) => id` — the composer handing the ack a lookup
 * that echoes the INTERNAL ID as the owner's board name, the exact thing
 * requirement (c) forbids — passed all of them. A test that builds its own lookup
 * is testing the resolver, not the wiring; the wiring is what shipped wrong.
 *
 * So this suite touches NO ack internals. It boots the whole stack (real
 * composer, real production graph, real SQLite), inserts a real `projects` row,
 * fires the PRODUCTION-wired ack the composition exposes, and then reads what a
 * reloading client would read: the persisted `app_chat_messages` row. That row
 * carries both halves at once — `body` is the text the owner sees, `topic_id` is
 * the surface it was delivered to. The only fake is the substrate (the model).
 *
 * THE ROUTING HALF IS A REGRESSION TEST, NOT A HYPOTHETICAL. General reaches the
 * ack as the literal `'general'` sentinel on the live path (a warm REPL's
 * `/tool-call` scope, ultimately `turn.project_id ?? 'general'`). The label
 * normalized that (`General`, correct) while the routing did not, so the ack was
 * filed under `app:<owner>:general` — a per-project topic the General surface
 * never subscribes to. Correct label, undeliverable message: the silent chat the
 * ack exists to prevent. `sentinel` and `null` must be indistinguishable HERE,
 * where the topic id is observable, which no unit test of the label can see.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { GENERAL_WORK_BOARD_PROJECT_ID } from '@neutronai/work-board/store.ts'
import { slugifyProjectId } from '@neutronai/onboarding/wow-moment/project-identity.ts'
import type { WorkBoardChatAck } from '@neutronai/work-board/chat-ack.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The instance/owner slug the composer is booted under. */
const OWNER_SLUG = 'owner'
/** A real rail project: the ID is a slug, the NAME is what the owner reads. */
const PROJECT_ID = 'example-project'
const PROJECT_NAME = 'Example Project'
/** A project id with no `projects` row — the deleted-mid-turn case. */
const GHOST_PROJECT_ID = 'ghost-project'

let home: IsolatedHome

interface Harness {
  base: string
  ack: WorkBoardChatAck
  /**
   * The composition's REAL `#339` delivery resolver — the closure
   * `trident/work-board-build-tool.ts` calls as
   * `deps.resolve_delivery?.(ctx.project_id)` to stamp a board-bound build's
   * `chat_id`. Same un-normalized `ctx.project_id` the ack receives, so it took
   * the sentinel too.
   */
  resolveDelivery: (project_id: string | null) => { chat_id: string | null }
  /** Bodies of persisted agent messages on a topic, oldest first. */
  bodiesOn(topic_id: string): string[]
  /** Every persisted agent message, whatever the topic. */
  allRows(): Array<{ topic_id: string; body: string }>
  close(): Promise<void>
}

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'work-board-ack-names-board',
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
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-work-board-ack-names-board',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
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
  // A REAL rail row. The whole point is that the ack must read this `name` and
  // must not fall back to the `id` beside it.
  const iso = Date.now()
  db.raw().run(
    `INSERT INTO projects (id, name, description, persona, emoji, privacy_mode,
                           billing_mode, created_at, updated_at, last_activity_at)
     VALUES (?, ?, '', NULL, NULL, 'private', 'personal', ?, ?, ?)`,
    [PROJECT_ID, PROJECT_NAME, iso, iso, iso],
  )

  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  const composition = await composer({ db, project_slug: OWNER_SLUG })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('no fetch/ws')
  }
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => graph.fetch!(req, srv),
    websocket: graph.websocket,
  })

  // The PRODUCTION ack — built by the composer with the real `readProjectName`
  // query, the real `tridentDeliveryChatId` router, and the real durable app-ws
  // poster. Nothing here is substituted.
  const ack = composition.work_board?.chat_ack
  if (ack === undefined) {
    throw new Error('composition exposes no work_board.chat_ack — the ack is unwired')
  }
  const resolveDelivery = composition.trident_build_dispatch?.resolve_delivery
  if (resolveDelivery === undefined) {
    throw new Error('composition exposes no trident_build_dispatch.resolve_delivery')
  }

  const allRows = (): Array<{ topic_id: string; body: string }> =>
    db
      .raw()
      .prepare<{ topic_id: string; body: string }, []>(
        `SELECT topic_id, body FROM app_chat_messages WHERE role = 'agent' ORDER BY topic_id, seq`,
      )
      .all()

  const h: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    ack,
    resolveDelivery,
    allRows,
    bodiesOn: (topic_id: string): string[] =>
      allRows()
        .filter((r) => r.topic_id === topic_id)
        .map((r) => r.body),
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

/**
 * The ack is deliberately fire-and-forget (it must never make a tool result wait
 * on a chat write), so its persistence lands a tick or two later. Poll until the
 * expected number of rows exists rather than sleeping a flat interval.
 */
async function waitForRows(h: Harness, count: number): Promise<Array<{ topic_id: string; body: string }>> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const rows = h.allRows()
    if (rows.length >= count) return rows
    if (Date.now() > deadline) {
      throw new Error(`only ${rows.length} of ${count} ack rows persisted within 5s`)
    }
    await Bun.sleep(20)
  }
}

/** The app-ws topic a General client subscribes to (no project suffix). */
const generalTopic = `app:${OWNER_SLUG}`
/** The app-ws topic a project client subscribes to. */
const projectTopic = `app:${OWNER_SLUG}:${PROJECT_ID}`

describe('a board ack names its board — through the real composer wiring', () => {
  test('a project-scoped ack speaks the rail NAME, never the internal id', async () => {
    const h = await boot()
    h.ack.post({
      project_id: PROJECT_ID,
      item_id: 'item-1',
      title: 'Ship the thing',
      kind: 'card_added',
    })
    await waitForRows(h, 1)

    const bodies = h.bodiesOn(projectTopic)
    expect(bodies.length).toBe(1)
    const body = bodies[0]!
    // THE assertion that kills `project_name: (id) => id`. The owner reads
    // "Example Project" in the rail; the id is internal vocabulary.
    expect(body).toContain(PROJECT_NAME)
    expect(body).toContain('Ship the thing')
    expect(body).not.toContain(PROJECT_ID)
    // And requirement (b): the storage key (the instance slug) is not a board name.
    expect(body).not.toContain(OWNER_SLUG)
  })

  test('a General ack says General and lands on the topic General subscribes to', async () => {
    const h = await boot()
    h.ack.post({ project_id: null, item_id: 'item-2', title: 'Tidy inbox', kind: 'card_added' })
    await waitForRows(h, 1)

    const bodies = h.bodiesOn(generalTopic)
    expect(bodies.length).toBe(1)
    expect(bodies[0]!).toContain('General')
    // (b) + (c): never the storage key, which for General IS the instance slug.
    expect(bodies[0]!).not.toContain(OWNER_SLUG)
  })

  /**
   * THE ROUTING REGRESSION. This is the shape the live path actually produces,
   * and the one that was broken: label right, destination wrong.
   */
  test("the 'general' sentinel routes to General's topic, not a suffixed one", async () => {
    const h = await boot()
    h.ack.post({
      project_id: GENERAL_WORK_BOARD_PROJECT_ID,
      item_id: 'item-3',
      title: 'Sentinel scoped work',
      kind: 'card_added',
    })
    const rows = await waitForRows(h, 1)

    expect(rows.length).toBe(1)
    // Delivered where a General client is listening…
    expect(rows[0]!.topic_id).toBe(generalTopic)
    // …and NOT to the per-project topic the un-normalized id produced.
    expect(rows[0]!.topic_id).not.toBe(`app:${OWNER_SLUG}:${GENERAL_WORK_BOARD_PROJECT_ID}`)
    expect(rows[0]!.body).toContain('General')
  })

  test('the sentinel and null are the SAME board, named and routed alike', async () => {
    const h = await boot()
    h.ack.post({ project_id: null, item_id: 'a', title: 'Via null', kind: 'card_added' })
    h.ack.post({
      project_id: GENERAL_WORK_BOARD_PROJECT_ID,
      item_id: 'b',
      title: 'Via sentinel',
      kind: 'card_added',
    })
    const rows = await waitForRows(h, 2)

    // One board ⇒ one topic. A divergence here is two boards wearing one name.
    expect(new Set(rows.map((r) => r.topic_id))).toEqual(new Set([generalTopic]))
    const labels = rows.map((r) => r.body.includes('General'))
    expect(labels).toEqual([true, true])
  })

  test('an unresolvable project degrades to a WORD, never the raw id', async () => {
    const h = await boot()
    h.ack.post({
      project_id: GHOST_PROJECT_ID,
      item_id: 'item-4',
      title: 'Orphaned work',
      kind: 'card_added',
    })
    const rows = await waitForRows(h, 1)

    expect(rows[0]!.body).toContain('unknown project')
    // (c) — an id that no longer resolves is still an id, and still must not leak.
    expect(rows[0]!.body).not.toContain(GHOST_PROJECT_ID)
    // It still routes to that project's own topic; the NAME degraded, not the scope.
    expect(rows[0]!.topic_id).toBe(`app:${OWNER_SLUG}:${GHOST_PROJECT_ID}`)
  })

  test('every ack kind names the board, not just the add', async () => {
    const h = await boot()
    h.ack.post({
      project_id: PROJECT_ID,
      item_id: 'item-5',
      title: 'Dispatched work',
      kind: 'build_dispatched',
    })
    h.ack.post({
      project_id: PROJECT_ID,
      item_id: 'item-6',
      title: 'Inline work',
      kind: 'inline_started',
    })
    await waitForRows(h, 2)

    const bodies = h.bodiesOn(projectTopic)
    expect(bodies.length).toBe(2)
    for (const body of bodies) {
      expect(body).toContain(PROJECT_NAME)
      expect(body).not.toContain(PROJECT_ID)
    }
  })

  /**
   * The SAME sentinel defect, one seam over, and the one that is not merely
   * cosmetic: `#339` stamps a board-bound build's `chat_id` from this resolver so
   * the completion announces back to the originating surface. Called with the raw
   * `ctx.project_id` (`trident/work-board-build-tool.ts:195,305`), it took the
   * `'general'` sentinel and produced `app:<owner>:general` — so a build started
   * from General announced its result into a topic no client subscribes to. That
   * is a SILENT COMPLETION, which is the exact bug #339 exists to prevent, and it
   * was reachable through the fix for the ack rather than in spite of it.
   */
  test('a General-scoped build announces back to General, not a phantom topic', async () => {
    const h = await boot()

    // All three spellings of "no project" are one destination.
    expect(h.resolveDelivery(null).chat_id).toBe(generalTopic)
    expect(h.resolveDelivery(GENERAL_WORK_BOARD_PROJECT_ID).chat_id).toBe(generalTopic)
    expect(h.resolveDelivery('').chat_id).toBe(generalTopic)
    expect(h.resolveDelivery(GENERAL_WORK_BOARD_PROJECT_ID).chat_id).not.toBe(
      `${generalTopic}:${GENERAL_WORK_BOARD_PROJECT_ID}`,
    )
    // A real project still gets its own topic — the normalization is about the
    // sentinel, and must not collapse everything onto General.
    expect(h.resolveDelivery(PROJECT_ID).chat_id).toBe(projectTopic)
  })

  /**
   * Drift guard for the ONE word that is declared in two places on purpose: the
   * work-board sentinel and the slugifier's reserved id. `slugifyProjectId` cannot
   * import the constant without giving `@neutronai/onboarding` a dependency on
   * `@neutronai/work-board` for a single string, so the repo's existing
   * convention applies (see `defaultProjectIdSlugifier` / `humaniseProjectId`):
   * duplicate the literal, and pin the equality in a test.
   */
  test('a project named General cannot claim the General sentinel as its id', () => {
    expect(GENERAL_WORK_BOARD_PROJECT_ID).toBe('general')
    // The collision that made this necessary: without the reservation, this
    // returned exactly the sentinel, and that project's board writes collapsed
    // onto General while its acks read "General" — a truthful-looking name for
    // the wrong board.
    expect(slugifyProjectId('General')).not.toBe(GENERAL_WORK_BOARD_PROJECT_ID)
    expect(slugifyProjectId('general')).not.toBe(GENERAL_WORK_BOARD_PROJECT_ID)
    // Ordinary names are untouched — the reservation is one word, not a policy.
    expect(slugifyProjectId('Example Project')).toBe('example-project')
    expect(slugifyProjectId('General Ledger')).toBe('general-ledger')
  })
})
