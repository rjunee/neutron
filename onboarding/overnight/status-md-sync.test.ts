import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OvernightItem } from './queue-store.ts'
import {
  checkContextGate,
  parseOptInFlag,
  parseOvernightSection,
  renderOvernightSection,
  resolveContextFile,
  spliceOvernightSection,
  MAX_CONTEXT_FILE_BYTES,
} from './status-md-sync.ts'

function item(partial: Partial<OvernightItem> & { id: string }): OvernightItem {
  return {
    owner_slug: 'acme',
    agent_role: 'forge',
    priority: 'P3',
    description: 'do a thing',
    status: 'queued',
    context_relpath: null,
    result: null,
    trident_run_id: null,
    trident_slug: null,
    spawn_attempts: 0,
    ralph: false,
    created_at: '2026-06-19T10:00:00Z',
    started_at: null,
    finished_at: null,
    window_date_local: null,
    ...partial,
  }
}

describe('render / parse round-trip', () => {
  test('a rendered queued item parses back to the same fields', () => {
    const it = item({
      id: 'owk-20260619-001',
      description: 'Add pagination',
      agent_role: 'forge',
      priority: 'P2',
      context_relpath: 'docs/spec.md',
    })
    const section = renderOvernightSection([it])
    const parsed = parseOvernightSection(section)
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.id).toBe('owk-20260619-001')
    expect(parsed[0]!.description).toBe('Add pagination')
    expect(parsed[0]!.agent_role).toBe('forge')
    expect(parsed[0]!.priority).toBe('P2')
    expect(parsed[0]!.context_relpath).toBe('docs/spec.md')
    expect(parsed[0]!.status).toBe('queued')
  })

  test('completed item renders [x] + strikethrough + result, parses completed', () => {
    const it = item({
      id: 'owk-20260619-002',
      status: 'completed',
      result: 'PR#42',
      finished_at: '2026-06-20T06:00:00Z',
    })
    const section = renderOvernightSection([it])
    expect(section).toContain('[x]')
    expect(section).toContain('~~do a thing~~')
    expect(section).toContain('[result:PR#42]')
    const parsed = parseOvernightSection(section)
    expect(parsed[0]!.status).toBe('completed')
    expect(parsed[0]!.result).toBe('PR#42')
  })

  test('malformed agent/priority tags skip the bullet (typo, not default)', () => {
    expect(parseOvernightSection('## Autonomous Overnight Work\n\n- [ ] x [agent:atals]\n')).toEqual(
      [],
    )
    expect(
      parseOvernightSection('## Autonomous Overnight Work\n\n- [ ] x [priority:p1]\n'),
    ).toEqual([])
  })

  test('empty queue renders the placeholder', () => {
    expect(renderOvernightSection([])).toContain('_No overnight work queued._')
  })
})

describe('spliceOvernightSection', () => {
  test('preserves bytes outside the section', () => {
    const md = `# Status\n\nSome prose.\n\n## Autonomous Overnight Work\n\nold.\n\n## Other\n\nkeep me.\n`
    const next = spliceOvernightSection(md, renderOvernightSection([]))
    expect(next).toContain('Some prose.')
    expect(next).toContain('## Other')
    expect(next).toContain('keep me.')
    expect(next).toContain('_No overnight work queued._')
    expect(next).not.toContain('old.')
  })

  test('appends the section when absent', () => {
    const md = `# Status\n\nProse only.\n`
    const next = spliceOvernightSection(md, renderOvernightSection([item({ id: 'owk-20260619-009' })]))
    expect(next).toContain('## Autonomous Overnight Work')
    expect(next).toContain('owk-20260619-009')
  })
})

describe('parseOptInFlag', () => {
  test('true when frontmatter sets the flag', () => {
    expect(parseOptInFlag('---\nname: x\nautonomous_overnight_enabled: true\n---\n# h')).toBe(true)
  })
  test('false when flag absent / off / no frontmatter', () => {
    expect(parseOptInFlag('---\nname: x\n---\n')).toBe(false)
    expect(parseOptInFlag('---\nautonomous_overnight_enabled: false\n---\n')).toBe(false)
    expect(parseOptInFlag('# no frontmatter')).toBe(false)
  })
})

describe('[context:] hard gate', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'neutron-overnight-ctx-'))
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'spec.md'), '# spec\nbuild it')
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('resolves a real in-repo file', () => {
    const res = resolveContextFile(repo, 'docs/spec.md')
    expect(res.error).toBeUndefined()
    expect(res.text).toContain('build it')
  })

  test('rejects absolute paths', () => {
    expect(resolveContextFile(repo, '/etc/passwd').error).toMatch(/absolute/)
  })

  test('rejects parent-dir traversal', () => {
    expect(resolveContextFile(repo, '../escape.md').error).toMatch(/parent-directory/)
  })

  test('rejects a symlink that escapes the repo root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'neutron-overnight-outside-'))
    writeFileSync(join(outside, 'secret.md'), 'secret')
    symlinkSync(join(outside, 'secret.md'), join(repo, 'docs', 'link.md'))
    expect(resolveContextFile(repo, 'docs/link.md').error).toMatch(/escapes repo root/)
    rmSync(outside, { recursive: true, force: true })
  })

  test('rejects oversized files', () => {
    writeFileSync(join(repo, 'docs', 'big.md'), 'x'.repeat(MAX_CONTEXT_FILE_BYTES + 1))
    expect(resolveContextFile(repo, 'docs/big.md').error).toMatch(/too large/)
  })

  test('checkContextGate: missing tag rejected', () => {
    const gate = checkContextGate(repo, item({ id: 'owk-1', context_relpath: null }))
    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('missing-context-tag')
  })

  test('checkContextGate: unresolved file rejected', () => {
    const gate = checkContextGate(repo, item({ id: 'owk-1', context_relpath: 'docs/nope.md' }))
    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('context-file-unresolved')
  })

  test('checkContextGate: valid context passes + returns text', () => {
    const gate = checkContextGate(repo, item({ id: 'owk-1', context_relpath: 'docs/spec.md' }))
    expect(gate.ok).toBe(true)
    expect(gate.context_text).toContain('build it')
  })
})
