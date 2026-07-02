/**
 * Pure spec-doc policy (M1 play-button + on-disk spec). Proves the triviality
 * heuristic, the docs-relative path + `neutron-docs:` ref round-trip, the doc
 * link label, and the markdown shape — all without touching disk or a DB.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildSpecDocMarkdown,
  designDocRefForPath,
  docLinkLabel,
  docPathFromDesignRef,
  shouldPersistSpecDoc,
  specDocRelPath,
  specDocSlug,
} from './spec-doc.ts'

describe('shouldPersistSpecDoc', () => {
  test('no spec → trivial (title-only, no doc)', () => {
    expect(shouldPersistSpecDoc(undefined, 'build a meditation timer')).toBe(false)
    expect(shouldPersistSpecDoc(null, 'x')).toBe(false)
    expect(shouldPersistSpecDoc('   ', 'x')).toBe(false)
  })

  test('short single-line spec → trivial', () => {
    expect(shouldPersistSpecDoc('build a meditation timer', 'meditation timer')).toBe(false)
    expect(shouldPersistSpecDoc('add a dark mode toggle', 'dark mode')).toBe(false)
  })

  test('multi-line spec → persist (structure is a strong signal)', () => {
    expect(shouldPersistSpecDoc('do X\n- a\n- b', 't')).toBe(true)
  })

  test('long single-line spec (>= 20 words) → persist', () => {
    const long = Array.from({ length: 22 }, (_, i) => `word${i}`).join(' ')
    expect(shouldPersistSpecDoc(long, 't')).toBe(true)
  })
})

describe('slug + path + ref round-trip', () => {
  test('specDocSlug is filesystem-safe + suffixed', () => {
    const slug = specDocSlug('Build a CSV Export!!!', 'AbC123')
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug).toBe('build-a-csv-export-abc123')
  })

  test('specDocSlug falls back to "plan" for a symbol-only title', () => {
    expect(specDocSlug('!!!', 'zz99')).toBe('plan-zz99')
  })

  test('specDocRelPath nests under plans/', () => {
    expect(specDocRelPath('foo-abc')).toBe('plans/foo-abc.md')
  })

  test('designDocRefForPath + docPathFromDesignRef round-trip', () => {
    const rel = specDocRelPath(specDocSlug('My Task', 'x1y2z3'))
    const ref = designDocRefForPath(rel)
    expect(ref).toBe(`neutron-docs:${rel}`)
    expect(docPathFromDesignRef(ref)).toBe(rel)
  })

  test('docPathFromDesignRef parses an /api/app docs path with ?path=', () => {
    const ref = '/api/app/projects/p/docs/file?path=plans/foo.md'
    expect(docPathFromDesignRef(ref)).toBe('plans/foo.md')
  })

  test('docPathFromDesignRef returns null for external / absent refs', () => {
    expect(docPathFromDesignRef('https://example.test/spec')).toBeNull()
    expect(docPathFromDesignRef(null)).toBeNull()
    expect(docPathFromDesignRef('')).toBeNull()
    expect(docPathFromDesignRef('neutron-docs:')).toBeNull()
  })

  test('docLinkLabel is the basename without .md', () => {
    expect(docLinkLabel('neutron-docs:plans/meditation-timer-abc.md')).toBe('meditation-timer-abc')
    expect(docLinkLabel('https://example.test/x')).toBeNull()
  })
})

describe('buildSpecDocMarkdown', () => {
  test('carries frontmatter + title heading + the verbatim spec body', () => {
    const md = buildSpecDocMarkdown({
      title: 'Wire CSV export',
      spec: 'Add a button.\nWire it to /export.\nCover with tests.',
      created_at: '2026-07-02T00:00:00.000Z',
    })
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('type: plan')
    expect(md).toContain('created: 2026-07-02T00:00:00.000Z')
    expect(md).toContain('# Wire CSV export')
    expect(md).toContain('Wire it to /export.')
    expect(md).toContain('Cover with tests.')
  })

  test('quotes a YAML-hostile title', () => {
    const md = buildSpecDocMarkdown({
      title: 'Fix: the thing',
      spec: 'x',
      created_at: '2026-07-02T00:00:00.000Z',
    })
    expect(md).toContain('title: "Fix: the thing"')
  })
})
