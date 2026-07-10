/**
 * Scribe → GBrain real-PGLite round-trip.
 *
 * Stands up an ACTUAL in-memory GBrain brain (the `gbrain` devDependency's
 * `PGLiteEngine` + `operations`, 100+ real schema migrations applied) — the
 * same harness `gbrain-memory/__tests__/sync-hook.test.ts` uses — and drives
 * the FULL scribe stack against it:
 *
 *   fake substrate (canned extraction JSON)
 *     → createScribe.extractAndWrite
 *     → REAL runtime/entity-writer.ts:writeEntity (writes markdown to a temp dir)
 *     → REAL GBrainSyncHook.onEntityWrite (put_page + add_link)
 *     → REAL GBrain PGLite storage
 *
 * Then asserts the entity page + typed edge are retrievable from GBrain. NOT a
 * stub — the data actually transits GBrain's storage layer.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { McpClient } from '@neutronai/gbrain-memory/mcp-client.ts'
import { GBrainMemoryStore } from '@neutronai/gbrain-memory/gbrain-memory-store.ts'
import { GBrainSyncHook } from '@neutronai/gbrain-memory/GBrainSyncHook.ts'
import { writeEntity } from '@neutronai/runtime/entity-writer.ts'
import { createScribe } from '../index.ts'
import { createState } from '../scribe-budget.ts'
import { bootPgliteBrain } from '@neutronai/gbrain-memory/__tests__/boot-pglite-brain.ts'

const t0 = Date.now()

/** Fake substrate that emits a canned extraction document then completes. */
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

describe('scribe → GBrain real PGLite round-trip', () => {
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
    // 100+ migrations against in-memory PGLite (~7s) — generous boot budget.
  }, 60_000)

  afterAll(async () => {
    if (engine !== undefined) await engine.disconnect()
  }, 30_000)

  test('a chat turn with extractable facts lands entity pages + a typed edge in GBrain', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-project-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    const extraction = JSON.stringify({
      entities: [
        { name: 'Sarah Patel', kind: 'person', fact: 'VP of Engineering, leads the platform team' },
        { name: 'Acme', kind: 'company', fact: 'an enterprise SaaS startup' },
      ],
      relations: [{ subject: 'Sarah Patel', predicate: 'works_at', object: 'Acme' }],
    })

    const scribe = createScribe({
      substrate: cannedSubstrate(extraction),
      syncHook,
      ownerDataDir,
      project_slug: 'acme-project',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0,
    })

    const turn =
      'Had a great call today with Sarah Patel, the VP of Engineering at Acme — she leads ' +
      'their platform team and is thinking about a big re-architecture next quarter.'
    const out = await scribe.extractAndWrite({ text: turn, observed_at: t0 })

    expect(out.ran).toBe(true)
    if (!out.ran) throw new Error('unreachable')
    expect(out.report.pages_written).toBe(2)
    expect(out.report.edges_emitted).toBeGreaterThanOrEqual(1)

    // Entity page landed in GBrain (put_page via the MemoryStore).
    const sarahPage = (await client.call('get_page', { slug: 'sarah-patel' })) as Record<
      string,
      unknown
    > | null
    expect(sarahPage).not.toBeNull()
    expect(sarahPage!['slug']).toBe('sarah-patel')

    const acmePage = (await client.call('get_page', { slug: 'acme' })) as Record<
      string,
      unknown
    > | null
    expect(acmePage).not.toBeNull()

    // Typed edge (sarah-patel, works_at, acme) landed and is retrievable.
    const links = await client.call('get_links', { slug: 'sarah-patel' })
    expect(edgesTo(links, 'acme', 'works_at').length).toBe(1)
  }, 60_000)

  test('re-running the same turn is idempotent (no duplicate pages/edges)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-project-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    const extraction = JSON.stringify({
      entities: [
        { name: 'Marcus Vela', kind: 'person', fact: 'founder of Volt' },
        { name: 'Volt', kind: 'company', fact: 'energy-storage startup' },
      ],
      relations: [{ subject: 'Marcus Vela', predicate: 'founded', object: 'Volt' }],
    })
    const mkScribe = (): ReturnType<typeof createScribe> =>
      createScribe({
        substrate: cannedSubstrate(extraction),
        syncHook,
        ownerDataDir,
        project_slug: 'acme-project',
        budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
        writeEntity,
        now: () => t0,
      })
    const turn =
      'Caught up with Marcus Vela this morning — he founded Volt, the energy-storage startup, ' +
      'and is raising a seed round to expand the engineering team.'

    const first = await mkScribe().extractAndWrite({ text: turn, observed_at: t0 })
    expect(first.ran).toBe(true)
    if (first.ran) expect(first.report.pages_written).toBe(2)

    // Second identical run: the entity-writer short-circuits byte-equal
    // rewrites → 0 new pages, and the edge stays single.
    const second = await mkScribe().extractAndWrite({ text: turn, observed_at: t0 })
    expect(second.ran).toBe(true)
    if (second.ran) expect(second.report.pages_written).toBe(0)

    const links = await client.call('get_links', { slug: 'marcus-vela' })
    expect(edgesTo(links, 'volt', 'founded').length).toBe(1)
  }, 60_000)

  test('a sparse chat turn does NOT erase a richer existing page (append-only; no edge retraction)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-project-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    // 1) Seed a RICH existing page (as onboarding/import would): Ada Lovelace
    //    with a founded→analytical-engine edge. Pre-create the edge target so
    //    add_link's endpoints both exist.
    await client.call('put_page', {
      slug: 'analytical-engine',
      content: '---\nslug: analytical-engine\ntype: concept\n---\n\nThe engine.\n',
    })
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'ada-lovelace',
        originInstance: 'roundtrip',
        receivingInstanceSlug: 'roundtrip',
        body: {
          frontmatter: { slug: 'ada-lovelace', type: 'person', name: 'Ada Lovelace' },
          compiledTruth:
            '# Ada Lovelace\n\nThe first computer programmer; wrote the first algorithm.\n\n## Relationships\n\n- Founded [[analytical-engine]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    // Sanity: the onboarding edge + rich prose are present.
    let links = await client.call('get_links', { slug: 'ada-lovelace' })
    expect(edgesTo(links, 'analytical-engine', 'founded').length).toBe(1)

    // 2) A LATER sparse chat turn mentions Ada with only a NEW relation.
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Ada Lovelace', kind: 'person', fact: 'mathematician' },
            { name: 'Babbage Co', kind: 'company', fact: 'engine works' },
          ],
          relations: [{ subject: 'Ada Lovelace', predicate: 'works_at', object: 'Babbage Co' }],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'acme-project',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
    })
    const out = await scribe.extractAndWrite({
      text:
        'Mentioned Ada Lovelace again today — she now works at Babbage Co on the engine project, ' +
        'still the sharpest mathematician on the team.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    // 3) The onboarding edge MUST survive (no retraction), AND the new edge is added.
    links = await client.call('get_links', { slug: 'ada-lovelace' })
    expect(edgesTo(links, 'analytical-engine', 'founded').length).toBe(1) // PRESERVED
    expect(edgesTo(links, 'babbage-co', 'works_at').length).toBe(1) // ADDED

    // 4) The rich compiled-truth prose MUST survive (append-only, not overwritten).
    const page = (await client.call('get_page', { slug: 'ada-lovelace' })) as Record<
      string,
      unknown
    > | null
    const pageText = JSON.stringify(page)
    expect(pageText).toContain('first computer programmer')
    expect(pageText).toContain('analytical-engine')
  }, 60_000)

  test('a chat append over an import-seeded page PRESERVES populator frontmatter (mention_count + category)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-project-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    // 1) Seed a page the way the import populator would: rich frontmatter with
    //    `mention_count` + `category:'inferred_interest'` + an original source
    //    citation. `writeEntity` renders frontmatter wholesale, so a later
    //    scribe touch with minimal frontmatter would clobber these unless scribe
    //    merges.
    await writeEntity(
      {
        ownerDataDir,
        kind: 'concept',
        slug: 'rock-climbing',
        originInstance: 'roundtrip',
        receivingInstanceSlug: 'roundtrip',
        body: {
          frontmatter: {
            slug: 'rock-climbing',
            type: 'concept',
            name: 'Rock Climbing',
            source: 'import:gmail',
            mention_count: 7,
            category: 'inferred_interest',
          },
          compiledTruth: '# Rock Climbing\n\nInferred non-work interest from your Gmail import.\n',
          timelineAppend: {
            ts: new Date(t0).toISOString(),
            source: 'import:gmail',
            body: 'seeded by import',
          },
        },
      },
      { syncHook },
    )

    // 2) A later chat turn mentions the same concept.
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [{ name: 'Rock Climbing', kind: 'concept', fact: 'a weekend hobby' }],
          relations: [],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'acme-project',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
    })
    const out = await scribe.extractAndWrite({
      text:
        'Spent the weekend rock climbing again — really getting into it as a way to unwind ' +
        'outside of work hours.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    // 3) The populator's frontmatter MUST survive the chat rewrite.
    const onDisk = readFileSync(
      join(ownerDataDir, 'entities', 'concepts', 'rock-climbing.md'),
      'utf8',
    )
    const fm = onDisk.slice(0, onDisk.indexOf('\n---\n', 4))
    expect(fm).toContain('mention_count: 7') // PRESERVED (would be dropped pre-fix)
    expect(fm).toContain('category: inferred_interest') // PRESERVED — no reclassification
    expect(fm).toContain('name: Rock Climbing') // scribe-authoritative, retained
    expect(fm).toContain('source: "chat:acme-project"') // scribe overrides source it owns (YAML-quoted: has a colon)
  }, 60_000)

  test('a later turn UPGRADES the predicate to an already-mentioned target (edge reaches the graph)', async () => {
    const ownerDataDir = mkdtempSync(join(tmpdir(), 'scribe-project-'))
    const syncHook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })

    // 1) Seed the edge target + a person page that already MENTIONS it (the weak
    //    predicate), as onboarding or an earlier chat turn would have left it.
    await writeEntity(
      {
        ownerDataDir,
        kind: 'company',
        slug: 'globex',
        originInstance: 'roundtrip',
        receivingInstanceSlug: 'roundtrip',
        body: {
          frontmatter: { slug: 'globex', type: 'company', name: 'Globex' },
          compiledTruth: '# Globex\n\nA company.\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )
    await writeEntity(
      {
        ownerDataDir,
        kind: 'person',
        slug: 'dana-wu',
        originInstance: 'roundtrip',
        receivingInstanceSlug: 'roundtrip',
        body: {
          frontmatter: { slug: 'dana-wu', type: 'person', name: 'Dana Wu' },
          compiledTruth:
            '# Dana Wu\n\nAn engineer.\n\n## Relationships\n\n- Mentions [[globex]].\n',
          timelineAppend: { ts: new Date(t0).toISOString(), source: 'import:onboarding', body: 'seeded' },
        },
      },
      { syncHook },
    )

    // 2) A later chat turn extracts a STRONGER predicate to the same target.
    const scribe = createScribe({
      substrate: cannedSubstrate(
        JSON.stringify({
          entities: [
            { name: 'Dana Wu', kind: 'person', fact: 'engineer' },
            { name: 'Globex', kind: 'company', fact: 'employer' },
          ],
          relations: [{ subject: 'Dana Wu', predicate: 'works_at', object: 'Globex' }],
        }),
      ),
      syncHook,
      ownerDataDir,
      project_slug: 'acme-project',
      budget: createState(join(ownerDataDir, '.scribe-budget.json'), t0),
      writeEntity,
      now: () => t0 + 1000,
    })
    const out = await scribe.extractAndWrite({
      text:
        'Talked to Dana Wu today — turns out she actually works at Globex now, leading their ' +
        'backend platform team.',
      observed_at: t0 + 1000,
    })
    expect(out.ran).toBe(true)

    // 3) The new predicate edge reached GBrain (the upgrade was NOT dropped just
    //    because [[globex]] was already referenced)…
    const links = await client.call('get_links', { slug: 'dana-wu' })
    expect(edgesTo(links, 'globex', 'works_at').length).toBe(1) // ADDED (the fix)

    // …and the weaker `mentions` EDGE was superseded in the graph (#390 MINOR):
    //   auto-link collapses to the strongest predicate → removedLinks=[mentions
    //   globex] → predicate-blind remove_link nukes the pair → add_link works_at.
    //   So the graph holds works_at, NOT mentions — supersede, not duplicate.
    expect(edgesTo(links, 'globex', 'mentions').length).toBe(0) // SUPERSEDED

    // …and the original line is preserved verbatim (no retraction).
    const onDisk = readFileSync(join(ownerDataDir, 'entities', 'people', 'dana-wu.md'), 'utf8')
    expect(onDisk).toContain('Mentions [[globex]].') // PRESERVED
    expect(onDisk).toContain('Works at [[globex]].') // APPENDED
  }, 60_000)
})
