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

  // F3 (Codex r18): a self-tick failure must be OBSERVABLE (surfaced via
  // console.error — Cores can't import the host logger), not silently swallowed.
  test('a self-tick failure is surfaced via console.error, not silently swallowed', async () => {
    const { home, close } = tmp()
    const realErr = console.error
    const errs: string[] = []
    console.error = (...a: unknown[]): void => {
      errs.push(a.map((x) => String(x)).join(' '))
    }
    let armed: (() => void) | null = null
    try {
      const resolver = new EmailProjectCacheResolver({ owner_home: home })
      const client = buildSeededInMemoryGmailClient()
      const s = buildTriageScheduler({
        cacheFor: () => {
          throw new Error('boom-cache') // make every tick throw
        },
        client,
        targetProjectId: async () => 'demo',
        fire: async () => ({ chat_message_id: 'cm' }),
        llm: async () => '[]',
        model: 'haiku',
        userTz: 'America/Los_Angeles',
        daily_hour: 8,
        daily_minute: 0,
        scheduleTimer: (fn) => {
          armed = fn
          return { cancel: (): void => { armed = null } }
        },
        now: () => new Date('2026-05-20T15:00:00Z'), // 08:00 PT — tick does real work
      })
      try {
        await s.start() // start()'s immediate tick may surface the throw too
      } catch {
        /* the immediate tick can reject on the injected throw — not the path under test */
      }
      expect(armed).not.toBeNull()
      armed!() // fire the recurring self-tick → tick throws → caught → console.error
      await new Promise((r) => setTimeout(r, 0)) // let the async self-tick settle
      expect(
        errs.find((l) => l.includes('email-triage-scheduler') && l.includes('tick failed')),
      ).toBeDefined()
      await s.stop()
      resolver.closeAll()
    } finally {
      console.error = realErr
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
