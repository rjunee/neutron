/**
 * Email-Managed Core — daily triage scheduler.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.4.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildTriageScheduler,
} from '../src/triage-scheduler.ts'
import { EmailProjectCacheResolver } from '../src/cache.ts'
import { buildSeededInMemoryGmailClient } from '../src/in-memory.ts'

function tmp(): { home: string; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'email-sched-'))
  return { home, close: (): void => rmSync(home, { recursive: true, force: true }) }
}

describe('TriageScheduler', () => {
  test('does not fire before start', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const client = buildSeededInMemoryGmailClient()
      let fired = 0
      const s = buildTriageScheduler({
        cacheFor: (id) => resolver.resolve(id),
        client,
        targetProjectId: async () => 'demo',
        fire: async () => {
          fired++
          return { chat_message_id: 'cm-1' }
        },
        llm: async () => '[]',
        model: 'haiku',
        userTz: 'America/Los_Angeles',
      })
      // Tick at 08:00 PT but before start().
      await s.tick(new Date('2026-05-20T15:00:00Z')) // 08:00 PT
      expect(fired).toBe(0)
      resolver.closeAll()
    } finally {
      close()
    }
  })

  test('fires once per day at the configured local hour', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const client = buildSeededInMemoryGmailClient()
      client.seed({ subject: 's1', from: 'a@x.com', label_ids: ['INBOX'] })
      let fires = 0
      const s = buildTriageScheduler({
        cacheFor: (id) => resolver.resolve(id),
        client,
        targetProjectId: async () => 'demo',
        fire: async () => {
          fires++
          return { chat_message_id: `cm-${fires}` }
        },
        llm: async () => {
          throw new Error('use fallback')
        },
        model: 'haiku',
        userTz: 'America/Los_Angeles',
        daily_hour: 8,
        daily_minute: 0,
        // Pin start()'s immediate tick to an off-hour so it's a deterministic
        // no-op; the explicit tick()s below drive the assertions.
        now: () => new Date('2026-05-20T19:00:00Z'),
      })
      await s.start()
      // First tick at 08:00 PT → fires.
      await s.tick(new Date('2026-05-20T15:00:00Z'))
      // Second tick same minute → no-op (idempotent).
      await s.tick(new Date('2026-05-20T15:00:00Z'))
      expect(fires).toBe(1)
      // Tick the NEXT day at 08:00 PT → fires again.
      await s.tick(new Date('2026-05-21T15:00:00Z'))
      expect(fires).toBe(2)
      // Off-hour tick → no fire.
      await s.tick(new Date('2026-05-21T19:00:00Z'))
      expect(fires).toBe(2)
      resolver.closeAll()
    } finally {
      close()
    }
  })

  test('hands the already-fetched inbox to the fire callback (scribe p2 — no second fetch)', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const client = buildSeededInMemoryGmailClient()
      // Seed with the per-project label so the project-scoped list returns them.
      client.seed({ subject: 's1', from: 'a@x.com', label_ids: ['INBOX', 'Neutron/demo'] })
      client.seed({ subject: 's2', from: 'b@x.com', label_ids: ['INBOX', 'Neutron/demo'] })
      let seenInbox = -1
      const s = buildTriageScheduler({
        cacheFor: (id) => resolver.resolve(id),
        client,
        targetProjectId: async () => 'demo',
        fire: async (input) => {
          seenInbox = input.inbox.length
          return { chat_message_id: 'cm-1' }
        },
        llm: async () => '[]',
        model: 'haiku',
        userTz: 'America/Los_Angeles',
        daily_hour: 8,
        daily_minute: 0,
        now: () => new Date('2026-05-20T19:00:00Z'), // off-hour: start() immediate tick is a no-op
      })
      await s.start()
      await s.tick(new Date('2026-05-20T15:00:00Z'))
      expect(seenInbox).toBe(2) // both seeded inbox messages rode into fire
      await s.stop()
      resolver.closeAll()
    } finally {
      close()
    }
  })

  test('self-ticks on its own cadence (no external loop needed)', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const client = buildSeededInMemoryGmailClient()
      client.seed({ subject: 's1', from: 'a@x.com', label_ids: ['INBOX'] })
      let fires = 0
      // Capture the self-tick fn the scheduler arms so the test drives it
      // deterministically (no real timer).
      let armed: (() => void) | null = null
      const s = buildTriageScheduler({
        cacheFor: (id) => resolver.resolve(id),
        client,
        targetProjectId: async () => 'demo',
        fire: async () => {
          fires++
          return { chat_message_id: `cm-${fires}` }
        },
        llm: async () => '[]',
        model: 'haiku',
        userTz: 'America/Los_Angeles',
        daily_hour: 8,
        daily_minute: 0,
        // Fake timer: capture fn instead of scheduling; `now` returns 08:00 PT.
        scheduleTimer: (fn) => {
          armed = fn
          return { cancel: () => { armed = null } }
        },
        now: () => new Date('2026-05-20T15:00:00Z'),
      })
      await s.start()
      // start() runs one immediate tick at 08:00 PT (Codex r1 P2 — don't miss
      // the daily window on a boot during the fire minute) → fires once…
      expect(fires).toBe(1)
      // …and arms the recurring self-tick (no external loop needed).
      expect(armed).not.toBeNull()
      // Re-firing the captured self-tick at the same local day is idempotent.
      armed!()
      await new Promise((r) => setTimeout(r, 0)) // let the async self-tick settle
      expect(fires).toBe(1)
      await s.stop()
      resolver.closeAll()
    } finally {
      close()
    }
  })

  test('writes triage_cache audit row on every fire', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const client = buildSeededInMemoryGmailClient()
      client.seed({ subject: 's1', from: 'a@x.com', label_ids: ['INBOX'] })
      const s = buildTriageScheduler({
        cacheFor: (id) => resolver.resolve(id),
        client,
        targetProjectId: async () => 'demo',
        fire: async () => ({ chat_message_id: 'cm-1' }),
        llm: async () => '[]',
        model: 'haiku',
        userTz: 'America/Los_Angeles',
        daily_hour: 8,
        daily_minute: 0,
        now: () => new Date('2026-05-20T19:00:00Z'), // off-hour: start() immediate tick is a no-op
      })
      await s.start()
      await s.tick(new Date('2026-05-20T15:00:00Z'))
      const cache = await resolver.resolve('demo')
      const rows = cache.listRecentTriage()
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0]?.chat_message_id).toBe('cm-1')
      resolver.closeAll()
    } finally {
      close()
    }
  })
})

describe('restart idempotency (ISSUES #103)', () => {
  // The defect: the per-day guard is the in-memory `lastFired` Map, which a
  // gateway restart wipes. `start()` then runs its immediate tick, so a restart
  // DURING the fire minute re-posts the day's triage to the owner. Scribe
  // fan-out is watermark-protected, so the duplicate CHAT POST is the whole bug.
  const FIRE_MINUTE = '2026-05-20T15:00:00Z' // 08:00 America/Los_Angeles

  function scheduler(
    resolver: EmailProjectCacheResolver,
    onFire: () => void,
    now: string,
  ) {
    return buildTriageScheduler({
      cacheFor: (id) => resolver.resolve(id),
      client: buildSeededInMemoryGmailClient(),
      targetProjectId: async () => 'demo',
      fire: async () => {
        onFire()
        return { chat_message_id: 'cm-1' }
      },
      llm: async () => '[]',
      model: 'haiku',
      userTz: 'America/Los_Angeles',
      now: () => new Date(now),
    })
  }

  test('a RESTART during the fire minute does not re-post the daily triage', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      let fired = 0

      // First boot, inside the fire minute → the day's triage fires once.
      const first = scheduler(resolver, () => (fired += 1), FIRE_MINUTE)
      await first.start()
      expect(fired).toBe(1)
      await first.stop()

      // Gateway restart in the SAME minute: a brand-new scheduler, so
      // `lastFired` is empty — exactly the state the restart produces.
      const second = scheduler(resolver, () => (fired += 1), FIRE_MINUTE)
      await second.start()
      expect(fired).toBe(1) // still 1 — the durable fired_at suppressed it
      await second.stop()

      resolver.closeAll()
    } finally {
      close()
    }
  })

  test('a restart on the NEXT day still fires — the guard is per local day', async () => {
    // The failure mode of over-correcting: suppressing forever.
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      let fired = 0

      const day1 = scheduler(resolver, () => (fired += 1), FIRE_MINUTE)
      await day1.start()
      await day1.stop()
      expect(fired).toBe(1)

      const day2 = scheduler(resolver, () => (fired += 1), '2026-05-21T15:00:00Z')
      await day2.start()
      await day2.stop()
      expect(fired).toBe(2)

      resolver.closeAll()
    } finally {
      close()
    }
  })

  test('a restart OUTSIDE the fire minute is unaffected by the durable check', async () => {
    // The durable read is gated on `isFireTime` first, so an off-hour restart
    // takes the same path it always did (tick returns early on its own).
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      let fired = 0
      const s = scheduler(resolver, () => (fired += 1), '2026-05-20T19:00:00Z') // 12:00 PT
      await s.start()
      expect(fired).toBe(0)
      await s.stop()
      resolver.closeAll()
    } finally {
      close()
    }
  })
})

describe('TriageScheduler — the digest reads the WHOLE inbox (live 400, 2026-08-06)', () => {
  // WHY THESE EXIST. The suite above passed with the tick scoping its inbox read
  // to `Neutron/<project_id>` and it passed after that scoping was removed —
  // 46 tests, identical result either way. They only ever counted whether the
  // scheduler FIRED. So a digest that fired daily and read the wrong mailbox
  // (or, against real Gmail, 400-ed every time) was indistinguishable from a
  // working one. These assert what the digest SAW.
  test('the inbox read carries NO project scope', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const inner = buildSeededInMemoryGmailClient()
      inner.seed({ subject: 'from a human', from: 'a@x.com', label_ids: ['INBOX'] })
      const seen: Array<Record<string, unknown>> = []
      const client = {
        ...inner,
        listMessages: async (input: Record<string, unknown>) => {
          seen.push(input)
          return inner.listMessages(input as Parameters<typeof inner.listMessages>[0])
        },
      } as typeof inner
      const s = buildTriageScheduler({
        cacheFor: (id) => resolver.resolve(id),
        client,
        targetProjectId: async () => 'demo',
        fire: async () => ({ chat_message_id: 'cm-1' }),
        llm: async () => {
          throw new Error('use fallback')
        },
        model: 'haiku',
        userTz: 'America/Los_Angeles',
      })
      await s.start()
      await s.tick(new Date('2026-05-20T15:00:00Z'))
      await s.stop()
      expect(seen.length).toBe(1)
      expect(seen[0]?.['label']).toBe('INBOX')
      // The scope that broke it. `project_id` selects the POST target, never the
      // read filter — the label is applied only to mail Neutron itself wrote, so
      // scoping the read pointed the morning digest at its own outbound threads.
      expect(seen[0]?.['project_id']).toBeUndefined()
      resolver.closeAll()
    } finally {
      close()
    }
  })

  test('the digest actually SEES ordinary inbox mail, not just "it fired"', async () => {
    const { home, close } = tmp()
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const client = buildSeededInMemoryGmailClient()
      // Seeded the way real mail arrives: INBOX, and NO project label. Under the
      // old project-scoped read the in-memory client filtered this out and the
      // triage composed over an empty inbox — while still reporting a fire.
      client.seed({ subject: 'from a human', from: 'a@x.com', label_ids: ['INBOX'] })
      const inboxes: number[] = []
      const s = buildTriageScheduler({
        cacheFor: (id) => resolver.resolve(id),
        client,
        targetProjectId: async () => 'demo',
        fire: async (input) => {
          inboxes.push(input.inbox.length)
          return { chat_message_id: 'cm-1' }
        },
        llm: async () => {
          throw new Error('use fallback')
        },
        model: 'haiku',
        userTz: 'America/Los_Angeles',
      })
      await s.start()
      await s.tick(new Date('2026-05-20T15:00:00Z'))
      await s.stop()
      expect(inboxes).toEqual([1])
      resolver.closeAll()
    } finally {
      close()
    }
  })
})
