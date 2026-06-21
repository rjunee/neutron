import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, utimes, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { refreshIndex } from './indexer.ts'
import { enumerateProjects } from './projects.ts'
import { DocSearchIndex } from './store.ts'
import { walkProjectMarkdown, readProjectDoc } from './walk.ts'

let ownerHome: string
let index: DocSearchIndex

/** Materialise a realistic project tree under <ownerHome>/Projects/. */
async function seedFixtureTree(root: string): Promise<void> {
  const mk = async (rel: string, body: string): Promise<void> => {
    const abs = join(root, 'Projects', rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
  // Project "topline": pricing lives in docs/, hiring in research/.
  await mk(
    'topline/README.md',
    '# Topline\n\nTopline is the revenue analytics project.',
  )
  await mk(
    'topline/STATUS.md',
    '---\nname: topline\nstatus: active\n---\n\n# Status\n\nShipping the pricing dashboard this sprint.',
  )
  await mk(
    'topline/docs/pricing-strategy.md',
    '# Pricing strategy\n\n## Tiers\n\nWe will offer three pricing tiers with volume discounts.\n\n## Risks\n\nUndercutting competitors on price erodes margin.',
  )
  await mk(
    'topline/research/hiring.md',
    '# Hiring research\n\nWe benchmarked engineer compensation across the market.',
  )
  // A non-markdown file + a hidden dir that must NOT be indexed.
  await mk('topline/docs/diagram.png', 'PNGDATA')
  await mkdir(join(root, 'Projects', 'topline', '.git'), { recursive: true })
  await writeFile(join(root, 'Projects', 'topline', '.git', 'config.md'), '# secret\n\npassword', 'utf8')

  // Project "atlas": separate corpus.
  await mk('atlas/README.md', '# Atlas\n\nAtlas handles onboarding flows.')
  await mk('atlas/notes/kickoff.md', '# Kickoff\n\nDiscussed the onboarding funnel and activation metrics.')
}

beforeEach(() => {
  ownerHome = mkdtempSync(join(tmpdir(), 'neutron-doc-search-'))
  index = DocSearchIndex.open(':memory:')
})
afterEach(() => {
  index.close()
  rmSync(ownerHome, { recursive: true, force: true })
})

describe('refreshIndex over a fixture project tree', () => {
  test('indexes every markdown file across all projects, skips non-md and hidden dirs', async () => {
    await seedFixtureTree(ownerHome)
    const stats = await refreshIndex({ ownerHome, index })
    expect(stats.projects).toBe(2)
    // 4 topline .md (README, STATUS, pricing, hiring) + 2 atlas (README, kickoff) = 6.
    expect(stats.filesIndexed).toBe(6)
    expect(index.stats().files).toBe(6)

    // The hidden .git/config.md must NOT have been indexed.
    const secret = await index.search({ query: 'password' })
    expect(secret).toEqual([])
  })

  test('query returns the right document ranked first', async () => {
    await seedFixtureTree(ownerHome)
    await refreshIndex({ ownerHome, index })

    const pricing = await index.search({ query: 'pricing tiers discounts' })
    expect(pricing[0]!.project).toBe('topline')
    expect(pricing[0]!.path).toBe('docs/pricing-strategy.md')
    expect(pricing[0]!.heading).toBe('Tiers')

    const onboarding = await index.search({ query: 'onboarding funnel activation' })
    expect(onboarding[0]!.project).toBe('atlas')
    expect(onboarding[0]!.path).toBe('notes/kickoff.md')
  })

  test('is incremental: a second refresh with no changes indexes nothing', async () => {
    await seedFixtureTree(ownerHome)
    await refreshIndex({ ownerHome, index })
    const second = await refreshIndex({ ownerHome, index })
    expect(second.filesIndexed).toBe(0)
    expect(second.filesSkipped).toBe(6)
  })

  test('picks up edits, new files, deletions, and removed projects', async () => {
    await seedFixtureTree(ownerHome)
    await refreshIndex({ ownerHome, index })

    // Edit a file (bump mtime so the incremental check reindexes it).
    const pricingPath = join(ownerHome, 'Projects', 'topline', 'docs', 'pricing-strategy.md')
    await writeFile(pricingPath, '# Pricing strategy\n\nNow we focus on enterprise contracts and procurement.', 'utf8')
    const future = new Date(Date.now() + 60_000)
    await utimes(pricingPath, future, future)

    // Add a new file.
    await writeFile(
      join(ownerHome, 'Projects', 'atlas', 'notes', 'retro.md'),
      '# Retro\n\nThe sprint retro surfaced flaky onboarding tests.',
      'utf8',
    )
    // Delete a file.
    await rm(join(ownerHome, 'Projects', 'topline', 'research', 'hiring.md'))
    // Remove a whole project.
    await rm(join(ownerHome, 'Projects', 'atlas', 'README.md'))

    const stats = await refreshIndex({ ownerHome, index })
    expect(stats.filesIndexed).toBe(2) // edited pricing + new retro
    expect(stats.filesRemoved).toBe(2) // hiring.md + atlas README

    expect((await index.search({ query: 'enterprise procurement' }))[0]!.path).toBe('docs/pricing-strategy.md')
    expect(await index.search({ query: 'tiers discounts' })).toEqual([])
    expect((await index.search({ query: 'flaky onboarding tests' })).length).toBe(1)
    expect(await index.search({ query: 'benchmarked compensation' })).toEqual([])
  })

  test('purges a project whose folder was deleted entirely', async () => {
    await seedFixtureTree(ownerHome)
    await refreshIndex({ ownerHome, index })
    await rm(join(ownerHome, 'Projects', 'atlas'), { recursive: true, force: true })

    const stats = await refreshIndex({ ownerHome, index })
    expect(stats.projectsRemoved).toBe(1)
    expect(index.indexedProjects()).toEqual(['topline'])
  })

  test('empty owner home (no Projects dir) is a clean no-op', async () => {
    const stats = await refreshIndex({ ownerHome, index })
    expect(stats).toMatchObject({ projects: 0, filesIndexed: 0 })
  })
})

describe('walk + project enumeration + path-safe read', () => {
  test('walkProjectMarkdown returns sorted relpaths, only markdown', async () => {
    await seedFixtureTree(ownerHome)
    const files = await walkProjectMarkdown(join(ownerHome, 'Projects', 'topline'))
    // Sorted by localeCompare (case-insensitive-ish, locale-aware).
    expect(files.map((f) => f.relpath)).toEqual([
      'docs/pricing-strategy.md',
      'README.md',
      'research/hiring.md',
      'STATUS.md',
    ])
  })

  test('enumerateProjects lists project folders only', async () => {
    await seedFixtureTree(ownerHome)
    expect(await enumerateProjects(ownerHome)).toEqual(['atlas', 'topline'])
  })

  test('readProjectDoc reads a valid doc and rejects traversal', async () => {
    await seedFixtureTree(ownerHome)
    const ok = await readProjectDoc(ownerHome, 'topline', 'STATUS.md')
    expect(ok?.content).toContain('pricing dashboard')

    expect(await readProjectDoc(ownerHome, 'topline', '../atlas/README.md')).toBeNull()
    expect(await readProjectDoc(ownerHome, 'topline', '/etc/passwd')).toBeNull()
    expect(await readProjectDoc(ownerHome, 'topline', '.git/config.md')).toBeNull()
    expect(await readProjectDoc(ownerHome, 'bad slug!', 'README.md')).toBeNull()
    expect(await readProjectDoc(ownerHome, 'topline', 'docs/diagram.png')).toBeNull()
    expect(await readProjectDoc(ownerHome, 'topline', 'missing.md')).toBeNull()
  })
})
