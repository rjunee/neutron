import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { chunkMarkdown } from './chunk.ts'
import { DocSearchIndex, type IndexFileInput } from './store.ts'

function fileInput(project: string, relpath: string, content: string, mtimeMs = 1000): IndexFileInput {
  const { title, chunks } = chunkMarkdown(content, { filename: relpath })
  return { project, relpath, absPath: `/owner/Projects/${project}/${relpath}`, title, mtimeMs, chunks }
}

let index: DocSearchIndex

beforeEach(() => {
  index = DocSearchIndex.open(':memory:')
})
afterEach(() => {
  index.close()
})

describe('DocSearchIndex (lexical BM25)', () => {
  test('ranks the most relevant document first', async () => {
    await index.indexFile(
      fileInput('topline', 'docs/pricing.md', '# Pricing strategy\n\nWe discussed the pricing tiers and discount model in depth.'),
    )
    await index.indexFile(
      fileInput('topline', 'docs/hiring.md', '# Hiring plan\n\nWe need two engineers and a designer next quarter.'),
    )
    await index.indexFile(
      fileInput('atlas', 'STATUS.md', '# Status\n\nThe project is on track. No pricing concerns.'),
    )

    const hits = await index.search({ query: 'pricing tiers discount' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.path).toBe('docs/pricing.md')
    expect(hits[0]!.project).toBe('topline')
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[hits.length - 1]!.score)
    expect(hits[0]!.snippet).toContain('[')
  })

  test('returns a heading and title for the matching section', async () => {
    await index.indexFile(
      fileInput('topline', 'docs/plan.md', '# Master plan\n\nintro\n\n## Launch checklist\n\nShip the beta to early users.'),
    )
    const hits = await index.search({ query: 'beta early users' })
    expect(hits[0]!.title).toBe('Master plan')
    expect(hits[0]!.heading).toBe('Launch checklist')
  })

  test('collapses multiple matching chunks to one hit per file', async () => {
    const md = '# Doc\n\n## One\n\nrocket rocket\n\n## Two\n\nrocket again rocket'
    await index.indexFile(fileInput('p', 'docs/a.md', md))
    const hits = await index.search({ query: 'rocket' })
    expect(hits.filter((h) => h.path === 'docs/a.md')).toHaveLength(1)
  })

  test('scopes results to a single project when asked', async () => {
    await index.indexFile(fileInput('alpha', 'notes/x.md', '# X\n\nwidget assembly notes'))
    await index.indexFile(fileInput('beta', 'notes/y.md', '# Y\n\nwidget assembly notes'))
    const scoped = await index.search({ query: 'widget assembly', project: 'beta' })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.project).toBe('beta')
  })

  test('phrase / punctuation queries do not throw and find content', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# Tax\n\nThe NEAR operator and (parentheses) appear here.'))
    const hits = await index.search({ query: 'NEAR (parentheses)' })
    expect(hits.length).toBeGreaterThan(0)
  })

  test('hyphenated query terms are searchable (not parsed as FTS operators)', async () => {
    await index.indexFile(
      fileInput('p', 'docs/audit.md', '# Audit\n\nThe daily-driver gap-audit lists the QMD-equivalent doc search.'),
    )
    const hits = await index.search({ query: 'daily-driver gap-audit' })
    expect(hits.length).toBe(1)
    expect(hits[0]!.path).toBe('docs/audit.md')
  })

  test('document limit is applied per-file, not per-chunk (no single-file starvation)', async () => {
    // One huge file with MANY matching sections (> limit*4 chunks) must not
    // crowd out other relevant documents.
    const bigSections = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nwidget widget widget`).join('\n\n')
    await index.indexFile(fileInput('p', 'docs/big.md', `# Big\n\n${bigSections}`))
    for (let i = 0; i < 5; i++) {
      await index.indexFile(fileInput('p', `docs/small-${i}.md`, `# Small ${i}\n\na single widget mention`))
    }
    const hits = await index.search({ query: 'widget', limit: 4 })
    expect(hits).toHaveLength(4)
    // The big file appears at most once, and other files get represented.
    expect(hits.filter((h) => h.path === 'docs/big.md')).toHaveLength(1)
    expect(new Set(hits.map((h) => h.path)).size).toBe(4)
  })

  test('empty / whitespace queries return nothing', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\nbody'))
    expect(await index.search({ query: '' })).toEqual([])
    expect(await index.search({ query: '   ' })).toEqual([])
  })

  test('clamps limit to [1,50]', async () => {
    for (let i = 0; i < 5; i++) {
      await index.indexFile(fileInput('p', `docs/${i}.md`, `# Doc ${i}\n\ncommon term here`))
    }
    const hits = await index.search({ query: 'common term', limit: 2 })
    expect(hits).toHaveLength(2)
  })
})

describe('DocSearchIndex (incremental reindex)', () => {
  test('replacing a file updates content and keeps one row set', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\noriginal apricot text'))
    expect((await index.search({ query: 'apricot' })).length).toBe(1)

    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\nrewritten banana text', 2000))
    expect(await index.search({ query: 'apricot' })).toEqual([])
    expect((await index.search({ query: 'banana' })).length).toBe(1)
    expect(index.fileMtimes('p').get('docs/a.md')).toBe(2000)
  })

  test('removeFile and removeProject drop content', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\ncherry'))
    await index.indexFile(fileInput('p', 'docs/b.md', '# B\n\ncherry'))
    await index.indexFile(fileInput('q', 'docs/c.md', '# C\n\ncherry'))

    index.removeFile('p', 'docs/a.md')
    expect((await index.search({ query: 'cherry', project: 'p' })).map((h) => h.path)).toEqual(['docs/b.md'])

    index.removeProject('p')
    expect(await index.search({ query: 'cherry', project: 'p' })).toEqual([])
    expect((await index.search({ query: 'cherry' })).length).toBe(1)
  })

  test('stats reflects projects / files / chunks', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\n## S1\n\none\n\n## S2\n\ntwo'))
    await index.indexFile(fileInput('q', 'docs/b.md', '# B\n\nbody'))
    const s = index.stats()
    expect(s.projects).toBe(2)
    expect(s.files).toBe(2)
    expect(s.chunks).toBeGreaterThanOrEqual(3)
  })
})

describe('DocSearchIndex (keyword-only; no dead embedder seam) — RA4', () => {
  // RA4 removed the never-wired optional `embedder` seam (a dead in-process
  // hybrid re-rank the composer never enabled and that could not share RA3's
  // out-of-process gbrain embedder). These tests are the DELETE mutation
  // guard: they RED if the dead embedder storage / API is re-introduced.

  test('the schema stores NO embedding column (pure lexical)', () => {
    const idx = DocSearchIndex.open(':memory:')
    const cols = idx
      .raw()
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('doc_chunks')`)
      .all()
      .map((c) => c.name)
    expect(cols).not.toContain('embedding')
    // The lexical columns that ARE load-bearing are still present.
    expect(cols).toContain('body')
    expect(cols).toContain('title')
    idx.close()
  })

  test('there is no semantic/embedder surface on the index or its factory', () => {
    const idx = DocSearchIndex.open(':memory:')
    // No leftover `semantic` getter and no embedder field.
    expect('semantic' in (idx as unknown as Record<string, unknown>)).toBe(false)
    expect((idx as unknown as Record<string, unknown>)['embedder']).toBeUndefined()
    // `open` takes a single path arg — the options/embedder param is gone.
    expect(DocSearchIndex.open.length).toBe(1)
    idx.close()
  })

  test('search returns keyword-ranked docs with in-range scores', async () => {
    await index.indexFile(fileInput('p', 'docs/revenue.md', '# Revenue\n\nquarterly revenue growth and churn metrics'))
    await index.indexFile(fileInput('p', 'docs/office.md', '# Office\n\nthe new office lease and desk layout'))
    const hits = await index.search({ query: 'revenue growth churn' })
    expect(hits[0]!.path).toBe('docs/revenue.md')
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
  })
})
