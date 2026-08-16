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

  test('a `~~~` inside a BACKTICK fence does not end it — a mismatched delimiter is body text', () => {
    // The regression: the fence state was one boolean flipped by EITHER delimiter, so the `~~~`
    // below closed the backtick block three lines early and the sample heading after it parsed as a
    // real entry — after which a concurrent addition could be placed INSIDE this entry's code block.
    const text = log(
      '## 2026-08-16 — quotes a doc that itself quotes code\n\n```md\nintro\n~~~\n## 2000-01-01 — sample only\n```\n\ntail\n\n',
    )
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(parsed.entries[0]!.lines.join('\n')).toContain('## 2000-01-01 — sample only')
    expect(serializeLog(parsed)).toBe(text)
  })

  test('a TILDE fence is closed by tildes and not by backticks', () => {
    const text = log('## 2026-08-16 — tilde fenced\n\n~~~md\n```\n## 2000-01-01 — sample only\n```\n~~~\n\ntail\n\n')
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('an info string opens a fence and never closes one', () => {
    // ```` ```md ```` is an OPENING fence with a language tag; a closing fence carries nothing but
    // whitespace. Reading it as a close ends the block early and exposes the sample heading below.
    const text = log('## 2026-08-16 — quotes markdown about markdown\n\n```\nsample:\n```md\n## 2000-01-01 — sample only\n```\n\ntail\n\n')
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('a longer closing run closes a shorter fence; a shorter one does not', () => {
    // CommonMark: the closing run must be at least as long as the opening one, so the inner ``` is
    // body text and the ```` closes the block.
    const text = log('## 2026-08-16 — nested\n\n````md\n```\n## 2000-01-01 — sample only\n```\n````\n\ntail\n\n')
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('an INDENTED fence opens and closes at its own indentation', () => {
    const text = log('## 2026-08-16 — fenced inside a list\n\n- item:\n\n  ```md\n## 2000-01-01 — sample only\n  ```\n\ntail\n\n')
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('the fence bug END TO END — a concurrent addition never lands inside an entry\'s code block', () => {
    // The shape that made the parse bug a corruption bug: with the sample heading read as a real
    // entry, the addition sorted between the two halves and was written INTO the code block.
    // The additions are dated BETWEEN the real entry and the sample heading inside its fence, which
    // is what turns the parse bug into a corruption bug: with the block ended early the sample reads
    // as a 2000-01-01 entry, and both additions sort into the gap — i.e. into the code block.
    const quoting = '## 2026-08-16 — quotes a doc that itself quotes code\n\n```md\nintro\n~~~\n## 2000-01-01 — sample only\nstill sample\n```\n\ntail\n\n'
    const mid_one = '## 2020-06-02 — a build from between the two dates\n\nmid body one\n\n'
    const mid_two = '## 2020-06-01 — another build from between them\n\nmid body two\n\n'
    const base = log(quoting)
    const res = mergeAsBuiltLog(base, log(quoting, mid_one), log(quoting, mid_two))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const lines = res.text.split('\n')
    const fenceOpen = lines.indexOf('```md')
    const fenceClose = lines.lastIndexOf('```')
    expect(fenceOpen).toBeGreaterThan(-1)
    expect(fenceClose).toBeGreaterThan(fenceOpen)
    for (const heading of ['## 2020-06-02 — a build from between the two dates', '## 2020-06-01 — another build from between them']) {
      const at = lines.indexOf(heading)
      expect(at).toBeGreaterThan(-1)
      expect(at > fenceOpen && at < fenceClose).toBe(false)
    }
    // …and the quoted sample is still one uninterrupted block.
    expect(res.text).toContain('```md\nintro\n~~~\n## 2000-01-01 — sample only\nstill sample\n```')
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

  test('ONE side arriving truncated is a conflict, not a licence to delete the history it lacks', () => {
    // The defect this pins: the refusal used to require BOTH sides to be entryless, so a malformed
    // single side was merged as though every entry it lacks had been deliberately deleted. `old`
    // exists in the base and in theirs, ours is a truncation, and the result used to be `ok: true`
    // carrying the new entry with `old` silently gone — from an append-only history, under a
    // success no human reads a diff of.
    const base = log(OLD_A)
    const res = mergeAsBuiltLog(base, 'TRUNCATED\n', log(NEW_ONE, OLD_A))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('truncated')
  })

  test('…and the same when it is THEIRS that arrives truncated', () => {
    const base = log(OLD_A)
    expect(mergeAsBuiltLog(base, log(NEW_ONE, OLD_A), 'TRUNCATED\n').ok).toBe(false)
  })

  test('a side that replaces every entry with different ones is refused too — the rule is what SURVIVED', () => {
    // Not entryless, so an entry-COUNT check would wave this through; every entry the base had is
    // still gone. Refusing on survivors catches a bad apply and a wholesale rewrite alike.
    const base = log(OLD_A, OLD_B)
    expect(mergeAsBuiltLog(base, log(NEW_ONE), log(NEW_TWO, OLD_A, OLD_B)).ok).toBe(false)
  })

  test('CONTROL — a side keeping even ONE base entry still merges, so the guard is not "refuse everything"', () => {
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(NEW_ONE, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('body one')
    expect(res.text).toContain('body two')
    expect(res.text).toContain('body of oldest thing')
  })

  test('an empty base is still merged — the guard is about LOSING history, not about having none', () => {
    const res = mergeAsBuiltLog(HEADER, HEADER, HEADER + NEW_ONE)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('body one')
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
