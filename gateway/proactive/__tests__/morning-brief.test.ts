/**
 * Morning-brief tests. Exercises the pure composer, the graceful-degradation
 * gatherer, and the full `runMorningBrief` path against a REAL in-memory DB +
 * a recording sink — asserting an outbound post carrying the composed brief
 * body, plus the once-per-local-day idempotency guard and the too-early gate.
 *
 * Spec: gap-audit P0-5 (WAVE 2 Track A).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import type { OutgoingMessage } from '../sink.ts'
import { ProactiveStateStore } from '../state-store.ts'
import {
  composeMorningBrief,
  gatherBriefContext,
  ownerLocalHour,
  runMorningBrief,
  type BriefContext,
  type MorningBriefDeps,
  type ProactiveContextSources,
} from '../morning-brief.ts'

const TZ = 'America/Los_Angeles'
// 2026-06-20 16:00 UTC = 09:00 LA (PDT, UTC-7) — past the 07:00 brief hour.
const NOON_LA_MS = Date.UTC(2026, 5, 20, 16, 0, 0)
// 2026-06-20 12:00 UTC = 05:00 LA — before the 07:00 brief hour.
const EARLY_LA_MS = Date.UTC(2026, 5, 20, 12, 0, 0)

interface Harness {
  db: ProjectDb
  store: ProactiveStateStore
  sent: OutgoingMessage[]
  sink: { send(m: OutgoingMessage): Promise<string> }
  close(): void
}

function open(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-proactive-brief-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new ProactiveStateStore(db)
  const sent: OutgoingMessage[] = []
  const sink = {
    async send(m: OutgoingMessage): Promise<string> {
      sent.push(m)
      return 'sent-id'
    },
  }
  return {
    db,
    store,
    sent,
    sink,
    close: () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

let h: Harness
beforeEach(() => {
  h = open()
})
afterEach(() => {
  h.close()
})

describe('composeMorningBrief (pure)', () => {
  it('renders every non-empty section under its header', () => {
    const ctx: BriefContext = {
      calendar: [{ when: '09:30', title: 'Standup' }],
      focus: [{ title: 'Ship proactive layer', project: 'neutron', due: 'due today' }],
      projects: [{ project: 'neutron', status: 'green, PR open' }],
      entities: [{ kind: 'person', name: 'Atlas' }],
    }
    const body = composeMorningBrief(ctx, '2026-06-20')
    expect(body).toContain('Morning brief — 2026-06-20')
    expect(body).toContain('📅 Today (1)')
    expect(body).toContain('09:30 — Standup')
    expect(body).toContain('🎯 Focus (1)')
    expect(body).toContain('Ship proactive layer (neutron, due today)')
    expect(body).toContain('📂 Projects (1)')
    expect(body).toContain('neutron: green, PR open')
    expect(body).toContain('🧠 Recently learned (1)')
    expect(body).toContain('Atlas (person)')
  })

  it('drops sections with no data and never fabricates them', () => {
    const body = composeMorningBrief({ focus: [{ title: 'Only focus' }] }, '2026-06-20')
    expect(body).toContain('🎯 Focus (1)')
    expect(body).not.toContain('📅 Today')
    expect(body).not.toContain('📂 Projects')
    expect(body).not.toContain('🧠 Recently learned')
  })

  it('emits an honest quiet-day line when nothing is available', () => {
    const body = composeMorningBrief({}, '2026-06-20')
    expect(body).toContain('a clear day')
    expect(body).not.toContain('📅')
    expect(body).not.toContain('🎯')
  })

  // #320 — the quiet-day copy must not over-claim the calendar is clear when
  // the calendar source was never checked (unwired or threw).
  it('#320 only claims "nothing on the calendar" when the calendar was actually checked', () => {
    const checked = composeMorningBrief({ calendar_checked: true }, '2026-06-20')
    expect(checked).toContain('Nothing on the calendar')

    const unchecked = composeMorningBrief({}, '2026-06-20')
    expect(unchecked).not.toContain('Nothing on the calendar')
    expect(unchecked).toContain("couldn't check your calendar")
  })
})

describe('gatherBriefContext (graceful degradation)', () => {
  it('collects every available source', async () => {
    const sources: ProactiveContextSources = {
      calendarToday: async () => [{ when: '10:00', title: 'Sync' }],
      focusQueue: async () => [{ title: 'Task A' }],
      entityDeltas: async () => [{ kind: 'company', name: 'Acme' }],
      projectStatus: async () => [{ project: 'p', status: 's' }],
    }
    const ctx = await gatherBriefContext(sources, '2026-06-20')
    expect(ctx.calendar).toHaveLength(1)
    expect(ctx.focus).toHaveLength(1)
    expect(ctx.entities).toHaveLength(1)
    expect(ctx.projects).toHaveLength(1)
  })

  it('omits a source that throws — the brief still composes from the rest', async () => {
    const logs: string[] = []
    const sources: ProactiveContextSources = {
      calendarToday: async () => {
        throw new Error('no calendar credential')
      },
      focusQueue: async () => [{ title: 'Survivor task' }],
    }
    const ctx = await gatherBriefContext(sources, '2026-06-20', (m) => logs.push(m))
    expect(ctx.calendar).toBeUndefined()
    expect(ctx.focus).toEqual([{ title: 'Survivor task' }])
    expect(logs.join('\n')).toContain("source 'calendar' failed")
  })

  it('omits an absent source without error', async () => {
    const ctx = await gatherBriefContext({}, '2026-06-20')
    expect(ctx).toEqual({})
  })

  // #320 — a calendar source that runs and returns [] is a CONFIRMED-empty
  // day (calendar_checked = true), distinct from an unwired/throwing source.
  it('#320 marks the calendar checked when the source returns an empty array', async () => {
    const confirmedEmpty = await gatherBriefContext({ calendarToday: async () => [] }, '2026-06-20')
    expect(confirmedEmpty.calendar).toBeUndefined()
    expect(confirmedEmpty.calendar_checked).toBe(true)

    const unwired = await gatherBriefContext({}, '2026-06-20')
    expect(unwired.calendar_checked).toBeUndefined()

    const threw = await gatherBriefContext(
      {
        calendarToday: async () => {
          throw new Error('no credential')
        },
      },
      '2026-06-20',
    )
    expect(threw.calendar_checked).toBeUndefined()
  })
})

describe('ownerLocalHour', () => {
  it('maps a UTC instant to the owner-local hour', () => {
    expect(ownerLocalHour(NOON_LA_MS, TZ)).toBe(9)
    expect(ownerLocalHour(EARLY_LA_MS, TZ)).toBe(5)
  })
})

function deps(over: Partial<MorningBriefDeps> & Pick<MorningBriefDeps, 'now'>): MorningBriefDeps {
  return {
    store: h.store,
    sources: {
      focusQueue: async () => [{ title: 'Ship the proactive layer', due: 'due today' }],
      calendarToday: async () => [{ when: '09:30', title: 'Standup' }],
    },
    sink: h.sink,
    general_topic_id: '-100123:42',
    tz: TZ,
    ...over,
  }
}

describe('runMorningBrief (compose + POST)', () => {
  it('composes from context and POSTS the brief to the General topic', async () => {
    const r = await runMorningBrief(deps({ now: () => NOON_LA_MS }))
    expect(r.status).toBe('posted')
    expect(r.day).toBe('2026-06-20')
    expect(h.sent).toHaveLength(1)
    const msg = h.sent[0]!
    expect(msg.topic.channel_topic_id).toBe('-100123:42')
    expect(msg.topic.channel_kind).toBe('telegram')
    // The outbound body carries the REAL composed brief, not a stub.
    expect(msg.text).toContain('Morning brief — 2026-06-20')
    expect(msg.text).toContain('Standup')
    expect(msg.text).toContain('Ship the proactive layer (due today)')
    expect(r.body_length).toBe(msg.text.length)
  })

  it('posts at most once per owner-local day (idempotency guard)', async () => {
    const first = await runMorningBrief(deps({ now: () => NOON_LA_MS }))
    expect(first.status).toBe('posted')
    const second = await runMorningBrief(deps({ now: () => NOON_LA_MS + 60_000 }))
    expect(second.status).toBe('already_posted')
    expect(h.sent).toHaveLength(1) // no second post
  })

  it('does not post before the brief hour', async () => {
    const r = await runMorningBrief(deps({ now: () => EARLY_LA_MS }))
    expect(r.status).toBe('too_early')
    expect(h.sent).toHaveLength(0)
  })

  it('does not record the day when delivery fails (so the next tick retries)', async () => {
    const failingSink = {
      async send(): Promise<string> {
        throw new Error('telegram 500')
      },
    }
    const r1 = await runMorningBrief(deps({ now: () => NOON_LA_MS, sink: failingSink }))
    // #320 — a delivery outage returns the distinct `deliver_failed` (NOT the
    // benign `too_early`) so the cron handler surfaces it as an error in
    // telemetry rather than folding it into the `skipped` bucket.
    expect(r1.status).toBe('deliver_failed')
    expect(h.store.hasBriefForDay('2026-06-20')).toBe(false)
    // Next tick with a working sink posts successfully.
    const r2 = await runMorningBrief(deps({ now: () => NOON_LA_MS + 1000 }))
    expect(r2.status).toBe('posted')
    expect(h.sent).toHaveLength(1)
  })
})
