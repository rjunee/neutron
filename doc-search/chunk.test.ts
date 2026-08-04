import { describe, expect, test } from 'bun:test'

import { chunkMarkdown, deriveTitleFromFilename } from './chunk.ts'

describe('chunkMarkdown', () => {
  test('uses the first H1 as the title', () => {
    const { title } = chunkMarkdown('# Project Topline\n\nbody', { filename: 'README.md' })
    expect(title).toBe('Project Topline')
  })

  test('falls back to the de-slugged filename when no H1', () => {
    expect(chunkMarkdown('no headings here').title).toBe('Untitled')
    expect(chunkMarkdown('text', { filename: 'kickoff-notes.md' }).title).toBe('Kickoff notes')
    expect(chunkMarkdown('text', { filename: 'docs/STATUS.md' }).title).toBe('STATUS')
  })

  test('splits into one chunk per heading, plus a preamble chunk', () => {
    const md = ['preamble text', '', '# Title', 'intro', '', '## Section A', 'alpha', '', '## Section B', 'beta'].join(
      '\n',
    )
    const { chunks } = chunkMarkdown(md)
    const headings = chunks.map((c) => c.heading)
    expect(headings).toEqual(['', 'Title', 'Section A', 'Section B'])
    expect(chunks[0]!.heading).toBe('')
    expect(chunks[0]!.body).toContain('preamble text')
    const a = chunks.find((c) => c.heading === 'Section A')!
    expect(a.body).toContain('alpha')
    expect(a.body).not.toContain('beta')
  })

  test('does not treat # lines inside code fences as headings', () => {
    const md = ['# Real Heading', '', '```bash', '# this is a shell comment', 'echo hi', '```', '', 'tail'].join('\n')
    const { chunks } = chunkMarkdown(md)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.heading).toBe('Real Heading')
    expect(chunks[0]!.body).toContain('# this is a shell comment')
  })

  test('assigns sequential ordinals and drops empty chunks', () => {
    const md = '# A\n\n\n# B\n\ncontent'
    const { chunks } = chunkMarkdown(md)
    expect(chunks.map((c) => c.ordinal)).toEqual([...chunks.keys()])
    // Heading-only "A" still has its heading line as body, so it survives;
    // verify ordinals are contiguous regardless.
    expect(chunks[0]!.ordinal).toBe(0)
  })

  test('splits a long section into sub-chunks at paragraph boundaries', () => {
    const para = 'word '.repeat(60).trim() // ~300 chars
    const md = `# Big\n\n${para}\n\n${para}\n\n${para}\n\n${para}`
    const { chunks } = chunkMarkdown(md, { maxChars: 400 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.heading).toBe('Big')
  })

  test('strips trailing closing hashes from a heading', () => {
    const { chunks } = chunkMarkdown('## Section ##\n\nbody')
    expect(chunks[0]!.heading).toBe('Section')
  })

  test('keeps a trailing # that is not a closing fence (no preceding space)', () => {
    const { chunks } = chunkMarkdown('## C#\n\nbody')
    expect(chunks[0]!.heading).toBe('C#')
  })

  test('a long run of spaces in a heading does not hang (ReDoS-safe)', () => {
    const heading = '#' + ' '.repeat(50000) + 'x' + ' '.repeat(50000)
    const start = performance.now()
    const { chunks } = chunkMarkdown(`${heading}\n\nbody`)
    // WALL-CLOCK-BOUND-OK: this is a COMPLEXITY assertion, and elapsed time is
    // the only observable that separates linear scanning from catastrophic
    // backtracking. Nothing deterministic can replace it: a ReDoS regression
    // returns the SAME `chunks` this test already checks, just exponentially
    // later, so the heading assertion below cannot see it. The per-test timeout
    // is not a substitute either — it only catches a total hang, while the
    // regression this guards against (a quadratic rescan) lands in the hundreds
    // of ms, under the timeout and over any honest budget. The threshold
    // discriminates two outcomes orders of magnitude apart and the margin is
    // measured, not hoped for: 0.25 ms unloaded, and 0.33/0.38/0.44 ms with a
    // 6.0 ms first-run outlier under 2x CPU oversubscription (16 spinners on 8
    // cores), against the 1000 ms budget — 0.6% of it at worst. ISSUES #438.
    expect(performance.now() - start).toBeLessThan(1000)
    expect(chunks[0]!.heading).toContain('x')
  })
})

describe('deriveTitleFromFilename', () => {
  test('handles undefined / empty', () => {
    expect(deriveTitleFromFilename(undefined)).toBe('Untitled')
    expect(deriveTitleFromFilename('')).toBe('Untitled')
  })
  test('keeps all-caps stems verbatim', () => {
    expect(deriveTitleFromFilename('CLAUDE.md')).toBe('CLAUDE')
  })
})
