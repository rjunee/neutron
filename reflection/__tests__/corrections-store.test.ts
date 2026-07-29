import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendCorrection, readRecentCorrections } from '../corrections-store.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-reflection-corr-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('corrections-store', () => {
  test('write then read round-trips a correction with all fields', () => {
    const at = Date.parse('2026-06-21T12:00:00.000Z')
    const written = appendCorrection({
      ownerDataDir: tmp,
      wrong: 'used tabs',
      right: 'always use two-space indentation',
      why: 'matches the repo style',
      scope: 'project-globex',
      source: 'no, use spaces not tabs',
      observed_at: at,
    })
    expect(written.right).toBe('always use two-space indentation')

    const back = readRecentCorrections({ ownerDataDir: tmp })
    expect(back).toHaveLength(1)
    const c = back[0]!
    expect(c.wrong).toBe('used tabs')
    expect(c.right).toBe('always use two-space indentation')
    expect(c.why).toBe('matches the repo style')
    expect(c.scope).toBe('project-globex')
    expect(c.source).toBe('no, use spaces not tabs')
    expect(c.id).toBe(written.id)
    expect(c.ts).toBe(written.ts)
  })

  test('creates a human-readable append-only markdown log', () => {
    const at = Date.parse('2026-06-21T12:00:00.000Z')
    appendCorrection({ ownerDataDir: tmp, wrong: 'w', right: 'do X', why: 'because', observed_at: at })
    const path = join(tmp, 'corrections', 'corrections-log.md')
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('# Corrections Log')
    expect(raw).toContain('ADAPTS SILENTLY')
    expect(raw).toContain('- **right:** do X')
    expect(raw).toContain('- **why:** because')
  })

  test('multiple corrections return newest-first', () => {
    const at = Date.parse('2026-06-21T12:00:00.000Z')
    appendCorrection({ ownerDataDir: tmp, wrong: '', right: 'first learning', observed_at: at })
    appendCorrection({ ownerDataDir: tmp, wrong: '', right: 'second learning', observed_at: at + 5000 })
    appendCorrection({ ownerDataDir: tmp, wrong: '', right: 'third learning', observed_at: at + 9000 })

    const back = readRecentCorrections({ ownerDataDir: tmp })
    expect(back.map((c) => c.right)).toEqual(['third learning', 'second learning', 'first learning'])
  })

  test('append-only: a new correction never rewrites a prior block', () => {
    const at = Date.parse('2026-06-21T12:00:00.000Z')
    appendCorrection({ ownerDataDir: tmp, wrong: '', right: 'keep me', observed_at: at })
    const path = join(tmp, 'corrections', 'corrections-log.md')
    const after1 = readFileSync(path, 'utf8')
    appendCorrection({ ownerDataDir: tmp, wrong: '', right: 'add me', observed_at: at + 1000 })
    const after2 = readFileSync(path, 'utf8')
    expect(after2.startsWith(after1)).toBe(true) // pure append
    expect(after2).toContain('add me')
  })

  test('limit caps the returned set', () => {
    const at = Date.parse('2026-06-21T12:00:00.000Z')
    for (let i = 0; i < 4; i++) {
      appendCorrection({ ownerDataDir: tmp, wrong: '', right: `learning ${i}`, observed_at: at + i * 1000 })
    }
    const back = readRecentCorrections({ ownerDataDir: tmp, limit: 2 })
    expect(back.map((c) => c.right)).toEqual(['learning 3', 'learning 2'])
  })

  test('empty right throws; missing file reads as empty', () => {
    expect(() => appendCorrection({ ownerDataDir: tmp, wrong: 'w', right: '   ' })).toThrow()
    const fresh = mkdtempSync(join(tmpdir(), 'neutron-reflection-corr-empty-'))
    expect(readRecentCorrections({ ownerDataDir: fresh })).toEqual([])
    rmSync(fresh, { recursive: true, force: true })
  })

  test('ids are unique even within the same millisecond', () => {
    const at = Date.parse('2026-06-21T12:00:00.000Z')
    const a = appendCorrection({ ownerDataDir: tmp, wrong: '', right: 'a', observed_at: at })
    const b = appendCorrection({ ownerDataDir: tmp, wrong: '', right: 'b', observed_at: at })
    expect(a.id).not.toBe(b.id)
  })
})
