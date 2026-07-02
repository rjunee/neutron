/**
 * Documents-tab frontmatter stripping (2026-07-01 SEV1 — "STOP M2" d).
 *
 * The shared React markdown renderer (`Markdown.tsx`) renders a document's raw
 * content. Project docs (STATUS.md, README.md, …) carry a leading YAML
 * frontmatter fence which, rendered as markdown, shows as a bold run-on blob at
 * the top. `stripLeadingFrontmatter` removes that fence for the Documents viewer
 * (the chat surface leaves it untouched). Pins: a well-formed leading fence is
 * removed, the body survives, and non-frontmatter text (including a bare `---`
 * horizontal rule) is left unchanged.
 */
import { describe, expect, test } from 'bun:test'

import { stripLeadingFrontmatter } from '../Markdown.tsx'

describe('stripLeadingFrontmatter', () => {
  test('removes a leading YAML frontmatter fence, keeping the body', () => {
    const doc =
      '---\nname: topline\nstatus: active\npriority: P2\none_liner: "Billing SaaS."\n---\n\n# Status\n\nReal body here.\n'
    const out = stripLeadingFrontmatter(doc)
    expect(out).not.toContain('one_liner')
    expect(out).not.toContain('priority: P2')
    expect(out.startsWith('# Status')).toBe(true)
    expect(out).toContain('Real body here.')
  })

  test('handles the minimal no-context STATUS.md frontmatter', () => {
    const doc =
      '---\nname: mystery\nstatus: active\npriority: P2\none_liner: ""\nremote: local\nlast_updated: 2026-07-01\n---\n\n# Status\n\nCreated during onboarding - no context yet.\n'
    const out = stripLeadingFrontmatter(doc)
    expect(out).not.toContain('remote: local')
    expect(out).not.toContain('last_updated')
    expect(out.trimStart().startsWith('# Status')).toBe(true)
    expect(out).toContain('Created during onboarding - no context yet.')
  })

  test('leaves a document with no frontmatter unchanged', () => {
    const doc = '# Just a heading\n\nSome prose, no frontmatter.\n'
    expect(stripLeadingFrontmatter(doc)).toBe(doc)
  })

  test('does NOT strip a bare `---` horizontal rule (no closing fence)', () => {
    const doc = 'Intro paragraph.\n\n---\n\nAfter the rule.\n'
    expect(stripLeadingFrontmatter(doc)).toBe(doc)
  })

  test('handles CRLF line endings', () => {
    const doc = '---\r\nname: x\r\n---\r\n\r\nBody.\r\n'
    const out = stripLeadingFrontmatter(doc)
    expect(out).not.toContain('name: x')
    expect(out).toContain('Body.')
  })

  test('is a no-op on empty input', () => {
    expect(stripLeadingFrontmatter('')).toBe('')
  })
})
