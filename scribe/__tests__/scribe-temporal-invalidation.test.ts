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

/** Canned extraction for an ORIGINAL fact: `person` works_at `old`. Parameterised
 *  so each test uses UNIQUE entity names — the whole suite shares one PGLite brain,
 *  so distinct subject/object slugs keep every test's graph assertions isolated. */
const factA = (person: string, old: string): string =>
  JSON.stringify({
    entities: [
      { name: person, kind: 'person', fact: 'a staff engineer' },
      { name: old, kind: 'company', fact: 'a former employer' },
    ],
    relations: [{ subject: person, predicate: 'works_at', object: old }],
  })

/** Canned extraction for a SUPERSEDING fact: `person` works_at `neu`, which
 *  invalidates the prior works_at `old` (keyed by the prior object's identity). */
const factSupersede = (person: string, old: string, neu: string): string =>
  JSON.stringify({
    entities: [
      { name: person, kind: 'person', fact: 'a staff engineer' },
      { name: neu, kind: 'company', fact: 'a new employer' },
    ],
    relations: [{ subject: person, predicate: 'works_at', object: neu, supersedes: old }],
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
    const first = await mk(factA('Alice Ng', 'OldCo'), t0).extractAndWrite({
      text: 'Alice Ng is a staff engineer at OldCo, her longtime employer, where she leads the platform team and mentors the juniors.',
      observed_at: t0,
    })
    expect(first.ran).toBe(true)

    // Sanity: the OldCo edge is present after the first write.
    let links = await client.call('get_links', { slug: 'alice-ng' })
    expect(edgesTo(links, 'oldco', 'works_at').length).toBe(1)

    // 2) Write the SUPERSEDING fact: Alice works_at NewCo, supersedes OldCo.
    const second = await mk(factSupersede('Alice Ng', 'OldCo', 'NewCo'), t0 + 1000).extractAndWrite({
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

    // (3) The timeline STILL contains the OldCo dated history (nothing lost):
    //     - the ORIGINAL works_at OldCo assertion at its OWN date (t0), and
    //     - the dated supersession note at the invalidation date (t0 + 1000),
    //     even though compiled-truth no longer asserts OldCo.
    const timeline = extractTimeline(onDisk)
    const originalRow = timeline.find(
      (e) => e.ts === new Date(t0).toISOString() && e.body.includes('works_at oldco'),
    )
    expect(originalRow).toBeDefined() // ORIGINAL dated belief preserved
    const supersedeRow = timeline.find(
      (e) =>
        e.ts === new Date(t0 + 1000).toISOString() &&
        e.body.includes('superseded works_at: oldco → newco'),
    )
    expect(supersedeRow).toBeDefined() // dated supersession recorded

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

    const first = await mk(factA('Fay Ober', 'Oldstead'), t0).extractAndWrite({
      text: 'Fay Ober is a staff engineer at Oldstead, her longtime employer, where she leads the platform team and mentors the juniors.',
      observed_at: t0,
    })
    expect(first.ran).toBe(true)

    // The SAME superseding extraction (the `supersedes` marker IS present) —
    // but with the flag off it must be inert.
    const second = await mk(factSupersede('Fay Ober', 'Oldstead', 'Newland'), t0 + 1000).extractAndWrite({
      text: 'Fay Ober just moved on from Oldstead — she now works at Newland, leading their infrastructure group, and is no longer at Oldstead.',
      observed_at: t0 + 1000,
    })
    expect(second.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'fay-ober.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)

    // Pure accretion: BOTH facts remain in compiled-truth (nothing superseded).
    expect(compiled).toContain('Works at [[oldstead]].')
    expect(compiled).toContain('Works at [[newland]].')

    // BOTH edges coexist in the graph — no invalidation applied.
    const links = await client.call('get_links', { slug: 'fay-ober' })
    expect(edgesTo(links, 'oldstead', 'works_at').length).toBe(1)
    expect(edgesTo(links, 'newland', 'works_at').length).toBe(1)

    // The timeline carries no supersession note (the marker was ignored).
    const timeline = extractTimeline(onDisk)
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false)
  }, 60_000)

  test('flag OFF→ON transition: a fact written flag-off, then superseded flag-on, still survives in the dated timeline', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-off2on-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    // 1) Original works_at OldCo written with the flag OFF — so it carries NO
    //    relation note of its own (fact-only timeline body), the pre-RB4 shape.
    const off = await createScribe({
      substrate: cannedSubstrate(factA('Gil Pace', 'Oldford')),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-off2on',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0,
      // supersede omitted → OFF
    }).extractAndWrite({
      text: 'Gil Pace is a staff engineer at Oldford, his longtime employer, where he leads the platform team and mentors the juniors.',
      observed_at: t0,
    })
    expect(off.ran).toBe(true)

    // 2) The flag is later ENABLED; a superseding turn arrives.
    const on = await createScribe({
      substrate: cannedSubstrate(factSupersede('Gil Pace', 'Oldford', 'Newforge')),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-off2on',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true, // flag now ON
    }).extractAndWrite({
      text: 'Gil Pace just moved on from Oldford — he now works at Newforge, leading their infrastructure group, and is no longer at Oldford.',
      observed_at: t0 + 1000,
    })
    expect(on.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'gil-pace.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // Current truth: Oldford retired, Newforge present.
    expect(compiled).not.toContain('[[oldford]]')
    expect(compiled).toContain('Works at [[newforge]].')

    // Graph reflects current truth.
    const links = await client.call('get_links', { slug: 'gil-pace' })
    expect(edgesTo(links, 'oldford', 'works_at').length).toBe(0)
    expect(edgesTo(links, 'newforge', 'works_at').length).toBe(1)

    // History NOT silently lost: the retired works_at Oldford fact survives in the
    // dated timeline via the invalidation-time supersession note (the original
    // date is unrecoverable — the flag-off write recorded no relation).
    const timeline = extractTimeline(onDisk)
    const supersedeRow = timeline.find(
      (e) =>
        e.ts === new Date(t0 + 1000).toISOString() &&
        e.body.includes('superseded works_at: oldford → newforge'),
    )
    expect(supersedeRow).toBeDefined()
  }, 60_000)

  test('flag ON: an ALIASED wikilink is invalidated (removal matches [[alphaco|Alphaco]], not just [[alphaco]])', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-alias-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    // Pre-create the edge endpoint, then seed a person page whose ONLY alphaco
    // assertion uses the ALIASED wikilink form the graph extractor supports.
    await client.call('put_page', {
      slug: 'alphaco',
      content: '---\nslug: alphaco\ntype: company\n---\n\nFormer employer.\n',
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
          compiledTruth: '# Cara Lee\n\nAn engineer.\n\n## Relationships\n\n- Works at [[alphaco|Alphaco]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    // The aliased line produced a real works_at edge.
    let links = await client.call('get_links', { slug: 'cara-lee' })
    expect(edgesTo(links, 'alphaco', 'works_at').length).toBe(1)

    // Supersede it via scribe (flag ON).
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Cara Lee', kind: 'person', fact: 'an engineer' },
            { name: 'Betaco', kind: 'company', fact: 'her new employer' },
          ],
          relations: [
            { subject: 'Cara Lee', predicate: 'works_at', object: 'Betaco', supersedes: 'Alphaco' },
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
      text: 'Cara Lee has moved on from Alphaco and now works at Betaco, leading their platform engineering team full time.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'cara-lee.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // The ALIASED alphaco assertion is gone; Betaco is current.
    expect(compiled).not.toContain('[[alphaco') // neither [[alphaco]] nor [[alphaco|…]]
    expect(compiled).toContain('Works at [[betaco]].')

    // The stale edge is invalidated; the current one reflects Betaco.
    links = await client.call('get_links', { slug: 'cara-lee' })
    expect(edgesTo(links, 'alphaco', 'works_at').length).toBe(0) // INVALIDATED (aliased)
    expect(edgesTo(links, 'betaco', 'works_at').length).toBe(1) // CURRENT
  }, 60_000)

  test('flag ON: supersede is PREDICATE-SCOPED — an unrelated current fact about the SAME object survives', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-scope-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'gammaco',
      content: '---\nslug: gammaco\ntype: company\n---\n\nA company Bob is tied to.\n',
    })
    // Bob both WORKS AT and ADVISES gammaco. The graph collapses the pair to the
    // strongest predicate (advises ≺ works_at), so the live gammaco edge is
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
            '# Bob Tan\n\nAn operator.\n\n## Relationships\n\n- Advises [[gammaco]].\n- Works at [[gammaco|Gammaco]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'bob-tan' })
    expect(edgesTo(links, 'gammaco', 'advises').length).toBe(1) // strongest → the live edge

    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Bob Tan', kind: 'person', fact: 'an operator' },
            { name: 'Deltaco', kind: 'company', fact: 'his new employer' },
          ],
          relations: [
            { subject: 'Bob Tan', predicate: 'works_at', object: 'Deltaco', supersedes: 'Gammaco' },
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
      text: 'Bob Tan left his day job at Gammaco and now works at Deltaco, though he still advises the Gammaco board on strategy.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'bob-tan.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // The works_at line is retired; the unrelated Advises assertion SURVIVES.
    expect(compiled).not.toContain('Works at [[gammaco')
    expect(compiled).toContain('Advises [[gammaco]].') // PRESERVED (different predicate)
    expect(compiled).toContain('Works at [[deltaco]].') // current

    // The advises edge to gammaco is intact; works_at deltaco is added.
    links = await client.call('get_links', { slug: 'bob-tan' })
    expect(edgesTo(links, 'gammaco', 'advises').length).toBe(1) // PRESERVED
    expect(edgesTo(links, 'deltaco', 'works_at').length).toBe(1) // CURRENT
  }, 60_000)

  test('flag ON: removal is SENTENCE-granular — same-line sibling sentence (same object) survives', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-sent1-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'epsico',
      content: '---\nslug: epsico\ntype: company\n---\n\nA company.\n',
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
            '# Dave Roe\n\nAn operator.\n\n## Relationships\n\n- Advises [[epsico]]. Works at [[epsico]].\n',
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
            { name: 'Zetaco', kind: 'company', fact: 'his new employer' },
          ],
          relations: [
            { subject: 'Dave Roe', predicate: 'works_at', object: 'Zetaco', supersedes: 'Epsico' },
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
      text: 'Dave Roe stepped down from Epsico and now works at Zetaco, but he still advises the Epsico leadership team.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const compiled = extractCompiledTruth(
      readFileSync(join(ownerDataDir, 'entities', 'people', 'dave-roe.md'), 'utf8'),
    )
    // ONLY the works_at [[epsico]] sentence is gone; the sibling Advises survives.
    expect(compiled).toContain('Advises [[epsico]].') // PRESERVED (same-line sibling)
    expect(compiled).not.toContain('Works at [[epsico]]') // RETIRED
    expect(compiled).toContain('Works at [[zetaco]].') // CURRENT
  }, 60_000)

  test('flag ON: removal is SENTENCE-granular — same-line UNRELATED-object sentence is not deleted', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-sent2-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'etaco',
      content: '---\nslug: etaco\ntype: company\n---\n\nA company.\n',
    })
    await client.call('put_page', {
      slug: 'boardeta',
      content: '---\nslug: boardeta\ntype: company\n---\n\nA company.\n',
    })
    // Two sentences on ONE line, DIFFERENT objects. (Line-granular removal would
    // delete the unrelated `advises boardeta` fact — Codex RB4 r2 repro 2.)
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
            '# Erin Vale\n\nAn operator.\n\n## Relationships\n\n- Works at [[etaco]]. Advises [[boardeta]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'erin-vale' })
    expect(edgesTo(links, 'etaco', 'works_at').length).toBe(1)
    expect(edgesTo(links, 'boardeta', 'advises').length).toBe(1)

    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Erin Vale', kind: 'person', fact: 'an operator' },
            { name: 'Thetaco', kind: 'company', fact: 'her new employer' },
          ],
          relations: [
            { subject: 'Erin Vale', predicate: 'works_at', object: 'Thetaco', supersedes: 'Etaco' },
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
      text: 'Erin Vale left Etaco to work at Thetaco full-time, though she continues to advise the Boardeta directors.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const compiled = extractCompiledTruth(
      readFileSync(join(ownerDataDir, 'entities', 'people', 'erin-vale.md'), 'utf8'),
    )
    // The unrelated same-line advises boardeta assertion SURVIVES.
    expect(compiled).toContain('Advises [[boardeta]].') // PRESERVED (unrelated object)
    expect(compiled).not.toContain('Works at [[etaco]]') // RETIRED
    expect(compiled).toContain('Works at [[thetaco]].') // CURRENT

    // Graph: stale works_at etaco gone; advises boardeta intact; works_at thetaco added.
    links = await client.call('get_links', { slug: 'erin-vale' })
    expect(edgesTo(links, 'etaco', 'works_at').length).toBe(0) // INVALIDATED
    expect(edgesTo(links, 'boardeta', 'advises').length).toBe(1) // PRESERVED
    expect(edgesTo(links, 'thetaco', 'works_at').length).toBe(1) // CURRENT
  }, 60_000)

  test('flag ON: a MARKDOWN-link assertion is invalidated (removal matches [Oldmark](oldmark), not only wikilinks)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-mdlink-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'oldmark',
      content: '---\nslug: oldmark\ntype: company\n---\n\nA company.\n',
    })
    // The prior assertion uses MARKDOWN-link syntax `[Display](slug)` — which the
    // graph extractor recognises but a `[[`-only gate would skip (Codex RB4 r5).
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'ivy-onn',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'ivy-onn', type: 'person', name: 'Ivy Onn' },
          compiledTruth: '# Ivy Onn\n\nAn engineer.\n\n## Relationships\n\n- Works at [Oldmark](oldmark).\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    // The markdown-link line produced a real works_at edge.
    let links = await client.call('get_links', { slug: 'ivy-onn' })
    expect(edgesTo(links, 'oldmark', 'works_at').length).toBe(1)

    const scribe = createScribe({
      substrate: cannedSubstrate(factSupersede('Ivy Onn', 'Oldmark', 'Newmark')),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-mdlink',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Ivy Onn has moved on from Oldmark and now works at Newmark, leading their platform engineering team full time.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const compiled = extractCompiledTruth(
      readFileSync(join(ownerDataDir, 'entities', 'people', 'ivy-onn.md'), 'utf8'),
    )
    // The MARKDOWN-link oldmark assertion is gone; Newmark is current.
    expect(compiled).not.toContain('oldmark') // neither [Oldmark](oldmark) nor a wikilink
    expect(compiled).toContain('Works at [[newmark]].')

    // The stale edge is invalidated; the current one reflects Newmark.
    links = await client.call('get_links', { slug: 'ivy-onn' })
    expect(edgesTo(links, 'oldmark', 'works_at').length).toBe(0) // INVALIDATED (markdown link)
    expect(edgesTo(links, 'newmark', 'works_at').length).toBe(1) // CURRENT
  }, 60_000)

  // ── Out-of-scope phrasings: RB4 is OBJECT-REPLACEMENT only. An entity RENAME
  //    and an ENDED affiliation with NO replacement are NOT modelled — the
  //    restricted prompt no longer asks for a `supersedes` marker on them, so
  //    such a turn just accretes normally. These pin the graceful outcome (no
  //    misleading invalidation, no bogus supersession note) + keep it mutation-
  //    stable (flag ON throughout). ──────────────────────────────────────────

  test('flag ON: an entity RENAME ("Renco is now Zephyr") does NOT invalidate the subject\'s existing relation', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-rename-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'renco',
      content: '---\nslug: renco\ntype: company\n---\n\nA company.\n',
    })
    // Rae works at Renco.
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'rae-kade',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'rae-kade', type: 'person', name: 'Rae Kade' },
          compiledTruth: '# Rae Kade\n\nAn engineer.\n\n## Relationships\n\n- Works at [[renco]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'rae-kade' })
    expect(edgesTo(links, 'renco', 'works_at').length).toBe(1)

    // A RENAME turn. The restricted prompt does NOT ask for `supersedes` on a
    // rename (the entity's own identity changed — nothing to key on), so the
    // faithful extraction carries only entities + an additive `mentions`, NO
    // supersede marker.
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Rae Kade', kind: 'person', fact: 'an engineer' },
            { name: 'Renco', kind: 'company', fact: 'now called Zephyr' },
            { name: 'Zephyr', kind: 'company', fact: 'the renamed Renco' },
          ],
          relations: [{ subject: 'Rae Kade', predicate: 'mentions', object: 'Zephyr' }],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-rename',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true, // flag ON — yet a rename must NOT trigger invalidation
    })
    const out = await scribe.extractAndWrite({
      text: 'Renco has rebranded and is now called Zephyr; Rae Kade still remembers the old name from her early days there.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'rae-kade.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // GRACEFUL: the prior employment is NOT retracted (rename is out of scope);
    // the additive mention accretes; NO supersession is fabricated.
    expect(compiled).toContain('Works at [[renco]].') // PRESERVED (not invalidated)
    expect(compiled).toContain('Mentions [[zephyr]].') // additive accretion
    const timeline = extractTimeline(onDisk)
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false) // no bogus note

    // The existing edge is intact; no edge was invalidated by the rename.
    links = await client.call('get_links', { slug: 'rae-kade' })
    expect(edgesTo(links, 'renco', 'works_at').length).toBe(1) // PRESERVED
  }, 60_000)

  test('flag ON: an ENDED affiliation with NO replacement ("Jane left Endco") does NOT retract or fabricate a supersession', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-ended-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'endco',
      content: '---\nslug: endco\ntype: company\n---\n\nA company.\n',
    })
    // Jane works at Endco.
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'jane-poll',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'jane-poll', type: 'person', name: 'Jane Poll' },
          compiledTruth: '# Jane Poll\n\nAn engineer.\n\n## Relationships\n\n- Works at [[endco]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'jane-poll' })
    expect(edgesTo(links, 'endco', 'works_at').length).toBe(1)

    // An ENDED-affiliation turn with NO new employer: there is no new object to
    // point at, so the restricted prompt does NOT ask for `supersedes`. The
    // faithful extraction has NO replacing relation.
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Jane Poll', kind: 'person', fact: 'has left her role at Endco' },
            { name: 'Endco', kind: 'company', fact: 'her former employer' },
          ],
          relations: [],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-ended',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true, // flag ON — yet an ended affiliation must NOT trigger invalidation
    })
    const out = await scribe.extractAndWrite({
      text: 'Jane Poll has left her role at Endco and is taking some time off before deciding what she wants to do next.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'jane-poll.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // GRACEFUL: RB4 does not retract an ended-without-replacement affiliation
    // (out of scope) — the fact persists, and NO supersession is fabricated.
    expect(compiled).toContain('Works at [[endco]].') // RETAINED (not retracted)
    const timeline = extractTimeline(onDisk)
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false) // no bogus note

    // The edge is untouched — no invalidation on an ended affiliation.
    links = await client.call('get_links', { slug: 'jane-poll' })
    expect(edgesTo(links, 'endco', 'works_at').length).toBe(1) // RETAINED
  }, 60_000)

  // ── Marker with NO matching prior assertion → NO fabricated supersession note.
  //    A `supersedes` marker is a MODEL claim; if the prior triple was never
  //    asserted, the timeline must NOT record a `superseded …` note (that would be
  //    fabricated history). The new object is still asserted additively. ────────

  test('flag ON: a supersedes marker on a BRAND-NEW subject records NO fabricated supersession (additive only)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-newsubj-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    // Empty owner dir — Nova and Nbold have NEVER existed. The model still emits a
    // supersedes marker (`works_at Nbnew supersedes Nbold`).
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Nova Byrd', kind: 'person', fact: 'an engineer' },
            { name: 'Nbnew', kind: 'company', fact: 'her employer' },
          ],
          relations: [
            { subject: 'Nova Byrd', predicate: 'works_at', object: 'Nbnew', supersedes: 'Nbold' },
          ],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-newsubj',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Nova Byrd is an engineer who now works at Nbnew, leading the reliability team on the platform side.',
      observed_at: t0,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'nova-byrd.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    expect(compiled).toContain('Works at [[nbnew]].') // the new fact IS asserted

    const timeline = extractTimeline(onDisk)
    // NO fabricated supersession — Nbold was never a belief here.
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false)
    expect(timeline.some((e) => e.body.includes('Nbold') || e.body.includes('nbold'))).toBe(false)
    // …the marker degrades to a plain ADDITIVE note instead.
    expect(timeline.some((e) => e.body.includes('works_at nbnew'))).toBe(true)

    const links = await client.call('get_links', { slug: 'nova-byrd' })
    expect(edgesTo(links, 'nbnew', 'works_at').length).toBe(1) // asserted
    expect(edgesTo(links, 'nbold', 'works_at').length).toBe(0) // never existed
  }, 60_000)

  test('flag ON: a supersedes marker whose claimed prior the subject NEVER asserted removes nothing + fabricates no note', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-stale-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'realco',
      content: '---\nslug: realco\ntype: company\n---\n\nA company.\n',
    })
    // Uma works at Realco — she has NEVER worked at "Ufold".
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'uma-frost',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'uma-frost', type: 'person', name: 'Uma Frost' },
          compiledTruth: '# Uma Frost\n\nAn engineer.\n\n## Relationships\n\n- Works at [[realco]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )

    // A turn claims `works_at Ufnew supersedes Ufold` — but Uma never asserted Ufold.
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Uma Frost', kind: 'person', fact: 'an engineer' },
            { name: 'Ufnew', kind: 'company', fact: 'a new engagement' },
          ],
          relations: [
            { subject: 'Uma Frost', predicate: 'works_at', object: 'Ufnew', supersedes: 'Ufold' },
          ],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-stale',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Uma Frost has picked up a new engagement at Ufnew this quarter, on top of everything else she is juggling right now.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'uma-frost.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // NO unrelated removal — the real prior fact survives; the new one accretes.
    expect(compiled).toContain('Works at [[realco]].') // PRESERVED (not touched by a stale marker)
    expect(compiled).toContain('Works at [[ufnew]].') // additive

    const timeline = extractTimeline(onDisk)
    // NO fabricated supersession note (Ufold was never asserted).
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false)
    expect(timeline.some((e) => e.body.includes('ufold'))).toBe(false)
    expect(timeline.some((e) => e.body.includes('works_at ufnew'))).toBe(true) // additive note

    const links = await client.call('get_links', { slug: 'uma-frost' })
    expect(edgesTo(links, 'realco', 'works_at').length).toBe(1) // PRESERVED
    expect(edgesTo(links, 'ufnew', 'works_at').length).toBe(1) // ADDED
  }, 60_000)

  test('flag ON: REPLAYING the identical superseding turn is a byte-identical no-op (idempotent)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-replay-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    const mk = (json: string, ts: number): ReturnType<typeof createScribe> =>
      createScribe({
        substrate: cannedSubstrate(json),
        syncHook,
        ownerDataDir,
        project_slug: 'rb4-replay',
        budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
        writeEntity,
        now: () => ts,
        supersede: true,
      })
    const pagePath = join(ownerDataDir, 'entities', 'people', 'iris-vale.md')

    // 1) Original works_at Oldiv, then 2) supersede to Newiv.
    await mk(factA('Iris Vale', 'Oldiv'), t0).extractAndWrite({
      text: 'Iris Vale is a staff engineer at Oldiv, where she has led the platform team for several years now.',
      observed_at: t0,
    })
    await mk(factSupersede('Iris Vale', 'Oldiv', 'Newiv'), t0 + 1000).extractAndWrite({
      text: 'Iris Vale has moved on from Oldiv and now works at Newiv, leading their platform engineering group.',
      observed_at: t0 + 1000,
    })
    const afterSupersede = readFileSync(pagePath, 'utf8')
    // The supersession was recorded exactly once.
    expect((afterSupersede.match(/superseded works_at: oldiv → newiv/g) ?? []).length).toBe(1)

    // 3) REPLAY the EXACT same superseding turn (same ts, source, extraction).
    const replay = await mk(factSupersede('Iris Vale', 'Oldiv', 'Newiv'), t0 + 1000).extractAndWrite({
      text: 'Iris Vale has moved on from Oldiv and now works at Newiv, leading their platform engineering group.',
      observed_at: t0 + 1000,
    })
    expect(replay.ran).toBe(true)
    if (!replay.ran) throw new Error('unreachable')
    // No page changed on replay — byte-identical re-write short-circuits.
    expect(replay.report.pages_written).toBe(0)

    const afterReplay = readFileSync(pagePath, 'utf8')
    expect(afterReplay).toBe(afterSupersede) // byte-identical page + timeline
    // No SECOND, contradictory row — still exactly one supersession note, and the
    // replay did NOT append a bogus additive `works_at newiv` timeline row.
    expect((afterReplay.match(/superseded works_at: oldiv → newiv/g) ?? []).length).toBe(1)
    const timeline = extractTimeline(afterReplay)
    expect(timeline.filter((e) => e.body.includes('works_at newiv')).length).toBe(0)
  }, 60_000)

  // ── Multiple relations WITHIN one sentence: removal is ALL-OR-NOTHING per
  //    sentence — a compound sentence carrying a still-current relation is NEVER
  //    dropped (no data loss). Bounded trade-off: a superseded relation embedded
  //    in a compound sentence is left in place rather than destroying a sibling.

  test('flag ON: a compound sentence with descriptive prose is kept BYTE-FOR-BYTE (no prose destroyed)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-compound-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'cwoold',
      content: '---\nslug: cwoold\ntype: company\n---\n\nA company.\n',
    })
    await client.call('put_page', {
      slug: 'cwboard',
      content: '---\nslug: cwboard\ntype: company\n---\n\nA company.\n',
    })
    // ONE hand-authored compound sentence: two relations to DIFFERENT objects PLUS
    // descriptive prose that exists nowhere else.
    const COMPOUND = '- Works at [[cwoold]] and advises [[cwboard]] on acquisitions since 2019.'
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'cwen-ash',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'cwen-ash', type: 'person', name: 'Cwen Ash' },
          compiledTruth: `# Cwen Ash\n\nAn operator.\n\n## Relationships\n\n${COMPOUND}\n`,
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'cwen-ash' })
    expect(edgesTo(links, 'cwboard', 'advises').length).toBe(1)

    const scribe = createScribe({
      substrate: cannedSubstrate(factSupersede('Cwen Ash', 'Cwoold', 'Cwnew')),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-compound',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Cwen Ash has moved on from Cwoold and now works at Cwnew, running their reliability org day to day.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'cwen-ash.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // PROSE SAFETY: the hand-authored compound sentence — including the descriptive
    // "on acquisitions since 2019" — survives BYTE-FOR-BYTE (never reconstructed).
    expect(compiled).toContain(COMPOUND)
    // The new employment accretes; no supersession is fabricated (nothing retired
    // from this compound sentence — the conservative, prose-preserving path).
    expect(compiled).toContain('Works at [[cwnew]].')
    const timeline = extractTimeline(onDisk)
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false)

    // The unrelated advisory edge is intact; the new employment edge is added. The
    // embedded works_at cwoold is left in place (bounded under-invalidation — the
    // documented trade-off for not mangling hand-authored prose).
    links = await client.call('get_links', { slug: 'cwen-ash' })
    expect(edgesTo(links, 'cwboard', 'advises').length).toBe(1) // PRESERVED (no data loss)
    expect(edgesTo(links, 'cwnew', 'works_at').length).toBe(1) // ADDED
  }, 60_000)

  test('flag ON: a same-object multi-predicate sentence is not destroyed; the collapsed edge survives', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-multipred-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'smold',
      content: '---\nslug: smold\ntype: company\n---\n\nA company.\n',
    })
    // ONE sentence, TWO predicates, SAME object — the graph collapses it to the
    // strongest predicate (advises), so `advises smold` is the live edge.
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'sam-orr',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'sam-orr', type: 'person', name: 'Sam Orr' },
          // Two refs to the SAME object with different predicates in ONE sentence:
          // the extractor collapses to the strongest (advises), so `advises smold`
          // is the live edge and there is no `works_at smold` edge.
          compiledTruth: '# Sam Orr\n\nAn operator.\n\n## Relationships\n\n- Advises [[smold]] and works at [[smold]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'sam-orr' })
    expect(edgesTo(links, 'smold', 'advises').length).toBe(1) // collapsed strongest edge

    const scribe = createScribe({
      substrate: cannedSubstrate(factSupersede('Sam Orr', 'Smold', 'Smnew')),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-multipred',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Sam Orr has picked up a new role at Smnew this quarter and is ramping up on their platform team.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'sam-orr.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // SAFETY: the multi-predicate sentence survives (advises smold not destroyed).
    expect(compiled).toContain('Advises [[smold]] and works at [[smold]].')
    expect(compiled).toContain('Works at [[smnew]].') // the new fact accretes
    const timeline = extractTimeline(onDisk)
    expect(timeline.some((e) => e.body.includes('superseded'))).toBe(false) // no fabrication

    // The collapsed advises edge is intact; the new employment edge is added.
    links = await client.call('get_links', { slug: 'sam-orr' })
    expect(edgesTo(links, 'smold', 'advises').length).toBe(1) // PRESERVED
    expect(edgesTo(links, 'smnew', 'works_at').length).toBe(1) // ADDED
  }, 60_000)

  test('flag ON: a later DISTINCT update reusing the same prior does NOT inherit a stale supersession note', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-reuseprior-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    const mk = (json: string, ts: number): ReturnType<typeof createScribe> =>
      createScribe({
        substrate: cannedSubstrate(json),
        syncHook,
        ownerDataDir,
        project_slug: 'rb4-reuseprior',
        budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
        writeEntity,
        now: () => ts,
        supersede: true,
      })

    // 1) works_at Oldrx, then 2) genuine supersession Oldrx → Newrx.
    await mk(factA('Rex Doe', 'Oldrx'), t0).extractAndWrite({
      text: 'Rex Doe is a staff engineer at Oldrx, where he has anchored the platform team for years now.',
      observed_at: t0,
    })
    await mk(factSupersede('Rex Doe', 'Oldrx', 'Newrx'), t0 + 1000).extractAndWrite({
      text: 'Rex Doe has moved on from Oldrx and now works at Newrx, leading their infrastructure group day to day.',
      observed_at: t0 + 1000,
    })

    // 3) A LATER, DISTINCT turn reuses the SAME prior (Oldrx) with a DIFFERENT
    //    replacement (Otherrx). Oldrx is already gone, so this retires nothing.
    await mk(factSupersede('Rex Doe', 'Oldrx', 'Otherrx'), t0 + 2000).extractAndWrite({
      text: 'Rex Doe also picked up an advisory-turned-role at Otherrx recently, adding to an already full plate.',
      observed_at: t0 + 2000,
    })

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'rex-doe.md'), 'utf8')
    const timeline = extractTimeline(onDisk)
    // The FIRST, genuine transition is recorded exactly once…
    expect(timeline.filter((e) => e.body.includes('superseded works_at: oldrx → newrx')).length).toBe(1)
    // …and the distinct third turn does NOT fabricate a `oldrx → otherrx` note
    // (it retired nothing) — it records the additive assertion instead.
    expect(timeline.some((e) => e.body.includes('superseded works_at: oldrx → otherrx'))).toBe(false)
    expect(timeline.some((e) => e.body.includes('works_at otherrx'))).toBe(true)

    // Graph: Oldrx gone (retired by turn 2); Newrx + Otherrx both current.
    const links = await client.call('get_links', { slug: 'rex-doe' })
    expect(edgesTo(links, 'oldrx', 'works_at').length).toBe(0)
    expect(edgesTo(links, 'newrx', 'works_at').length).toBe(1)
    expect(edgesTo(links, 'otherrx', 'works_at').length).toBe(1)
  }, 60_000)

  test('flag ON: re-delivering the SAME transition at a LATER ts is additive, not a second supersession', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-later-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    const mk = (json: string, ts: number): ReturnType<typeof createScribe> =>
      createScribe({
        substrate: cannedSubstrate(json),
        syncHook,
        ownerDataDir,
        project_slug: 'rb4-later',
        budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
        writeEntity,
        now: () => ts,
        supersede: true,
      })

    await mk(factA('Tia Vex', 'Toldv'), t0).extractAndWrite({
      text: 'Tia Vex is a staff engineer at Toldv, where she has run the platform team for a good while now.',
      observed_at: t0,
    })
    // Genuine supersession at t0+1000 → records the transition once.
    await mk(factSupersede('Tia Vex', 'Toldv', 'Tnewv'), t0 + 1000).extractAndWrite({
      text: 'Tia Vex has moved on from Toldv and now works at Tnewv, leading their reliability org day to day.',
      observed_at: t0 + 1000,
    })
    // The SAME transition re-delivered at a DIFFERENT (later) ts. This is NOT a
    // replay — Toldv is already gone, so it retired nothing and must NOT stamp a
    // second dated supersession; it records the current fact additively.
    await mk(factSupersede('Tia Vex', 'Toldv', 'Tnewv'), t0 + 2000).extractAndWrite({
      text: 'Tia Vex, now at Tnewv (no longer Toldv), continues to scale their reliability practice this half.',
      observed_at: t0 + 2000,
    })

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'tia-vex.md'), 'utf8')
    const timeline = extractTimeline(onDisk)
    // Exactly ONE dated supersession event (from t0+1000) — no duplicate at t0+2000.
    const superRows = timeline.filter((e) => e.body.includes('superseded works_at: toldv → tnewv'))
    expect(superRows.length).toBe(1)
    expect(superRows[0]!.ts).toBe(new Date(t0 + 1000).toISOString())
    // The later re-delivery landed an ADDITIVE row instead.
    const laterRow = timeline.find((e) => e.ts === new Date(t0 + 2000).toISOString())
    expect(laterRow).toBeDefined()
    expect(laterRow!.body.includes('superseded')).toBe(false)
    expect(laterRow!.body.includes('works_at tnewv')).toBe(true)

    const links = await client.call('get_links', { slug: 'tia-vex' })
    expect(edgesTo(links, 'toldv', 'works_at').length).toBe(0)
    expect(edgesTo(links, 'tnewv', 'works_at').length).toBe(1)
  }, 60_000)

  test('flag ON: CONFLICTING supersedes for one prior (untrusted LLM) resolve to a single supersession', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-conflict-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'zold',
      content: '---\nslug: zold\ntype: company\n---\n\nA company.\n',
    })
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'zoe-park',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'zoe-park', type: 'person', name: 'Zoe Park' },
          compiledTruth: '# Zoe Park\n\nAn engineer.\n\n## Relationships\n\n- Works at [[zold]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )

    // The extractor (untrusted) emits TWO conflicting supersedes of the same prior.
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Zoe Park', kind: 'person', fact: 'an engineer' },
            { name: 'Cona', kind: 'company', fact: 'employer A' },
            { name: 'Conb', kind: 'company', fact: 'employer B' },
          ],
          relations: [
            { subject: 'Zoe Park', predicate: 'works_at', object: 'Cona', supersedes: 'Zold' },
            { subject: 'Zoe Park', predicate: 'works_at', object: 'Conb', supersedes: 'Zold' },
          ],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-conflict',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Zoe Park has left Zold; the notes are muddled on whether she landed at Cona or Conb, but it is one of them now.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'zoe-park.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // Zold is retired once; both candidate employers accrete (no data loss).
    expect(compiled).not.toContain('[[zold]]')
    expect(compiled).toContain('Works at [[cona]].')
    expect(compiled).toContain('Works at [[conb]].')

    const timeline = extractTimeline(onDisk)
    // EXACTLY ONE supersession is recorded — the deterministic winner (cona < conb)…
    expect(timeline.filter((e) => e.body.includes('superseded works_at: zold →')).length).toBe(1)
    expect(timeline.some((e) => e.body.includes('superseded works_at: zold → cona'))).toBe(true)
    // …never the contradictory second transition.
    expect(timeline.some((e) => e.body.includes('superseded works_at: zold → conb'))).toBe(false)

    const links = await client.call('get_links', { slug: 'zoe-park' })
    expect(edgesTo(links, 'zold', 'works_at').length).toBe(0) // retired once
    expect(edgesTo(links, 'cona', 'works_at').length).toBe(1)
    expect(edgesTo(links, 'conb', 'works_at').length).toBe(1)
  }, 60_000)

  test('flag ON: superseding into an object already carrying a stronger predicate — prior retired, KG keeps the strongest edge', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-rb4-stronger-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    await client.call('put_page', {
      slug: 'ulold',
      content: '---\nslug: ulold\ntype: company\n---\n\nA company.\n',
    })
    await client.call('put_page', {
      slug: 'ulnew',
      content: '---\nslug: ulnew\ntype: company\n---\n\nA company.\n',
    })
    // The subject already ADVISES ulnew (stronger than works_at) and works_at ulold.
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'uwe-lang',
        originInstance: 'rb4',
        receivingInstanceSlug: 'rb4',
        body: {
          frontmatter: { slug: 'uwe-lang', type: 'person', name: 'Uwe Lang' },
          compiledTruth:
            '# Uwe Lang\n\nAn operator.\n\n## Relationships\n\n- Works at [[ulold]].\n- Advises [[ulnew]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    let links = await client.call('get_links', { slug: 'uwe-lang' })
    expect(edgesTo(links, 'ulold', 'works_at').length).toBe(1)
    expect(edgesTo(links, 'ulnew', 'advises').length).toBe(1)

    const scribe = createScribe({
      substrate: cannedSubstrate(factSupersede('Uwe Lang', 'Ulold', 'Ulnew')),
      syncHook,
      ownerDataDir,
      project_slug: 'rb4-stronger',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
      supersede: true,
    })
    const out = await scribe.extractAndWrite({
      text: 'Uwe Lang has moved on from Ulold and now works at Ulnew, the firm he had already been advising for a while.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'uwe-lang.md'), 'utf8')
    const compiled = extractCompiledTruth(onDisk)
    // The prior is retired; the new employment prose accretes; the advisory stays.
    expect(compiled).not.toContain('[[ulold]]')
    expect(compiled).toContain('Advises [[ulnew]].')
    expect(compiled).toContain('Works at [[ulnew]].')
    // The transition is recorded in the dated history.
    const timeline = extractTimeline(onDisk)
    expect(timeline.some((e) => e.body.includes('superseded works_at: ulold → ulnew'))).toBe(true)

    // Graph: Ulold retired; the subject's edge to Ulnew is the STRONGEST predicate
    // (advises) per the pre-existing KG one-edge-per-pair collapse — a current-truth
    // edge to Ulnew, not a separate works_at edge.
    links = await client.call('get_links', { slug: 'uwe-lang' })
    expect(edgesTo(links, 'ulold', 'works_at').length).toBe(0) // RETIRED
    expect(edgesTo(links, 'ulnew', 'advises').length).toBe(1) // strongest edge to the replacement
  }, 60_000)
})
