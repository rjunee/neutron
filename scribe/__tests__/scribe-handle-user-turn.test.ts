/**
 * K11b0 re-anchor — `scribe.handleUserTurn(...)` reaches `extractAndWrite`
 * end-to-end: the turn text is dispatched to the substrate with the scribe
 * extraction persona, the parsed extraction is fanned to the write path, and
 * each extracted entity is written with own-origin attribution + provenance.
 *
 * Previously asserted by `scribe-live-wiring.test.ts` test 4, which drove
 * scribe THROUGH the dead `buildWebChatBridge` `scribeOnUserTurn` hook (and only
 * checked `substrate.start` was called ONCE). That bridge surface was excised in
 * K11b0; the chat-time FIRING is now covered by
 * `open/__tests__/open-app-ws-scribe-wiring.test.ts`. This survivor pins the
 * scribe-internal CONTRACT directly (no bridge): it drives `handleUserTurn`
 * against a faithfully-faked, inspectable substrate + a recording `writeEntity`
 * and asserts the extracted/written CONTENT, not just the call count.
 *
 * NOTE on propagation: `handleUserTurn` forwards ONLY `text` / `observed_at` /
 * `author` into `extractAndWrite` (trigger is pinned to `'chat'`); the turn's
 * `user_id` / `topic_id` are intentionally NOT threaded — scribe is per-instance
 * and derives `source` / own-origin slug from its OWN configured `project_slug`.
 *
 * Mutation guards (each assertion below fails if propagation breaks):
 *   - stop forwarding the turn text → the substrate prompt no longer contains
 *     LONG_TURN.
 *   - stop running the write path → `writeEntity` records nothing.
 *   - drop the relation / fact / author / own-origin plumbing → the recorded
 *     writeEntity input no longer matches.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { createScribe, SCRIBE_EXTRACTION_PROMPT } from '../index.ts'
import { createState } from '../scribe-budget.ts'
import type { WriteEntityFn } from '../write-to-gbrain.ts'

const t0 = Date.parse('2026-07-06T00:00:00.000Z')
const LONG_TURN =
  'Had a productive sync with Dana Reeves at Northstar about the migration roadmap and budget.'
const AUTHOR = { id: 'u-1-author', display: 'Ryan' }

// A real extraction JSON — two entities + a typed relation — so the write path
// actually plans + writes pages (not the empty `{"entities":[],"relations":[]}`
// the old call-count test used).
const EXTRACTION_JSON = JSON.stringify({
  entities: [
    { name: 'Dana Reeves', kind: 'person', fact: 'Leads the migration roadmap at Northstar' },
    { name: 'Northstar', kind: 'company' },
  ],
  relations: [{ subject: 'Dana Reeves', predicate: 'works_at', object: 'Northstar' }],
})

interface RecordedWrite {
  kind: string
  slug: string
  name: string
  source: string
  timelineSource: string
  compiledTruth: string
  originInstance: string
  receivingInstanceSlug: string
}

/** Build a scribe wired to an inspectable substrate + recording writeEntity. */
function makeHarness(extractionJson: string): {
  scribe: ReturnType<typeof createScribe>
  specs: AgentSpec[]
  writes: Map<string, RecordedWrite>
} {
  const specs: AgentSpec[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: extractionJson }
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
  const noopSyncHook: SyncHook = { async onEntityWrite(): Promise<void> {} }
  const writes = new Map<string, RecordedWrite>()
  const recordingWriteEntity: WriteEntityFn = async (i) => {
    writes.set(i.slug, {
      kind: i.kind,
      slug: i.slug,
      name: String(i.body.frontmatter['name']),
      source: String(i.body.frontmatter['source']),
      timelineSource: i.body.timelineAppend.source,
      compiledTruth: i.body.compiledTruth,
      originInstance: i.originInstance,
      receivingInstanceSlug: i.receivingInstanceSlug,
    })
    // Report `changed` + one typed edge per wikilink so the write report is
    // deterministic and tied to the composed relation lines.
    const linkCount = (i.body.compiledTruth.match(/\[\[/g) ?? []).length
    return { path: `/x/${i.slug}.md`, changed: true, newLinks: new Array(linkCount).fill({}) }
  }

  const scribe = createScribe({
    substrate,
    syncHook: noopSyncHook,
    ownerDataDir: mkdtempSync(join(tmpdir(), 'scribe-wire-')),
    project_slug: 'acme',
    budget: createState(join(mkdtempSync(join(tmpdir(), 'scribe-wire-b-')), '.s.json'), t0),
    writeEntity: recordingWriteEntity,
    now: () => t0,
  })
  return { scribe, specs, writes }
}

describe('scribe.handleUserTurn — direct extract→substrate→write wiring', () => {
  test('drives the turn text into the substrate extraction prompt', async () => {
    const { scribe, specs } = makeHarness(EXTRACTION_JSON)

    // Call the scribe hook DIRECTLY (production shape is `(i) => scribe.handleUserTurn(i)`),
    // NOT through any chat surface. `handleUserTurn` is fire-and-forget/void.
    scribe.handleUserTurn({
      project_slug: 'acme',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      text: LONG_TURN,
      observed_at: t0,
      author: AUTHOR,
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(specs.length).toBe(1)
    const spec = specs[0]!
    // Prompt shape: the scribe extraction persona + the EXACT turn text
    // (composeExtractionPrompt embeds it). Breaking text propagation fails here.
    expect(spec.prompt).toContain(SCRIBE_EXTRACTION_PROMPT)
    expect(spec.prompt).toContain(LONG_TURN)
    // Extraction is a tool-less single call with a model preference set.
    expect(spec.tools).toEqual([])
    expect(spec.model_preference.length).toBeGreaterThanOrEqual(1)
  })

  test('fans the parsed extraction to writeEntity with content + own-origin provenance', async () => {
    const { scribe, writes } = makeHarness(EXTRACTION_JSON)

    scribe.handleUserTurn({
      project_slug: 'acme',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      text: LONG_TURN,
      observed_at: t0,
      author: AUTHOR,
    })
    await new Promise((r) => setTimeout(r, 30))

    // Both extracted entities were written, keyed by slug.
    expect([...writes.keys()].sort()).toEqual(['dana-reeves', 'northstar'])

    const dana = writes.get('dana-reeves')!
    expect(dana.kind).toBe('person')
    expect(dana.name).toBe('Dana Reeves')
    // The parsed FACT reached the composed page.
    expect(dana.compiledTruth).toContain('Leads the migration roadmap at Northstar')
    // The parsed RELATION rendered as a typed-edge wikilink (works_at → object slug).
    expect(dana.compiledTruth).toContain('Works at [[northstar]].')

    const northstar = writes.get('northstar')!
    expect(northstar.kind).toBe('company')
    expect(northstar.name).toBe('Northstar')

    // Provenance: source is `chat:<scribe project_slug>`; the author id folds
    // into the timeline provenance. Own-origin stamps both instance slugs to
    // the scribe's own slug (passes the write-boundary quarantine guard).
    for (const w of writes.values()) {
      expect(w.source).toBe('chat:acme')
      expect(w.timelineSource).toBe('chat:acme#author:u-1-author')
      expect(w.originInstance).toBe('acme')
      expect(w.receivingInstanceSlug).toBe('acme')
    }
  })

  test('extractAndWrite returns the parsed-result report end-to-end', async () => {
    const { scribe } = makeHarness(EXTRACTION_JSON)

    // Direct, awaitable entry — pins the ScribeOutcome the fire-and-forget hook
    // discards. Two pages written; one typed edge (Dana works_at Northstar).
    const outcome = await scribe.extractAndWrite({ text: LONG_TURN, observed_at: t0 })
    expect(outcome.ran).toBe(true)
    if (!outcome.ran) throw new Error('unreachable')
    expect(outcome.report.pages_written).toBe(2)
    expect(outcome.report.pages_skipped).toBe(0)
    expect(outcome.report.edges_emitted).toBe(1)
  })

  test('an empty extraction writes nothing (parser → write-path negative)', async () => {
    const { scribe, writes } = makeHarness(JSON.stringify({ entities: [], relations: [] }))

    const outcome = await scribe.extractAndWrite({ text: LONG_TURN, observed_at: t0 })
    expect(outcome.ran).toBe(true)
    if (!outcome.ran) throw new Error('unreachable')
    expect(outcome.report.pages_written).toBe(0)
    expect(writes.size).toBe(0)
  })
})
