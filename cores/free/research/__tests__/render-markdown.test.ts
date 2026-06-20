/**
 * @neutronai/research-core — render-markdown tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3.
 */

import { describe, expect, test } from 'bun:test'

import type { ResearchBrief } from '../src/backend.ts'
import { renderBriefMarkdown } from '../src/render-markdown.ts'

function brief(overrides: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    topic: overrides.topic ?? 'how does water cycle work',
    key_findings: overrides.key_findings ?? ['rain evaporates', 'rivers flow'],
    sources: overrides.sources ?? [],
    confidence_level: overrides.confidence_level ?? 'medium',
    recommendations: overrides.recommendations ?? ['drink water'],
    ...(overrides.claims !== undefined ? { claims: overrides.claims } : {}),
  }
}

describe('renderBriefMarkdown', () => {
  test('emits YAML front-matter with topic / date / task_id / claim_count', () => {
    const md = renderBriefMarkdown(
      brief({ claims: [{ claim: 'x', citation: 'https://x', confidence: 'high' }] }),
      {
        task_id: 't-abc-123',
        project_id: 'proj-1',
        written_at: new Date('2026-05-21T12:00:00Z'),
      },
    )
    expect(md).toContain('---')
    expect(md).toContain('task_id: t-abc-123')
    expect(md).toContain('date: 2026-05-21')
    expect(md).toContain('claim_count: 1')
  })

  test('engineering-shape topic gets the 5-line spec-conformance-diff template', () => {
    const md = renderBriefMarkdown(
      brief({
        topic: 'sprint plan for migration foo',
        claims: [{ claim: 'x', citation: 'docs/x.md', confidence: 'high' }],
      }),
      { task_id: 't-1', project_id: 'p-1' },
    )
    expect(md).toContain('5-line spec-conformance diff')
    expect(md).toContain('SPEC:')
    expect(md).toContain('GAP:')
  })

  test('non-engineering topic does NOT get the template', () => {
    const md = renderBriefMarkdown(
      brief({
        topic: 'best coffee in seattle',
        claims: [{ claim: 'x', citation: 'https://x', confidence: 'high' }],
      }),
      { task_id: 't-1', project_id: 'p-1' },
    )
    expect(md).not.toContain('5-line spec-conformance diff')
  })

  test('claims are rendered with unverified tag where appropriate', () => {
    const md = renderBriefMarkdown(
      brief({
        claims: [
          { claim: 'verified fact', citation: 'https://x', confidence: 'high' },
          { claim: 'unverified guess', confidence: 'unverified' },
        ],
      }),
      { task_id: 't-1', project_id: 'p-1' },
    )
    expect(md).toContain('verified fact')
    expect(md).toContain('unverified guess _(unverified)_')
  })

  test('citation list dedupes', () => {
    const md = renderBriefMarkdown(
      brief({
        claims: [
          { claim: 'a', citation: 'https://x.com', confidence: 'high' },
          { claim: 'b', citation: 'https://x.com', confidence: 'medium' },
        ],
      }),
      { task_id: 't-1', project_id: 'p-1' },
    )
    // Slice the Sources block from `## Sources` to the next H2 — only
    // count occurrences inside that section.
    const start = md.indexOf('## Sources')
    const remainder = md.slice(start + '## Sources'.length)
    const nextH2 = remainder.indexOf('\n## ')
    const sourcesBlock = nextH2 === -1 ? remainder : remainder.slice(0, nextH2)
    const occurrences = sourcesBlock.split('https://x.com').length - 1
    expect(occurrences).toBe(1)
  })

  test('deterministic — same input → same output', () => {
    const b = brief({
      claims: [{ claim: 'a', citation: 'https://x', confidence: 'high' }],
    })
    const opts = {
      task_id: 't-1',
      project_id: 'p-1',
      written_at: new Date('2026-05-21T12:00:00Z'),
    }
    const a = renderBriefMarkdown(b, opts)
    const b2 = renderBriefMarkdown(b, opts)
    expect(a).toBe(b2)
  })
})
