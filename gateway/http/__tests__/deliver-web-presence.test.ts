/**
 * `deliver` × web presence — the SEAM, which neither half's own suite can see.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * `gateway/push/web-presence.test.ts` asserts the wrapper returns `false` when it
 * suppresses. `gateway/http/__tests__/deliver.test.ts` asserts the durable row is
 * stamped when the owner is reached. Both pass. Between them sits a fact neither
 * one states: deliver's stamp condition is
 *
 *     if (durability === 'reply' && (notified || delivered)) await stampDelivered(...)
 *
 * — TWO arms. The wrapper only controls `notified`. `delivered` is the live
 * socket fan-out, and it stamps on its own. So the wrapper's docblock, which
 * originally claimed that returning `false` was what kept a suppressed message's
 * row unstamped, was describing an intended mode the code never entered: rule 3a,
 * the aspirational docblock, in the one subsystem whose failure mode is silence.
 *
 * A stamped row makes the NEXT re-emit of the same `idempotency_key` read
 * `was_delivered: true` and return before the notify path — so getting this wrong
 * does not produce one missed buzz, it produces a stable alert key that never
 * buzzes again. `open/credential-lapse-notice.ts` and the email escalation path
 * both depend on exactly that re-emit.
 *
 * ── WHAT MAKES IT CORRECT NOW ──────────────────────────────────────────────
 *
 * Not the return value: the CONVERSATION SCOPE. Suppression requires a web client
 * foregrounded on the message's own conversation, which is the same socket the
 * live fan-out just delivered to — so `delivered: true` and "it is on his screen"
 * are two readings of one fact and the stamp records something that happened.
 * The tests below pin all three legs: the scoped suppression stamps no more than
 * an ordinary push would, a suppression with NO live delivery stamps nothing and
 * leaves the re-emit free to buzz, and a message for a conversation he is not
 * looking at is never suppressed in the first place.
 *
 * Driven over the REAL `ButtonStore` against a real migrated DB, for the reason
 * the sibling suite already learned the hard way: a fake that answers
 * `was_delivered` from a literal proves the question is asked and silently
 * assumes something wrote the answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  createWebPresenceTracker,
  suppressPushWhileWebForeground,
  WEB_PRESENCE_TTL_MS,
} from '../../push/web-presence.ts'
import type { WebPresenceTracker } from '../../push/web-presence.ts'
import { createDeliver } from '../deliver.ts'

const OWNER = 'acct-2'
/** The owner's General app-ws topic — `chatMessagePushScope` reads it as `project_id: null`. */
const GENERAL_TOPIC = `app:${OWNER}`
/** A project chat's topic — scope `proj-a`. */
const PROJECT_TOPIC = `app:${OWNER}:proj-a`

/** A stable-key alert: the shape whose whole value is that it re-emits. */
const ALERT = {
  body: 'your credential lapsed — reconnect?',
  durability: 'reply' as const,
  idempotency_key: 'credential-lapse:gmail',
}

describe('deliver × web presence — the stamp seam', () => {
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore
  let tracker: WebPresenceTracker
  let clock: { now: () => number; advance: (ms: number) => void }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-deliver-presence-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
    let t = 1_000_000
    clock = { now: () => t, advance: (ms) => void (t += ms) }
    tracker = createWebPresenceTracker({ now: clock.now })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Build the deliver the composer builds: ONE sink, wrapped in the presence
   * check, feeding deliver's `notify`. `live` decides whether an app-ws socket
   * accepts the fan-out — i.e. whether `delivered` is true.
   */
  function build(live: boolean): { deliver: ReturnType<typeof createDeliver>; buzzed: string[] } {
    const buzzed: string[] = []
    const notify = suppressPushWhileWebForeground({
      sink: async (n): Promise<boolean> => {
        buzzed.push(n.message_id)
        return true
      },
      isWebForeground: (msg) => tracker.isForeground(OWNER, msg.project_id),
    })
    const deliver = createDeliver({
      buttonStore: store,
      push: { app: (): boolean => live },
      notify,
    })
    return { deliver, buzzed }
  }

  it('CONTROL: with no tab open, the alert buzzes and the row is stamped', async () => {
    // The baseline every other test is measured against. Without it, an assertion
    // that something did NOT buzz proves only that the harness cannot buzz.
    const { deliver, buzzed } = build(true)
    const r = await deliver(GENERAL_TOPIC, ALERT)
    expect(buzzed).toHaveLength(1)
    expect(await store.deliveredAt(r.prompt_id!)).not.toBeNull()
  })

  it('a foregrounded tab on THAT chat silences the phone — and the message still landed', async () => {
    const { deliver, buzzed } = build(true)
    tracker.foreground(OWNER, 'conn-web', null) // General, which is where the alert lands
    const r = await deliver(GENERAL_TOPIC, ALERT)
    expect(buzzed).toHaveLength(0)
    // The durable row exists regardless — suppression is about the push, never
    // about the message.
    expect(r.persisted).toBe(true)
    expect(r.prompt_id).not.toBeNull()
  })

  it('suppression does not make the re-emit QUIETER than an ordinary push would have', async () => {
    // The honest statement of the seam. He is looking at the chat, so the live
    // socket delivered it, so the row stamps — exactly as it would have if the
    // push had been sent and he had read it on his phone. Web presence is not
    // allowed to change this either way, and this asserts it against the control
    // above rather than asserting a value in isolation.
    const suppressed = build(true)
    tracker.foreground(OWNER, 'conn-web', null)
    const r = await suppressed.deliver(GENERAL_TOPIC, ALERT)
    expect(suppressed.buzzed).toHaveLength(0)
    expect(await store.deliveredAt(r.prompt_id!)).not.toBeNull()
  })

  it('THE BLOCKER: a suppression with NO live delivery stamps nothing, so the re-emit still reaches him', async () => {
    // This is the case that would have been permanent silence. Suppressed
    // (`notified: false`) AND the fan-out reached no socket (`delivered: false`)
    // means `notified || delivered` is false and the row must stay unstamped —
    // otherwise a stable alert key is silenced forever for a message that was
    // never sent anywhere.
    const first = build(false) // no live socket accepts the frame
    tracker.foreground(OWNER, 'conn-web', null)
    const r = await first.deliver(GENERAL_TOPIC, ALERT)
    expect(first.buzzed).toHaveLength(0)
    expect(await store.deliveredAt(r.prompt_id!)).toBeNull()

    // He shuts the laptop; the tab dies without a close frame and the TTL forgets
    // it. The next re-emit of the SAME key must buzz.
    clock.advance(WEB_PRESENCE_TTL_MS + 1)
    const second = build(false)
    const again = await second.deliver(GENERAL_TOPIC, ALERT)
    expect(again.prompt_id).toBe(r.prompt_id) // the same row: a true re-emit
    expect(second.buzzed).toHaveLength(1)
  })

  it('THE CROSS-CONVERSATION BUG: a tab open on one project never silences another', async () => {
    // With a global presence check this buzzed zero times: one open tab silenced
    // every other conversation for as long as it stayed open, and nothing was
    // stamped, so it was not even recoverable by the re-emit — just quiet.
    const { deliver, buzzed } = build(true)
    tracker.foreground(OWNER, 'conn-web', 'proj-a') // he is reading project A

    await deliver(GENERAL_TOPIC, { ...ALERT, idempotency_key: 'k-general' })
    await deliver(PROJECT_TOPIC, { ...ALERT, idempotency_key: 'k-proj-a' })

    // General buzzed (he cannot see it); project A did not (he is reading it).
    expect(buzzed).toHaveLength(1)
  })

  it('presence expiry restores the buzz mid-stream, without a close frame', async () => {
    const { deliver, buzzed } = build(true)
    tracker.foreground(OWNER, 'conn-web', null)
    await deliver(GENERAL_TOPIC, { ...ALERT, idempotency_key: 'k-1' })
    expect(buzzed).toHaveLength(0) // control: it really was suppressed

    clock.advance(WEB_PRESENCE_TTL_MS + 1)
    await deliver(GENERAL_TOPIC, { ...ALERT, idempotency_key: 'k-2' })
    expect(buzzed).toHaveLength(1)
  })

  it('a throwing tracker notifies — an unanswerable question never withholds an alert', async () => {
    const buzzed: string[] = []
    const notify = suppressPushWhileWebForeground({
      sink: async (n): Promise<boolean> => {
        buzzed.push(n.message_id)
        return true
      },
      isWebForeground: () => {
        throw new Error('tracker exploded')
      },
    })
    const deliver = createDeliver({
      buttonStore: store,
      push: { app: (): boolean => true },
      notify,
    })
    await deliver(GENERAL_TOPIC, ALERT)
    expect(buzzed).toHaveLength(1)
  })
})
