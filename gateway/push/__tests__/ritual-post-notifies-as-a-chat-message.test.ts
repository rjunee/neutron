/**
 * A RITUAL POST IS A CHAT MESSAGE — the WHOLE chain, from a ritual row to the
 * bytes Expo is handed (owner-reported, 2026-08-09).
 *
 * WHAT HE SAW: *"the notification that comes in on Android says 'ritual:kaizen'. I
 * don't need a special case notification for rituals. I should just get
 * notifications of chat messages, and a ritual posting is just a chat message. And
 * the notification should include at least the first part of the chat message in
 * the notification itself."*
 *
 * WHY THIS FILE EXISTS AND NOT ANOTHER UNIT TEST. The first round of this fix was
 * covered by a test that hand-built the outbound's input — `{ body: 'Kaizen review:
 * …' }` — and asserted that body reached the notification. It could not fail on the
 * reported bug, because the bug is that the body a ritual reaches the outbound WITH
 * used to be the row's `message`, i.e. the token. A test that supplies the correct
 * body proves nothing about who supplies it in production. The other arm was worse:
 * an integration test fired an UNAPPROVED ritual, which composes nothing and posts
 * nothing, then asserted `not.toContain('ritual:')` inside a loop over an empty
 * collection. Zero notifications passed it.
 *
 * So this drives the REAL chain end to end and requires it to be non-empty at every
 * link:
 *
 *   a ritual `reminders` row (its `message` IS `ritual:<id>`)
 *     → the REAL `buildRitualFirePlanner` over the REAL registry + a granted
 *       approval, so the planner FIRES instead of skipping
 *     → the REAL `buildReminderDispatcher`, which composes the turn
 *     → the REAL `buildButtonStoreReminderOutbound`
 *     → the REAL `createDeliver` (durable row, then notify)
 *     → the REAL `buildChatMessagePushSink` + `buildChatMessagePush`
 *     → the Expo message: title, body, and tap payload.
 *
 * Every link is production code; the only stubs are the substrate's text, the
 * ButtonStore, and the Expo fan-out — the three edges of the system.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ApprovalManager, type ApprovalNotifier } from '@neutronai/tools/approval.ts'
import {
  buildReminderDispatcher,
  buildRitualFirePlanner,
  createRitualRegistry,
  createRitualRunStore,
  registerBundledRituals,
  ReminderStore,
  seedBundledRituals,
  type Reminder,
  type ReminderLlm,
} from '@neutronai/reminders/index.ts'

import { createDeliver } from '../../http/deliver.ts'
import { buildButtonStoreReminderOutbound } from '../../proactive/reminder-outbound.ts'
import { buildChatMessagePushSink } from '../chat-message-push.ts'

/** The composed report a fired `kaizen` posts — deliberately NOT the row's message. */
const COMPOSED =
  'Kaizen review: two things landed today, the importer is still blocked, and the ' +
  'notification path is the one worth fixing next because it is the only thing the ' +
  'owner sees without opening the app at all.'

const OWNER_SLUG = 'owner'
/** The one topic every out-of-turn producer delivers to (`open/composer.ts`). */
const OWNER_TOPIC = 'app:owner'

let tmp: string
let ritualsDir: string
let db: ProjectDb
let store: ReminderStore

const noopNotifier: ApprovalNotifier = { notify: async () => {} }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-push-'))
  ritualsDir = mkdtempSync(join(tmpdir(), 'neutron-ritual-push-defs-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new ReminderStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(ritualsDir, { recursive: true, force: true })
})

/** A due reminder row tagged as a ritual — its `message` is the dispatch token. */
async function ritualRow(ritual_id: string): Promise<Reminder> {
  const r = await store.create({
    owner_slug: OWNER_SLUG,
    topic_id: null,
    fire_at: 1000,
    message: `ritual:${ritual_id}`,
  })
  db.raw().run('UPDATE reminders SET ritual_id = ? WHERE id = ?', [ritual_id, r.id])
  return { ...r, ritual_id }
}

/** The durable-row edge. Returns a fixed prompt id so the tap-anchor assertion is exact. */
function fakeButtonStore(): ButtonStore {
  return {
    async emit(prompt: { body: string }, opts: { topic_id: string }) {
      void prompt
      void opts
      return { prompt_id: 'durable-row-1', was_new: true }
    },
    async persistInertAgentTurn() {
      return { prompt_id: 'durable-row-inert' }
    },
    // `deliver` stamps the row delivered after a successful notification, so the
    // NEXT idempotent re-emit can stay quiet. Present here so that call is a real
    // one rather than a TypeError absorbed by deliver's catch — the suppression
    // itself is asserted against the real store in `gateway/http/__tests__/deliver.test.ts`.
    async markDelivered() {},
  } as unknown as ButtonStore
}

interface ExpoMessage {
  to: string
  title?: string
  body: string
  data?: { kind?: unknown; message_id?: unknown; project_id?: unknown }
}

/**
 * The production chain, assembled from production builders.
 *
 * `build_approval_check` is the ONE seam forced: granting a real content-hash
 * approval would mean recomputing the hash of the seeded prompt bytes here, which
 * asserts the approval algorithm rather than the notification. The unapproved arm
 * (below) uses the REAL `ApprovalManager` path, so the fail-closed behaviour is
 * still exercised against the real thing.
 */
function buildChain(opts: { approved: boolean }): {
  dispatch: (r: Reminder) => Promise<void>
  expo: ExpoMessage[]
  composeCalls: () => number
} {
  const expo: ExpoMessage[] = []
  let composeCalls = 0

  const chatPush = buildChatMessagePushSink({
    project_slug: OWNER_SLUG,
    fanOut: {
      async pushAll(project_slug, message) {
        expect(project_slug).toBe(OWNER_SLUG)
        expo.push({ to: 'ExponentPushToken[device]', ...message })
        return { ok: true }
      },
    },
  })

  const deliver = createDeliver({
    buttonStore: fakeButtonStore(),
    push: {},
    notify: chatPush,
  })

  const registry = createRitualRegistry({ rituals_dir: ritualsDir })
  seedBundledRituals({ rituals_dir: ritualsDir })
  registerBundledRituals(registry)

  const llm: ReminderLlm = {
    compose: async () => {
      composeCalls += 1
      return COMPOSED
    },
  }

  const dispatcher = buildReminderDispatcher({
    outbound: buildButtonStoreReminderOutbound({ deliver }),
    llm,
    resolveTopicId: () => OWNER_TOPIC,
    ritual_planner: buildRitualFirePlanner({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: OWNER_SLUG,
      runs: createRitualRunStore(db),
      ...(opts.approved ? { build_approval_check: () => ({ isApproved: () => true }) } : {}),
      mint_run_id: () => 'run-1',
    }),
    resolve_ritual_model: () => 'model-best',
  })

  return { dispatch: (r) => dispatcher.dispatch(r), expo, composeCalls: () => composeCalls }
}

describe('an APPROVED ritual fire notifies as a chat message', () => {
  test('the notification body is the COMPOSED report, never the `ritual:<id>` token', async () => {
    const chain = buildChain({ approved: true })

    await chain.dispatch(await ritualRow('kaizen'))

    // NON-EMPTY FIRST, and this is the assertion the previous version of this test
    // was missing: everything below is vacuous if nothing was sent, and an
    // unapproved ritual sends nothing while looking green.
    expect(chain.composeCalls()).toBe(1)
    expect(chain.expo).toHaveLength(1)

    const msg = chain.expo[0]!
    // THE REPORTED DEFECT, in one line. The row's `message` is `ritual:kaizen`; the
    // notification must be the text the turn produced.
    expect(msg.body).not.toContain('ritual:')
    expect(msg.body.startsWith('Kaizen review: two things landed today,')).toBe(true)
    // *"at least the first part of the chat message"* — excerpted on a word
    // boundary with an ellipsis, not the whole 200-character report and not a
    // mid-word cut.
    expect(msg.body.endsWith('…')).toBe(true)
    expect(msg.body.length).toBeLessThan(COMPOSED.length)
    expect(COMPOSED.startsWith(msg.body.slice(0, -1))).toBe(true)
  })

  test('the tap payload routes to the CHAT and anchors on the durable row', async () => {
    const chain = buildChain({ approved: true })
    await chain.dispatch(await ritualRow('kaizen'))

    expect(chain.expo).toHaveLength(1)
    const data = chain.expo[0]!.data ?? {}
    // A chat message, not a reminder: the tap opens the transcript, not the tab.
    expect(data.kind).toBe('agent_message')
    // The id the client carries onto the row, so the transcript can land ON it.
    expect(data.message_id).toBe('durable-row-1')
    // General names itself explicitly — an app bundle already on a device reads a
    // missing project as a malformed payload and refuses to route.
    expect(data.project_id).toBe('~general')
    // And the title says WHERE, so the shade answers "which conversation is this?"
    expect(chain.expo[0]!.title).toBe('General')
  })
})

describe('an UNAPPROVED ritual (the REAL ApprovalManager path) notifies nothing', () => {
  test('no turn, no post, and NO notification — asserted as an empty collection', async () => {
    const chain = buildChain({ approved: false })

    await chain.dispatch(await ritualRow('kaizen'))

    // Fail-closed: the planner refuses, so there is no composed text and nothing
    // reaches chat — therefore nothing may reach the owner's phone either. Stated
    // as `toEqual([])` rather than as a property checked inside a loop, because a
    // loop over nothing is how the previous version of this test passed while
    // proving nothing.
    expect(chain.composeCalls()).toBe(0)
    expect(chain.expo).toEqual([])
  })
})

describe('an ordinary NUDGE reaches the identical notification shape', () => {
  test('a plain reminder and a ritual produce the same kind of notification', async () => {
    // *"a ritual posting is just a chat message"* — so there must be no shape a
    // ritual has that a nudge does not. Both rows travel the same dispatcher, the
    // same outbound, the same deliver and the same sink; this pins that the OUTPUT
    // is the same too, which is the part a reader can check at a glance.
    const chain = buildChain({ approved: true })

    await chain.dispatch(await ritualRow('kaizen'))
    await chain.dispatch(
      await store.create({
        owner_slug: OWNER_SLUG,
        topic_id: null,
        fire_at: 1000,
        message: 'drink water',
      }),
    )

    expect(chain.expo).toHaveLength(2)
    const [fromRitual, fromNudge] = chain.expo as [ExpoMessage, ExpoMessage]
    // Byte-identical, because the composed text is the same and NOTHING else in the
    // notification depends on which producer wrote it. Compared directly rather
    // than re-asserted field by field: a field added to one path and not the other
    // is exactly the divergence the owner was complaining about.
    expect(fromNudge).toEqual(fromRitual)
    expect(fromNudge.data?.kind).toBe('agent_message')
  })
})
