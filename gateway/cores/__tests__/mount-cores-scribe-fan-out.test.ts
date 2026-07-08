/**
 * Gap #1 wiring test — the Cores→scribe phase-2 fan-out is LIVE, not test-only.
 *
 * This is the "built but never wired" trap guard: it does NOT exercise
 * `scribeFanOut` in isolation. It threads the REAL composer-owned binding
 * (`buildScribeCoresFanOut` → `scribe.extractFromCoresSource`) through the SAME
 * production factories the Open composer/mount use
 * (`buildEmailTriageSchedulerDeps` / `buildCalendarPreMeetingBriefSchedulerDeps`
 * and `mountCoresScribeFanOut`) and asserts that firing a Core actually drives an
 * extraction whose entities REACH THE WRITER. If the binding were ever
 * disconnected from the factories, these tests fail.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GmailClient, GmailMessageMeta } from '@neutronai/email-managed-core'
import type { PreMeetingBriefFireInput } from '@neutronai/calendar-core'

import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { createScribe, type Scribe, type WriteEntityFn } from '@neutronai/scribe/index.ts'
import { createState } from '@neutronai/scribe/scribe-budget.ts'
import { buildCalendarPreMeetingBriefSchedulerDeps } from '../calendar-wiring.ts'
import { buildEmailTriageSchedulerDeps } from '../email-managed-wiring.ts'
import {
  buildScribeCoresFanOut,
  enumerateOwnerProjects,
  mountCoresScribeFanOut,
} from '../mount-cores-scribe-fan-out.ts'

const t0 = Date.parse('2026-06-15T08:00:00.000Z')

/** A substrate whose single completion yields a canned extraction JSON. */
function cannedSubstrate(json: string): Substrate {
  return {
    start(): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: json }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'fake',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('no tools')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

const noopSyncHook: SyncHook = { async onEntityWrite(): Promise<void> {} }

/** Build a real scribe with a canned extractor + a writeEntity recorder. */
function makeScribe(
  extraction: Record<string, unknown>,
  owner_home: string,
): { scribe: Scribe; written: string[] } {
  const written: string[] = []
  const writeEntity: WriteEntityFn = async (input) => {
    written.push(`${input.kind}:${input.slug}`)
    return { path: `${owner_home}/entities/${input.slug}.md`, changed: true, newLinks: [] }
  }
  const scribe = createScribe({
    substrate: cannedSubstrate(JSON.stringify(extraction)),
    syncHook: noopSyncHook,
    ownerDataDir: owner_home,
    project_slug: 'acme',
    budget: createState(join(owner_home, '.scribe-budget.json'), t0),
    writeEntity,
    now: () => t0,
  })
  return { scribe, written }
}

const tmpdirs: string[] = []
function freshHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpdirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpdirs.length > 0) {
    const d = tmpdirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

describe('buildScribeCoresFanOut — the composer-owned binding', () => {
  test('fanOut delegates to scribe.extractFromCoresSource and idle() drains it', async () => {
    const home = freshHome('fanout-bind-')
    const { scribe, written } = makeScribe(
      { entities: [{ name: 'Priya Rao', kind: 'person', fact: 'Head of Design at Lumio' }], relations: [] },
      home,
    )
    const binding = buildScribeCoresFanOut(scribe)
    binding.fanOut(
      'calendar',
      'Design sync with Priya Rao, Head of Design at Lumio — discuss the Q3 roadmap and hiring plan in detail.',
      'gcal:evt-1',
    )
    expect(written.length).toBe(0) // fire-and-forget — not awaited yet
    await binding.idle()
    expect(written).toContain('person:priya-rao')
  })

  test('a throwing extractor never escapes the void fanOut (idle resolves)', async () => {
    const scribe = {
      extractFromCoresSource: async (): Promise<never> => {
        throw new Error('boom')
      },
    }
    const logs: string[] = []
    const binding = buildScribeCoresFanOut(scribe, (msg) => logs.push(msg))
    expect(() => binding.fanOut('email', 'x'.repeat(90), 'email:1')).not.toThrow()
    await binding.idle()
    expect(logs.some((l) => l.includes('fan-out'))).toBe(true)
  })
})

describe('the binding threaded through the REAL Core factories reaches the writer', () => {
  test('email: buildEmailTriageSchedulerDeps.fire fans each inbox msg → scribe → writeEntity', async () => {
    const home = freshHome('fanout-email-')
    const { scribe, written } = makeScribe(
      { entities: [{ name: 'Northwind', kind: 'company', fact: 'a logistics partner' }], relations: [] },
      home,
    )
    const binding = buildScribeCoresFanOut(scribe)
    const deps = buildEmailTriageSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => ({}) as never,
      targetProjectId: async () => 'general',
      llm: async () => '[]',
      model: 'haiku',
      pushDispatcher: null,
      scribeFanOut: binding.fanOut, // ← the REAL composer binding, not a recorder
    })
    const inbox: GmailMessageMeta[] = [
      {
        id: 'm1',
        thread_id: 'th1',
        subject: 'Logistics deal with Northwind',
        from: '"Tomas" <tomas@northwind.io>',
        snippet: 'Following up on the Q3 logistics partnership — terms, volumes, and the rollout timeline.',
        internal_date: '2026-06-14T08:00:00Z',
        label_ids: ['INBOX'],
      },
    ]
    await deps.fire({
      triage: { items: [], prompt_hash: 'h', model: 'haiku', outcome: 'ok' as const },
      project_id: 'general',
      inbox,
    })
    await binding.idle()
    expect(written).toContain('company:northwind')
  })

  test('calendar: buildCalendarPreMeetingBriefSchedulerDeps.fire fans the event → scribe → writeEntity', async () => {
    const home = freshHome('fanout-cal-')
    const { scribe, written } = makeScribe(
      { entities: [{ name: 'Dana Wu', kind: 'person', fact: 'leads the roadmap review' }], relations: [] },
      home,
    )
    const binding = buildScribeCoresFanOut(scribe)
    const deps = buildCalendarPreMeetingBriefSchedulerDeps({
      project_slug: 'acme',
      client: {} as never,
      cacheFor: async () => null as never,
      enumerateProjects: async () => [],
      pushDispatcher: null,
      queueStore: {} as never,
      llm: async () => {
        throw new Error('no llm — brief falls back to llm_error')
      },
      scribeFanOut: binding.fanOut, // ← the REAL composer binding
    })
    const fireInput: PreMeetingBriefFireInput = {
      event: {
        id: 'evt-9',
        calendar_id: 'primary',
        title: 'Roadmap review with Dana Wu',
        start: '2026-06-15T17:00:00Z',
        end: '2026-06-15T17:30:00Z',
        status: 'confirmed',
        description: 'Discuss Q3 roadmap, staffing, and the launch checklist with Dana Wu in depth.',
        attendees: ['dana@x.com'],
      },
      project_id: 'general',
      fired_at: t0,
    }
    await deps.fire(fireInput)
    await binding.idle()
    expect(written).toContain('person:dana-wu')
  })
})

describe('mountCoresScribeFanOut — live on the Open boot path', () => {
  test('enumerateOwnerProjects lists Projects/ dirs (empty when absent)', () => {
    const home = freshHome('fanout-enum-')
    expect(enumerateOwnerProjects(home)).toEqual([])
    mkdirSync(join(home, 'Projects', 'general'), { recursive: true })
    mkdirSync(join(home, 'Projects', 'work'), { recursive: true })
    expect(enumerateOwnerProjects(home).sort()).toEqual(['general', 'work'])
  })

  test('mount starts both schedulers; an email tick fans the inbox into scribe→writer; stop() drains + tears down', async () => {
    const home = freshHome('fanout-mount-')
    mkdirSync(join(home, 'Projects', 'general'), { recursive: true })
    const { scribe, written } = makeScribe(
      { entities: [{ name: 'Acme Logistics', kind: 'company', fact: 'inbound partnership lead' }], relations: [] },
      home,
    )
    const inboxMsg: GmailMessageMeta = {
      id: 'mm1',
      thread_id: 'tt1',
      subject: 'Partnership with Acme Logistics',
      from: '"Lee" <lee@acme.io>',
      snippet: 'Proposing an inbound logistics partnership — pricing tiers, SLAs, and an onboarding timeline to review.',
      internal_date: '2026-06-14T09:00:00Z',
      label_ids: ['INBOX'],
    }
    // Minimal Gmail client — the tick only calls listMessages.
    const gmailClient = {
      listMessages: async () => ({ results: [inboxMsg] }),
    } as unknown as GmailClient

    const mounted = mountCoresScribeFanOut({
      scribe,
      project_slug: 'acme',
      owner_home: home,
      gmailClient,
      emailLlm: async () => '[]',
      emailModel: 'haiku',
      userTz: 'UTC',
      nowMs: () => t0, // 08:00:00Z → the daily fire window in UTC
    })
    try {
      expect(mounted.emailScheduler).toBeDefined()
      expect(mounted.calendarScheduler).toBeDefined()
      // Drive a tick at the fire window (idempotent w/ the start() immediate tick).
      await mounted.emailScheduler.tick(new Date(t0))
      await mounted.idle()
      expect(written).toContain('company:acme-logistics')
    } finally {
      await mounted.stop()
    }
  })
})
