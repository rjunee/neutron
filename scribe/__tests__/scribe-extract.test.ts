/**
 * scribe extract tests:
 *   - JSON parse robustness (direct / fenced / preamble / garbage / filters)
 *   - extraction dispatches through the CC-spawn SUBSTRATE, never a direct
 *     `fetch` to api.anthropic.com
 *   - watchdog aborts a hanging extract and releases the budget as a failure
 *   - budget cap blocks extraction (`reason: 'budget'`)
 *   - too-short / command turns are filtered before any dispatch
 */

import { describe, test, expect, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { parseExtraction, runExtraction } from '../extract.ts'
import { createScribe } from '../index.ts'
import { createState, DAILY_CAP } from '../scribe-budget.ts'
import type { WriteEntityFn } from '../write-to-gbrain.ts'

const t0 = Date.now()
const LONG = 'x'.repeat(120) // clears SCRIBE_MIN_CHARS

function tmpStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'scribe-ex-')), '.scribe-budget.json')
}

/** A substrate that yields `text` then completes. Records the spec it was handed. */
function completingSubstrate(
  text: string,
  onStart?: (spec: unknown) => void,
): Substrate {
  return {
    start(spec): SessionHandle {
      onStart?.(spec)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text }
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

/** A substrate that hangs until `cancel()` is called (watchdog path). */
function hangingSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      let releaseGate!: () => void
      const gate = new Promise<void>((r) => {
        releaseGate = r
      })
      async function* gen(): AsyncGenerator<Event> {
        await gate // hang; cancel() releases this, generator then returns
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('no tools')
        },
        async cancel(): Promise<void> {
          releaseGate()
        },
        tool_resolution: 'internal',
      }
    },
  }
}

const noopSyncHook: SyncHook = { async onEntityWrite(): Promise<void> {} }
const recordingWriteEntity: WriteEntityFn = async (input) => ({
  path: `/x/${input.slug}.md`,
  changed: true,
  newLinks: [],
})

describe('parseExtraction', () => {
  test('parses a direct JSON object', () => {
    const out = parseExtraction(
      '{"entities":[{"name":"Ada","kind":"person","fact":"founder"}],"relations":[]}',
    )
    expect(out.entities).toEqual([{ name: 'Ada', kind: 'person', fact: 'founder' }])
  })

  test('strips a markdown code fence', () => {
    const out = parseExtraction('```json\n{"entities":[{"name":"Acme","kind":"company"}]}\n```')
    expect(out.entities).toEqual([{ name: 'Acme', kind: 'company' }])
  })

  test('recovers an object after preamble prose', () => {
    const out = parseExtraction('Here you go: {"entities":[{"name":"X","kind":"concept"}]} done')
    expect(out.entities[0]?.name).toBe('X')
  })

  test('garbage → empty extraction', () => {
    expect(parseExtraction('not json at all')).toEqual({ entities: [], relations: [] })
    expect(parseExtraction('')).toEqual({ entities: [], relations: [] })
  })

  test('filters invalid kinds + predicates', () => {
    const out = parseExtraction(
      JSON.stringify({
        entities: [
          { name: 'Good', kind: 'person' },
          { name: 'Bad', kind: 'alien' },
          { name: '', kind: 'person' },
        ],
        relations: [
          { subject: 'Good', predicate: 'works_at', object: 'Acme' },
          { subject: 'Good', predicate: 'enslaves', object: 'Acme' },
          { subject: 'Good', predicate: 'met', object: '' },
        ],
      }),
    )
    expect(out.entities).toEqual([{ name: 'Good', kind: 'person' }])
    expect(out.relations).toEqual([{ subject: 'Good', predicate: 'works_at', object: 'Acme' }])
  })
})

describe('runExtraction — substrate routing', () => {
  test('dispatches through substrate.start and NEVER calls fetch (no direct API)', async () => {
    let startedSpec: { prompt?: string; model_preference?: string[] } | undefined
    const substrate = completingSubstrate(
      '{"entities":[{"name":"Ada Lovelace","kind":"person","fact":"founder"}],"relations":[]}',
      (spec) => {
        startedSpec = spec as { prompt?: string; model_preference?: string[] }
      },
    )

    const originalFetch = globalThis.fetch
    const fetchSpy = mock(() => {
      throw new Error('scribe must NOT call fetch directly — CC-spawn substrate only')
    })
    // @ts-expect-error override for the assertion window
    globalThis.fetch = fetchSpy
    try {
      const out = await runExtraction({ substrate }, LONG)
      expect(out.entities[0]?.name).toBe('Ada Lovelace')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(startedSpec?.prompt).toContain('scribe')
    // Default model preference is Opus (BEST_MODEL) — non-empty.
    expect((startedSpec?.model_preference ?? []).length).toBeGreaterThan(0)
  })
})

describe('createScribe.extractAndWrite — budget + watchdog', () => {
  test('budget cap blocks extraction (reason: budget)', async () => {
    const budget = createState(tmpStatePath(), t0)
    budget.daily.total = DAILY_CAP // exhausted
    const scribe = createScribe({
      substrate: completingSubstrate('{"entities":[],"relations":[]}'),
      syncHook: noopSyncHook,
      ownerDataDir: '/tmp/x',
      owner_slug: 'acme',
      budget,
      writeEntity: recordingWriteEntity,
      now: () => t0,
    })
    const out = await scribe.extractAndWrite({ text: LONG })
    expect(out).toEqual({ ran: false, reason: 'budget' })
  })

  test('too-short + command turns are filtered before dispatch', async () => {
    let startCount = 0
    const substrate: Substrate = {
      start: (spec) => {
        startCount++
        return completingSubstrate('{"entities":[],"relations":[]}').start(spec)
      },
    }
    const scribe = createScribe({
      substrate,
      syncHook: noopSyncHook,
      ownerDataDir: '/tmp/x',
      owner_slug: 'acme',
      budget: createState(tmpStatePath(), t0),
      writeEntity: recordingWriteEntity,
      now: () => t0,
    })
    expect(await scribe.extractAndWrite({ text: 'hi' })).toEqual({ ran: false, reason: 'filtered' })
    expect(await scribe.extractAndWrite({ text: '/help me with this very long command line here' })).toEqual(
      { ran: false, reason: 'filtered' },
    )
    expect(startCount).toBe(0)
  })

  test('watchdog aborts a hanging extract and releases the budget as a failure', async () => {
    const budget = createState(tmpStatePath(), t0)
    const scribe = createScribe({
      substrate: hangingSubstrate(),
      syncHook: noopSyncHook,
      ownerDataDir: '/tmp/x',
      owner_slug: 'acme',
      budget,
      writeEntity: recordingWriteEntity,
      watchdog_ms: 25,
      now: () => t0,
    })
    const out = await scribe.extractAndWrite({ text: LONG })
    expect(out).toEqual({ ran: false, reason: 'error' })
    // Budget slot released; failure recorded.
    expect(budget.inflight).toBe(0)
    expect(budget.daily.failures).toBe(1)
  })
})
