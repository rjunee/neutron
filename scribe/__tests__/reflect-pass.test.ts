/**
 * RB3 reflect — the consolidation batch pass, end-to-end over REAL on-disk
 * entity pages (real `writeEntity`, temp `ownerDataDir`, no brain needed).
 *
 * Covers the three acceptance gates:
 *   1. DEDUP — two near-duplicate pages collapse into one; the loser is deleted
 *      and the survivor keeps BOTH pages' timeline history (deterministic; 0 LLM).
 *   2. RESERVED KINDS — an input that should yield a `meeting` entity is written
 *      by the reflect pass, where Scribe alone (person/company/concept only) never
 *      would.
 *   3. COST CONFINEMENT — a normal `writeEntity` save invokes the batch substrate
 *      ZERO times; only the reflect pass does. A no-substrate pass makes ZERO LLM
 *      calls yet still dedups. Re-synthesis can never drop a graph edge.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import {
  writeEntity,
  type EntityKind,
} from '@neutronai/runtime/entity-writer.ts'
import { extractTimeline, extractCompiledTruth } from '@neutronai/runtime/entity-format.ts'
import { runReflectPass, type ReflectPassDeps } from '../reflect/reflect-pass.ts'

const OWN = 'owner'
const t0 = Date.parse('2026-07-16T00:00:00.000Z')

function tmpOwner(): string {
  return mkdtempSync(join(tmpdir(), 'reflect-pass-'))
}

/** A substrate whose reply is computed from the prompt. Records call count. */
function scriptedSubstrate(reply: (prompt: string) => string): {
  substrate: Substrate
  calls: () => number
} {
  let n = 0
  const substrate: Substrate = {
    start(spec): SessionHandle {
      n += 1
      const text = reply(spec.prompt)
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
  return { substrate, calls: () => n }
}

/** Seed one entity page on disk via the REAL writer (append-only timeline rows). */
async function seed(
  ownerDataDir: string,
  kind: EntityKind,
  slug: string,
  name: string,
  compiledTruth: string,
  timelineRows: Array<{ ts: string; source: string; body: string }>,
): Promise<void> {
  for (const row of timelineRows) {
    await writeEntity({
      ownerDataDir,
      kind,
      slug,
      body: {
        frontmatter: { slug, type: kind, name, source: 'seed' },
        compiledTruth,
        timelineAppend: row,
      },
      originInstance: OWN,
      receivingInstanceSlug: OWN,
    })
  }
}

async function readPage(ownerDataDir: string, dir: string, slug: string): Promise<string | null> {
  try {
    return await readFile(join(ownerDataDir, 'entities', dir, `${slug}.md`), 'utf8')
  } catch {
    return null
  }
}

function baseDeps(ownerDataDir: string): ReflectPassDeps {
  return {
    ownerDataDir,
    ownSlug: OWN,
    writeEntity: writeEntity as unknown as ReflectPassDeps['writeEntity'],
    now: () => t0,
  }
}

describe('reflect dedup (deterministic, no LLM)', () => {
  test('two near-duplicate pages collapse into one, history preserved', async () => {
    const owner = tmpOwner()
    // acme: richer history (2 rows) → survivor. acme-inc: 1 row → loser.
    await seed(
      owner,
      'company',
      'acme',
      'Acme',
      'Acme is an enterprise SaaS company building developer tooling for platform teams.',
      [
        { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'First mention of Acme' },
        { ts: '2026-07-05T00:00:00.000Z', source: 'chat:owner', body: 'Acme raised a Series B' },
      ],
    )
    await seed(
      owner,
      'company',
      'acme-inc',
      'Acme Inc',
      'Acme Inc is an enterprise SaaS company building developer tooling for platform teams.',
      [{ ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'Acme Inc hired a new CTO' }],
    )

    const deletedSlugs: string[] = []
    const report = await runReflectPass({
      ...baseDeps(owner),
      deletePage: async (slug: string): Promise<void> => {
        deletedSlugs.push(slug)
      },
    })

    expect(report.llmCalls).toBe(0) // no substrate → deterministic dedup only
    expect(report.merged).toBe(1) // one loser merged away

    // The loser page is gone; the survivor remains.
    expect(await readPage(owner, 'companies', 'acme-inc')).toBeNull()
    const survivor = await readPage(owner, 'companies', 'acme')
    expect(survivor).not.toBeNull()
    expect(deletedSlugs).toContain('acme-inc') // brain mirror delete fired

    // History preserved: the survivor's timeline carries BOTH pages' rows plus a
    // dated merge marker.
    const tl = extractTimeline(survivor!)
    const bodies = tl.map((e) => e.body)
    expect(bodies).toContain('First mention of Acme')
    expect(bodies).toContain('Acme raised a Series B')
    expect(bodies).toContain('Acme Inc hired a new CTO') // loser's history survived
    expect(bodies.some((b) => b.startsWith('Merged near-duplicate'))).toBe(true)
  })

  test('distinct pages are NOT merged', async () => {
    const owner = tmpOwner()
    await seed(owner, 'company', 'acme', 'Acme', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'Acme note' },
    ])
    await seed(owner, 'company', 'globex', 'Globex', 'Globex is a freight and logistics conglomerate.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'Globex note' },
    ])
    const report = await runReflectPass(baseDeps(owner))
    expect(report.merged).toBe(0)
    expect(await readPage(owner, 'companies', 'acme')).not.toBeNull()
    expect(await readPage(owner, 'companies', 'globex')).not.toBeNull()
  })
})

describe('reflect reserved-kind extraction (meeting/project/original)', () => {
  test('writes a meeting entity Scribe alone would never produce', async () => {
    const owner = tmpOwner()
    // A person page (1 timeline row → below the resynth gate, so ONLY the reserved
    // extraction call fires) whose content evidences a meeting.
    await seed(
      owner,
      'person',
      'sarah-patel',
      'Sarah Patel',
      'Sarah Patel is VP of Engineering. Presented the roadmap at the Q3 Board Meeting.',
      [{ ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'Met Sarah at the Q3 board meeting' }],
    )
    // Scribe alone never writes a meeting — assert none exists pre-pass.
    expect(await readPage(owner, 'meetings', 'q3-board-meeting')).toBeNull()

    const { substrate, calls } = scriptedSubstrate((prompt) => {
      if (prompt.includes('DIGEST:')) {
        return JSON.stringify({
          entities: [
            { name: 'Q3 Board Meeting', kind: 'meeting', fact: 'Roadmap presented to the board in Q3' },
          ],
        })
      }
      return '{"entities":[]}'
    })

    const report = await runReflectPass({ ...baseDeps(owner), substrate })

    expect(calls()).toBeGreaterThanOrEqual(1)
    expect(report.reservedWritten).toBeGreaterThanOrEqual(1)
    const meeting = await readPage(owner, 'meetings', 'q3-board-meeting')
    expect(meeting).not.toBeNull()
    expect(extractCompiledTruth(meeting!)).toContain('Q3 Board Meeting')
  })
})

describe('reflect cost confinement (tiered-write discipline)', () => {
  test('a normal writeEntity save invokes the batch substrate ZERO times', async () => {
    const owner = tmpOwner()
    const { substrate, calls } = scriptedSubstrate(() => '{"entities":[]}')
    // A normal save — the deterministic per-save path. It must not touch the
    // reflect substrate at all.
    await seed(owner, 'person', 'ada', 'Ada', 'Ada builds compilers.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'Ada note' },
    ])
    expect(calls()).toBe(0)

    // Only the reflect pass spends tokens.
    await runReflectPass({ ...baseDeps(owner), substrate })
    expect(calls()).toBeGreaterThan(0)
  })

  test('a no-substrate pass makes ZERO LLM calls but still dedups', async () => {
    const owner = tmpOwner()
    await seed(owner, 'company', 'acme', 'Acme', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    await seed(owner, 'company', 'acme-co', 'Acme Co', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'c' },
    ])
    const report = await runReflectPass(baseDeps(owner)) // no substrate
    expect(report.llmCalls).toBe(0)
    expect(report.merged).toBe(1)
  })

  test('re-synthesis that would drop a wikilink is rejected (no edge loss)', async () => {
    const owner = tmpOwner()
    const original = 'Works at [[globex]]. A senior staff engineer since 2019.'
    // 3 rows → clears the resynth gate.
    await seed(owner, 'person', 'jordan', 'Jordan', original, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'r1' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'r2' },
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'r3' },
    ])
    // Substrate returns a "tidied" body that DROPS the [[globex]] wikilink.
    const { substrate } = scriptedSubstrate((prompt) =>
      prompt.includes('DIGEST:')
        ? '{"entities":[]}'
        : 'Jordan is a senior staff engineer since 2019.', // no wikilink → must be rejected
    )
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    expect(report.resynthesized).toBe(0) // rejected — edge would be lost
    // The page's compiled-truth is byte-unchanged (still carries the wikilink).
    const page = await readPage(owner, 'people', 'jordan')
    expect(extractCompiledTruth(page!)).toContain('[[globex]]')
  })

  test('an edge-preserving re-synthesis IS accepted', async () => {
    const owner = tmpOwner()
    await seed(owner, 'person', 'kim', 'Kim', 'Works at [[initech]].', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'r1' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'r2' },
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'r3' },
    ])
    const { substrate } = scriptedSubstrate((prompt) =>
      prompt.includes('DIGEST:')
        ? '{"entities":[]}'
        : 'Kim works at [[initech]] and leads the data team.', // preserves the wikilink
    )
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    expect(report.resynthesized).toBe(1)
    const page = await readPage(owner, 'people', 'kim')
    expect(extractCompiledTruth(page!)).toContain('leads the data team')
    expect(extractCompiledTruth(page!)).toContain('[[initech]]') // edge kept
  })
})
