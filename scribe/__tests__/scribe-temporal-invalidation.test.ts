/**
 * RB4 — Temporal invalidation (belief evolution) real-PGLite round-trip.
 *
 * Same harness as `scribe-gbrain-roundtrip.test.ts` (a REAL in-memory GBrain
 * brain + the REAL entity-writer + REAL GBrainSyncHook), driving the supersede
 * path end-to-end:
 *
 *   fact A (works_at OldCo)  → compiled-truth + edge + timeline
 *   superseding fact         → works_at NewCo, `supersedes: "OldCo"`
 *
 * ACCEPTANCE (flag ON): superseding a fact updates compiled-truth + the graph
 * edge to CURRENT truth but leaves the dated history intact —
 *   (1) compiled-truth shows ONLY NewCo,
 *   (2) the gbrain edge reflects NewCo, not OldCo,
 *   (3) the timeline STILL contains the OldCo dated entry (history preserved).
 *
 * PLUS a flag-OFF test proving pure-accretion behaviour is unchanged (both the
 * OldCo and NewCo facts + edges coexist — exactly as today).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { extractCompiledTruth, extractTimeline } from '@neutronai/runtime/entity-format.ts'
import type { McpClient } from '@neutronai/gbrain-memory/mcp-client.ts'
import { GBrainMemoryStore } from '@neutronai/gbrain-memory/gbrain-memory-store.ts'
import { GBrainSyncHook } from '@neutronai/gbrain-memory/GBrainSyncHook.ts'
import { writeEntity } from '@neutronai/runtime/entity-writer.ts'
import { createScribe } from '../index.ts'
import { createState } from '../scribe-budget.ts'
import { bootPgliteBrain } from '@neutronai/gbrain-memory/__tests__/boot-pglite-brain.ts'

const t0 = Date.now()

/** Fake substrate that emits a canned extraction document then completes. The
 *  supersede FLAG affects only the prompt (which this fake ignores); the write-
 *  path behaviour under test is exercised by the injected `supersedes` marker +
 *  the scribe-level `supersede` gate. */
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

/** Canned extraction for the ORIGINAL fact: Alice works_at OldCo. */
const FACT_A = JSON.stringify({
  entities: [
    { name: 'Alice Ng', kind: 'person', fact: 'a staff engineer' },
    { name: 'OldCo', kind: 'company', fact: 'her former employer' },
  ],
  relations: [{ subject: 'Alice Ng', predicate: 'works_at', object: 'OldCo' }],
})

/** Canned extraction for the SUPERSEDING fact: Alice works_at NewCo, which
 *  invalidates the prior works_at OldCo (keyed by the prior object's identity). */
const FACT_SUPERSEDE = JSON.stringify({
  entities: [
    { name: 'Alice Ng', kind: 'person', fact: 'a staff engineer' },
    { name: 'NewCo', kind: 'company', fact: 'her new employer' },
  ],
  relations: [
    { subject: 'Alice Ng', predicate: 'works_at', object: 'NewCo', supersedes: 'OldCo' },
  ],
})

describe('RB4 temporal invalidation (belief evolution) — real PGLite round-trip', () => {
  let engine: { disconnect(): Promise<void> }
  let client: McpClient

  beforeAll(async () => {
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

  test('flag ON: superseding a fact updates compiled-truth + the graph edge to current truth, timeline keeps history', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-on-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    const mk = (json: string, ts: number): ReturnType<typeof createScribe> =>
      createScribe({
        substrate: cannedSubstrate(json),
        syncHook,
        ownerDataDir,
        project_slug: 'rb4-on',
        budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
        writeEntity,
        now: () => ts,
        supersede: true, // ← the shared NEUTRON_PERFECT_RECALL gate, ON
      })

    // 1) Write the ORIGINAL fact: Alice works_at OldCo.
    const first = await mk(FACT_A, t0).extractAndWrite({
      text: 'Alice Ng is a staff engineer at OldCo, her longtime employer, where she leads the platform team and mentors the juniors.',
      observed_at: t0,
    })
    expect(first.ran).toBe(true)

    // Sanity: the OldCo edge is present after the first write.
    let links = await client.call('get_links', { slug: 'alice-ng' })
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(1)

    // 2) Write the SUPERSEDING fact: Alice works_at NewCo, supersedes OldCo.
    const second = await mk(FACT_SUPERSEDE, t0 + 1000).extractAndWrite({
      text: 'Alice Ng just moved on from OldCo — she now works at NewCo, leading their infrastructure group, and is no longer at OldCo.',
      observed_at: t0 + 1000,
    })
    expect(second.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'alice-ng.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)

    // (1) Compiled-truth shows ONLY NewCo — the superseded OldCo sentence is gone.
    expect(compiled).toContain('Works at [[newco]].')
    expect(compiled).not.toContain('[[oldco]]')

    // (2) The gbrain edge reflects NewCo, not OldCo.
    links = await client.call('get_links', { slug: 'alice-ng' })
    expect(edgesTo(links, 'newco', 'works_at').length).toBe(1) // CURRENT
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(0) // INVALIDATED

    // (3) The timeline STILL contains the OldCo dated entry (history preserved):
    //     the supersession is recorded as a dated timeline row naming old-co,
    //     even though compiled-truth no longer asserts it.
    const timeline = extractTimeline(onDisk)
    const supersedeRow = timeline.find((e) => e.body.includes('oldco'))
    expect(supersedeRow).toBeDefined()
    expect(supersedeRow!.ts).toBe(new Date(t0 + 1000).toISOString())

    // …and the OldCo entity page itself survives untouched on disk (history).
    const oldCoPage = readFileSync(join(ownerDataDir, 'entities', 'companies', 'oldco.md'), 'utf8')
    expect(oldCoPage).toContain('slug: oldco')
  }, 60_000)

  test('flag OFF: the SAME superseding input is pure accretion — both OldCo and NewCo facts + edges coexist (unchanged)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-off-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    const mk = (json: string, ts: number): ReturnType<typeof createScribe> =>
      createScribe({
        substrate: cannedSubstrate(json),
        syncHook,
        ownerDataDir,
        project_slug: 'rb4-off',
        budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
        writeEntity,
        now: () => ts,
        // supersede omitted → default OFF (flag not opted in)
      })

    const first = await mk(FACT_A, t0).extractAndWrite({
      text: 'Alice Ng is a staff engineer at OldCo, her longtime employer, where she leads the platform team and mentors the juniors.',
      observed_at: t0,
    })
    expect(first.ran).toBe(true)

    // The SAME superseding extraction (the `supersedes` marker IS present) —
    // but with the flag off it must be inert.
    const second = await mk(FACT_SUPERSEDE, t0 + 1000).extractAndWrite({
      text: 'Alice Ng just moved on from OldCo — she now works at NewCo, leading their infrastructure group, and is no longer at OldCo.',
      observed_at: t0 + 1000,
    })
    expect(second.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'alice-ng.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)

    // Pure accretion: BOTH facts remain in compiled-truth (nothing superseded).
    expect(compiled).toContain('Works at [[oldco]].')
    expect(compiled).toContain('Works at [[newco]].')

    // BOTH edges coexist in the graph — no invalidation applied.
    const links = await client.call('get_links', { slug: 'alice-ng' })
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(1)
    expect(edgesTo(links, 'newco', 'works_at').length).toBe(1)

    // The timeline carries no supersession note (the marker was ignored).
    const timeline = extractTimeline(onDisk)
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false)
  }, 60_000)

  test('flag ON: an ALIASED wikilink is invalidated (removal matches [[oldco|OldCo]], not just [[oldco]])', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-alias-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    // Pre-create the edge endpoint, then seed a person page whose ONLY oldco
    // assertion uses the ALIASED wikilink form the graph extractor supports.
    await client.call('put_page', {
      slug: 'oldco',
      content: '---\nslug: oldco\ntype: company\n---\n\nFormer employer.\n',
    })
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'cara-lee',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'cara-lee', type: 'person', name: 'Cara Lee' },
          compiledTruth: '# Cara Lee\n\nAn engineer.\n\n## Relationships\n\n- Works at [[oldco|OldCo]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    // The aliased line produced a real works_at edge.
    let links = await client.call('get_links', { slug: 'cara-lee' })
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(1)

    // Supersede it via scribe (flag ON).
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Cara Lee', kind: 'person', fact: 'an engineer' },
            { name: 'NewCo', kind: 'company', fact: 'her new employer' },
          ],
          relations: [
            { subject: 'Cara Lee', predicate: 'works_at', object: 'NewCo', supersedes: 'OldCo' },
          ],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-alias',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Cara Lee has moved on from OldCo and now works at NewCo, leading their platform engineering team full time.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'cara-lee.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // The ALIASED oldco assertion is gone; NewCo is current.
    expect(compiled).not.toContain('[[oldco') // neither [[oldco]] nor [[oldco|…]]
    expect(compiled).toContain('Works at [[newco]].')

    // The stale edge is invalidated; the current one reflects NewCo.
    links = await client.call('get_links', { slug: 'cara-lee' })
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(0) // INVALIDATED (aliased)
    expect(edgesTo(links, 'newco', 'works_at').length).toBe(1) // CURRENT
  }, 60_000)

  test('flag ON: supersede is PREDICATE-SCOPED — an unrelated current fact about the SAME object survives', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-scope-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'oldco',
      content: '---\nslug: oldco\ntype: company\n---\n\nA company Bob is tied to.\n',
    })
    // Bob both WORKS AT and ADVISES oldco. The graph collapses the pair to the
    // strongest predicate (advises ≺ works_at), so the live oldco edge is
    // `advises`. Superseding works_at must NOT disturb the advises assertion.
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'bob-tan',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'bob-tan', type: 'person', name: 'Bob Tan' },
          compiledTruth:
            '# Bob Tan\n\nAn operator.\n\n## Relationships\n\n- Advises [[oldco]].\n- Works at [[oldco|OldCo]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'bob-tan' })
    expect(edgesTo(links, 'oldco', 'advises').length).toBe(1) // strongest → the live edge

    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Bob Tan', kind: 'person', fact: 'an operator' },
            { name: 'NewCo', kind: 'company', fact: 'his new employer' },
          ],
          relations: [
            { subject: 'Bob Tan', predicate: 'works_at', object: 'NewCo', supersedes: 'OldCo' },
          ],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-scope',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Bob Tan left his day job at OldCo and now works at NewCo, though he still advises the OldCo board on strategy.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'bob-tan.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // The works_at line is retired; the unrelated Advises assertion SURVIVES.
    expect(compiled).not.toContain('Works at [[oldco')
    expect(compiled).toContain('Advises [[oldco]].') // PRESERVED (different predicate)
    expect(compiled).toContain('Works at [[newco]].') // current

    // The advises edge to oldco is intact; works_at newco is added.
    links = await client.call('get_links', { slug: 'bob-tan' })
    expect(edgesTo(links, 'oldco', 'advises').length).toBe(1) // PRESERVED
    expect(edgesTo(links, 'newco', 'works_at').length).toBe(1) // CURRENT
  }, 60_000)

  test('flag ON: removal is SENTENCE-granular — same-line sibling sentence (same object) survives', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-sent1-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'oldco',
      content: '---\nslug: oldco\ntype: company\n---\n\nA company.\n',
    })
    // TWO sentences on ONE line, same object. (Line-granular removal would leave
    // the stale `Works at` sentence — Codex RB4 r2 repro 1.)
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'dave-roe',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'dave-roe', type: 'person', name: 'Dave Roe' },
          compiledTruth:
            '# Dave Roe\n\nAn operator.\n\n## Relationships\n\n- Advises [[oldco]]. Works at [[oldco]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )

    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Dave Roe', kind: 'person', fact: 'an operator' },
            { name: 'NewCo', kind: 'company', fact: 'his new employer' },
          ],
          relations: [
            { subject: 'Dave Roe', predicate: 'works_at', object: 'NewCo', supersedes: 'OldCo' },
          ],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-sent1',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Dave Roe stepped down from OldCo and now works at NewCo, but he still advises the OldCo leadership team.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const compiled = extractCompiledTruth(
      readFileSync(join(ownerDataDir, 'entities', 'people', 'dave-roe.md'), 'utf8'),
    )
    // ONLY the works_at [[oldco]] sentence is gone; the sibling Advises survives.
    expect(compiled).toContain('Advises [[oldco]].') // PRESERVED (same-line sibling)
    expect(compiled).not.toContain('Works at [[oldco]]') // RETIRED
    expect(compiled).toContain('Works at [[newco]].') // CURRENT
  }, 60_000)

  test('flag ON: removal is SENTENCE-granular — same-line UNRELATED-object sentence is not deleted', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-sent2-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'oldco',
      content: '---\nslug: oldco\ntype: company\n---\n\nA company.\n',
    })
    await client.call('put_page', {
      slug: 'boardco',
      content: '---\nslug: boardco\ntype: company\n---\n\nA company.\n',
    })
    // Two sentences on ONE line, DIFFERENT objects. (Line-granular removal would
    // delete the unrelated `advises boardco` fact — Codex RB4 r2 repro 2.)
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'erin-vale',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'erin-vale', type: 'person', name: 'Erin Vale' },
          compiledTruth:
            '# Erin Vale\n\nAn operator.\n\n## Relationships\n\n- Works at [[oldco]]. Advises [[boardco]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'erin-vale' })
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(1)
    expect(edgesTo(links, 'boardco', 'advises').length).toBe(1)

    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Erin Vale', kind: 'person', fact: 'an operator' },
            { name: 'NewCo', kind: 'company', fact: 'her new employer' },
          ],
          relations: [
            { subject: 'Erin Vale', predicate: 'works_at', object: 'NewCo', supersedes: 'OldCo' },
          ],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-sent2',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Erin Vale left OldCo to work at NewCo full-time, though she continues to advise the BoardCo directors.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const compiled = extractCompiledTruth(
      readFileSync(join(ownerDataDir, 'entities', 'people', 'erin-vale.md'), 'utf8'),
    )
    // The unrelated same-line advises boardco assertion SURVIVES.
    expect(compiled).toContain('Advises [[boardco]].') // PRESERVED (unrelated object)
    expect(compiled).not.toContain('Works at [[oldco]]') // RETIRED
    expect(compiled).toContain('Works at [[newco]].') // CURRENT

    // Graph: stale works_at oldco gone; advises boardco intact; works_at newco added.
    links = await client.call('get_links', { slug: 'erin-vale' })
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(0) // INVALIDATED
    expect(edgesTo(links, 'boardco', 'advises').length).toBe(1) // PRESERVED
    expect(edgesTo(links, 'newco', 'works_at').length).toBe(1) // CURRENT
  }, 60_000)
})
