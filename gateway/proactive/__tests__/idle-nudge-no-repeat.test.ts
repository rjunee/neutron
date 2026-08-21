/**
 * The idle nudge must not spam. (2026-07-30)
 *
 * The re-engagement nudge was built, tested, and then deliberately left
 * switched OFF, because two defects made it repeat forever:
 *
 *   1. THE WATERMARK POLLUTED ITSELF. The nudge posts through a sink that
 *      persists a durable row into `button_prompts` — the very table the
 *      activity watermark was read from (`MAX(created_at)`, no speaker
 *      filter). The sweep's dedupe branch only skips while activity has NOT
 *      advanced past the watermark stored at the last nudge, so the nudge's
 *      own bubble re-armed it. Every idle cycle, forever.
 *   2. SINGLE-NAMESPACE ENUMERATION. The owner speaks under TWO topic roots —
 *      `web:<owner>` and `app:<owner>` — and the store could only scan one, so
 *      the sweep was blind to whichever client the owner was actually using
 *      and would nudge about work just handled on the other one.
 *
 * These tests are the reason the feature can ship ON. They run the REAL sweep
 * against a REAL database, with the REAL sink shape (an inert agent row,
 * exactly what `buildButtonStoreProactiveSink` persists) and the REAL
 * production enumerator — no stubs in the loop that matters.
 *
 * MUTATION CONTRACT — every one of these fails if the watermark fix is
 * reverted:
 *   • `does not repeat` — reverting to an unfiltered watermark makes cycles
 *     2..4 post again (4 nudges instead of 1).
 *   • `the nudge's own post moves last_created_at but NOT last_user_activity_at`
 *     — pins the two watermarks apart at the source; an unfiltered
 *     `last_user_activity_at` fails the equality assertion directly.
 * And the inverse (silence-bug) direction is pinned by `real user activity
 * re-arms the nudge`: a watermark that NOTHING can advance would dedupe the
 * owner into permanent silence, which is the trade this must not make.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import { appWsTopicId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { webTopicId } from '../../http/web-topic-id.ts'
import {
  runIdleNudgeSweep,
  type IdleNudgeSweepResult,
  type NudgeRater,
  type ProactiveTopicCandidate,
} from '../idle-nudge-sweep.ts'
import { buildOwnerIdleTopicEnumerator } from '../idle-topic-enumeration.ts'
import type { OutgoingMessage } from '../sink.ts'
import { ProactiveStateStore } from '../state-store.ts'

/** Placeholder owner id — never a real one (this repo is public). */
const OWNER = 'owner-under-test'
const SLUG = 'owner'
const WEB_ROOT = webTopicId(OWNER)
const APP_ROOT = appWsTopicId(OWNER)
const TOPIC_ROOTS = [WEB_ROOT, APP_ROOT] as const

const TZ = 'America/Los_Angeles'
const IDLE_MS = 4 * 60 * 60 * 1000
/** 2026-06-20 00:00 America/Los_Angeles (PDT, UTC-7). */
const DAY_START = Date.UTC(2026, 5, 20, 7, 0, 0)
const DAY = '2026-06-20'
/** Owner-local wall clock on that one day — every tick stays inside it so the
 *  ranker's `(project_slug, day)` pick resolves for all of them. */
function la(hour: number, minute = 0): number {
  return DAY_START + hour * 60 * 60 * 1000 + minute * 60 * 1000
}

interface Harness {
  db: ProjectDb
  buttons: ButtonStore
  proactive: ProactiveStateStore
  /** Every message the sweep handed to the sink. */
  posted: OutgoingMessage[]
  sink: { send(m: OutgoingMessage): Promise<string> }
  /** Move the shared clock (drives ButtonStore timestamps AND the sweep's now). */
  setNow(ms: number): void
  /** Persist a GENUINE user turn (what a real chat message writes). */
  userSpeaks(topic_id: string, at: number, text?: string): Promise<void>
  seedPick(task_id: string, title: string): Promise<void>
  close(): void
}

function open(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-nudge-no-repeat-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  let clock = DAY_START
  const buttons = new ButtonStore({ db, now: () => clock })
  const tasks = new TaskStore(db)
  const posted: OutgoingMessage[] = []
  return {
    db,
    buttons,
    proactive: new ProactiveStateStore(db),
    posted,
    // The production sink shape: `buildButtonStoreProactiveSink` → `deliver(...,
    // {durability:'inert'})` → `ButtonStore.persistInertAgentTurn`. Using the
    // real persistence is the whole point — a stub sink would hide the
    // self-pollution this file exists to prove is gone.
    sink: {
      async send(m: OutgoingMessage): Promise<string> {
        posted.push(m)
        const row = await buttons.persistInertAgentTurn({
          topic_id: m.topic.channel_topic_id,
          body: m.text,
        })
        return row.prompt_id
      },
    },
    setNow: (ms: number): void => {
      clock = ms
    },
    userSpeaks: async (topic_id: string, at: number, text = 'on it'): Promise<void> => {
      const restore = clock
      clock = at
      await buttons.persistInertUserTurn({
        topic_id,
        text,
        speaker_user_id: OWNER,
        channel_kind: 'app_socket',
      })
      clock = restore
    },
    seedPick: async (task_id: string, title: string): Promise<void> => {
      await tasks.create({ id: task_id, project_slug: SLUG, title })
      await db.run(
        `INSERT INTO current_focus_pick
           (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at,
            llm_model, llm_request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          SLUG,
          DAY,
          task_id,
          'Unblocks everything downstream.',
          JSON.stringify([task_id]),
          new Date(DAY_START).toISOString(),
          'claude-haiku-4-5',
        ],
      )
    },
    close: (): void => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** The production enumerator, over both of the owner's topic roots. */
function enumerator(
  h: Harness,
  roots: readonly string[] = TOPIC_ROOTS,
): () => Promise<ProactiveTopicCandidate[]> {
  return buildOwnerIdleTopicEnumerator({
    store: h.buttons,
    project_slug: SLUG,
    topic_id: APP_ROOT,
    topic_roots: roots,
    now: () => Date.now(),
  })
}

/** Run ONE sweep tick at owner-local `at`. */
async function tick(
  h: Harness,
  at: number,
  opts: {
    listTopics?: () => Promise<ProactiveTopicCandidate[]>
    rateNudge?: NudgeRater
  } = {},
): Promise<IdleNudgeSweepResult> {
  h.setNow(at)
  const rater = opts.rateNudge
  return await runIdleNudgeSweep({
    db: h.db,
    store: h.proactive,
    sink: h.sink,
    listTopics: opts.listTopics ?? enumerator(h),
    now: () => at,
    tz: TZ,
    idle_threshold_ms: IDLE_MS,
    channel_kind: 'app_socket',
    ...(rater !== undefined ? { rateNudge: rater } : {}),
  })
}

let h: Harness
beforeEach(() => {
  h = open()
})
afterEach(() => {
  h.close()
})

describe('idle nudge — non-repetition (the bar for shipping it ON)', () => {
  it('nudges EXACTLY ONCE across four idle cycles with no intervening user activity', async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    await h.userSpeaks(APP_ROOT, la(0, 30))

    // Cycle 1 — 4.5h of silence: the nudge is due.
    const first = await tick(h, la(5))
    expect(first.posted).toBe(1)
    expect(first.posted_topics).toEqual([APP_ROOT])

    // Cycles 2-4 — still silent. The ONLY new row in `button_prompts` since
    // cycle 1 is the nudge's own durable post. Nothing may re-arm on it.
    const later = [await tick(h, la(6)), await tick(h, la(7)), await tick(h, la(8))]
    for (const r of later) {
      expect(r.posted).toBe(0)
      expect(r.skip_reasons.already_nudged).toBe(1)
    }

    // The whole point: one nudge, not four.
    expect(h.posted.length).toBe(1)
  })

  it("the nudge's own post moves last_created_at but NOT last_user_activity_at", async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    const spokeAt = la(0, 30)
    await h.userSpeaks(APP_ROOT, spokeAt)

    await tick(h, la(5))
    expect(h.posted.length).toBe(1)

    const rows = await h.buttons.listTopicsByUser({
      user_id_prefix: TOPIC_ROOTS,
      now: la(5),
    })
    const general = rows.find((r) => r.topic_id === APP_ROOT)
    expect(general).toBeDefined()

    // The naive watermark IS polluted — the nudge's own row is the newest thing
    // in the topic. This assertion documents that the defect was real, not
    // theoretical: read this value and the sweep re-arms on itself.
    expect(general!.last_created_at).toBe(la(5))
    // The watermark the sweep actually reads only a PERSON can move.
    expect(general!.last_user_activity_at).toBe(spokeAt)

    // And that is what got written into the dedupe ledger.
    expect(h.proactive.getTopicState(APP_ROOT)?.last_activity_at_ms).toBe(spokeAt)
  })

  it('real user activity re-arms the nudge (no silence bug)', async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    await h.userSpeaks(APP_ROOT, la(0, 30))

    expect((await tick(h, la(5))).posted).toBe(1)

    // The owner comes back.
    await h.userSpeaks(APP_ROOT, la(6))

    // One hour later the topic is ACTIVE, not idle — no nudge.
    const tooSoon = await tick(h, la(7))
    expect(tooSoon.posted).toBe(0)
    expect(tooSoon.skip_reasons.active).toBe(1)

    // Five hours after that return, idle again → the nudge is due a SECOND time.
    const rearmed = await tick(h, la(11))
    expect(rearmed.posted).toBe(1)
    expect(h.posted.length).toBe(2)
  })
})

describe('idle nudge — dual-namespace enumeration', () => {
  it('sees activity on the app root that a web-only enumeration is blind to', async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    // The owner handled this on their phone 30 minutes ago.
    await h.userSpeaks(`${APP_ROOT}:proj-a`, la(4, 30))

    // Both roots: the sweep can see it, so the topic reads ACTIVE — silence.
    const both = await tick(h, la(5), { listTopics: enumerator(h) })
    expect(both.posted).toBe(0)
    expect(both.skip_reasons.active).toBe(1)
    expect(h.posted.length).toBe(0)

    // Web root only (the pre-fix enumeration): blind to the phone, so it nudges
    // the owner about something they finished half an hour ago.
    const webOnly = await tick(h, la(5), { listTopics: enumerator(h, [WEB_ROOT]) })
    expect(webOnly.posted).toBe(1)
  })

  it('sees activity on the web root too', async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    await h.userSpeaks(`${WEB_ROOT}:proj-b`, la(4, 30))

    const both = await tick(h, la(5), { listTopics: enumerator(h) })
    expect(both.posted).toBe(0)
    expect(both.skip_reasons.active).toBe(1)

    // App root only → blind in the mirror direction.
    const appOnly = await tick(h, la(5), { listTopics: enumerator(h, [APP_ROOT]) })
    expect(appOnly.posted).toBe(1)
  })

  it('merges the MAX across both roots rather than taking the first hit', async () => {
    await h.userSpeaks(`${WEB_ROOT}:proj-b`, la(1))
    await h.userSpeaks(`${APP_ROOT}:proj-a`, la(3))
    const candidates = await enumerator(h)()
    expect(candidates).toEqual([
      { topic_id: APP_ROOT, project_slug: SLUG, last_activity_ms: la(3) },
    ])
  })

  it('reports a null watermark when a person has never spoken', async () => {
    // An agent-authored row exists, but no human turn. Null, not the agent row.
    await h.buttons.persistInertAgentTurn({ topic_id: APP_ROOT, body: 'welcome' })
    const candidates = await enumerator(h)()
    expect(candidates[0]!.last_activity_ms).toBeNull()
  })
})

describe('idle nudge — the ≥7 quality floor applies once enumeration is correct', () => {
  it('stays silent when either dimension is below the floor', async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    await h.userSpeaks(APP_ROOT, la(0, 30))

    const result = await tick(h, la(5), {
      rateNudge: async () => ({ leverage: 6, gratitude: 10 }),
    })
    expect(result.posted).toBe(0)
    expect(result.skip_reasons.low_quality).toBe(1)
    expect(h.posted.length).toBe(0)
  })

  it('posts when both dimensions clear the floor', async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    await h.userSpeaks(APP_ROOT, la(0, 30))

    const result = await tick(h, la(5), {
      rateNudge: async () => ({ leverage: 7, gratitude: 7 }),
    })
    expect(result.posted).toBe(1)
  })

  it('abstains (skips) when the rater returns null', async () => {
    await h.seedPick('t-ship', 'Ship the migration')
    await h.userSpeaks(APP_ROOT, la(0, 30))

    const result = await tick(h, la(5), { rateNudge: async () => null })
    expect(result.posted).toBe(0)
    expect(result.skip_reasons.low_quality).toBe(1)
  })
})
