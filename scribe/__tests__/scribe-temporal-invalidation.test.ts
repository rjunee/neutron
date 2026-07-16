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
})
