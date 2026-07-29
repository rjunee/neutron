import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendDiaryEntry, readRecentDiary } from '../diary-store.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-reflection-diary-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('diary-store', () => {
  test('write then read round-trips a single entry', () => {
    const at = Date.parse('2026-06-21T10:00:00.000Z')
    const written = appendDiaryEntry({ ownerDataDir: tmp, text: 'Shipped the diary layer.', observed_at: at })
    expect(written.date).toBe('2026-06-21')
    expect(written.kind).toBe('reflection')

    const back = readRecentDiary({ ownerDataDir: tmp, now: at })
    expect(back).toHaveLength(1)
    expect(back[0]?.text).toBe('Shipped the diary layer.')
    expect(back[0]?.date).toBe('2026-06-21')
  })

  test('creates a per-day markdown file with a frontmatter header', () => {
    const at = Date.parse('2026-06-21T10:00:00.000Z')
    appendDiaryEntry({ ownerDataDir: tmp, text: 'first', observed_at: at })
    const path = join(tmp, 'diary', '2026-06-21.md')
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('kind: diary')
    expect(raw).toContain('# Diary — 2026-06-21')
    expect(raw).toContain('- 2026-06-21T10:00:00.000Z | reflection | - | first')
  })

  test('is append-only: a second write keeps the first line intact', () => {
    const at = Date.parse('2026-06-21T10:00:00.000Z')
    appendDiaryEntry({ ownerDataDir: tmp, text: 'one', observed_at: at })
    appendDiaryEntry({ ownerDataDir: tmp, text: 'two', observed_at: at + 1000 })
    const raw = readFileSync(join(tmp, 'diary', '2026-06-21.md'), 'utf8')
    expect(raw).toContain('| one')
    expect(raw).toContain('| two')

    const back = readRecentDiary({ ownerDataDir: tmp, now: at + 1000 })
    expect(back.map((e) => e.text)).toEqual(['two', 'one']) // newest-first
  })

  test('reads across multiple day files within the window, newest-first', () => {
    const d1 = Date.parse('2026-06-20T09:00:00.000Z')
    const d2 = Date.parse('2026-06-21T09:00:00.000Z')
    appendDiaryEntry({ ownerDataDir: tmp, text: 'yesterday note', observed_at: d1 })
    appendDiaryEntry({ ownerDataDir: tmp, text: 'today note', observed_at: d2 })

    const back = readRecentDiary({ ownerDataDir: tmp, days: 7, now: d2 })
    expect(back.map((e) => e.text)).toEqual(['today note', 'yesterday note'])
  })

  test('honours the days window — old files outside it are skipped', () => {
    const old = Date.parse('2026-06-01T09:00:00.000Z')
    const recent = Date.parse('2026-06-21T09:00:00.000Z')
    appendDiaryEntry({ ownerDataDir: tmp, text: 'ancient', observed_at: old })
    appendDiaryEntry({ ownerDataDir: tmp, text: 'fresh', observed_at: recent })

    const back = readRecentDiary({ ownerDataDir: tmp, days: 3, now: recent })
    expect(back.map((e) => e.text)).toEqual(['fresh'])
  })

  test('preserves session + kind, and collapses newlines to one line', () => {
    const at = Date.parse('2026-06-21T10:00:00.000Z')
    appendDiaryEntry({
      ownerDataDir: tmp,
      text: 'multi\nline\treflection',
      kind: 'correction',
      session: 'project-globex',
      observed_at: at,
    })
    const back = readRecentDiary({ ownerDataDir: tmp, now: at })
    expect(back[0]?.kind).toBe('correction')
    expect(back[0]?.session).toBe('project-globex')
    expect(back[0]?.text).toBe('multi line reflection')
  })

  test('empty text throws; missing dir reads as empty', () => {
    expect(() => appendDiaryEntry({ ownerDataDir: tmp, text: '   ' })).toThrow()
    const fresh = mkdtempSync(join(tmpdir(), 'neutron-reflection-empty-'))
    expect(readRecentDiary({ ownerDataDir: fresh })).toEqual([])
    rmSync(fresh, { recursive: true, force: true })
  })

  test('limit caps returned entries', () => {
    const at = Date.parse('2026-06-21T10:00:00.000Z')
    for (let i = 0; i < 5; i++) appendDiaryEntry({ ownerDataDir: tmp, text: `e${i}`, observed_at: at + i })
    const back = readRecentDiary({ ownerDataDir: tmp, limit: 2, now: at + 10 })
    expect(back).toHaveLength(2)
    expect(back[0]?.text).toBe('e4')
  })
})
