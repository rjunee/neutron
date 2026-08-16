/**
 * Unit proofs for the entry-aware log merge. The real-git acceptance test
 * (`as-built-merge-realgit.test.ts`) proves the mechanism works through git; this file pins the
 * properties that make it SAFE to let it near a 17,000-line file nobody re-reads afterwards.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { mergeAsBuiltLog, parseLog, serializeLog } from './as-built-log-merge.ts'

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const REAL_LOG = join(REPO_ROOT, 'docs', 'AS_BUILT.md')

const HEADER = '# AS_BUILT\n\nRunning log of what shipped, newest first. One entry per merged change.\n\n'

function log(...entries: string[]): string {
  return HEADER + entries.join('')
}

const OLD_A = '## 2026-08-10 — older thing\n\nbody of older thing\n\n'
const OLD_B = '## 2026-08-09 — oldest thing\n\nbody of oldest thing\n\n'
const NEW_ONE = '## 2026-08-16 — build one\n\nbody one\n\n'
const NEW_TWO = '## 2026-08-16 — build two\n\nbody two\n\n'

describe('parse/serialize', () => {
  test('round-trips the REAL AS_BUILT.md byte-for-byte', () => {
    // A merge driver that cannot reproduce its own input is a corruption engine. This is the file
    // it will actually be pointed at — 300+ entries, four duplicated headings, ten undated
    // sections and a great deal of fenced sample markdown.
    const text = readFileSync(REAL_LOG, 'utf8')
    expect(serializeLog(parseLog(text))).toBe(text)
  })

  test('finds every entry in the real log, and only real ones', () => {
    const text = readFileSync(REAL_LOG, 'utf8')
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBeGreaterThan(250)
    for (const entry of parsed.entries) expect(entry.lines[0]?.startsWith('## ')).toBe(true)
    // The preamble is the title block, never an entry.
    expect(parsed.preamble.join('\n')).toContain('# AS_BUILT')
    expect(parsed.preamble.join('\n')).not.toContain('\n## ')
  })

  test('a `## ` inside a fenced block is sample text, not a heading', () => {
    // Otherwise an entry quoting markdown gets cut in half and another entry can be merged
    // between the halves.
    const text = log('## 2026-08-16 — quotes markdown\n\n```md\n## 2026-01-01 — not a real entry\n```\n\ntail\n\n')
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('repeated headings stay distinct entries', () => {
    // The real log genuinely repeats four headings verbatim; folding them would delete history.
    const dup = '## 2026-08-09 — Model usage on the phone\n\nfirst\n\n'
    const dup2 = '## 2026-08-09 — Model usage on the phone\n\nsecond\n\n'
    const parsed = parseLog(log(dup, dup2))
    expect(parsed.entries.length).toBe(2)
    expect(parsed.entries[0]!.key).not.toBe(parsed.entries[1]!.key)
  })
})

describe('merge', () => {
  test('unions two concurrent additions, newest first, whole entries', () => {
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(NEW_ONE, OLD_A, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(NEW_ONE, NEW_TWO, OLD_A, OLD_B))
  })

  test('an identical no-op merge returns the file unchanged', () => {
    const base = readFileSync(REAL_LOG, 'utf8')
    const res = mergeAsBuiltLog(base, base, base)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(base)
  })

  test('a real added entry merges into the REAL log without disturbing anything else', () => {
    const base = readFileSync(REAL_LOG, 'utf8')
    const parsed = parseLog(base)
    const ours = base.replace(parsed.entries[0]!.lines[0]!, `## 2026-08-17 — ours\n\nours body\n\n${parsed.entries[0]!.lines[0]!}`)
    const theirs = base.replace(parsed.entries[0]!.lines[0]!, `## 2026-08-17 — theirs\n\ntheirs body\n\n${parsed.entries[0]!.lines[0]!}`)
    const res = mergeAsBuiltLog(base, ours, theirs)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const merged = parseLog(res.text)
    // Exactly two entries more than the base, and every original entry still present in order.
    expect(merged.entries.length).toBe(parsed.entries.length + 2)
    const originals = merged.entries.filter((e) => e.lines[0] !== '## 2026-08-17 — ours' && e.lines[0] !== '## 2026-08-17 — theirs')
    expect(originals.map((e) => e.lines[0])).toEqual(parsed.entries.map((e) => e.lines[0]))
  })

  test('one side adding while the other stands still keeps the addition', () => {
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(NEW_ONE, OLD_A, OLD_B), base)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(NEW_ONE, OLD_A, OLD_B))
  })

  test('an edit to an existing entry on one side alone is taken', () => {
    const base = log(OLD_A, OLD_B)
    const edited = '## 2026-08-10 — older thing\n\nbody of older thing, corrected\n\n'
    const res = mergeAsBuiltLog(base, log(edited, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(NEW_TWO, edited, OLD_B))
  })

  test('a dated addition older than the newest entry slots into date order, not on top', () => {
    const base = log(OLD_A, OLD_B)
    const between = '## 2026-08-09 — squeezed in\n\nbetween body\n\n'
    const res = mergeAsBuiltLog(base, log(OLD_A, between, OLD_B), base)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(OLD_A, between, OLD_B))
  })

  test('an undated subsection stays with the entry it belongs to', () => {
    // Ten sections in the real log carry no date; a new entry must not be inserted between an
    // entry and its own continuation.
    const sub = '## a subsection with no date\n\nsub body\n\n'
    const base = log(OLD_A, sub, OLD_B)
    const res = mergeAsBuiltLog(base, log(NEW_ONE, OLD_A, sub, OLD_B), base)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(NEW_ONE, OLD_A, sub, OLD_B))
  })

  test('ordering does not depend on locale — same-date additions break ties by heading bytes', () => {
    const base = log(OLD_A)
    // Two same-date additions whose order under a locale-aware compare could differ from a byte
    // compare. The expectation is the byte order, deterministically.
    const upper = '## 2026-08-16 — Zebra\n\nz\n\n'
    const lower = '## 2026-08-16 — apple\n\na\n\n'
    const res = mergeAsBuiltLog(base, log(upper, OLD_A), log(lower, OLD_A))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(upper, lower, OLD_A))
  })
})

describe('what it refuses — the floor is a conflict a human reads, never a guess', () => {
  test('both sides editing the SAME entry differently is a conflict', () => {
    const base = log(OLD_A, OLD_B)
    const ours = log('## 2026-08-10 — older thing\n\nours version\n\n', OLD_B)
    const theirs = log('## 2026-08-10 — older thing\n\ntheirs version\n\n', OLD_B)
    const res = mergeAsBuiltLog(base, ours, theirs)
    expect(res.ok).toBe(false)
  })

  test('one side deleting what the other edited is a conflict', () => {
    const base = log(OLD_A, OLD_B)
    const ours = log(OLD_B)
    const theirs = log('## 2026-08-10 — older thing\n\nedited, not deleted\n\n', OLD_B)
    expect(mergeAsBuiltLog(base, ours, theirs).ok).toBe(false)
  })

  test('two different entries added under the SAME heading is a conflict, not a coin flip', () => {
    const base = log(OLD_A)
    const ours = log('## 2026-08-16 — same title\n\nours body\n\n', OLD_A)
    const theirs = log('## 2026-08-16 — same title\n\ntheirs body\n\n', OLD_A)
    expect(mergeAsBuiltLog(base, ours, theirs).ok).toBe(false)
  })

  test('a diverged header is a conflict', () => {
    const base = log(OLD_A)
    expect(mergeAsBuiltLog(base, `# OURS\n\n${OLD_A}`, `# THEIRS\n\n${OLD_A}`).ok).toBe(false)
  })

  test('a file that is not an entry log is handed back to git', () => {
    expect(mergeAsBuiltLog('nothing', 'no entries here', 'none here either').ok).toBe(false)
  })

  test('both sides deleting the same entry is agreement, not a conflict', () => {
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(OLD_B), log(OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(OLD_B))
  })
})
