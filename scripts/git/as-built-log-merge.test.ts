/**
 * Unit proofs for the entry-aware log merge. The real-git acceptance test
 * (`as-built-merge-realgit.test.ts`) proves the mechanism works through git; this file pins the
 * properties that make it SAFE to let it near a 17,000-line file nobody re-reads afterwards.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { mergeAsBuiltLog, parseLog, serializeLog } from './as-built-log-merge.ts'
import { runDriver } from './as-built-merge-driver.ts'

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
    // it will actually be pointed at — 300+ entries, four duplicated headings, and a great deal of
    // fenced sample markdown. (An earlier comment here also claimed ten undated sections; measured,
    // there are zero — every entry in the current file carries a date. See `effectiveDates`.)
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

  test('KNOWN LIMIT — a new entry colliding with an old heading keeps BOTH; only order is odd', () => {
    // Identity is heading + occurrence, so an addition whose heading is byte-identical to an
    // existing entry shifts the indices below it. The documented consequence is a possibly odd
    // ORDER — never a dropped entry. This pins the part that matters: nothing is lost.
    const collide = '## 2026-08-10 — older thing\n\na genuinely new entry that reuses the heading\n\n'
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(collide, OLD_A, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('a genuinely new entry that reuses the heading')
    expect(res.text).toContain('body of older thing')
    expect(res.text).toContain('body two')
    expect(res.text).toContain('body of oldest thing')
  })

  test('both sides deleting the same entry is agreement, not a conflict', () => {
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(OLD_B), log(OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(OLD_B))
  })
})

describe('the driver CLI — what git actually gets back', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  /** Lay the three inputs out the way git does and run the driver over them. */
  function drive(base: string, ours: string, theirs: string): { code: number; result: string } {
    const dir = mkdtempSync(join(tmpdir(), 'as-built-driver-'))
    dirs.push(dir)
    const paths = { O: join(dir, 'base'), A: join(dir, 'ours'), B: join(dir, 'theirs') }
    writeFileSync(paths.O, base)
    writeFileSync(paths.A, ours)
    writeFileSync(paths.B, theirs)
    const code = runDriver([paths.O, paths.A, paths.B, '7', 'docs/AS_BUILT.md'])
    // git reads the merged result back out of %A, so that is what is asserted — not a return value.
    return { code, result: readFileSync(paths.A, 'utf8') }
  }

  test('a clean merge exits 0 and leaves the union in the ours file', () => {
    const base = log(OLD_A)
    const { code, result } = drive(base, log(NEW_ONE, OLD_A), log(NEW_TWO, OLD_A))
    expect(code).toBe(0)
    expect(result).toBe(log(NEW_ONE, NEW_TWO, OLD_A))
    expect(result).not.toContain('<<<<<<<')
  })

  test('THE FLOOR — a refused merge comes back as git\'s own conflict markers, non-zero', () => {
    // The claim this change rests on is that its failure mode is exactly today's behaviour. That
    // is only true if the fallback really runs `git merge-file` and really writes markers, so it
    // is asserted rather than described.
    const base = log(OLD_A)
    const ours = log('## 2026-08-10 — older thing\n\nours version\n\n')
    const theirs = log('## 2026-08-10 — older thing\n\ntheirs version\n\n')
    const { code, result } = drive(base, ours, theirs)
    expect(code).not.toBe(0)
    expect(result).toContain('<<<<<<< ours')
    expect(result).toContain('=======')
    expect(result).toContain('>>>>>>> theirs')
    // Both sides' text is still there for the human who has to reconcile it.
    expect(result).toContain('ours version')
    expect(result).toContain('theirs version')
  })

  test('the marker size git asks for is the marker size it gets', () => {
    const base = log(OLD_A)
    const dir = mkdtempSync(join(tmpdir(), 'as-built-driver-'))
    dirs.push(dir)
    const paths = { O: join(dir, 'base'), A: join(dir, 'ours'), B: join(dir, 'theirs') }
    writeFileSync(paths.O, base)
    writeFileSync(paths.A, log('## 2026-08-10 — older thing\n\nours\n\n'))
    writeFileSync(paths.B, log('## 2026-08-10 — older thing\n\ntheirs\n\n'))
    runDriver([paths.O, paths.A, paths.B, '9', 'docs/AS_BUILT.md'])
    expect(readFileSync(paths.A, 'utf8')).toContain('<'.repeat(9))
  })

  test('a missing input file is a conflict, never a silent clean merge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-built-driver-'))
    dirs.push(dir)
    const ours = join(dir, 'ours')
    writeFileSync(ours, log(OLD_A))
    expect(runDriver([join(dir, 'nope'), ours, join(dir, 'nope2'), '7', 'docs/AS_BUILT.md'])).not.toBe(0)
  })

  test('too few arguments is refused rather than guessed at', () => {
    expect(runDriver([])).toBe(2)
  })
})

// ----------------------------------------------------------------------------------------------
// Round-3 review findings. Every one of these FAILED against the previous cut of this module, and
// every one of them is a way the merge could return `ok: true` while losing or mangling history —
// which is the single outcome this file exists to prevent. A clean merge that quietly drops a
// change is worse than a conflict, because nobody looks at it.
// ----------------------------------------------------------------------------------------------

const HEAD_OLD_A = '## 2026-08-10 — older thing'
const HEAD_OLD_B = '## 2026-08-09 — oldest thing'
const HEAD_NEW_ONE = '## 2026-08-16 — build one'

describe('a side that is not a log never merges silently', () => {
  test('ONE side truncated to zero entries is refused — it used to wipe the whole history', () => {
    // THE BUG: the guard read `A.entries.length === 0 && B.entries.length === 0`, so a ONE-sided
    // truncation slipped straight past it. Every base entry was then present in `theirs` and
    // absent from `ours`, which the retention loop reads as a legitimate deletion — for all of
    // them at once. The result was ok:true with the canonical log replaced by the single new entry.
    const base = log(OLD_A, OLD_B)
    const truncated = '# AS_BUILT\n\nRunning log of what shipped, newest first. One entry per merged change.\n'
    const appended = log(NEW_ONE, OLD_A, OLD_B)

    expect(mergeAsBuiltLog(base, truncated, appended).ok).toBe(false)
    // and in the other direction — `ours`/`theirs` swap with the direction of the merge
    expect(mergeAsBuiltLog(base, appended, truncated).ok).toBe(false)

    // CONTROL — the same two sides with the truncation replaced by an ordinary no-op DO merge, so
    // the refusals above are caused by the truncation and not by the shape of the fixture.
    const control = mergeAsBuiltLog(base, base, appended)
    expect(control.ok).toBe(true)
    expect((control as { text: string }).text).toContain('body of oldest thing')
  })
})

describe('fence tracking is CommonMark, not a boolean toggle', () => {
  test('a four-backtick fence quoting a three-backtick block stays ONE entry', () => {
    // THE BUG: `fenced = !fenced` on every fence line. The inner ``` closed the block early, the
    // sample `## ` heading below it was read as a real entry, and one entry silently became two —
    // which the merge then date-sorts independently, so another entry can be placed between the
    // two halves of what was one entry.
    // The sample heading sits after an ODD number of inner fence lines on purpose. A boolean
    // toggle is back to "open" after a balanced inner block, which would hide the bug; it is
    // "closed" here, so the toggle reads the sample as a real entry and the entry splits in two.
    const text = log(
      '## 2026-08-16 — documents a fenced format\n\n````md\n```sh\n## 2026-01-01 — sample, not an entry\n```\n````\n\ntail\n\n',
    )
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(text)

    // CONTROL — the same sample heading OUTSIDE any fence is still found, so the fix suppressed a
    // false positive rather than blinding the parser to real headings.
    expect(parseLog(log('## 2026-08-16 — real\n\nx\n\n## 2026-01-01 — also real\n\ny\n\n')).entries.length).toBe(2)
  })

  test('a shorter fence does not close a longer one, and a tilde does not close a backtick', () => {
    expect(parseLog(log('## 2026-08-16 — a\n\n````\n```\n## 2026-01-01 — sample\n````\n\n')).entries.length).toBe(1)
    expect(parseLog(log('## 2026-08-16 — a\n\n~~~\n```\n## 2026-01-01 — sample\n~~~\n\n')).entries.length).toBe(1)
  })
})

describe('a reordering of existing entries survives the merge', () => {
  test('one side reordering the retained entries has that order honoured, not reverted', () => {
    // THE BUG: retained entries were emitted unconditionally in the BASE's order, so a
    // restructuring pass over this file — #304 was exactly that — merged at ok:true and was
    // silently reverted to the old order.
    const base = log(OLD_A, OLD_B)
    const reordered = log(OLD_B, OLD_A)
    const appended = log(NEW_ONE, OLD_A, OLD_B)

    const merged = mergeAsBuiltLog(base, reordered, appended)
    expect(merged.ok).toBe(true)
    expect(parseLog((merged as { text: string }).text).entries.map((e) => e.lines[0])).toEqual([
      HEAD_NEW_ONE,
      HEAD_OLD_B,
      HEAD_OLD_A,
    ])

    // CONTROL — with neither side reordering, the base order is kept. So the assertion above is
    // reached by the reorder, not by the placement logic putting things there anyway.
    const straight = mergeAsBuiltLog(base, base, appended)
    expect(parseLog((straight as { text: string }).text).entries.map((e) => e.lines[0])).toEqual([
      HEAD_NEW_ONE,
      HEAD_OLD_A,
      HEAD_OLD_B,
    ])
  })

  test('both sides reordering DIFFERENTLY is a conflict, not a coin flip', () => {
    const base = log(OLD_A, OLD_B, NEW_ONE)
    const ours = log(OLD_B, OLD_A, NEW_ONE)
    const theirs = log(NEW_ONE, OLD_A, OLD_B)
    expect(mergeAsBuiltLog(base, ours, theirs).ok).toBe(false)

    // CONTROL — both sides reordering the SAME way is agreement, and merges.
    expect(mergeAsBuiltLog(base, ours, ours).ok).toBe(true)
  })
})

describe('an added undated continuation lands beside its parent', () => {
  test('a new undated section sorts with the entry above it, not to the bottom of the file', () => {
    // THE BUG: additions sorted on the bare heading date while `effectiveDates` was applied only to
    // RETAINED entries. A newly added continuation therefore carried `''`, which sorts below every
    // real date, and was emitted at the very end of the log — detached from the entry it continues.
    const base = log(OLD_A, OLD_B)
    const continuation = '## Follow-up, same change\n\nmore about build one\n\n'
    const withBoth = log(NEW_ONE, continuation, OLD_A, OLD_B)

    const merged = mergeAsBuiltLog(base, withBoth, base)
    expect(merged.ok).toBe(true)
    const headings = parseLog((merged as { text: string }).text).entries.map((e) => e.lines[0])
    expect(headings[0]).toBe(HEAD_NEW_ONE)
    expect(headings[1]).toBe('## Follow-up, same change')
    // and specifically NOT at the end, which is where it used to land
    expect(headings[headings.length - 1]).not.toBe('## Follow-up, same change')
  })
})
