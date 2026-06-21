/**
 * Integration test — the REAL fire path end-to-end.
 *
 * Drives a real `ReminderTickLoop` over a real SQLite-backed `ReminderStore`
 * with a due row, wired to the real `buildReminderDispatcher`. Only the LLM
 * substrate and the chat surface are fakes (a deterministic composer + a
 * recording outbound). Asserts that a due reminder at fire time INVOKES the
 * dispatcher → composes via the LLM → POSTS the composed body to the topic —
 * not merely that the tick advances the row.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import type { AgentSpec } from '../runtime/substrate.ts'
import { ReminderStore } from './store.ts'
import { ReminderTickLoop } from './tick.ts'
import {
  buildReminderDispatcher,
  type ReminderLlm,
  type ReminderOutbound,
  type ReminderOutboundInput,
} from './dispatcher.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-reminders-dispatch-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function recordingOutbound(): ReminderOutbound & { posts: ReminderOutboundInput[] } {
  const posts: ReminderOutboundInput[] = []
  return { posts, post: (m) => { posts.push(m); return true } }
}

describe('reminder fire path (tick → dispatcher → compose → post)', () => {
  test('a due reminder composes via the LLM and posts the composed body', async () => {
    const store = new ReminderStore(db)
    let now = 1_700_000_000_000
    const created = await store.create({
      project_slug: 'globex',
      topic_id: 'topic-globex',
      fire_at: now / 1000 - 60,
      message: 'submit the Q3 expense report',
    })

    const specs: AgentSpec[] = []
    const llm: ReminderLlm = {
      compose: async (spec) => {
        specs.push(spec)
        return 'Q3 expenses are still open - knock the report out before the window closes.'
      },
    }
    const outbound = recordingOutbound()
    const dispatcher = buildReminderDispatcher({ outbound, llm, now: () => now })
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })

    const result = await loop.runOnce()

    // The tick fired exactly the due row...
    expect(result.fired).toBe(1)
    // ...the dispatcher actually invoked the composer with the stored intent...
    expect(specs).toHaveLength(1)
    expect(specs[0]!.prompt).toContain('submit the Q3 expense report')
    // ...and the composed body was posted to the originating topic.
    expect(outbound.posts).toHaveLength(1)
    expect(outbound.posts[0]!.topic_id).toBe('topic-globex')
    expect(outbound.posts[0]!.reminder_id).toBe(created.id)
    expect(outbound.posts[0]!.body).toBe(
      'Q3 expenses are still open - knock the report out before the window closes.',
    )
    // ...and the row flipped to fired (no double-fire on the next tick).
    expect(store.get(created.id)?.status).toBe('fired')
    expect((await loop.runOnce()).fired).toBe(0)
  })

  test('a recurring reminder re-arms instead of firing once, posting each time', async () => {
    const store = new ReminderStore(db)
    let now = 1_700_000_000_000
    const r = await store.createRecurring({
      project_slug: 'biohacking',
      topic_id: 'topic-bio',
      fire_at: now / 1000 - 60,
      message: 'PATTERN: check-in-cadence\nHABIT: meditation\nQUESTION: did you sit today?',
      recurrence: 'weekly',
    })

    const outbound = recordingOutbound()
    const llm: ReminderLlm = { compose: async () => 'Did you get your sit in today?' }
    const dispatcher = buildReminderDispatcher({ outbound, llm, now: () => now })
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })

    expect((await loop.runOnce()).fired).toBe(1)
    expect(outbound.posts).toHaveLength(1)
    // Recurring row stays pending, advanced to next week — not fired-and-gone.
    expect(store.get(r.id)?.status).toBe('pending')

    // Advance the clock a week + a tick — it fires AGAIN and posts AGAIN.
    now += 8 * 24 * 60 * 60 * 1000
    expect((await loop.runOnce()).fired).toBe(1)
    expect(outbound.posts).toHaveLength(2)
  })

  test('LLM-less instance still delivers: literal body posted at fire time', async () => {
    const store = new ReminderStore(db)
    let now = 1_700_000_000_000
    await store.create({
      project_slug: 'general',
      topic_id: null,
      fire_at: now / 1000 - 60,
      message: 'call mom',
    })

    const outbound = recordingOutbound()
    // No `llm` wired — the LLM-less Open boot path.
    const dispatcher = buildReminderDispatcher({
      outbound,
      llm: null,
      general_topic_id: 'general',
      now: () => now,
    })
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })

    expect((await loop.runOnce()).fired).toBe(1)
    expect(outbound.posts).toHaveLength(1)
    expect(outbound.posts[0]!.body).toBe('call mom')
    expect(outbound.posts[0]!.topic_id).toBe('general')
  })

  test('one reminder whose post throws does not block other due reminders', async () => {
    const store = new ReminderStore(db)
    let now = 1_700_000_000_000
    const bad = await store.create({
      project_slug: 'p',
      topic_id: 'boom',
      fire_at: now / 1000 - 120,
      message: 'this one explodes on post',
    })
    const good = await store.create({
      project_slug: 'p',
      topic_id: 'ok',
      fire_at: now / 1000 - 60,
      message: 'this one delivers',
    })

    const delivered: string[] = []
    const llm: ReminderLlm = { compose: async () => 'composed' }
    const outbound: ReminderOutbound = {
      post: (m) => {
        if (m.topic_id === 'boom') throw new Error('chat surface down')
        delivered.push(m.topic_id)
        return true
      },
    }
    const dispatcher = buildReminderDispatcher({ outbound, llm, now: () => now })
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })

    // The tick swallows the failed dispatch (per tick.ts contract) and keeps
    // going: the good reminder still fires + posts + advances.
    const result = await loop.runOnce()
    expect(result.fired).toBe(1) // only the good one reached markFired
    expect(delivered).toEqual(['ok'])
    // The exploding row threw before markFired, so it stays pending; the good
    // row flipped to fired.
    expect(store.get(bad.id)?.status).toBe('pending')
    expect(store.get(good.id)?.status).toBe('fired')
  })
})
