/**
 * The auto-merge must be REVERSIBLE.
 *
 * The reflect pass fuses near-duplicate memory pages and deletes the loser.
 * Jaccard similarity is a heuristic, so that judgement can be wrong — and a
 * wrong merge used to be unrecoverable. These tests hold the line at the level
 * that matters to the owner: not "the copy exists" but **"I can get my page
 * back, byte for byte, after it was merged away."**
 *
 * Every test drives a REAL merge over REAL on-disk pages (real `writeEntity`,
 * real `deleteEntity`, temp owner data dir, no LLM, no brain).
 *
 * MUTATION PROOF: revert the merge path to a hard delete (drop the
 * archive-before-delete block in `reflect-pass.ts:mergeCluster`) and
 * "recovers the losing page after the merge, byte for byte" goes RED — the
 * ledger is empty and `restoreArchivedPage` returns `not_found`.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEntity, type EntityKind } from '@neutronai/runtime/entity-writer.ts'
import { extractCompiledTruth } from '@neutronai/runtime/entity-format.ts'
import { runReflectPass, type ReflectPassDeps } from '../reflect/reflect-pass.ts'
import {
  readMergeLedger,
  restoreArchivedPage,
  pruneMergeArchive,
  mergeArchiveRoot,
  archiveMergedPage,
  MERGE_ARCHIVE_RETENTION_MS,
  type ReflectArchivePage,
} from '../reflect/merge-archive.ts'

const OWN = 'owner'
const t0 = Date.parse('2026-07-16T00:00:00.000Z')

function tmpOwner(): string {
  return mkdtempSync(join(tmpdir(), 'reflect-merge-archive-'))
}

function baseDeps(ownerDataDir: string): ReflectPassDeps {
  return {
    ownerDataDir,
    ownSlug: OWN,
    writeEntity: writeEntity as unknown as ReflectPassDeps['writeEntity'],
    now: () => t0,
  }
}

async function seed(
  ownerDataDir: string,
  kind: EntityKind,
  slug: string,
  name: string,
  compiledTruth: string,
  rows: Array<{ ts: string; source: string; body: string }>,
): Promise<void> {
  for (const row of rows) {
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

function pagePath(ownerDataDir: string, dir: string, slug: string): string {
  return join(ownerDataDir, 'entities', dir, `${slug}.md`)
}

async function readPage(ownerDataDir: string, dir: string, slug: string): Promise<string | null> {
  try {
    return await readFile(pagePath(ownerDataDir, dir, slug), 'utf8')
  } catch {
    return null
  }
}

/** Two near-duplicate company pages. `acme` has more history → survivor. */
const SHARED_BODY =
  'Acme is an enterprise SaaS company building developer tooling for platform teams.'

async function seedNearDuplicatePair(owner: string): Promise<void> {
  await seed(owner, 'company', 'acme', 'Acme', SHARED_BODY, [
    { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'First mention of Acme' },
    { ts: '2026-07-05T00:00:00.000Z', source: 'chat:owner', body: 'Acme raised a Series B' },
  ])
  await seed(owner, 'company', 'acme-inc', 'Acme Inc', SHARED_BODY, [
    { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'Acme Inc hired a new CTO' },
  ])
}

describe('a merged-away memory page can be recovered', () => {
  test('recovers the losing page after the merge, byte for byte', async () => {
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)

    // Capture the loser EXACTLY as it stands before the pass — this is what
    // "recovered" has to mean.
    const loserBefore = await readPage(owner, 'companies', 'acme-inc')
    expect(loserBefore).not.toBeNull()

    const report = await runReflectPass(baseDeps(owner))
    expect(report.merged).toBe(1)
    expect(report.archived).toBe(1)

    // The merge happened: the loser is gone from live memory.
    expect(await readPage(owner, 'companies', 'acme-inc')).toBeNull()
    expect(await readPage(owner, 'companies', 'acme')).not.toBeNull()

    // The merge is on the record, and the record says what it was merged into.
    const ledger = await readMergeLedger(owner)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.slug).toBe('acme-inc')
    expect(ledger[0]!.kind).toBe('company')
    expect(ledger[0]!.merged_into).toBe('acme')
    expect(ledger[0]!.archived_at).toBe(new Date(t0).toISOString())

    // ── THE BAR: actually get the page back. ──────────────────────────────────
    const restored = await restoreArchivedPage({ ownerDataDir: owner, slug: 'acme-inc' })
    expect(restored.restored).toBe(true)

    const loserAfter = await readPage(owner, 'companies', 'acme-inc')
    expect(loserAfter).not.toBeNull()
    // Byte-for-byte identical to the page that was deleted — not a reconstruction.
    expect(loserAfter).toBe(loserBefore!)
    // And the recovered page is the real thing: its own facts are readable again.
    expect(extractCompiledTruth(loserAfter!)).toBe(extractCompiledTruth(loserBefore!))
  })

  test('recovers a loser that was the BETTER page — nothing assumes the winner was right', async () => {
    const owner = tmpOwner()
    // The survivor is picked by timeline length, NOT by quality. Give the page
    // that will LOSE the far more valuable body: the merge picks `acme` (2 rows)
    // over `acme-inc` (1 row) even though `acme-inc` carries the detail and the
    // graph edges. This is exactly the mis-judgement the archive exists to survive.
    const longBody =
      'Acme is an enterprise SaaS company building developer tooling for platform teams. ' +
      'It sells a hosted build system, an artifact registry, and a deployment dashboard, ' +
      'mostly to mid-market engineering organisations in Europe. Pricing is per seat with ' +
      'an annual commit, and support is handled by a small solutions team based in Lisbon.'
    await seed(owner, 'company', 'acme', 'Acme', longBody, [
      { ts: '2026-07-01T00:00:00.000Z', source: 'chat:owner', body: 'a' },
      { ts: '2026-07-02T00:00:00.000Z', source: 'chat:owner', body: 'b' },
    ])
    // Similar enough to cluster (well over the 0.7 Jaccard bar), yet it is the
    // page carrying the durable facts and the graph edges.
    const richBody = `${longBody} Renewal sits in Q4; account run by [[dana-okonkwo]].`
    await seed(owner, 'company', 'acme-inc', 'Acme Inc', richBody, [
      { ts: '2026-07-03T00:00:00.000Z', source: 'chat:owner', body: 'c' },
    ])

    const loserBefore = await readPage(owner, 'companies', 'acme-inc')
    const report = await runReflectPass(baseDeps(owner))
    expect(report.merged).toBe(1)
    // The WRONG page won.
    expect(await readPage(owner, 'companies', 'acme-inc')).toBeNull()

    // The better page comes back whole — every detail and every wikilink.
    const restored = await restoreArchivedPage({ ownerDataDir: owner, slug: 'acme-inc' })
    expect(restored.restored).toBe(true)
    const recovered = await readPage(owner, 'companies', 'acme-inc')
    expect(recovered).toBe(loserBefore!)
    expect(recovered).toContain('[[dana-okonkwo]]')
    expect(recovered).toContain('Renewal sits in Q4')
  })

  test('a page merged away is findable without knowing its slug', async () => {
    // The owner notices "where did that page go?" — the ledger has to answer it.
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)
    await runReflectPass(baseDeps(owner))

    const ledger = await readMergeLedger(owner)
    expect(ledger.map((e) => e.slug)).toEqual(['acme-inc'])
    // The archived copy is a plain readable page sitting in a plain directory.
    const copy = join(mergeArchiveRoot(owner), ledger[0]!.file)
    expect(existsSync(copy)).toBe(true)
    expect(await readFile(copy, 'utf8')).toContain('Acme Inc hired a new CTO')
    // …next to instructions anyone can follow.
    const readme = await readFile(join(mergeArchiveRoot(owner), 'README.md'), 'utf8')
    expect(readme).toContain('neutron memory-restore')
  })

  test('restore refuses to clobber a live page unless forced', async () => {
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)
    await runReflectPass(baseDeps(owner))

    // A NEW page later claims the slug. Recovering an old merge must not destroy it.
    await seed(owner, 'company', 'acme-inc', 'Acme Inc (new)', 'A different company entirely.', [
      { ts: '2026-07-20T00:00:00.000Z', source: 'chat:owner', body: 'new page' },
    ])
    const live = await readPage(owner, 'companies', 'acme-inc')

    const refused = await restoreArchivedPage({ ownerDataDir: owner, slug: 'acme-inc' })
    expect(refused.restored).toBe(false)
    expect(refused.restored === false ? refused.reason : '').toBe('live_page_exists')
    expect(await readPage(owner, 'companies', 'acme-inc')).toBe(live!) // untouched

    const forced = await restoreArchivedPage({
      ownerDataDir: owner,
      slug: 'acme-inc',
      overwrite: true,
    })
    expect(forced.restored).toBe(true)
    expect(await readPage(owner, 'companies', 'acme-inc')).toContain('Acme Inc hired a new CTO')
  })

  test('restoring an unknown page reports not_found instead of inventing one', async () => {
    const owner = tmpOwner()
    const r = await restoreArchivedPage({ ownerDataDir: owner, slug: 'never-existed' })
    expect(r.restored).toBe(false)
    expect(r.restored === false ? r.reason : '').toBe('not_found')
  })
})

describe('no page is deleted without a recoverable copy', () => {
  test('a failed archive KEEPS the loser instead of deleting it', async () => {
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)

    const exploding: ReflectArchivePage = async () => {
      throw new Error('disk full')
    }
    const report = await runReflectPass({ ...baseDeps(owner), archivePage: exploding })

    // Nothing was merged away, nothing was archived — and crucially BOTH pages
    // are still on disk. A backup that cannot be written is not a licence to delete.
    expect(report.archived).toBe(0)
    expect(report.merged).toBe(0)
    expect(await readPage(owner, 'companies', 'acme-inc')).not.toBeNull()
    expect(await readPage(owner, 'companies', 'acme')).not.toBeNull()
  })

  test('the archived copy is written BEFORE the page is unlinked', async () => {
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)

    let archiveExistedAtDeleteTime = false
    await runReflectPass({
      ...baseDeps(owner),
      deleteEntity: async (input) => {
        const ledger = await readMergeLedger(owner)
        archiveExistedAtDeleteTime = ledger.some(
          (e) => e.slug === input.slug && existsSync(join(mergeArchiveRoot(owner), e.file)),
        )
        return { deleted: false, conflict: true } // refuse: the loser stays on disk
      },
    })
    expect(archiveExistedAtDeleteTime).toBe(true)
  })

  test('a loser re-archived on a later pass does not accrete duplicate copies', async () => {
    // A delete that keeps failing means the same loser is re-archived every 6h.
    // The archive must not grow one copy per pass, forever.
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)
    const refuseDelete = async (): Promise<{ deleted: boolean; conflict: boolean }> => ({
      deleted: false,
      conflict: true,
    })
    for (let i = 0; i < 3; i += 1) {
      await runReflectPass({ ...baseDeps(owner), deleteEntity: refuseDelete })
    }
    const ledger = await readMergeLedger(owner)
    expect(ledger).toHaveLength(1) // content-idempotent: one copy, one ledger row
  })
})

describe('the archive is bounded', () => {
  test('copies past the retention horizon are pruned, and their ledger rows with them', async () => {
    const owner = tmpOwner()
    mkdirSync(join(owner, 'entities', 'companies'), { recursive: true })
    await archiveMergedPage({
      ownerDataDir: owner,
      kind: 'company',
      slug: 'old-page',
      raw: '---\nslug: old-page\n---\n\nAn old merged-away page.\n',
      mergedIntoKind: 'company',
      mergedIntoSlug: 'acme',
      now: t0,
    })
    await archiveMergedPage({
      ownerDataDir: owner,
      kind: 'company',
      slug: 'recent-page',
      raw: '---\nslug: recent-page\n---\n\nA recent merged-away page.\n',
      mergedIntoKind: 'company',
      mergedIntoSlug: 'acme',
      now: t0,
    })
    expect(await readMergeLedger(owner)).toHaveLength(2)

    // Age the first copy past the horizon.
    const root = mergeArchiveRoot(owner)
    const oldFile = join(root, 'companies', (await readMergeLedger(owner))[0]!.file.split('/')[1]!)
    const aged = new Date(t0 - MERGE_ARCHIVE_RETENTION_MS - 60_000)
    await utimes(oldFile, aged, aged)

    const { pruned } = await pruneMergeArchive({ ownerDataDir: owner, now: t0 })
    expect(pruned).toBe(1)
    expect(existsSync(oldFile)).toBe(false)

    const ledger = await readMergeLedger(owner)
    expect(ledger.map((e) => e.slug)).toEqual(['recent-page']) // row dropped with the file
    // The surviving copy is still restorable after the compaction.
    const r = await restoreArchivedPage({ ownerDataDir: owner, slug: 'recent-page' })
    expect(r.restored).toBe(true)
  })

  test('the reflect pass prunes on its own, and a fresh copy survives the pass that made it', async () => {
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)
    await runReflectPass({ ...baseDeps(owner), mergeArchiveRetentionMs: 60_000 })
    // Written at t0, pruned at t0 with a 60s horizon → still inside it.
    expect(await readMergeLedger(owner)).toHaveLength(1)
    expect((await restoreArchivedPage({ ownerDataDir: owner, slug: 'acme-inc' })).restored).toBe(true)
  })

  test('a torn ledger line never makes the rest of the archive unreadable', async () => {
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)
    await runReflectPass(baseDeps(owner))
    const ledgerPath = join(mergeArchiveRoot(owner), 'merges.jsonl')
    const good = await readFile(ledgerPath, 'utf8')
    writeFileSync(ledgerPath, `{"kind":"comp\n${good}not json at all\n`)

    const ledger = await readMergeLedger(owner)
    expect(ledger).toHaveLength(1)
    expect((await restoreArchivedPage({ ownerDataDir: owner, slug: 'acme-inc' })).restored).toBe(true)
  })

  test('archived copies live OUTSIDE entities/ so they are never re-scanned as memory', async () => {
    const owner = tmpOwner()
    await seedNearDuplicatePair(owner)
    const first = await runReflectPass(baseDeps(owner))
    expect(first.merged).toBe(1)

    // A second pass sees only the survivor — the archived copy is inert.
    const second = await runReflectPass(baseDeps(owner))
    expect(second.scanned).toBe(1)
    expect(second.merged).toBe(0)
    expect(await stat(mergeArchiveRoot(owner))).toBeDefined()
  })
})
