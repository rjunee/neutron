/**
 * Scribe phase-2 — Cores fire-callback decoration (the wiring seam).
 *
 * Asserts the gateway wiring DECORATES (never replaces) each Core's `fire`:
 *   - calendar: one scribe fan-out per fired event, with the composed payload +
 *     `gcal:<id>` source pointer, and the existing brief path still runs.
 *   - email: one scribe fan-out per ALREADY-FETCHED inbox message, with the
 *     composed payload + `email:<id>` source pointer.
 * The fan-out is fire-and-forget and rides the Cores' own connectors + cadence
 * (no second fetch, no new poller — see scribe-cores-source.test.ts static gate).
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GmailMessageMeta } from '@neutronai/email-managed-core'
import type { PreMeetingBriefFireInput } from '@neutronai/calendar-core'
import { composeCalendarPayload, composeEmailPayload } from '../../../scribe/index.ts'
import { buildCalendarPreMeetingBriefSchedulerDeps } from '../calendar-wiring.ts'
import {
  buildEmailTriageSchedulerDeps,
  fileScribeEmailWatermark,
  renderTriageText,
  type ScribeEmailWatermarkStore,
} from '../email-managed-wiring.ts'
import type { ScribeFanOut } from '../scribe-fan-out.ts'

/** In-memory watermark store for deterministic cross-day idempotency tests. */
function memWatermark(initial = 0): ScribeEmailWatermarkStore {
  let mark = initial
  return {
    get: async () => mark,
    set: async (ms: number): Promise<void> => {
      mark = ms
    },
  }
}

function recorder(): { fan: ScribeFanOut; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = []
  return {
    calls,
    fan: (trigger, text, source): void => {
      calls.push([trigger, text, source])
    },
  }
}

describe('calendar-wiring fire decoration', () => {
  test('fans the fired event into scribe (calendar / composed payload / gcal: source) AND still runs the brief', async () => {
    const { fan, calls } = recorder()
    let cacheForCalls = 0
    const deps = buildCalendarPreMeetingBriefSchedulerDeps({
      project_slug: 'acme',
      // The fire path only touches cacheFor + (failing) llm + null push.
      client: {} as never,
      cacheFor: async () => {
        cacheForCalls += 1
        return null as never
      },
      enumerateProjects: async () => [],
      pushDispatcher: null,
      queueStore: {} as never,
      llm: async () => {
        throw new Error('no llm — brief falls back to llm_error')
      },
      scribeFanOut: fan,
    })

    const fireInput: PreMeetingBriefFireInput = {
      event: {
        id: 'evt-9',
        calendar_id: 'primary',
        title: 'Roadmap review with Dana',
        start: '2026-06-10T17:00:00Z',
        end: '2026-06-10T17:30:00Z',
        status: 'confirmed',
        description: 'Discuss Q3 with Dana Wu.',
        attendees: ['dana@x.com'],
      },
      project_id: 'general',
      fired_at: Date.now(),
    }
    await deps.fire(fireInput)

    expect(cacheForCalls).toBeGreaterThanOrEqual(1) // existing brief path ran
    expect(calls.length).toBe(1)
    expect(calls[0]![0]).toBe('calendar')
    expect(calls[0]![1]).toBe(
      composeCalendarPayload({
        title: 'Roadmap review with Dana',
        attendees: ['dana@x.com'],
        description: 'Discuss Q3 with Dana Wu.',
      }),
    )
    expect(calls[0]![2]).toBe('gcal:evt-9')
  })

  test('no scribeFanOut → fire still completes (no throw, no fan-out)', async () => {
    const deps = buildCalendarPreMeetingBriefSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => null as never,
      enumerateProjects: async () => [],
      pushDispatcher: null,
      queueStore: {} as never,
      llm: async () => {
        throw new Error('no llm')
      },
    })
    await deps.fire({
      event: {
        id: 'e1',
        calendar_id: 'primary',
        title: 't',
        start: '2026-06-10T17:00:00Z',
        end: '2026-06-10T17:30:00Z',
        status: 'confirmed',
      },
      project_id: 'general',
      fired_at: Date.now(),
    })
  })
})

describe('email-managed-wiring fire decoration', () => {
  const inbox: GmailMessageMeta[] = [
    {
      id: 'm1',
      thread_id: 'th1',
      subject: 'Deal with Northwind',
      from: '"Tomas" <tomas@northwind.io>',
      snippet: 'about the logistics deal',
      internal_date: '2026-06-07T08:00:00Z',
      label_ids: ['INBOX'],
    },
    {
      id: 'm2',
      thread_id: 'th2',
      subject: 'Lunch?',
      from: 'pal@x.com',
      snippet: 'free friday?',
      internal_date: '2026-06-07T07:00:00Z',
      label_ids: ['INBOX'],
    },
  ]

  const triage = {
    items: [
      { message_id: 'm1', thread_id: 'th1', from: 'tomas@northwind.io', subject: 'Deal with Northwind', reason: 'biz', rank: 1 },
    ],
    prompt_hash: 'h',
    model: 'haiku',
    outcome: 'ok' as const,
  }

  test('fans EACH already-fetched inbox message into scribe (email / composed payload / email: source)', async () => {
    const { fan, calls } = recorder()
    const deps = buildEmailTriageSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => ({}) as never,
      targetProjectId: async () => 'general',
      llm: async () => '[]',
      model: 'haiku',
      pushDispatcher: null,
      scribeFanOut: fan,
    })
    const res = await deps.fire({ triage, project_id: 'general', inbox })
    expect(res.chat_message_id).toBeNull() // null push dispatcher
    expect(calls.length).toBe(2)
    expect(calls.map((c) => c[0])).toEqual(['email', 'email'])
    expect(calls[0]![1]).toBe(composeEmailPayload(inbox[0]!))
    expect(calls[0]![2]).toBe('email:m1')
    expect(calls[1]![2]).toBe('email:m2')
  })

  test('no scribeFanOut → fire still posts/returns (no fan-out)', async () => {
    const deps = buildEmailTriageSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => ({}) as never,
      targetProjectId: async () => 'general',
      llm: async () => '[]',
      model: 'haiku',
      pushDispatcher: null,
    })
    const res = await deps.fire({ triage, project_id: 'general', inbox })
    expect(res.chat_message_id).toBeNull()
  })

  test('renderTriageText lists ranked items, or a friendly empty line', () => {
    expect(renderTriageText(triage)).toContain('1. Deal with Northwind')
    expect(renderTriageText({ ...triage, items: [] })).toContain('No notable emails')
  })
})

describe('email-managed-wiring — project timezone (Argus r1 IMPORTANT)', () => {
  test('threads the provided userTz into the scheduler opts', () => {
    const deps = buildEmailTriageSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => ({}) as never,
      targetProjectId: async () => 'general',
      llm: async () => '[]',
      model: 'haiku',
      userTz: 'America/New_York',
      pushDispatcher: null,
    })
    expect(deps.userTz).toBe('America/New_York')
  })

  test('falls back to America/Los_Angeles when userTz is omitted', () => {
    const deps = buildEmailTriageSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => ({}) as never,
      targetProjectId: async () => 'general',
      llm: async () => '[]',
      model: 'haiku',
      pushDispatcher: null,
    })
    expect(deps.userTz).toBe('America/Los_Angeles')
  })
})

describe('email-managed-wiring — cross-day scribe watermark (Argus r1 IMPORTANT)', () => {
  const inbox: GmailMessageMeta[] = [
    {
      id: 'm1',
      thread_id: 'th1',
      subject: 'Deal with Northwind',
      from: '"Tomas" <tomas@northwind.io>',
      snippet: 'about the logistics deal',
      internal_date: '2026-06-07T08:00:00Z',
      label_ids: ['INBOX'],
    },
    {
      id: 'm2',
      thread_id: 'th2',
      subject: 'Lunch?',
      from: 'pal@x.com',
      snippet: 'free friday?',
      internal_date: '2026-06-07T07:00:00Z',
      label_ids: ['INBOX'],
    },
  ]
  const triage = {
    items: [],
    prompt_hash: 'h',
    model: 'haiku',
    outcome: 'ok' as const,
  }

  test('a persistent inbox is fanned exactly once across daily fires', async () => {
    const { fan, calls } = recorder()
    const watermark = memWatermark()
    const make = (): ReturnType<typeof buildEmailTriageSchedulerDeps> =>
      buildEmailTriageSchedulerDeps({
        project_slug: 'acme',
        client: {} as never,
        cacheFor: async () => ({}) as never,
        targetProjectId: async () => 'general',
        llm: async () => '[]',
        model: 'haiku',
        pushDispatcher: null,
        scribeFanOut: fan,
        scribeWatermark: watermark,
      })

    // Day 1 — both messages are new → fanned.
    await make().fire({ triage, project_id: 'general', inbox })
    expect(calls.length).toBe(2)

    // Day 2 — same lookback returns the same mail → NOTHING re-fanned.
    await make().fire({ triage, project_id: 'general', inbox })
    expect(calls.length).toBe(2)

    // Day 3 — one genuinely newer message arrives → only it is fanned.
    const m3: GmailMessageMeta = {
      id: 'm3',
      thread_id: 'th3',
      subject: 'Contract signed',
      from: 'legal@northwind.io',
      snippet: 'all set',
      internal_date: '2026-06-08T09:00:00Z',
      label_ids: ['INBOX'],
    }
    await make().fire({ triage, project_id: 'general', inbox: [m3, ...inbox] })
    expect(calls.length).toBe(3)
    expect(calls[2]![2]).toBe('email:m3')
  })

  test('without a watermark the whole window re-fans every fire (back-compat)', async () => {
    const { fan, calls } = recorder()
    const deps = buildEmailTriageSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => ({}) as never,
      targetProjectId: async () => 'general',
      llm: async () => '[]',
      model: 'haiku',
      pushDispatcher: null,
      scribeFanOut: fan,
    })
    await deps.fire({ triage, project_id: 'general', inbox })
    await deps.fire({ triage, project_id: 'general', inbox })
    expect(calls.length).toBe(4) // 2 messages × 2 fires
  })

  test('fileScribeEmailWatermark round-trips through disk + reads 0 when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scribe-wm-'))
    const path = join(dir, '.scribe-email-watermark.json')
    const store = fileScribeEmailWatermark(path)
    expect(await store.get()).toBe(0) // missing file → 0
    await store.set(1717747200000)
    expect(await store.get()).toBe(1717747200000)
    const raw = JSON.parse(await readFile(path, 'utf8')) as { watermark_ms: number }
    expect(raw.watermark_ms).toBe(1717747200000)
  })
})
