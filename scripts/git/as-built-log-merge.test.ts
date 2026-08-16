/**
 * Unit proofs for the entry-aware log merge. The real-git acceptance test
 * (`as-built-merge-realgit.test.ts`) proves the mechanism works through git; this file pins the
 * properties that make it SAFE to let it near a 17,000-line file nobody re-reads afterwards.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
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
    // it will actually be pointed at — 300+ entries, ten undated sections and a great deal of
    // fenced sample markdown. (It also carried four duplicated headings until those were
    // resolved and gated by `scripts/git/as-built-heading-uniqueness.ts`.)
    const text = readFileSync(REAL_LOG, 'utf8')
    expect(serializeLog(parseLog(text))).toBe(text)
  })

  test('finds every entry in the real log, and only real ones', () => {
    const text = readFileSync(REAL_LOG, 'utf8')
    const parsed = parseLog(text)

    // THE COUNT IS READ FROM THE FILE, NEVER RESTATED. This assertion used to be
    // `toBeGreaterThan(250)`, which forbids a legitimate future in which the log is archived down —
    // 200 entries would have gone red with no defect anywhere — and which is blind in BOTH
    // directions at the magnitudes real regressions come in. Measured: an over-parse of one entry
    // (309, the shape of the `##foo` bug `HEADING` used to have) and an under-parse of three (305,
    // a fence swallowing headings) both clear it. It was not worthless — a stuck fence taking the
    // log from 308 to 13 does trip it, and that is the case it caught — but it only ever saw the
    // catastrophic end, and it paid for that with a false red on an ordinary archive. Measured on
    // the equality: green at 308, 200 and 50; red at 309, 305 and 13.
    //
    // WHAT IT IS AND IS NOT. It compares the parse against a RAW line scan, which has no idea what
    // a fence is, so it is a cross-check between two oracles and not a proof of a bijection — a
    // simultaneous over- and under-parse could cancel. Nor does the per-entry check below prove
    // "only real ones" outright: it applies the SAME lexical predicate, so it cannot catch a case
    // that predicate itself gets wrong, and the two rounds of `HEADING` defects on this branch were
    // exactly that kind. Those are pinned by the fixture tests further down, which name each
    // rejected spelling explicitly. What this test covers is the aggregate — fence drift, and the
    // parse collapsing or inflating against the file it is pointed at.
    //
    // ONE LEGITIMATE CHANGE WOULD MOVE THE TWO APART: an entry quoting a heading at COLUMN ZERO
    // inside a code fence, which is sample text and correctly heads no entry. That is a real cost
    // and it is accepted rather than unnoticed. The alternative is to teach this test the fence
    // rules so it can skip such lines — i.e. a SECOND implementation of the parser, which is the
    // exact drift `as-built-heading-uniqueness.ts` was rewritten to avoid (its docblock lists the
    // three ways its own re-derived scanner had already diverged before it shipped). A one-line
    // subtraction the day a fenced sample lands is cheaper than a duplicate parser maintained
    // forever. The log has no such line today: verified, every one of its heading lines heads an
    // entry, and its quoted markdown is indented.
    const isHeadingLine = (line: string): boolean => /^##[ \t]+(?![ \t]*#*[ \t]*\r?$)/.test(line)
    const atColumnZero = text.split('\n').filter(isHeadingLine).length
    expect(parsed.entries.length).toBe(atColumnZero)
    // The same shape the parser uses, NOT `startsWith('## ')`. A literal space here would forbid
    // the tab spelling this suite deliberately accepts two tests below — the real log carries none
    // today, so the contradiction was latent, but a test may not quietly outlaw what the parser and
    // the heading-uniqueness gate both admit.
    for (const entry of parsed.entries) expect(isHeadingLine(entry.lines[0] ?? '')).toBe(true)
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

  test('an INDENTED fence opens and closes at its own indentation, up to CommonMark\'s three spaces', () => {
    const text = log('## 2026-08-16 — fenced inside a list\n\n- item:\n\n  ```md\n## 2000-01-01 — sample only\n  ```\n\ntail\n\n')
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('FOUR spaces is indented code, not a fence — so it cannot swallow the entries that follow', () => {
    // The regex was `^\s*`, which accepted any indentation. CommonMark stops at three: at four the
    // line is ordinary indented-code TEXT and opens nothing. Measured on the old regex, this exact
    // input parsed to ONE entry — the four-space ``` opened a block that never closed, and the
    // second entry was swallowed into the first, where a merge could then place things inside it.
    const text = log(
      '## 2026-08-16 — quotes an over-indented sample\n\n    ```\n    not a fence, just indented code\n\n',
      '## 2026-08-15 — a real entry that must stay reachable\n\nbody\n\n',
    )
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(2)
    expect(parsed.entries[1]!.lines[0]).toBe('## 2026-08-15 — a real entry that must stay reachable')
    expect(serializeLog(parsed)).toBe(text)
  })

  test('…and a four-space CLOSING run does not close a fence opened at column zero', () => {
    // The same bound on the other end: an over-indented run is body text, so the block stays open
    // and the sample heading inside it is still sample text.
    const text = log('## 2026-08-16 — fence closed properly\n\n```\n    ```\n## 2000-01-01 — sample only\n```\n\ntail\n\n')
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

  test('a fence is tracked on CRLF lines too — `.` does not match a carriage return', () => {
    // THE DEFECT THIS PINS. Lines are split on `\n`, so every line of a CRLF file carries a trailing
    // `\r`, and JavaScript's `.` excludes `\r`. The classifier's trailer group was `(.*)`, so the
    // regex matched NOTHING on a CRLF file and no fence ever opened — the tracker did not run at
    // all, silently, on the one input class where its absence corrupts the file.
    //
    // CONTROL, so the mutation is visibly landed rather than asserted: the OLD pattern, run here on
    // the exact line that reaches it.
    expect(/^ {0,3}(`{3,}|~{3,})(.*)$/.exec('```\r')).toBeNull()
    expect(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec('```\r')).not.toBeNull()

    const text = log('## 2026-08-16 — quotes markdown\n\n```md\n## 2000-01-01 — not a real entry\n```\n\ntail\n\n')
    const crlf = text.replaceAll('\n', '\r\n')
    const parsed = parseLog(crlf)
    expect(parsed.entries.length).toBe(1)
    expect(serializeLog(parsed)).toBe(crlf)
  })

  test('the CRLF fence bug END TO END — an addition never lands inside a CRLF entry\'s code block', () => {
    // The same shape as the LF end-to-end case above, on the line endings that made the classifier
    // blind. Under the old pattern the sample heading inside the fence parsed as a 2000-01-01 entry
    // and the addition sorted into the gap — i.e. into the code block.
    const quoting = '## 2026-08-16 — quotes markdown\n\n```md\nintro\n## 2000-01-01 — sample only\nstill sample\n```\n\ntail\n\n'
    const mid = '## 2020-06-02 — a build from between the two dates\n\nmid body\n\n'
    const base = log(quoting).replaceAll('\n', '\r\n')
    const res = mergeAsBuiltLog(base, log(quoting, mid).replaceAll('\n', '\r\n'), base)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const lines = res.text.split('\n')
    const fenceOpen = lines.indexOf('```md\r')
    const fenceClose = lines.lastIndexOf('```\r')
    expect(fenceOpen).toBeGreaterThan(-1)
    expect(fenceClose).toBeGreaterThan(fenceOpen)
    const at = lines.indexOf('## 2020-06-02 — a build from between the two dates\r')
    expect(at).toBeGreaterThan(-1)
    expect(at > fenceOpen && at < fenceClose).toBe(false)
    expect(res.text).toContain('```md\r\nintro\r\n## 2000-01-01 — sample only\r\nstill sample\r\n```')
  })

  test('a backtick run whose info string contains a backtick opens nothing (CommonMark 4.5)', () => {
    // ```` ```a`b ```` is a paragraph, not a fence. Reading it as one opens a block that never
    // closes, and every entry after it is swallowed into the entry that quoted it.
    const text = log(
      '## 2026-08-16 — mentions ```a`b in prose\n\n```a`b\n\n',
      '## 2026-08-15 — must stay reachable\n\nbody\n\n',
    )
    const parsed = parseLog(text)
    expect(parsed.entries.length).toBe(2)
    expect(parsed.entries[1]!.lines[0]).toBe('## 2026-08-15 — must stay reachable')
    expect(serializeLog(parsed)).toBe(text)
  })

  test('repeated headings stay distinct entries', () => {
    // The real log repeated four headings verbatim until they were resolved and gated; folding
    // two same-titled entries together would delete history, so this stays a fixture-level rule
    // rather than something the current state of the log is allowed to make moot.
    const dup = '## 2026-08-09 — Model usage on the phone\n\nfirst\n\n'
    const dup2 = '## 2026-08-09 — Model usage on the phone\n\nsecond\n\n'
    const parsed = parseLog(log(dup, dup2))
    expect(parsed.entries.length).toBe(2)
    expect(parsed.entries[0]!.key).not.toBe(parsed.entries[1]!.key)
  })

  test('a body line beginning `##` with no space is body text, not an entry (CommonMark 4.2)', () => {
    // `/^##[^#]/` accepted it, so an ordinary `##` in prose or a shell comment minted an entry.
    const parsed = parseLog(log('## 2026-08-16 — has a hash in its body\n\n##not-a-heading\n\ntail\n\n'))
    expect(parsed.entries.length).toBe(1)
    expect(parsed.entries[0]!.lines.join('\n')).toContain('##not-a-heading')
  })

  test('…and so is an EMPTY heading, in every spelling CommonMark has for one', () => {
    // Two passes of the same defect. `/^##[ \t]/` rejected a bare `##` and accepted `## ` and
    // `##\t` — the same empty heading with trailing whitespace. `/^##[ \t]+\S/` closed those and
    // still accepted the CLOSING-SEQUENCE forms: a run of `#` at the end of an ATX heading is
    // optional punctuation, so `## #` and `## ###   ` render empty too. An entry with no title is
    // not "one entry per merged change", and its identity would be a keystroke.
    for (const marker of ['##', '## ', '##\t', '##  ', '## #', '## ##', '## ###   ', '## #\r']) {
      const parsed = parseLog(log(`## 2026-08-16 — has a stray marker\n\n${marker}\n\ntail\n\n`))
      expect(parsed.entries.length).toBe(1)
    }
  })

  test('…but a title may BEGIN with a hash, because a closing sequence only counts at the end', () => {
    // The narrowing that rejects `## #` must not reject `## #303 landed`, which is a heading whose
    // CONTENT starts with a hash. Without this the fix would trade a fabricated conflict for a
    // dropped entry, which is the direction that loses history.
    const parsed = parseLog(log('## #303 landed\n\nbody\n\n'))
    expect(parsed.entries.length).toBe(1)
    expect(parsed.entries[0]!.lines[0]).toBe('## #303 landed')
  })

  test('…while a TAB after the hashes still is one, which `/^## /` would have silently missed', () => {
    // CommonMark accepts a tab as the delimiter, and `as-built-heading-uniqueness.ts` shares this
    // parser and pins the same case — narrowing to a literal space would make the gate parse that
    // fixture as ZERO entries and report the log clean, which is the silent direction: a real
    // collision goes unreported rather than being reported wrongly.
    const parsed = parseLog(log('##\t2026-08-16 — tab after the hashes\n\nbody\n\n'))
    expect(parsed.entries.length).toBe(1)
    expect(parsed.entries[0]!.lines[0]).toBe('##\t2026-08-16 — tab after the hashes')
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

  test('editing a body line that begins `##` is an ordinary edit, not a fabricated hard conflict', () => {
    // THE DEFECT THIS PINS. `HEADING` was `/^##[^#]/`, so this entry's `##not-a-heading` body line
    // split it into TWO entries and became one of their keys. Editing that line therefore removed
    // a key from `ours` that `theirs` still had, and the merge came back `ok: false` with
    // `wouldLoseEntries: true` — the refusal reserved for history loss, raised on a body edit that
    // loses nothing, and terminated by the driver as a conflict no fallback may resolve.
    const withHash = '## 2026-08-16 — quotes a hash\n\n##not-a-heading\n\ntail\n\n'
    const edited = '## 2026-08-16 — quotes a hash\n\n##still-not-a-heading\n\ntail\n\n'
    const base = log(withHash, OLD_B)
    const res = mergeAsBuiltLog(base, log(edited, OLD_B), log(NEW_TWO, withHash, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(NEW_TWO, edited, OLD_B))

    // CONTROL — the same shape with the edit on a PLAIN body line merged cleanly before this fix
    // too, which is what made the bug a trap rather than an outage: only the `##` line differed.
    const plain = '## 2026-08-16 — quotes a hash\n\n##not-a-heading\n\ntail, corrected\n\n'
    const control = mergeAsBuiltLog(base, log(plain, OLD_B), log(NEW_TWO, withHash, OLD_B))
    expect(control.ok).toBe(true)
  })

  test('…and editing a stray EMPTY heading is an ordinary edit too, in both of its shapes', () => {
    // The same defect in its two narrower spellings, each of which survived one round and was
    // found by a cross-model reviewer. Reproduced exactly as reported both times: the base parsed
    // to THREE entries and the merge returned `ok: false, wouldLoseEntries: true` — on key `## 1`
    // for the whitespace form and `## # 1` for the closing-sequence form — a fabricated hard
    // conflict raised by an edit that changed one space, or one hash.
    for (const [before, after] of [
      ['## ', '##'],
      ['## #', '## ##'],
    ] as const) {
      const withMarker = `## 2026-08-16 — has a stray marker\n\n${before}\n\ntail\n\n`
      const edited = `## 2026-08-16 — has a stray marker\n\n${after}\n\ntail\n\n`
      const base = log(withMarker, OLD_B)
      const res = mergeAsBuiltLog(base, log(edited, OLD_B), log(NEW_TWO, withMarker, OLD_B))
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.text).toBe(log(NEW_TWO, edited, OLD_B))
    }
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

  test('an ADDED undated section stays under the entry it continues, not at the end of the file', () => {
    // THE DEFECT THIS PINS: an undated heading has no date, sorted at `''` — below every real
    // date — so a newly-added continuation was appended at the very TAIL of the log, hundreds of
    // entries away from the entry whose text it continues. In the real file that is a section
    // orphaned in 2024 under a 2026 entry, with nothing marking it as displaced.
    const sub = '## the continuation of build one\n\nsub body\n\n'
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(NEW_ONE, sub, OLD_A, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Directly under its own entry, and above the entries it is newer than — never at the tail.
    expect(res.text).toBe(log(NEW_ONE, sub, NEW_TWO, OLD_A, OLD_B))
  })

  test('…and one added under an entry the base ALREADY had lands under that entry, not above it', () => {
    // Here the section continues a RETAINED entry, so date order alone would place it ABOVE the
    // thing it continues (same effective date, and additions sort above same-date retained
    // entries). It is emitted directly after the entry it followed on its own side instead.
    const sub = '## a note appended under the older thing\n\nnote body\n\n'
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(OLD_A, sub, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(NEW_TWO, OLD_A, sub, OLD_B))
  })

  test('…and one added under an entry the OTHER SIDE added in the same merge stays under it too', () => {
    // THE DEFECT THIS PINS, and it is the case the two tests above cannot reach: `attachAfter` was
    // resolved only against RETAINED entries — the ones the base already had — so a section
    // continuing an entry ADDED IN THIS SAME MERGE found no anchor and was left to date-sort alone.
    // It arises whenever both sides write the same heading and only one writes the follow-up under
    // it: to `theirs` the section is an addition while its own head is not (ours added it too), so
    // the section starts a run of its own.
    //
    // The heading below is chosen so the bug is VISIBLE rather than latent. Both sort at the same
    // effective date, so the tie breaks on heading bytes, and `(` (0x28) precedes `2` (0x32) — the
    // section came out ABOVE its own head, reading as a separate top-level entry. A continuation
    // whose heading happened to sort after its head would have hidden this behind luck.
    const shared = '## 2026-08-16 — shared heading\n\nshared body\n\n'
    const sub = '## (addendum) follow-up detail\n\naddendum body\n\n'
    const base = log(OLD_A)
    const res = mergeAsBuiltLog(base, log(shared, OLD_A), log(shared, sub, OLD_A))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(shared, sub, OLD_A))
  })

  test('CONTROL — the same section under a head only ONE side added is unaffected', () => {
    // Identical but for `ours` not writing the shared entry, so the head is an ordinary same-side
    // addition and the section rides in its run as it always did. This proves the fix above adds a
    // path rather than re-routing the one that already worked.
    const shared = '## 2026-08-16 — shared heading\n\nshared body\n\n'
    const sub = '## (addendum) follow-up detail\n\naddendum body\n\n'
    const base = log(OLD_A)
    const res = mergeAsBuiltLog(base, log(OLD_A), log(shared, sub, OLD_A))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toBe(log(shared, sub, OLD_A))
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
    // The base is entryless too, which is the whole reason this one may be delegated — see the
    // pair below, where it is not.
    const res = mergeAsBuiltLog('nothing', 'no entries here', 'none here either')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.wouldLoseEntries).toBe(false)
  })

  test('BOTH sides parsing to zero against an ENTRYFUL base is a refusal git must NOT be asked to finish', () => {
    // THE DEFECT THIS PINS. The entryless-sides guard returned `wouldLoseEntries: false`
    // unconditionally, so the driver delegated — and this is the LARGEST history-loss case in the
    // file, neither side keeping anything, sitting one guard above the rule that refuses the
    // strictly smaller case of ONE side keeping nothing. The test that covered this line used an
    // entryless base, so it could not see the difference.
    //
    // Measured on `git merge-file` with this exact input: two DIFFERENT truncations conflict
    // (exit 1) while two matching ones resolve to a file with no entries at all (exit 0, no
    // markers). The loud outcome was git's accident rather than this file's decision, which is
    // precisely what `wouldLoseEntries` exists to stop depending on.
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, `${HEADER}ours truncated\n`, `${HEADER}theirs truncated\n`)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.wouldLoseEntries).toBe(true)
    expect(res.reason).toContain('the base had 2')
  })

  test('CONTROL — an entryless BASE still delegates, so the rule keys on lost history and not on parsing', () => {
    // Same shape as above with the one variable changed: no entries in the base, so there is
    // genuinely nothing to lose and git's textual three-way is the right answer. If this went red
    // the fix would have become "refuse every unparseable merge", which is a different feature.
    const res = mergeAsBuiltLog(HEADER, `${HEADER}ours truncated\n`, `${HEADER}theirs truncated\n`)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.wouldLoseEntries).toBe(false)
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

  test('a NEWEST-FIRST truncation that keeps one entry is refused too — surviving the guard is not surviving', () => {
    // THE DEFECT THIS PINS, and it is the ordinary shape of the bug rather than the extreme one:
    // the survivor guard only fired at ZERO survivors, so a side truncated to its newest entries
    // cleared it with one entry to spare and every older entry was then read as "deleted by us,
    // untouched by them" and dropped under `ok: true`. `ours` here keeps NEW_ONE and OLD_B and has
    // lost OLD_A; `theirs` still has OLD_A. Against the real 308-entry log the same input keeps one
    // entry and deletes 307.
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(NEW_ONE, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('## 2026-08-10 — older thing')
  })

  test('CONTROL — the same merge with nothing missing still succeeds, so the rule is not "refuse everything"', () => {
    // Identical to the case above except that `ours` keeps OLD_A. If this went red the rule would
    // have stopped being a safety property and started being a denial of the feature.
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(NEW_ONE, OLD_A, OLD_B), log(NEW_TWO, OLD_A, OLD_B))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('body one')
    expect(res.text).toContain('body two')
    expect(res.text).toContain('body of older thing')
    expect(res.text).toContain('body of oldest thing')
  })

  test('THE REAL LOG — a truncation keeping ONE entry is refused, not merged minus all the others', () => {
    // The fixtures above are three-entry toys. This is the file the driver is actually pointed at,
    // in the shape the bug takes there: `ours` truncated newest-first to a single base entry,
    // `theirs` an ordinary concurrent build. Measured against the previous rule, this exact input
    // returned `ok: true` with every entry but one gone.
    //
    // The counts are READ FROM THE FILE, never written into the name or the body: the log gains an
    // entry on most days, so "308 entries minus 307" was a name that stopped being true on the next
    // append while the assertion under it went on passing.
    //
    // AND THE GUARD BELOW IS DERIVED FOR THE SAME REASON. It used to read `toBeGreaterThan(250)`,
    // which is that same restated count one level up: it asserts nothing about this test, it forbids
    // a legitimate future in which the log is archived down, and it would have gone red on a change
    // with no defect in it. What this test actually needs is only that the base has MORE THAN THE
    // ONE ENTRY `ours` is truncated to — otherwise the truncation removes nothing and the refusal
    // below would pass vacuously. That is the property, so that is what is asserted.
    const parsed = parseLog(readFileSync(REAL_LOG, 'utf8'))
    expect(parsed.entries.length).toBeGreaterThan(1)

    const base = serializeLog(parsed)
    const ours = serializeLog({ preamble: parsed.preamble, entries: parsed.entries.slice(0, 1) })
    const fresh = parseLog(log(NEW_ONE)).entries[0]!
    const theirs = serializeLog({ preamble: parsed.preamble, entries: [fresh, ...parsed.entries] })

    const res = mergeAsBuiltLog(base, ours, theirs)
    expect(res.ok).toBe(false)

    // CONTROL — the same `theirs` against an INTACT `ours` still merges, so what is being refused
    // is the truncation and not the size of the file.
    const intact = mergeAsBuiltLog(base, base, theirs)
    expect(intact.ok).toBe(true)
    if (!intact.ok) return
    expect(parseLog(intact.text).entries.length).toBe(parsed.entries.length + 1)
  })

  test('a one-sided deletion is refused even when the other side never touched the entry', () => {
    // The narrowest possible statement of the rule, with no truncation and no concurrent edit
    // anywhere: base has two entries, `ours` drops one, `theirs` is byte-identical to the base.
    // Under the old code this was the textbook "clean deletion" and the entry left silently.
    const base = log(OLD_A, OLD_B)
    const res = mergeAsBuiltLog(base, log(OLD_B), base)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('append-only')
    // …and it is marked as the kind of refusal git must not be asked to finish, because a
    // line-based merge resolves a one-sided deletion cleanly. See the driver test of the same name.
    expect(res.wouldLoseEntries).toBe(true)
  })

  test('the two KINDS of refusal are distinguished, because only one of them may be delegated', () => {
    // The flag is what stands between "refused" and "refused, and then resolved anyway by the
    // fallback". A refusal about a missing entry must never be delegated; a textual disagreement
    // must still be, or the driver buys its safety by breaking merges that were fine.
    const base = log(OLD_A, OLD_B)

    const missing = mergeAsBuiltLog(base, log(OLD_B), base)
    const truncated = mergeAsBuiltLog(base, 'TRUNCATED\n', log(NEW_ONE, OLD_A, OLD_B))
    for (const res of [missing, truncated]) {
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.wouldLoseEntries).toBe(true)
    }

    const bothEdited = mergeAsBuiltLog(
      base,
      log('## 2026-08-10 — older thing\n\nours version\n\n', OLD_B),
      log('## 2026-08-10 — older thing\n\ntheirs version\n\n', OLD_B),
    )
    const notALog = mergeAsBuiltLog('nothing', 'no entries here', 'none here either')
    const header = mergeAsBuiltLog(log(OLD_A), `# OURS\n\n${OLD_A}`, `# THEIRS\n\n${OLD_A}`)
    const sameHeading = mergeAsBuiltLog(
      log(OLD_A),
      log('## 2026-08-16 — same title\n\nours body\n\n', OLD_A),
      log('## 2026-08-16 — same title\n\ntheirs body\n\n', OLD_A),
    )
    for (const res of [bothEdited, notALog, header, sameHeading]) {
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.wouldLoseEntries).toBe(false)
    }
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

  test('…but a marker size the CHECKOUT chose is clamped, so %L cannot size our output for us', () => {
    // THE DEFECT THIS PINS. `%L` is git substituting the merged path's `conflict-marker-size`
    // attribute, and a TRACKED `.gitattributes` in the repository being merged sets it — verified
    // separately by configuring a driver that does nothing but print `%L`, which received a
    // committed `conflict-marker-size=2000000` intact. The conflict this driver constructs writes
    // that many characters three times, so the same refusal grew from 302 bytes to 6,000,281,
    // linearly, on a number the checkout picks. It is the one checkout-supplied input the driver
    // takes, and it is now bounded.
    const dir = mkdtempSync(join(tmpdir(), 'as-built-driver-'))
    dirs.push(dir)
    const paths = { O: join(dir, 'base'), A: join(dir, 'ours'), B: join(dir, 'theirs') }
    writeFileSync(paths.O, log(OLD_A, OLD_B))
    // A wouldLoseEntries refusal, which is the path that writes markers from THIS process.
    writeFileSync(paths.A, log(OLD_B))
    writeFileSync(paths.B, log(OLD_A, OLD_B))
    expect(runDriver([paths.O, paths.A, paths.B, '2000000', 'docs/AS_BUILT.md'])).not.toBe(0)
    const result = readFileSync(paths.A, 'utf8')
    expect(result).toContain('<'.repeat(200))
    expect(result).not.toContain('<'.repeat(201))
    expect(result.length).toBeLessThan(10_000)
    // CONTROL — both sides are still whole, so the clamp bounded the MARKERS and nothing else.
    expect(result).toContain('body of older thing')
    expect(result).toContain('body of oldest thing')
  })

  test('…and the DELEGATED path is bounded too, which the first cut of the clamp was not', () => {
    // THE DEFECT THIS PINS, found by the cross-model reviewer. The clamp originally covered only
    // the conflict this process constructs, and left `delegateToGit` forwarding `%L` to
    // `git merge-file` untouched — justified as keeping the delegated path byte-for-byte what an
    // unconfigured repo does. That justification is false in THIS repository: `.gitattributes`
    // gives `docs/AS_BUILT.md` `merge=union`, and union never reports a conflict, so an
    // unconfigured repo writes ZERO markers on this path rather than six megabytes of them. There
    // was no floor property to protect, so both paths are bounded now.
    //
    // A TEXTUAL disagreement, which is the input that reaches `git merge-file` rather than
    // `writeConflict` — both sides rewriting one entry, nothing deleted.
    const dir = mkdtempSync(join(tmpdir(), 'as-built-driver-'))
    dirs.push(dir)
    const paths = { O: join(dir, 'base'), A: join(dir, 'ours'), B: join(dir, 'theirs') }
    writeFileSync(paths.O, log(OLD_A))
    writeFileSync(paths.A, log('## 2026-08-10 — older thing\n\nours version\n\n'))
    writeFileSync(paths.B, log('## 2026-08-10 — older thing\n\ntheirs version\n\n'))
    expect(runDriver([paths.O, paths.A, paths.B, '2000000', 'docs/AS_BUILT.md'])).not.toBe(0)
    const result = readFileSync(paths.A, 'utf8')
    // CONTROL — this really is the delegated path: git labels its markers, this process does not.
    expect(result).toContain('<<<<<<< ours')
    expect(result).not.toContain('REFUSED by as-built-merge-driver')
    expect(result).not.toContain('<'.repeat(201))
    expect(result.length).toBeLessThan(10_000)
    // Both sides still whole, so the bound applied to the markers and nothing else.
    expect(result).toContain('ours version')
    expect(result).toContain('theirs version')
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

  test('THE BLOCKER — a refusal about a MISSING ENTRY is not handed to git, which would resolve it', () => {
    // The gap between "the merge function refuses" and "the merge does not happen". `git
    // merge-file` reads a one-sided deletion as a CLEAN hunk: it resolves it, exits 0 and writes no
    // markers, so delegating this refusal deleted the entries anyway — the refusal fired, said the
    // right thing on stderr, and changed nothing about the outcome.
    // A log with some depth to it, because the reproduction needs the DELETION and the ADDITION to
    // be far enough apart that git sees two independent hunks — which is the ordinary shape of this
    // bug on a 300-entry file, and the reason a three-entry fixture cannot show it. (With the
    // deletion adjacent to the addition git happens to conflict, which is how the delegation looked
    // safe.)
    const history = Array.from({ length: 20 }, (_, i) => `## 2026-07-${String(20 - i).padStart(2, '0')} — entry ${20 - i}\n\nbody of entry ${20 - i}\n\n`)
    const base = log(...history)
    const ours = log(...history.filter((_, i) => i !== 10)) // one entry in the middle, dropped
    const theirs = log(NEW_ONE, ...history)

    // CONTROL — the delegate this used to call, on these exact bytes. If git ever started
    // conflicting here the guard below would be unnecessary, and this line would say so.
    const dir = mkdtempSync(join(tmpdir(), 'as-built-delegate-'))
    dirs.push(dir)
    const paths = { O: join(dir, 'base'), A: join(dir, 'ours'), B: join(dir, 'theirs') }
    writeFileSync(paths.O, base)
    writeFileSync(paths.A, ours)
    writeFileSync(paths.B, theirs)
    const delegated = spawnSync('git', ['merge-file', '--marker-size=7', paths.A, paths.O, paths.B])
    expect(delegated.status).toBe(0) // clean, in git's opinion
    const asGitLeftIt = readFileSync(paths.A, 'utf8')
    expect(asGitLeftIt).not.toContain('<<<<<<<')
    expect(asGitLeftIt).not.toContain('body of entry 10') // …and the entry is gone, silently

    // THE PROPERTY — the driver terminates this itself.
    const { code, result } = drive(base, ours, theirs)
    expect(code).not.toBe(0)
    expect(result).toContain('<<<<<<< ours')
    expect(result).toContain('>>>>>>> theirs')
    // Nothing was dropped on the way to the conflict: every entry from both sides is still readable.
    for (const entry of history) expect(result).toContain(entry.trimEnd())
    expect(result).toContain('body one')
    // …and the marker line says why, so the human opening the file does not need the stderr.
    expect(result).toContain('append-only')
  })

  test('…and a TEXTUAL disagreement is still delegated, so the fallback did not become "always conflict"', () => {
    // The other half of the same rule. Both sides rewrote one entry in DISJOINT places; nothing is
    // being deleted, so git's line-level three-way is a real answer and this must still reach it.
    // Without this the change would have bought its safety by refusing merges that were fine.
    const long = ['## 2026-08-10 — older thing', '', 'alpha', 'beta', 'gamma', '', ''].join('\n')
    const base = log(long)
    const ours = log(long.replace('alpha', 'ALPHA'))
    const theirs = log(long.replace('gamma', 'GAMMA'))
    const { code, result } = drive(base, ours, theirs)
    expect(code).toBe(0)
    expect(result).toContain('ALPHA')
    expect(result).toContain('GAMMA')
    expect(result).not.toContain('<<<<<<<')
  })

  test('a path this driver was not written for gets git\'s merge, not this log\'s semantics', () => {
    // A checked-out repository can point `merge=as-built-log` at anything through its own tracked
    // `.gitattributes`. That is a semantics question, not a security one — nothing from the checkout
    // is executed either way — but a driver bound to a file it does not understand should decline.
    const dir = mkdtempSync(join(tmpdir(), 'as-built-otherpath-'))
    dirs.push(dir)
    const paths = { O: join(dir, 'base'), A: join(dir, 'ours'), B: join(dir, 'theirs') }
    writeFileSync(paths.O, 'one\ntwo\nthree\n')
    writeFileSync(paths.A, 'ONE\ntwo\nthree\n')
    writeFileSync(paths.B, 'one\ntwo\nTHREE\n')
    expect(runDriver([paths.O, paths.A, paths.B, '7', 'src/unrelated.ts'])).toBe(0)
    // git's own three-way, not ours: both disjoint edits taken, no entry structure imposed.
    expect(readFileSync(paths.A, 'utf8')).toBe('ONE\ntwo\nTHREE\n')
  })
})
