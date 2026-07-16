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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
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

  test('a loser whose on-disk deletion FAILS is retained + not counted as merged', async () => {
    const owner = tmpOwner()
    await seed(owner, 'company', 'acme', 'Acme', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    await seed(owner, 'company', 'acme-co', 'Acme Co', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'c' },
    ])
    // removeFile always rejects with a NON-ENOENT error → deletion "fails".
    const report = await runReflectPass({
      ...baseDeps(owner),
      removeFile: async (): Promise<void> => {
        const err = new Error('EACCES') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      },
    })
    // Merge is NOT reported (both files still on disk), and the loser survives.
    expect(report.merged).toBe(0)
    expect(existsSync(join(owner, 'entities', 'companies', 'acme-co.md'))).toBe(true)
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

describe('reflect path containment (untrusted frontmatter slug)', () => {
  test('a page with a traversal slug is skipped — never read or deleted', async () => {
    const owner = tmpOwner()
    // A REAL secret outside the entities tree the traversal would target.
    writeFileSync(join(owner, 'secret.md'), '# TOP SECRET\n\nsomething private\n')
    // A page file whose FRONTMATTER slug escapes the entities dir. The enumerator
    // trusts the frontmatter slug, so the pass must reject it by grammar.
    mkdirSync(join(owner, 'entities', 'companies'), { recursive: true })
    writeFileSync(
      join(owner, 'entities', 'companies', 'evil.md'),
      '---\nslug: ../../secret\ntype: company\nname: Evil\n---\n\nEvil corp.\n\n---\n\n## Timeline\n\n',
    )
    // A legit page so the pass still has work to do.
    await seed(owner, 'company', 'good', 'Good', 'Good is a real company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'note' },
    ])
    const deleted: string[] = []
    const report = await runReflectPass({
      ...baseDeps(owner),
      deletePage: async (slug: string): Promise<void> => {
        deleted.push(slug)
      },
    })
    // The traversal page never counted, the secret is untouched, nothing merged.
    expect(report.merged).toBe(0)
    expect(deleted).not.toContain('../../secret')
    expect(existsSync(join(owner, 'secret.md'))).toBe(true)
    const secret = await readFile(join(owner, 'secret.md'), 'utf8')
    expect(secret).toContain('TOP SECRET') // never deleted
  })

  test('a slug-alias page cannot cause deletion of an unrelated canonical page', async () => {
    const owner = tmpOwner()
    // The canonical page `good.md` (frontmatter slug matches filename).
    await seed(owner, 'company', 'good', 'Good', 'Good is a real developer-tools company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'note' },
    ])
    // A hostile ALIAS: filename `evil.md`, frontmatter `slug: good` + identical body
    // (would cluster with `good` and, under filename-from-slug reconstruction,
    // resolve both cluster members to `good.md` → unlink the canonical page).
    writeFileSync(
      join(owner, 'entities', 'companies', 'evil.md'),
      '---\nslug: good\ntype: company\nname: Good\n---\n\nGood is a real developer-tools company.\n\n---\n\n## Timeline\n\n',
    )
    const report = await runReflectPass(baseDeps(owner))
    // The alias is rejected (identity = filename, mismatch skipped): no merge, and
    // the canonical page survives intact.
    expect(report.merged).toBe(0)
    expect(existsSync(join(owner, 'entities', 'companies', 'good.md'))).toBe(true)
  })

  test('a symlinked kind dir is never traversed for read OR delete', async () => {
    const owner = tmpOwner()
    // An OUTSIDE directory holding two would-be-duplicate pages.
    const outside = mkdtempSync(join(tmpdir(), 'reflect-outside-'))
    const page = (name: string): string =>
      `---\nslug: ${name}\ntype: company\nname: ${name}\n---\n\nAcme is a developer-tools SaaS company.\n\n---\n\n## Timeline\n\n- 2026-07-01T00:00:00.000Z | s | x\n`
    writeFileSync(join(outside, 'acme.md'), page('acme'))
    writeFileSync(join(outside, 'acme-co.md'), page('acme-co'))
    // entities/companies is a SYMLINK to the outside dir (an ancestor redirect).
    mkdirSync(join(owner, 'entities'), { recursive: true })
    symlinkSync(outside, join(owner, 'entities', 'companies'))

    const report = await runReflectPass(baseDeps(owner))
    // The symlinked kind dir is rejected by containment → no pages loaded, no
    // merge, and NEITHER outside file is deleted.
    expect(report.merged).toBe(0)
    expect(existsSync(join(outside, 'acme.md'))).toBe(true)
    expect(existsSync(join(outside, 'acme-co.md'))).toBe(true)
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

  test('re-extraction is APPEND-ONLY over an existing reserved page (no clobber)', async () => {
    const owner = tmpOwner()
    // A pre-existing, RICH project page with multiple facts + a wikilink edge.
    const rich =
      '# Perfect Recall\n\nA memory-uplift initiative. Sponsored by [[sarah-patel]]. Targets Q4 GA.'
    await seed(owner, 'project', 'perfect-recall', 'Perfect Recall', rich, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'seed', body: 'kicked off' },
    ])
    // The reflect extraction re-mentions it with only ONE thin fact.
    const { substrate } = scriptedSubstrate((prompt) =>
      prompt.includes('DIGEST:')
        ? JSON.stringify({
            entities: [{ name: 'Perfect Recall', kind: 'project', fact: 'in progress' }],
          })
        : '{"entities":[]}',
    )
    await runReflectPass({ ...baseDeps(owner), substrate })
    // The rich compiled-truth (both facts + the wikilink) is preserved verbatim —
    // never replaced by the one-fact digest, so no edge/fact is retracted.
    const page = await readPage(owner, 'projects', 'perfect-recall')
    const ct = extractCompiledTruth(page!)
    expect(ct).toContain('memory-uplift initiative')
    expect(ct).toContain('Targets Q4 GA')
    expect(ct).toContain('[[sarah-patel]]') // graph edge intact
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

  test('an UNCHANGED re-synthesis is a true no-op (no write, no marker, no count)', async () => {
    const owner = tmpOwner()
    const truth = 'Works at [[initech]].'
    await seed(owner, 'person', 'lee', 'Lee', truth, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'r1' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'r2' },
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'r3' },
    ])
    // The LLM returns the already-consolidated truth verbatim.
    const { substrate } = scriptedSubstrate((prompt) =>
      prompt.includes('DIGEST:') ? '{"entities":[]}' : truth,
    )
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    expect(report.resynthesized).toBe(0) // no phantom consolidation
    const page = await readPage(owner, 'people', 'lee')
    // No marker row was appended — the timeline is exactly the 3 seeded rows.
    const bodies = extractTimeline(page!).map((e) => e.body)
    expect(bodies).toEqual(['r3', 'r2', 'r1'])
    expect(bodies.some((b) => b.includes('Consolidated'))).toBe(false)
  })

  test('reserved extraction sees the SAME-pass consolidated truth (freshness)', async () => {
    const owner = tmpOwner()
    // Compiled-truth does NOT mention the project; the timeline does. Re-synthesis
    // lifts it into compiled-truth, and the reserved extraction (same pass) must
    // then see it.
    await seed(owner, 'person', 'mira', 'Mira', 'Mira is a product manager.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'kicked off Project Zephyr' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'r2' },
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'r3' },
    ])
    const { substrate } = scriptedSubstrate((prompt) => {
      if (prompt.includes('DIGEST:')) {
        // Only emit the project when the digest ALREADY carries the consolidated
        // mention — proving extraction ran on post-resynthesis content.
        return prompt.includes('Project Zephyr')
          ? JSON.stringify({ entities: [{ name: 'Project Zephyr', kind: 'project', fact: 'led by Mira' }] })
          : '{"entities":[]}'
      }
      // Re-synthesis lifts the project from the timeline into compiled-truth.
      return 'Mira is a product manager leading Project Zephyr.'
    })
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    expect(report.resynthesized).toBe(1)
    expect(report.reservedWritten).toBeGreaterThanOrEqual(1)
    expect(await readPage(owner, 'projects', 'project-zephyr')).not.toBeNull()
  })
})
