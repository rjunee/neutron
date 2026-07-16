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
  deleteEntity,
  type EntityKind,
} from '@neutronai/runtime/entity-writer.ts'
import { extractTimeline, extractCompiledTruth } from '@neutronai/runtime/entity-format.ts'
import {
  runReflectPass,
  type ReflectPassDeps,
  type ReflectWriteEntity,
  type ReflectDeleteEntity,
} from '../reflect/reflect-pass.ts'

const realWrite = writeEntity as unknown as ReflectWriteEntity

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
  })

  test('cross-kind slug collision: the GBrain delete is SKIPPED (no sibling eviction)', async () => {
    const owner = tmpOwner()
    const boiler = 'Acme is an enterprise developer-tools SaaS company building platform tooling.'
    // Two DUPLICATE company pages that cluster (shared boilerplate). `acme` has
    // more history → survivor; `shared` → loser (its slug is `shared`).
    await seed(owner, 'company', 'acme', 'Acme', boiler, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    await seed(owner, 'company', 'shared', 'Acme Shared', boiler, [
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'company-shared-row' },
    ])
    // A PERSON that COLLIDES on the bare slug `shared` — it is the current GBrain
    // page for slug "shared" (GBrain keys by slug alone, kind-blind).
    await seed(owner, 'person', 'shared', 'Shared Person', 'Shared is a person the owner knows.', [
      { ts: '2026-07-04T00:00:00.000Z', source: 'chat:owner', body: 'person-row' },
    ])

    const deletedSlugs: string[] = []
    const report = await runReflectPass({
      ...baseDeps(owner),
      deletePage: async (slug: string): Promise<void> => {
        deletedSlugs.push(slug)
      },
    })

    // The COMPANY dedup collapsed (disk delete is kind-qualified → companies/shared.md gone).
    expect(report.merged).toBe(1)
    expect(await readPage(owner, 'companies', 'shared')).toBeNull()
    expect(extractTimeline((await readPage(owner, 'companies', 'acme'))!).map((e) => e.body)).toContain(
      'company-shared-row',
    )
    // The PERSON 'shared' page is untouched on disk...
    expect(await readPage(owner, 'people', 'shared')).not.toBeNull()
    // ...and — the fix — the bare-slug GBrain delete was SKIPPED for 'shared' (a
    // different kind still claims it), so the person's GBrain page is NOT evicted.
    // MUTATION-KILL: reverting to unconditional deps.deletePage(l.slug) puts
    // 'shared' in deletedSlugs and fails here.
    expect(deletedSlugs).not.toContain('shared')
  })

  test('cross-kind collision CREATED after the snapshot is still not evicted (live recheck)', async () => {
    const owner = tmpOwner()
    const boiler = 'Acme is an enterprise developer-tools SaaS company building platform tooling.'
    await seed(owner, 'company', 'acme', 'Acme', boiler, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    await seed(owner, 'company', 'shared', 'Acme Shared', boiler, [
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'company-shared-row' },
    ])
    const deletedSlugs: string[] = []
    const report = await runReflectPass({
      ...baseDeps(owner),
      // A person 'shared' is created AFTER the snapshot (not in the stale index) and
      // synced to the kind-blind GBrain key. The live pre-delete recheck must still
      // see it and skip the bare-slug brain delete.
      onAfterSnapshot: async (): Promise<void> => {
        await writeEntity({
          ownerDataDir: owner,
          kind: 'person',
          slug: 'shared',
          body: {
            frontmatter: { slug: 'shared', type: 'person', name: 'Shared Person', source: 'chat' },
            compiledTruth: 'Shared is a person the owner knows.',
            timelineAppend: { ts: '2026-07-09T00:00:00.000Z', source: 'chat:owner', body: 'person-row' },
          },
          originInstance: OWN,
          receivingInstanceSlug: OWN,
        })
      },
      deletePage: async (slug: string): Promise<void> => {
        deletedSlugs.push(slug)
      },
    })
    expect(report.merged).toBe(1)
    expect(await readPage(owner, 'companies', 'shared')).toBeNull() // company loser gone
    expect(await readPage(owner, 'people', 'shared')).not.toBeNull() // the mid-pass person survives
    // MUTATION-KILL: a stale-snapshot check would miss the mid-pass person and call
    // deletePage('shared'); the LIVE recheck skips it.
    expect(deletedSlugs).not.toContain('shared')
  })

  test('a loser whose on-disk deletion FAILS is retained + not counted as merged', async () => {
    const owner = tmpOwner()
    const boiler = 'Acme is an enterprise developer-tools SaaS company building platform tooling.'
    await seed(owner, 'company', 'acme', 'Acme', boiler, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    // The loser shares the boilerplate (clusters) but carries a UNIQUE edge.
    await seed(owner, 'company', 'acme-co', 'Acme Co', `${boiler} Advises [[globex]].`, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'c' },
    ])
    // deleteEntity always throws → deletion "fails".
    const failingDelete = async (): Promise<{ deleted: boolean; conflict: boolean }> => {
      throw new Error('EACCES')
    }
    const report = await runReflectPass({ ...baseDeps(owner), deleteEntity: failingDelete })
    // Merge is NOT reported (deletion failed), but SURVIVOR-FIRST means the survivor
    // durably absorbed the loser's content before the (failed) delete — so no loss.
    expect(report.merged).toBe(0)
    expect(existsSync(join(owner, 'entities', 'companies', 'acme-co.md'))).toBe(true)
    const afterFirst = await readPage(owner, 'companies', 'acme')
    // The survivor holds the loser's unique edge + its history row.
    expect(afterFirst).toContain('[[globex]]')
    expect(extractTimeline(afterFirst!).map((e) => e.body)).toContain('c')

    // IDEMPOTENCE: a SECOND pass (deletion still failing) is byte-identical — the
    // content-idempotent fold never re-adds an already-present loser body.
    const report2 = await runReflectPass({ ...baseDeps(owner), deleteEntity: failingDelete })
    expect(report2.merged).toBe(0)
    const afterSecond = await readPage(owner, 'companies', 'acme')
    expect(afterSecond).toBe(afterFirst) // no duplicate fold / timeline growth
  })

  test('a concurrent write to a cluster member aborts the merge (no clobber, no wrong delete)', async () => {
    const owner = tmpOwner()
    await seed(owner, 'company', 'acme', 'Acme', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    await seed(owner, 'company', 'acme-co', 'Acme Co', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'c' },
    ])
    const report = await runReflectPass({
      ...baseDeps(owner),
      // A concurrent user write lands on the loser AFTER the snapshot, BEFORE merge.
      onAfterSnapshot: async (): Promise<void> => {
        await writeEntity({
          ownerDataDir: owner,
          kind: 'company',
          slug: 'acme-co',
          body: {
            frontmatter: { slug: 'acme-co', type: 'company', name: 'Acme Co', source: 'chat' },
            compiledTruth: 'Acme is a developer-tools SaaS company.',
            timelineAppend: { ts: '2026-07-09T00:00:00.000Z', source: 'chat:owner', body: 'FRESH concurrent fact' },
          },
          originInstance: OWN,
          receivingInstanceSlug: OWN,
        })
      },
    })
    // The CAS re-read sees the loser changed → the merge aborts: nothing merged,
    // both files survive, and the concurrent fact is intact.
    expect(report.merged).toBe(0)
    expect(existsSync(join(owner, 'entities', 'companies', 'acme.md'))).toBe(true)
    expect(existsSync(join(owner, 'entities', 'companies', 'acme-co.md'))).toBe(true)
    const loser = await readPage(owner, 'companies', 'acme-co')
    expect(extractTimeline(loser!).map((e) => e.body)).toContain('FRESH concurrent fact')
  })

  test('atomic guard: a loser write racing the atomic delete → retained + genuinely unmerged', async () => {
    const owner = tmpOwner()
    await seed(owner, 'company', 'acme', 'Acme', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    await seed(owner, 'company', 'acme-io', 'Acme IO', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'c' },
    ])
    // A delete wrapper: land a concurrent user write on the loser RIGHT BEFORE the
    // atomic delete runs. The real deleteEntity then re-reads under its lock, sees
    // the changed body vs the precondition, and conflicts → the loser is retained.
    const wrappedDelete: ReflectDeleteEntity = async (input) => {
      if (input.slug === 'acme-io') {
        await writeEntity({
          ownerDataDir: owner,
          kind: 'company',
          slug: 'acme-io',
          body: {
            frontmatter: { slug: 'acme-io', type: 'company', name: 'Acme IO', source: 'chat' },
            compiledTruth: 'Acme is a developer-tools SaaS company.',
            timelineAppend: { ts: '2026-07-09T00:00:00.000Z', source: 'chat:owner', body: 'FRESH loser fact' },
          },
          originInstance: OWN,
          receivingInstanceSlug: OWN,
        })
      }
      return deleteEntity(input)
    }
    const report = await runReflectPass({ ...baseDeps(owner), deleteEntity: wrappedDelete })
    // The atomic delete's CAS sees the concurrent write → conflict → the loser is
    // RETAINED with its fresh fact (never destroyed)...
    expect(report.merged).toBe(0)
    expect(existsSync(join(owner, 'entities', 'companies', 'acme-io.md'))).toBe(true)
    const loser = await readPage(owner, 'companies', 'acme-io')
    expect(extractTimeline(loser!).map((e) => e.body)).toContain('FRESH loser fact')
    // ...and — survivor-first, so no loss — the survivor durably absorbed the
    // loser's SNAPSHOT history (row `c`) before the delete was attempted. The
    // loser's FRESH fact stays on the (retained) loser; a later pass folds it in.
    const survivor = await readPage(owner, 'companies', 'acme')
    const survivorBodies = extractTimeline(survivor!).map((e) => e.body)
    expect(survivorBodies).toContain('c') // snapshot history durable before delete
    expect(survivorBodies).not.toContain('FRESH loser fact') // fresh content stays on the loser
  })

  test("a near-duplicate loser's UNIQUE fact + edge are preserved into the survivor", async () => {
    const owner = tmpOwner()
    // Both pages cross the Jaccard bar (shared boilerplate) but the LOSER alone
    // asserts `[[important-client]]` — Jaccard similarity ≠ semantic subsumption.
    await seed(
      owner,
      'company',
      'acme',
      'Acme',
      'Acme is an enterprise developer-tools SaaS company building platform tooling.',
      [{ ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' }, { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' }],
    )
    await seed(
      owner,
      'company',
      'acme-inc',
      'Acme Inc',
      'Acme is an enterprise developer-tools SaaS company building platform tooling. Advises [[important-client]].',
      [{ ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'c' }],
    )
    const report = await runReflectPass(baseDeps(owner))
    expect(report.merged).toBe(1)
    expect(await readPage(owner, 'companies', 'acme-inc')).toBeNull() // collapsed
    // The loser's UNIQUE edge survived into the survivor (folded before deletion),
    // so `[[important-client]]` is not silently discarded.
    const survivor = await readPage(owner, 'companies', 'acme')
    expect(extractCompiledTruth(survivor!)).toContain('[[important-client]]')
    expect(extractTimeline(survivor!).map((e) => e.body)).toContain('c') // history too
  })

  test('a survivor conflict aborts the merge WITHOUT deleting the loser (no loss)', async () => {
    const owner = tmpOwner()
    await seed(owner, 'company', 'acme', 'Acme', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    await seed(owner, 'company', 'acme-co', 'Acme Co', 'Acme is a developer-tools SaaS company.', [
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'c' },
    ])
    // Survivor-first: make the survivor write conflict by concurrently editing acme
    // just before it commits. The merge aborts BEFORE any loser is deleted — so no
    // page and no history is lost, and no compensation is needed.
    let mutated = false
    const wrapped: ReflectWriteEntity = async (input, d) => {
      if (input.slug === 'acme' && input.precondition !== undefined && !mutated) {
        mutated = true
        await writeEntity({
          ownerDataDir: owner,
          kind: 'company',
          slug: 'acme',
          body: {
            frontmatter: { slug: 'acme', type: 'company', name: 'Acme', source: 'chat' },
            compiledTruth: 'Acme is a developer-tools SaaS company.',
            timelineAppend: { ts: '2026-07-09T00:00:00.000Z', source: 'chat:owner', body: 'CONCURRENT survivor edit' },
          },
          originInstance: OWN,
          receivingInstanceSlug: OWN,
        })
      }
      return realWrite(input, d)
    }
    const report = await runReflectPass({ ...baseDeps(owner), writeEntity: wrapped })
    expect(report.merged).toBe(0) // aborted on survivor conflict
    // The loser was NEVER deleted (survivor-first aborts before any delete).
    expect(existsSync(join(owner, 'entities', 'companies', 'acme-co.md'))).toBe(true)
    expect(extractTimeline((await readPage(owner, 'companies', 'acme-co'))!).map((e) => e.body)).toContain('c')
    // The survivor kept the concurrent edit (the stale merge never clobbered it).
    expect(extractTimeline((await readPage(owner, 'companies', 'acme'))!).map((e) => e.body)).toContain(
      'CONCURRENT survivor edit',
    )
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

  test('an oversized EARLY page does not disable reserved extraction for later pages', async () => {
    const owner = tmpOwner()
    // A PERSON page whose compiled-truth ALONE exceeds the digest budget. Since
    // `loadAllPages` enumerates kinds in ENTITY_KINDS order (person BEFORE company),
    // this oversized page is digested first — under the old `break` it emptied the
    // digest and skipped reserved extraction for the whole corpus. Now it is
    // per-page-capped + skipped-past so the later company page still digests.
    await seed(owner, 'person', 'bigco-notes', 'BigCo Notes', 'X '.repeat(400).trim(), [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'r' },
    ])
    // A small COMPANY page (enumerated AFTER the person) that evidences a meeting.
    await seed(
      owner,
      'company',
      'acme',
      'Acme',
      'Acme reviewed plans at the Q3 Board Meeting.',
      [{ ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'met at Q3 board meeting' }],
    )
    const { substrate } = scriptedSubstrate((prompt) =>
      prompt.includes('DIGEST:') && prompt.includes('Q3 Board Meeting')
        ? JSON.stringify({ entities: [{ name: 'Q3 Board Meeting', kind: 'meeting', fact: 'Sarah presented' }] })
        : '{"entities":[]}',
    )
    // A small budget so the first page alone would blow it (repro of the boundary).
    const report = await runReflectPass({ ...baseDeps(owner), substrate, maxReservedDigestChars: 300 })
    expect(report.reservedWritten).toBeGreaterThanOrEqual(1)
    expect(await readPage(owner, 'meetings', 'q3-board-meeting')).not.toBeNull()
  })

  test('re-extraction ADDITIVELY MERGES over an existing reserved page (new fact durable, no clobber)', async () => {
    const owner = tmpOwner()
    // A pre-existing, RICH project page with multiple facts + a wikilink edge.
    const rich =
      '# Perfect Recall\n\nA memory-uplift initiative. Sponsored by [[sarah-patel]]. Targets Q4 GA.'
    await seed(owner, 'project', 'perfect-recall', 'Perfect Recall', rich, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'seed', body: 'kicked off' },
    ])
    // The reflect extraction surfaces a NEW durable fact.
    const { substrate } = scriptedSubstrate((prompt) =>
      prompt.includes('DIGEST:')
        ? JSON.stringify({
            entities: [{ name: 'Perfect Recall', kind: 'project', fact: 'Now in private beta' }],
          })
        : '{"entities":[]}',
    )
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    const page = await readPage(owner, 'projects', 'perfect-recall')
    const ct = extractCompiledTruth(page!)
    // Prior facts + the wikilink edge are preserved (nothing retracted)...
    expect(ct).toContain('memory-uplift initiative')
    expect(ct).toContain('Targets Q4 GA')
    expect(ct).toContain('[[sarah-patel]]') // graph edge intact
    // ...AND the new fact reached COMPILED-TRUTH (durable + graph-extractable),
    // not just the timeline.
    expect(ct).toContain('Now in private beta')
    expect(report.reservedWritten).toBeGreaterThanOrEqual(1)
  })

  test('re-extracting an ALREADY-present fact is a no-op (no unbounded growth)', async () => {
    const owner = tmpOwner()
    await seed(
      owner,
      'project',
      'perfect-recall',
      'Perfect Recall',
      '# Perfect Recall\n\nA memory-uplift initiative. Now in private beta.',
      [{ ts: '2026-07-01T00:00:00.000Z', source: 'seed', body: 'kicked off' }],
    )
    const { substrate } = scriptedSubstrate((prompt) =>
      prompt.includes('DIGEST:')
        ? JSON.stringify({
            entities: [{ name: 'Perfect Recall', kind: 'project', fact: 'Now in private beta' }],
          })
        : '{"entities":[]}',
    )
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    expect(report.reservedWritten).toBe(0) // fact already present → no write
    const tl = extractTimeline((await readPage(owner, 'projects', 'perfect-recall'))!)
    expect(tl.length).toBe(1) // no reserved timeline row appended
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

  test('a concurrent write DURING the resynth LLM call is not clobbered', async () => {
    const owner = tmpOwner()
    await seed(owner, 'person', 'nadia', 'Nadia', 'Nadia is an engineer.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'r1' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'r2' },
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'r3' },
    ])
    // A substrate whose resynth call lands a concurrent user fact DURING the LLM
    // window, then returns a STALE full-replacement that omits that fact.
    const substrate: Substrate = {
      start(spec): SessionHandle {
        const isResynth = !spec.prompt.includes('DIGEST:')
        const concurrent = isResynth
          ? writeEntity({
              ownerDataDir: owner,
              kind: 'person',
              slug: 'nadia',
              body: {
                frontmatter: { slug: 'nadia', type: 'person', name: 'Nadia', source: 'chat' },
                compiledTruth: 'Nadia is an engineer. Promoted to staff.',
                timelineAppend: { ts: '2026-07-09T00:00:00.000Z', source: 'chat:owner', body: 'promo' },
              },
              originInstance: OWN,
              receivingInstanceSlug: OWN,
            })
          : Promise.resolve(undefined)
        async function* gen(): AsyncGenerator<Event> {
          await concurrent // the concurrent write lands DURING the LLM call
          yield { kind: 'token', text: isResynth ? 'Nadia is a senior engineer.' : '{"entities":[]}' }
          yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'fake' }
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
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    // The CAS re-read sees the on-disk truth changed → the stale rewrite is skipped.
    expect(report.resynthesized).toBe(0)
    const ct = extractCompiledTruth((await readPage(owner, 'people', 'nadia'))!)
    expect(ct).toContain('Promoted to staff') // concurrent fact survived
    expect(ct).not.toContain('senior engineer') // stale rewrite NOT applied
  })

  test('atomic precondition: a write landing just before the resynth write is not clobbered', async () => {
    const owner = tmpOwner()
    await seed(owner, 'person', 'omar', 'Omar', 'Omar is a designer.', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'r1' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'r2' },
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'r3' },
    ])
    // A writer wrapper: right BEFORE the reflect resynth write commits, land a
    // concurrent user write. The writer's precondition (checked inside its lock,
    // AFTER this concurrent write) must catch the mismatch and refuse to clobber.
    let injected = false
    const wrapped: ReflectWriteEntity = async (input, d) => {
      if (!injected && input.slug === 'omar' && input.body.compiledTruth.includes('senior')) {
        injected = true
        await writeEntity({
          ownerDataDir: owner,
          kind: 'person',
          slug: 'omar',
          body: {
            frontmatter: { slug: 'omar', type: 'person', name: 'Omar', source: 'chat' },
            compiledTruth: 'Omar is a designer. Now a manager.',
            timelineAppend: { ts: '2026-07-09T00:00:00.000Z', source: 'chat:owner', body: 'promo' },
          },
          originInstance: OWN,
          receivingInstanceSlug: OWN,
        })
      }
      return realWrite(input, d)
    }
    const { substrate } = scriptedSubstrate((p) =>
      p.includes('DIGEST:') ? '{"entities":[]}' : 'Omar is a senior designer.',
    )
    const report = await runReflectPass({ ...baseDeps(owner), writeEntity: wrapped, substrate })
    expect(report.resynthesized).toBe(0) // precondition conflict → no write
    const ct = extractCompiledTruth((await readPage(owner, 'people', 'omar'))!)
    expect(ct).toContain('Now a manager') // concurrent fact survived
    expect(ct).not.toContain('senior designer') // stale rewrite NOT applied
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

  test('a merged survivor can still be re-synthesized in the SAME pass (fresh CAS baseline)', async () => {
    const owner = tmpOwner()
    // Two near-duplicate people (enough rows to clear the resynth gate) → they
    // merge into a survivor, which must then re-synthesize in the same pass (its
    // CAS baseline is the POST-merge body, not the stale pre-merge snapshot).
    await seed(owner, 'person', 'rob', 'Rob', 'Rob is a staff engineer at [[globex]].', [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'r1' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'r2' },
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'r3' },
    ])
    await seed(owner, 'person', 'rob-smith', 'Rob Smith', 'Rob is a staff engineer at [[globex]].', [
      { ts: '2026-07-04T00:00:00.000Z', source: 'chat:owner', body: 'r4' },
    ])
    const { substrate } = scriptedSubstrate((p) =>
      p.includes('DIGEST:')
        ? '{"entities":[]}'
        : 'Rob is a staff engineer at [[globex]] and mentors the platform team.',
    )
    const report = await runReflectPass({ ...baseDeps(owner), substrate })
    expect(report.merged).toBe(1) // the pair collapsed
    expect(report.resynthesized).toBe(1) // and the survivor was re-synthesized SAME pass
    const ct = extractCompiledTruth((await readPage(owner, 'people', 'rob'))!)
    expect(ct).toContain('mentors the platform team') // resynth applied
    expect(ct).toContain('[[globex]]') // edge preserved
  })
})
