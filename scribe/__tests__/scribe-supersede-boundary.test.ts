/**
 * RB4 extraction-BOUNDARY tests (deterministic, no PGLite).
 *
 * The real-PGLite round-trip (`scribe-temporal-invalidation.test.ts`) drives the
 * write/graph half with a fake substrate that INJECTS `supersedes` directly — so
 * on its own it would still pass if the extraction boundary silently stopped
 * asking the model for the marker. These tests pin that boundary (Codex RB4 r7):
 *
 *   1. `composeExtractionPrompt` — flag OFF is byte-identical to the legacy
 *      prompt; flag ON splices in `SUPERSEDE_GUIDANCE`.
 *   2. `parseExtraction` — the optional `supersedes` marker is preserved when
 *      present and omitted when absent/blank.
 *   3. `createScribe` PROPAGATION — a `supersede: true` scribe dispatches an
 *      extraction prompt containing the guidance (and `false` does not), proving
 *      the flag threads `createScribe → runExtraction → composeExtractionPrompt`.
 *   4. env WIRING — `isPerfectRecallEnabled` (the exact value
 *      `open/wiring/memory.ts` feeds into `createScribe`'s `supersede`) maps the
 *      shared `NEUTRON_PERFECT_RECALL` token.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { isPerfectRecallEnabled } from '@neutronai/runtime/perfect-recall-flag.ts'
import {
  composeExtractionPrompt,
  parseExtraction,
  SCRIBE_EXTRACTION_PROMPT,
  SUPERSEDE_GUIDANCE,
} from '../extract.ts'
import { createScribe } from '../index.ts'
import { createState } from '../scribe-budget.ts'
import type { WriteEntityFn } from '../write-to-gbrain.ts'

const t0 = Date.parse('2026-07-15T00:00:00.000Z')

describe('RB4 extraction boundary — prompt guidance', () => {
  test('flag OFF is byte-identical to the legacy prompt (no supersede guidance)', () => {
    const text = 'Alice moved to NewCo.'
    const legacy = `${SCRIBE_EXTRACTION_PROMPT}${text}\n`
    expect(composeExtractionPrompt(text)).toBe(legacy)
    expect(composeExtractionPrompt(text, { supersede: false })).toBe(legacy)
    expect(composeExtractionPrompt(text)).not.toContain(SUPERSEDE_GUIDANCE)
  })

  test('flag ON splices the supersede guidance in before the message', () => {
    const text = 'Alice moved to NewCo.'
    const prompt = composeExtractionPrompt(text, { supersede: true })
    expect(prompt).toContain(SUPERSEDE_GUIDANCE)
    expect(prompt).toContain('"supersedes"') // the guidance teaches the marker
    // The turn text still trails the prompt (guidance is spliced ABOVE MESSAGE:).
    expect(prompt.endsWith(`${text}\n`)).toBe(true)
    expect(prompt.indexOf(SUPERSEDE_GUIDANCE)).toBeLessThan(prompt.indexOf('MESSAGE:'))
  })
})

describe('RB4 extraction boundary — parse preserves the supersedes marker', () => {
  test('supersedes is preserved when present, omitted when absent/blank', () => {
    const parsed = parseExtraction(
      JSON.stringify({
        entities: [],
        relations: [
          { subject: 'Alice', predicate: 'works_at', object: 'NewCo', supersedes: 'OldCo' },
          { subject: 'Bob', predicate: 'works_at', object: 'Acme' }, // no marker
          { subject: 'Cara', predicate: 'works_at', object: 'Foo', supersedes: '   ' }, // blank
        ],
      }),
    )
    expect(parsed.relations[0]!.supersedes).toBe('OldCo')
    expect(parsed.relations[1]!.supersedes).toBeUndefined()
    expect(parsed.relations[2]!.supersedes).toBeUndefined() // blank trimmed → dropped
  })
})

/** A substrate that RECORDS every dispatched AgentSpec (so we can inspect the
 *  extraction prompt) then returns an empty extraction. */
function recordingSubstrate(specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: '{"entities":[],"relations":[]}' }
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

const noopWriteEntity: WriteEntityFn = async (i) => ({
  path: `/x/${i.slug}.md`,
  changed: false,
  newLinks: [],
})

describe('RB4 extraction boundary — createScribe propagates the supersede flag to the prompt', () => {
  const mkScribe = (supersede: boolean, specs: AgentSpec[]): ReturnType<typeof createScribe> =>
    createScribe({
      substrate: recordingSubstrate(specs),
      syncHook: { async onEntityWrite(): Promise<void> {} } as SyncHook,
      ownerDataDir: mkdtempSync(join(tmpdir(), 'scribe-sb-')),
      project_slug: 'acme',
      budget: createState(join(mkdtempSync(join(tmpdir(), 'scribe-sb-b-')), '.s.json'), t0),
      writeEntity: noopWriteEntity,
      now: () => t0,
      supersede,
    })

  const TURN =
    'Alice Ng just moved on from OldCo — she now works at NewCo, leading their infra team full time.'

  test('supersede ON → the dispatched extraction prompt carries the guidance', async () => {
    const specs: AgentSpec[] = []
    await mkScribe(true, specs).extractAndWrite({ text: TURN, observed_at: t0 })
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).toContain(SUPERSEDE_GUIDANCE)
  })

  test('supersede OFF → the dispatched extraction prompt is the legacy prompt', async () => {
    const specs: AgentSpec[] = []
    await mkScribe(false, specs).extractAndWrite({ text: TURN, observed_at: t0 })
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).not.toContain(SUPERSEDE_GUIDANCE)
    expect(specs[0]!.prompt).toBe(`${SCRIBE_EXTRACTION_PROMPT}${TURN}\n`)
  })
})

describe('RB4 extraction boundary — env wiring reaches createScribe.supersede', () => {
  test('isPerfectRecallEnabled (the value memory.ts feeds `supersede`) maps NEUTRON_PERFECT_RECALL', () => {
    // open/wiring/memory.ts wires `supersede: isPerfectRecallEnabled(env)`.
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: '1' })).toBe(true)
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: 'on' })).toBe(true)
    expect(isPerfectRecallEnabled({})).toBe(false)
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: 'off' })).toBe(false)
  })
})
