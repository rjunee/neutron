/**
 * @neutronai/trident — the ONE home of what an as-built entry is.
 *
 * The heading-uniqueness gate, the outer-loop appender, and — until it is retired — the merge
 * driver all share this parser. Scripts import `@neutronai/trident`; trident never imports
 * scripts. `scripts/ci/check-governed-repo-attributes.ts` is the existing precedent for that
 * direction.
 *
 * The first shape of the heading-uniqueness gate re-derived this parsing from scratch under
 * `trident/`, and it had already drifted three ways before it ever shipped:
 *
 *   - `~~~` fences unrecognised → a heading quoted inside one reads as a real
 *     entry, and the gate blocks a merge over prose (loud, expensive, wrong).
 *   - an indented fence CLOSER not matched → the scanner stays stuck open and
 *     every heading below it goes uncounted, so a real collision reports clean
 *     (silent, and the direction nobody ever finds out about).
 *   - `##\ttitle` counted by the driver, missed here → the driver merges two
 *     entries the gate swears are one.
 *
 * There is one parser here so those contracts cannot drift apart again.
 */

/**
 * An entry begins at a `## ` heading. `#` (the file title) and `### ` (subsections) do not.
 *
 * THE DELIMITER AFTER THE `##` IS REQUIRED, AND THE FIRST CUT OF THIS ONLY REQUIRED IT NOT TO BE A
 * `#`. `/^##[^#]/` accepted `##foo`, which CommonMark 4.2 does not read as a heading at all — there
 * the run of `#` must be followed by a space, a tab, or the end of the line. So an ordinary BODY line
 * beginning `##` (a shell comment, a C preprocessor line, an `##` in prose) parsed as an entry of
 * its own, and the consequence was not cosmetic: the split changed the entry KEYS either side of
 * it, so an edit to that entry's body read as an entry missing from one side and this file
 * returned `wouldLoseEntries: true` — a hard conflict a human must resolve, fabricated out of a
 * body edit. Measured on a two-entry base carrying one `##not-a-heading` body line: THREE entries
 * parsed, and an ours-side edit of that line came back `ok: false, wouldLoseEntries: true` —
 * "the ours side is missing an entry the other still has … `##not-a-heading 1`" — because the edit
 * renamed a key. With the delimiter required the same base parses to two and the same merge is
 * `ok: true`. It fails LOUD rather than lossy, which is why it survived review, and there are zero
 * live occurrences in the tracked markdown (`git grep -cE '^##[^# ]' -- '*.md'` → none, against a
 * control of 308 for `^## ` in this log) — so this is a latent trap being closed, not an outage.
 *
 * THE TAB IS DELIBERATE AND IT IS NOT THE SAME AS `/^## /`. CommonMark accepts `##\ttitle`, and
 * `as-built-heading-uniqueness.ts` — which shares this parser precisely so a gate and a driver can
 * never disagree about where an entry begins — pins that case in its own test file. Narrowing to a
 * literal space would have counted a real heading as body text, which is the SILENT direction:
 * measured on that fixture, the gate parses ZERO entries and reports the log clean, so a genuine
 * collision goes unreported rather than being reported wrongly.
 *
 * A TITLE IS REQUIRED, WHICH IS THIS LOG'S CONTRACT AND NOT CommonMark'S. `docs/AS_BUILT.md` line 3
 * says "One entry per merged change"; an entry with no title is not one, and a line that heads
 * nothing is safer as body text than as an entry whose identity is a stray keystroke. This is
 * deliberately NARROWER than CommonMark, which reads every one of the rejected forms as a valid
 * EMPTY heading and additionally allows up to three leading spaces and an end-of-line straight
 * after the hashes.
 *
 * IT TOOK THREE PASSES TO STATE THAT RULE CORRECTLY, AND EVERY MISS WAS THE SAME DEFECT WEARING A
 * SHORTER NAME — a cross-model reviewer found each one, and each was reproduced before it was
 * fixed. `/^##[ \t]/` rejects a bare `##` but ACCEPTS `## ` and `##\t`, the same empty heading with
 * trailing whitespace. `/^##[ \t]+\S/` closed those and still accepted `## #`, `## ##`,
 * `## ###   `: in CommonMark a run of `#` at the END of an ATX heading is an optional CLOSING
 * sequence, so those render empty too (the spec's own example is `### ###`). Spelling the closing
 * sequence out as `(?![ \t]*#*[ \t]*\r?$)` closed THOSE and still accepted `## #\r\r`, and — worse,
 * because it was a REGRESSION rather than a leftover — `## ` followed by a non-breaking space,
 * a vertical tab or a form feed, all of which the `\S` cut had rejected. Every one reproduces
 * identically: a base carrying one such body line parses to THREE entries, and an ours-side edit of
 * that line alone (`## ` → `##`, `## #` → `## ##`) returns `ok: false, wouldLoseEntries: true` —
 * the refusal reserved for history loss, fabricated by editing whitespace or punctuation.
 *
 * SO THE RULE IS STATED ONCE, AS A CLASS RATHER THAN AS A SHAPE: after the delimiter there must be
 * a character that is neither whitespace nor a hash. That is one lookahead, it needs no cases, and
 * it cannot be defeated by a spelling nobody enumerated — which is what the previous two attempts
 * were, and why each of them needed another round. Two consequences are deliberate:
 *
 *   - A title may BEGIN with a hash. `## #303 landed` is a heading with content, because a closing
 *     sequence only counts at the END, and it has its own guard test — over-narrowing here would
 *     DROP an entry, which is worse than fabricating a conflict.
 *   - A title made ENTIRELY of hashes and whitespace (`## # #`, whose CommonMark content is `#`) is
 *     body text. This is the one place the rule is narrower than the spec by choice: line 3 of the
 *     log says "One entry per merged change", `#` is not a change, and admitting it would put an
 *     entry key on a line whose whole content is punctuation.
 *
 * ONE LIMIT REMAINS AND IS NAMED RATHER THAN PAPERED OVER. CommonMark counts a lone `\r` as a line
 * ending; this file splits on `\n` only, so `## \r2026-01-01 — x` is one line here and two there,
 * and this reads it as a dated heading where a renderer reads an empty heading followed by a
 * paragraph. Closing it means changing the line model the whole file rests on, including the
 * byte-exact round-trip `serializeLog(parseLog(t)) === t` that every other guarantee is checked
 * against. Nothing is LOST by it — the line is intact and both sides parse it the same way — and no
 * generator writes a bare `\r` mid-line, so it is recorded here rather than fixed.
 */
const HEADING = /^##[ \t]+(?![\s#]*$)/
/** `## 2026-08-15 — title`. Ten historical sections carry no date; see `effectiveDates`. */
const DATE_IN_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\b/
/**
 * A fence opens or closes a code block. Entries in this log quote shell and markdown, so a
 * `## ` INSIDE a fence is sample text, not a heading — treating it as one would cut an entry in
 * half and let a merge place another entry between the halves.
 *
 * THE DELIMITER IS CAPTURED BECAUSE A FENCE IS CLOSED ONLY BY ITS OWN KIND. An earlier cut of this
 * matched `(```|~~~)` and flipped a single boolean on either one, so a `~~~` quoted INSIDE a
 * backtick fence ended the block early and the sample `## ` heading three lines later parsed as a
 * real entry — after which a concurrent addition was placed INSIDE the original entry's code
 * block. Per CommonMark a closing fence uses the SAME character, is at least as long as the
 * opening run, and carries nothing after it but whitespace; an info string (```` ```md ````) marks
 * an opening fence and can never close one. All three of those are enforced in `parseLog`.
 *
 * INDENTATION IS BOUNDED AT THREE SPACES, WHICH IS CommonMark AND NOT A DETAIL. `^\s*` accepted
 * ANY indentation, so four-or-more spaces then ``` opened a block that CommonMark reads as ordinary
 * indented-code TEXT — and every following `## ` was then swallowed into the preceding entry until
 * something happened to close it. Measured on the old regex: a two-entry input whose first entry
 * quotes a four-space-indented ``` parsed as ONE entry, so the second entry could not be merged
 * against, only inside. Three spaces is also CommonMark's limit for a CLOSING fence, which the same
 * bound gives for free. Nothing is lost in the other direction: `HEADING` only matches at column 0,
 * so a `## ` that is itself indented into a code block was never read as a heading anyway.
 *
 * THE TRAILER IS `[^\n]*`, NOT `.`, BECAUSE `.` DOES NOT MATCH A CARRIAGE RETURN. Lines are split on
 * `\n`, so a CRLF file hands every line a trailing `\r` — and in JavaScript `.` excludes `\r` along
 * with `\n`. With `(.*)$` the regex therefore matched NOTHING on a CRLF file: measured,
 * ``FENCE.exec('```\r')`` returned `null`, so no fence ever opened, every `## ` quoted inside a code
 * block parsed as a real entry, and a concurrent addition was merged INTO the block — the exact
 * corruption the fence tracker exists to prevent, on the one input class where the tracker silently
 * did not run at all. Worse than the pre-driver behaviour, which handled that file correctly.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/

export interface LogEntry {
  /**
   * Identity of the entry. The heading line plus an OCCURRENCE INDEX, because the real log
   * repeated four headings verbatim when this was written (e.g. `## 2026-08-09 — Model usage on
   * the phone`, whose two bodies were 784 and 2464 chars — different changes, same title). Those
   * are resolved and gated now, but keying on the bare heading would still silently fold two
   * distinct entries into one and DELETE history — the one outcome this file must never produce.
   */
  key: string
  /** `YYYY-MM-DD` from the heading, or `''` for the undated subsections. */
  date: string
  /**
   * The date this entry sorts AT within the file it was parsed from: its own date, or — for an
   * undated subsection — the date of the entry it continues.
   *
   * An ADDED undated section used to sort at `''`, which is below every real date, so it was
   * appended at the very END of the file, hundreds of entries away from the entry it continues.
   * The date is carried here, at parse time, because that is the only place the section's own
   * neighbourhood is still known — by merge time the sides have been indexed into maps.
   */
  sortDate: string
  /** Heading line + body, verbatim, as lines. */
  lines: string[]
}

export interface ParsedLog {
  preamble: string[]
  entries: LogEntry[]
}

/**
 * Split a log into its preamble and its entries.
 *
 * Round-trips EXACTLY: `serializeLog(parseLog(t)) === t` for any input, including trailing
 * newlines, CRLF bodies and files with no entries at all. That property is asserted directly
 * against the real 17k-line `docs/AS_BUILT.md` in the test suite, because a merge driver that
 * cannot reproduce its own input byte-for-byte is a corruption engine.
 */
export function parseLog(text: string): ParsedLog {
  const lines = text.split('\n')
  const preamble: string[] = []
  const entries: LogEntry[] = []
  const seen = new Map<string, number>()
  let current: LogEntry | null = null
  /** The delimiter that OPENED the block we are inside, or `null` outside any block. */
  let fence: { char: string; length: number } | null = null
  /** The date the most recent DATED heading carried — what an undated section sorts at. */
  let carriedDate = ''

  for (const line of lines) {
    const delimiter = FENCE.exec(line)
    // Whether this line is a fence delimiter rather than content. It is tracked separately from the
    // regex match because a run of backticks whose info string CONTAINS a backtick is not a fence
    // at all (CommonMark 4.5: an opening backtick fence's info string may not contain a backtick,
    // which is what keeps `` `foo` `` in a paragraph from opening a block).
    let isDelimiter = false
    if (delimiter !== null) {
      const run = delimiter[1] as string
      const trailer = delimiter[2] as string
      if (fence === null) {
        if (run[0] !== '`' || !trailer.includes('`')) {
          fence = { char: run[0] as string, length: run.length }
          isDelimiter = true
        }
      } else {
        isDelimiter = true
        if (run[0] === fence.char && run.length >= fence.length && trailer.trim() === '') fence = null
      }
    }
    // A line that is itself a fence delimiter is never a heading, whichever side of the block it
    // sits on, so it is excluded here rather than depending on the order the state was updated in.
    if (fence === null && !isDelimiter && HEADING.test(line)) {
      if (current !== null) entries.push(current)
      const heading = line.trimEnd()
      const occurrence = (seen.get(heading) ?? 0) + 1
      seen.set(heading, occurrence)
      const date = DATE_IN_HEADING.exec(line)?.[1] ?? ''
      if (date !== '') carriedDate = date
      current = {
        key: `${heading} ${occurrence}`,
        date,
        sortDate: carriedDate,
        lines: [line],
      }
    } else if (current !== null) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current !== null) entries.push(current)
  return { preamble, entries }
}

export function serializeLog(log: ParsedLog): string {
  const out: string[] = [...log.preamble]
  for (const entry of log.entries) out.push(...entry.lines)
  return out.join('\n')
}

/** One heading that appears more than once, with every line it appears on. */
export interface DuplicateEntryHeading {
  /** The full heading line, verbatim, including the leading `## `. */
  heading: string
  /** 1-based line numbers, in file order. Always length >= 2. */
  lines: number[]
}

/**
 * Every `## ` entry heading that appears more than once in an as-built log.
 *
 * Pure — the caller reads the file — so the rule is testable without a repo.
 * Empty array means conformant.
 *
 * {@link parseLog} decides what an entry IS: a `## ` heading (never `###` and
 * deeper, which are an entry's internal structure and repeat legitimately —
 * "### Verification" appears in dozens) that is not inside a ``` or ~~~ fence,
 * because an entry quoting a markdown snippet is prose and a gate that blocks a
 * merge must not fire on one. Identity is the heading `trimEnd`ed, matching the
 * driver's own key, so trailing whitespace cannot hide a collision from the gate
 * that the merge would still fold together.
 *
 * Line numbers are reconstructed from the parse rather than re-scanned: the
 * preamble, then each entry's own length. `serializeLog(parseLog(t)) === t` is
 * asserted against the real log in `scripts/git/as-built-log-merge.test.ts`, so
 * every line is accounted for exactly once and the arithmetic cannot drift.
 */
export function findDuplicateEntryHeadings(log: string): DuplicateEntryHeading[] {
  const { preamble, entries } = parseLog(log)
  const seen = new Map<string, number[]>()

  let lineNo = preamble.length + 1
  for (const entry of entries) {
    const heading = entry.lines[0]!.trimEnd()
    const at = seen.get(heading)
    if (at) at.push(lineNo)
    else seen.set(heading, [lineNo])
    lineNo += entry.lines.length
  }

  return [...seen.entries()]
    .filter(([, at]) => at.length > 1)
    .map(([heading, lines]) => ({ heading, lines }))
}

/** Human-readable failure text for a non-empty {@link findDuplicateEntryHeadings} result. */
export function explainDuplicateEntryHeadings(
  logPath: string,
  duplicates: readonly DuplicateEntryHeading[],
): string {
  const out = [
    `❌ ${logPath}: ${duplicates.length} entry heading(s) appear more than once.`,
    '',
    '   The log says "One entry per merged change", and NEITHER merge driver this',
    '   path can carry will tell you when it stops being true: `merge=union` keeps',
    '   BOTH sides of a conflicting hunk rather than raising, and the entry-aware',
    '   driver reorders silently on a collision. It compounds instead of failing.',
    '',
  ]
  for (const d of duplicates) {
    out.push(`   ${d.heading}`)
    out.push(`     lines ${d.lines.join(', ')}`)
  }
  out.push('')
  out.push('   If the bodies are the same change, keep one. If they are DIFFERENT')
  out.push('   changes that happen to share a title, give each its own heading —')
  out.push('   deleting a body to satisfy this gate loses history.')
  return out.join('\n')
}

/** The canonical form required of newly staged as-built entries. */
export const AS_BUILT_ENTRY_HEADING = /^## \d{4}-\d{2}-\d{2} — .+/

export type FoldResult =
  | { ok: true; log: string; heading: string; retitled: boolean }
  | { ok: false; reason: string }

/** Fold one staged entry directly below the log preamble. */
export function foldEntryIntoLog(log: string, entry: string): FoldResult {
  const parsed = parseLog(entry)
  const preambleContent = parsed.preamble.find((line) => line.trim() !== '')
  if (preambleContent !== undefined) {
    return {
      ok: false,
      reason: `content before the '## ' heading: '${preambleContent}'`,
    }
  }

  if (parsed.entries.length !== 1) {
    const offendingLine =
      parsed.entries[1]?.lines[0]?.trimEnd() ??
      parsed.preamble.find((line) => line.trim() !== '') ??
      entry.split('\n').find((line) => line.trim() !== '') ??
      '(empty input)'
    return {
      ok: false,
      reason: `must be exactly one entry; found ${parsed.entries.length}; offending line: '${offendingLine}'`,
    }
  }

  const staged = parsed.entries[0]!
  const originalHeading = staged.lines[0]!.trimEnd()
  if (!AS_BUILT_ENTRY_HEADING.test(originalHeading)) {
    return {
      ok: false,
      reason: `heading '${originalHeading}' does not match '## YYYY-MM-DD — title'`,
    }
  }

  const parsedLog = parseLog(log)
  const headings = new Set(parsedLog.entries.map((existing) => existing.lines[0]!.trimEnd()))
  let heading = originalHeading
  let retitled = false
  if (headings.has(heading)) {
    let n = 2
    while (headings.has(`${originalHeading} (${n})`)) n += 1
    heading = `${originalHeading} (${n})`
    staged.lines[0] = heading
    staged.key = `${heading} 1`
    retitled = true
  }

  while (staged.lines.length > 0 && staged.lines.at(-1)!.trim() === '') staged.lines.pop()
  staged.lines.push('')

  // `split('\n')` retains the final empty sentinel. When an entryless preamble already ends in a
  // newline, that sentinel is replaced by serializeLog's boundary newline so the old bytes remain
  // a literal prefix rather than gaining an extra blank line.
  if (
    parsedLog.entries.length === 0 &&
    (log === '' || log.endsWith('\n')) &&
    parsedLog.preamble.at(-1) === ''
  ) {
    parsedLog.preamble.pop()
  }
  parsedLog.entries.unshift(staged)

  return { ok: true, log: serializeLog(parsedLog), heading, retitled }
}

/** Fold staged entries in landing order; each successful fold becomes the new first entry. */
export function foldEntriesIntoLog(
  log: string,
  entries: readonly string[],
): {
  log: string
  folded: { heading: string; retitled: boolean }[]
  refused: { index: number; reason: string }[]
} {
  let foldedLog = log
  const folded: { heading: string; retitled: boolean }[] = []
  const refused: { index: number; reason: string }[] = []

  for (const [index, entry] of entries.entries()) {
    const result = foldEntryIntoLog(foldedLog, entry)
    if (result.ok) {
      foldedLog = result.log
      folded.push({ heading: result.heading, retitled: result.retitled })
    } else {
      refused.push({ index, reason: result.reason })
    }
  }

  return { log: foldedLog, folded, refused }
}
