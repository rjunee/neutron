/**
 * Scribe phase-2 — Cores-source extract path (`extractFromCoresSource`).
 *
 * Covers the phase-2 surface:
 *   1. Cores-data → extract → REAL GBrain (page + typed edge + source pointer
 *      in the timeline). (The old content-sync foreign-origin quarantine
 *      pre-filter was removed with the Connect mesh, connect-spec §2.1.)
 *   2. No duplicate poller (static): the phase-2 wiring + payload code registers
 *      no `setInterval`/`setTimeout` and makes no `fetch`/`gog`/D1 call.
 *   3. Budget — per-trigger counters increment; an over-`MAX_INFLIGHT` Cores
 *      event is dropped clean (`{ran:false, reason:'budget'}`), not queued.
 *   + payload composition (calendar / email shapes).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { McpClient } from '@neutronai/gbrain-memory/mcp-client.ts'
import { GBrainMemoryStore } from '@neutronai/gbrain-memory/gbrain-memory-store.ts'
import { GBrainSyncHook } from '@neutronai/gbrain-memory/GBrainSyncHook.ts'
import { writeEntity } from '@neutronai/runtime/entity-writer.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { MAX_INFLIGHT, createState, snapshot } from '../scribe-budget.ts'
import {
  createScribe,
  composeCalendarPayload,
  composeEmailPayload,
  type WriteEntityFn,
} from '../index.ts'
import { bootPgliteBrain } from '@neutronai/gbrain-memory/__tests__/boot-pglite-brain.ts'

const t0 = Date.now()
const PROJECT = 'acme-project'

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

function edgesTo(links: unknown, object: string, predicate: string): unknown[] {
  const rows = Array.isArray(links) ? links : []
  return rows.filter((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    return o['to_slug'] === object && o['link_type'] === predicate
  })
}

describe('scribe phase-2 — Cores-source extract (real GBrain round-trip)', () => {
  let engine: { disconnect(): Promise<void> }
  let client: McpClient

  beforeAll(async () => {
    // Serialised + retry-hardened real-PGLite boot (see boot-pglite-brain.ts).
    const { engine: eng, operations } = await bootPgliteBrain()
    engine = eng
    const ctx = {
      engine: eng,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    }
    client = {
      async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        const op = operations.find((o) => o.name === name)
        if (op === undefined) throw new Error(`no gbrain op: ${name}`)
        return op.handler(ctx, args)
      },
    }
  }, 60_000)

  afterAll(async () => {
    if (engine !== undefined) await engine.disconnect()
  }, 30_000)

  test('a CALENDAR event (own-origin) passes the guard and lands an entity + typed edge + source pointer', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-cal-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    const extraction = JSON.stringify({
      entities: [
        { name: 'Priya Rao', kind: 'person', fact: 'Head of Design at Lumio' },
        { name: 'Lumio', kind: 'company', fact: 'a design-tools startup' },
      ],
      relations: [{ subject: 'Priya Rao', predicate: 'works_at', object: 'Lumio' }],
    })
    const scribe = createScribe({
      substrate: cannedSubstrate(extraction),
      syncHook,
      ownerDataDir,
      project_slug: PROJECT,
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0,
    })

    const payload = composeCalendarPayload({
      title: 'Design sync with Priya',
      attendees: ['priya@lumio.com'],
      description: 'Talk to Priya Rao, Head of Design at Lumio.',
    })
    const out = await scribe.extractFromCoresSource({
      trigger: 'calendar',
      text: payload,
      source: 'gcal:evt-123',
      observed_at: t0,
    })
    expect(out.ran).toBe(true)
    if (!out.ran) throw new Error('unreachable')
    expect(out.report.pages_written).toBe(2)

    const priya = (await client.call('get_page', { slug: 'priya-rao' })) as Record<
      string,
      unknown
    > | null
    expect(priya).not.toBeNull()
    const links = await client.call('get_links', { slug: 'priya-rao' })
    expect(edgesTo(links, 'lumio', 'works_at').length).toBe(1)

    // The Cores source provenance pointer flowed into the on-disk timeline.
    const onDisk = readFileSync(
      resolve(ownerDataDir, 'entities', 'people', 'priya-rao.md'),
      'utf8',
    )
    expect(onDisk).toContain('gcal:evt-123')
  }, 60_000)

  test('an EMAIL message (own-origin) passes the guard and lands an entity + edge', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-email-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    const extraction = JSON.stringify({
      entities: [
        { name: 'Tomas Berg', kind: 'person', fact: 'founder of Northwind' },
        { name: 'Northwind', kind: 'company', fact: 'logistics startup' },
      ],
      relations: [{ subject: 'Tomas Berg', predicate: 'founded', object: 'Northwind' }],
    })
    const scribe = createScribe({
      substrate: cannedSubstrate(extraction),
      syncHook,
      ownerDataDir,
      project_slug: PROJECT,
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0,
    })
    const payload = composeEmailPayload({
      subject: 'Intro to Northwind',
      from: '"Tomas Berg" <tomas@northwind.io>',
      snippet: 'Hi — I founded Northwind, a logistics startup…',
      body_text: 'Long body about Tomas Berg founding Northwind.',
    })
    const out = await scribe.extractFromCoresSource({
      trigger: 'email',
      text: payload,
      source: 'email:msg-77',
      observed_at: t0,
    })
    expect(out.ran).toBe(true)
    if (!out.ran) throw new Error('unreachable')
    const links = await client.call('get_links', { slug: 'tomas-berg' })
    expect(edgesTo(links, 'northwind', 'founded').length).toBe(1)
  }, 60_000)

})

describe('scribe phase-2 — budget governance over Cores sources', () => {
  function lightScribe(
    ownerDataDir: string,
    budget: ReturnType<typeof createState>,
    onWrite?: () => void,
  ): ReturnType<typeof createScribe> {
    const recordingWrite: WriteEntityFn = async () => {
      onWrite?.()
      return { path: 'x', changed: true, newLinks: [] }
    }
    const noopHook: SyncHook = { async onEntityWrite() {} }
    return createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({ entities: [{ name: 'X Corp', kind: 'company' }], relations: [] }),
      ),
      syncHook: noopHook,
      ownerDataDir,
      project_slug: PROJECT,
      budget,
      writeEntity: recordingWrite,
      now: () => t0,
    })
  }

  test('byTrigger.calendar / byTrigger.email increment on Cores-source extracts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scribe-budget-'))
    const budget = createState(join(dir, '.scribe-budget.json'), t0)
    const scribe = lightScribe(dir, budget)
    const text = composeEmailPayload({
      subject: 'A long enough subject to clear the min-chars filter for scribe',
      from: 'x@y.com',
      snippet: 'and a snippet that adds more body so the extract actually runs here',
    })
    await scribe.extractFromCoresSource({ trigger: 'calendar', text, source: 'gcal:1', observed_at: t0 })
    await scribe.extractFromCoresSource({ trigger: 'email', text, source: 'email:1', observed_at: t0 })
    const snap = snapshot(budget, t0)
    expect(snap.daily.byTrigger.calendar).toBe(1)
    expect(snap.daily.byTrigger.email).toBe(1)
  })

  test('an over-MAX_INFLIGHT Cores event is dropped CLEAN (reason:budget), not queued', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scribe-budget2-'))
    const budget = createState(join(dir, '.scribe-budget.json'), t0)
    // Saturate the inflight cap so tryAcquire rejects (inflight_cap → budget).
    budget.inflight = MAX_INFLIGHT
    let wrote = 0
    const scribe = lightScribe(dir, budget, () => {
      wrote += 1
    })
    const out = await scribe.extractFromCoresSource({
      trigger: 'calendar',
      text: composeCalendarPayload({
        title: 'A meeting with a sufficiently long title to clear the min-chars gate',
        description: 'plus a description body that adds enough characters to extract',
      }),
      source: 'gcal:over',
      observed_at: t0,
    })
    expect(out.ran).toBe(false)
    if (out.ran) throw new Error('unreachable')
    expect(out.reason).toBe('budget')
    expect(wrote).toBe(0) // dropped clean — never wrote
  })
})

describe('scribe phase-2 — payload composition', () => {
  test('calendar payload = title / attendees / blank / description', () => {
    expect(
      composeCalendarPayload({
        title: 'Sync',
        attendees: ['a@x.com', 'b@x.com'],
        description: 'agenda here',
      }),
    ).toBe('Sync\nattendees: a@x.com, b@x.com\n\nagenda here')
    // newlines in the title are flattened; missing fields degrade gracefully
    expect(composeCalendarPayload({ title: 'a\nb' })).toBe('a b\nattendees: \n\n')
  })

  test('email payload = subject | from / snippet / body (no category field)', () => {
    expect(
      composeEmailPayload({
        subject: 'Hello',
        from: '"A" <a@x.com>',
        snippet: 'snip',
        body_text: 'body',
      }),
    ).toBe('Hello | "A" <a@x.com>\nsnip\nbody')
    // body absent (list metadata only) → empty third segment, no second fetch
    expect(composeEmailPayload({ subject: 'H', from: 'a@x.com', snippet: 's' })).toBe(
      'H | a@x.com\ns\n',
    )
  })
})

describe('scribe phase-2 — no duplicate poller (static)', () => {
  const PHASE2_FILES = [
    'scribe/compose-payload.ts',
    'gateway/cores/email-managed-wiring.ts',
    'gateway/cores/scribe-fan-out.ts',
  ]
  // Repo root is two levels up from scribe/__tests__/.
  const root = resolve(import.meta.dir, '..', '..')

  for (const rel of PHASE2_FILES) {
    test(`${rel} introduces no timer / fetch / gog / D1`, () => {
      const src = readFileSync(resolve(root, rel), 'utf8')
      expect(src).not.toMatch(/setInterval/)
      expect(src).not.toMatch(/setTimeout/)
      expect(src).not.toMatch(/\bfetch\s*\(/)
      expect(src).not.toMatch(/api\.anthropic\.com/)
      expect(src).not.toMatch(/\bgog\b/)
      expect(src).not.toMatch(/cloudflare|d1\.prepare|D1Database/)
    })
  }

  test('the calendar fire decoration adds no timer (cadence stays the Core scheduler)', () => {
    const src = readFileSync(resolve(root, 'gateway/cores/calendar-wiring.ts'), 'utf8')
    expect(src).not.toMatch(/setInterval/)
    expect(src).not.toMatch(/setTimeout/)
    // it DOES call the scribe fan-out (the only net-new behaviour)
    expect(src).toMatch(/scribeFanOut\?\.\(\s*'calendar'/)
  })
})
