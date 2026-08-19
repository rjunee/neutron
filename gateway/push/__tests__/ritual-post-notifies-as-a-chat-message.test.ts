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
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
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
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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
function buildChain(opts: { approved: boolean; planner?: boolean; rejectPost?: boolean }): {
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
        // A real `PushResult`, count included. `ok` alone is not a delivery — the
        // sink requires `delivered >= 1`, because `dispatch` returns `ok: true` with
        // `delivered: 0` both when no device is registered and when every ticket
        // errored (`gateway/push/chat-message-push.ts`). Reporting only `ok` here
        // would model a chain that reached a device when it had not.
        return { attempted: 1, delivered: 1, errored: 0, ok: true, error: null }
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

  // `planner: false` models the LLM-less box: `open/composer.ts` never runs
  // `init_ritual_planner`, so the dispatcher is handed NO planner at all. That is a
  // different arm from `approved: false` (a planner that refuses) and it used to
  // reach the owner very differently — see the test below.
  const planner =
    opts.planner === false
      ? undefined
      : buildRitualFirePlanner({
          registry,
          approvals: new ApprovalManager(db, noopNotifier),
          project_slug: OWNER_SLUG,
          runs: createRitualRunStore(db),
          ...(opts.approved ? { build_approval_check: () => ({ isApproved: () => true }) } : {}),
          mint_run_id: () => 'run-1',
        })

  const dispatcher = buildReminderDispatcher({
    // The production outbound, except in the one arm that needs a REJECTED post.
    // Rejection is an outbound-level answer (`ReminderOutbound.post` → false), so a
    // two-line stub states it exactly; driving `deliver` into failing instead would
    // assert deliver's internals rather than the dispatcher's response to a refusal.
    outbound:
      opts.rejectPost === true
        ? { post: async (): Promise<boolean> => false }
        : buildButtonStoreReminderOutbound({ deliver }),
    llm,
    resolveTopicId: () => OWNER_TOPIC,
    ...(planner !== undefined ? { ritual_planner: planner } : {}),
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

describe('a ritual row with NO PLANNER is refused, and the owner is TOLD', () => {
  test('the `ritual:<id>` token never becomes a notification on an instance with no model', async () => {
    // THE SECOND ROUTE TO THE REPORTED SYMPTOM, and the one the first fix left open.
    // `ritual_planner` is null whenever `init_ritual_planner` does not run — an
    // LLM-less box (`open/composer.ts`). The dispatcher's decision then read
    // `{ kind: 'nudge' }` for EVERY row, so a ritual row composed from its stored
    // `message`, which IS `ritual:<id>` — and the owner's lock screen read
    // `ritual:kaizen` again, by a completely different path from the one this lane
    // originally fixed.
    //
    // The comment on `ritualPlanner` called that fall-through "fail-closed: nothing
    // reads a ritual's prompt". Correct about the prompt, silent about the
    // notification. Fail-closed here has to mean posting NOTHING.
    const chain = buildChain({ approved: true, planner: false })

    await chain.dispatch(await ritualRow('kaizen'))

    // NO COMPOSE TURN. This is the assertion that pins the refusal itself: a nudge
    // fall-through would have spent one, and its text would have been the token.
    expect(chain.composeCalls()).toBe(0)

    // AND EXACTLY ONE NOTIFICATION, whose body is a sentence rather than a token.
    //
    // The first version of this arm asserted `toEqual([])` here, and the review round
    // after it found what that emptiness was hiding: the dispatcher returns NORMALLY,
    // so the tick loop's pre-dispatch claim stands and the occurrence is retired. An
    // empty `expo` therefore did not mean "nothing bad reached him", it meant "a
    // scheduled ritual was consumed and he was never told" — which is the ISSUES #506
    // class this lane exists inside, and which `reminders/AGENTS.md` forbids: for a
    // ritual, a failure is recorded AND noticed. So the count is 1, not 0.
    expect(chain.expo).toHaveLength(1)
    const body = chain.expo[0]?.body ?? ''
    // The reported defect, still: the notice must not carry the dispatch token.
    expect(body).not.toContain('ritual:')
    expect(body).toContain("Ritual 'kaizen' did not run")
    expect(body.length).toBeGreaterThan(0)
    // It is an ordinary chat message, so it routes like one.
    expect(chain.expo[0]?.data?.kind).toBe('agent_message')
  })

  test('the occurrence is CONSUMED, not thrown back for a 30s retry loop', async () => {
    // The deliberate half of the posture, asserted so it cannot be "fixed" into a
    // hot loop by a later reader. An instance with no model credential cannot plan
    // this row on the next tick either, so throwing (which reverts the tick's claim,
    // `reminders/tick.ts`) would re-fire it every 30 s until an operator intervenes.
    // The occurrence is retired and the owner is told instead.
    const chain = buildChain({ approved: true, planner: false })

    await expect(chain.dispatch(await ritualRow('kaizen'))).resolves.toBeUndefined()
  })

  test('a REJECTED notice throws, so the occurrence is not consumed in silence', async () => {
    // The other half: consuming the occurrence is only acceptable because the owner
    // was told. If the notice never landed, the row must stay pending — the same
    // contract the nudge and ritual post sites hold (#319: the dispatcher only ever
    // throws BEFORE a successful delivery).
    const chain = buildChain({ approved: true, planner: false, rejectPost: true })

    await expect(chain.dispatch(await ritualRow('kaizen'))).rejects.toThrow(
      /unplannable notice rejected/,
    )
  })

  test('a PLAIN reminder still fires normally with no planner — the guard is keyed on the row, not the box', async () => {
    // The control that keeps the guard honest. A box with no planner must still
    // deliver ordinary reminders; if this went silent the fix would have traded one
    // reported bug for a much worse unreported one.
    const chain = buildChain({ approved: true, planner: false })
    const plain = await store.create({
      owner_slug: OWNER_SLUG,
      topic_id: null,
      fire_at: 1000,
      message: 'take the dogs out',
    })

    await chain.dispatch(plain)

    expect(chain.expo).toHaveLength(1)
    // The EXCERPT, not the whole report — a notification body is budgeted and ends
    // in an ellipsis on a word boundary (`chatPushExcerpt`). Asserting equality with
    // `COMPOSED` here would be asserting the excerpt never happened.
    const body = chain.expo[0]?.body ?? ''
    expect(COMPOSED.startsWith(body.replace(/…$/, ''))).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain('ritual:')
  })

  test('a plain reminder WORDED like a dispatch token still fires — the column decides, not the text', async () => {
    // THE ARM THAT MAKES THE KEYING CHECKABLE. The guard is documented as keyed on
    // the `ritual_id` COLUMN rather than on the shape of `message`, with a stated
    // reason: a prefix test "would also swallow a plain reminder the owner happened
    // to word that way". Nothing tested that reason — swapping the condition for
    // `reminder.message.startsWith('ritual:')` passed every arm above, which is zero
    // coverage on the one design decision the docblock argues for.
    //
    // So: a row with `ritual_id === null` whose message BEGINS with the token
    // prefix. There is no planner, so the mutant would refuse it and send the
    // "did not run" notice for a reminder the owner simply typed a colon into.
    // The real code composes and delivers it like any other reminder.
    const chain = buildChain({ approved: true, planner: false })
    const worded = await store.create({
      owner_slug: OWNER_SLUG,
      topic_id: null,
      fire_at: 1000,
      message: 'ritual: stretch for ten minutes before the call',
    })
    // The premise of the test, pinned: this is NOT a ritual row. If `create` ever
    // starts inferring `ritual_id` from the message, this arm would be testing
    // nothing and should red here rather than pass for the wrong reason.
    expect(worded.ritual_id).toBeNull()

    await chain.dispatch(worded)

    // COMPOSED, not refused — the compose turn is the thing the refusal skips, so
    // it is the sharpest single assertion that the guard did not fire.
    expect(chain.composeCalls()).toBe(1)
    expect(chain.expo).toHaveLength(1)
    const body = chain.expo[0]?.body ?? ''
    expect(body).not.toContain('did not run')
    expect(COMPOSED.startsWith(body.replace(/…$/, ''))).toBe(true)
  })
})
