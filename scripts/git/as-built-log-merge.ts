/**
 * ENTRY-AWARE three-way merge for `docs/AS_BUILT.md` — the pure function behind the git merge
 * driver in `as-built-merge-driver.ts`.
 *
 * WHY THIS EXISTS. The log is newest-first and every build PREPENDS its entry immediately under
 * the same three header lines. Two builds therefore write different bytes at the SAME OFFSET
 * against the SAME CONTEXT, which is a guaranteed conflict rather than an unlucky one — measured
 * on 2026-08-15T23:20Z as three concurrent builds failing at publish on this file and nothing
 * else. Splitting the log into one file per entry was tried and REVERSED by owner lock on
 * 2026-08-16 ("AS BUILT is canonical … everything needs to be put into AS BUILT", #304), whose
 * own body names the remaining fix: "an entry-aware merge driver for this path — which keeps one
 * file *and* removes the conflict".
 *
 * ENTRY-AWARE, NOT LINE-AWARE — THIS IS THE WHOLE POINT. A `union` merge driver would interleave
 * the two entries line by line; interleaving inside a single entry is what produced broken
 * TypeScript in an earlier incident. So the unit of merge here is a WHOLE ENTRY (a `## ` heading
 * and everything under it up to the next heading). Two entries are never spliced together, and
 * an entry's bytes are either taken intact or not at all.
 *
 * THE RULE, stated once: an entry present in one side and absent from the base is an ADDITION,
 * and additions from both sides are UNIONED. Entries the base already had keep their existing
 * relative order — the file is only loosely ordered historically and re-sorting all 300 of them
 * on every merge would bury a one-entry change in a whole-file diff. New entries are placed
 * newest-first among the retained ones, which for the ordinary case (a build writing today's
 * date) means exactly where a build would have prepended it by hand.
 *
 * WHAT IT REFUSES. If both sides modify the SAME existing entry differently, or the preamble
 * diverges, or A BASE ENTRY IS ABSENT FROM ONE SIDE WHILE THE OTHER STILL HAS IT, that is a
 * genuine semantic conflict and this returns `{ ok: false }`. A driver that guessed here would be
 * worse than the conflict it replaced. Every ambiguous case is biased toward refusing: this file
 * rewrites the project's permanent history, so a conflict costs a human five minutes and a
 * plausible-looking result costs entries nobody notices are gone.
 *
 * A REFUSAL SAYS WHETHER GIT MAY BE ASKED TO FINISH IT, BECAUSE FOR HALF OF THEM IT MAY NOT.
 * `wouldLoseEntries` (see `MergeRefusal`) separates the two kinds. A textual disagreement — two
 * rewrites of one entry, a diverged header, a file that is not this log — goes to `git merge-file`,
 * so that floor is exactly today's behaviour. A refusal ABOUT A MISSING ENTRY cannot: to a
 * line-based merge a one-sided deletion is a clean hunk, so git resolves it, exits 0 and the
 * entries leave anyway — measured, 3 of 21 headings surviving with no markers written. Those
 * refusals are terminated by the driver itself.
 *
 * DELETION REQUIRES AGREEMENT — THE ONLY REMOVAL THIS ACCEPTS IS ONE BOTH SIDES MADE. That rule
 * replaces a weaker one that only refused when a side kept NONE of the base's entries, and the
 * weaker rule lost history in the ordinary case: a side truncated newest-first keeps its top few
 * entries, clears the survivor guard with one to spare, and every older entry then reads as
 * "deleted by us, untouched by them" and is dropped under `ok: true`. Run against the real
 * `docs/AS_BUILT.md` (308 entries) with `ours` truncated to ONE base entry and `theirs` an ordinary
 * concurrent build, the weaker rule returned `ok: true` and DELETED 307 entries from an APPEND-ONLY
 * history, in a merge nobody diffs. There is no counterpart risk on the
 * other side of the trade: refusing costs one conflict a human resolves by hand, which is exactly
 * what happened before this driver existed. The survivor guard below is kept anyway, ahead of this
 * one, purely because it names the wholesale-truncation case in a sentence an operator can act on.
 *
 * KNOWN LIMIT, STATED RATHER THAN DISCOVERED LATER. Identity is the heading plus an occurrence
 * index, so adding an entry whose heading is byte-identical to an existing one (same date AND same
 * title) SHIFTS the indices of the entries below it, and this then reads the addition as an edit
 * of the old entry plus a re-addition of it. Every entry still survives — nothing is dropped, which
 * is the property that actually matters — but their ORDER can come out odd. The real log carried
 * four verbatim-duplicated headings when this driver was written; all four are resolved and
 * `as-built-heading-uniqueness.ts` (next to this file) now fails a PR that reintroduces one, so
 * the log holds zero and this limit is unreachable while that gate stands. It is kept because the
 * gate runs on PRs and this driver runs on merges, so the driver must still behave sanely if one
 * ever slips past. Keying on a content hash instead would fix it and would break something worse:
 * an ordinary edit to an entry would read as a delete plus an add.
 */

/** An entry begins at a `## ` heading. `#` (the file title) and `### ` (subsections) do not. */
const HEADING = /^##[^#]/
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

function body(entry: LogEntry): string {
  return entry.lines.join('\n')
}

function index(log: ParsedLog): Map<string, LogEntry> {
  const map = new Map<string, LogEntry>()
  for (const entry of log.entries) map.set(entry.key, entry)
  return map
}

/**
 * The date each retained entry sorts AT.
 *
 * Ten sections in the real log carry no date of their own; #304 placed each one beside the entry
 * it belongs to rather than flinging it to the end. So an undated entry INHERITS its predecessor's
 * date, which stops a newly-merged entry from being inserted between an entry and its own
 * continuation.
 */
function effectiveDates(entries: LogEntry[]): string[] {
  const dates: string[] = []
  let carried = ''
  for (const entry of entries) {
    if (entry.date !== '') carried = entry.date
    dates.push(carried)
  }
  return dates
}

/**
 * A refusal, and — the part the driver acts on — WHETHER GIT MAY BE TRUSTED TO FINISH IT.
 *
 * `wouldLoseEntries` marks the refusals whose whole content is "an entry that exists on one side is
 * absent from the other". Handing one of those to `git merge-file` DEFEATS IT: a one-sided deletion
 * is a clean hunk to a line-based merge, so git resolves it, exits 0, writes no markers, and the
 * entries leave anyway. Measured on a 20-entry log with `ours` truncated newest-first to two
 * entries: `git merge-file` exit 0, zero conflict markers, 3 of 21 headings surviving. So these
 * refusals are terminated by the driver itself, and only the rest — where the disagreement is
 * textual and git's own three-way is exactly the pre-driver behaviour — are delegated.
 */
export type MergeRefusal = { ok: false; reason: string; wouldLoseEntries: boolean }
export type MergeResult = { ok: true; text: string } | MergeRefusal

/**
 * A run of added entries that moves together: a head, plus any undated sections that continue it.
 *
 * `attachAfter` is set only for a run whose HEAD is undated — a section added as a continuation of
 * an entry that was already in the base. It names that entry, so the section is emitted directly
 * after it instead of being date-sorted away from it.
 */
interface Addition {
  entries: LogEntry[]
  sortDate: string
  attachAfter: string | null
}

/**
 * Group one side's additions into runs, in the order that side wrote them.
 *
 * Two properties come out of walking the side in order rather than filtering it: entries a single
 * build added stay in the order it added them, and an undated section stays with whatever it was
 * written under — its own run's head if that is also new, otherwise the base entry it continues.
 */
function additionsFrom(side: ParsedLog, isAddition: (entry: LogEntry) => boolean): Addition[] {
  const runs: Addition[] = []
  let run: Addition | null = null
  let previousKey: string | null = null
  for (const entry of side.entries) {
    if (!isAddition(entry)) {
      run = null
      previousKey = entry.key
      continue
    }
    if (run !== null && entry.date === '') {
      run.entries.push(entry)
    } else {
      run = { entries: [entry], sortDate: entry.sortDate, attachAfter: entry.date === '' ? previousKey : null }
      runs.push(run)
    }
    previousKey = entry.key
  }
  return runs
}

/**
 * Three-way merge of the log. `base` is the common ancestor, `ours` the side being merged into,
 * `theirs` the side being merged in.
 */
export function mergeAsBuiltLog(base: string, ours: string, theirs: string): MergeResult {
  const O = parseLog(base)
  const A = parseLog(ours)
  const B = parseLog(theirs)

  const inO = index(O)
  const inA = index(A)
  const inB = index(B)

  // A file with no entries is not this log — a rename, a truncation, something unexpected. Let
  // git's own merge handle it rather than inventing structure that is not there.
  if (A.entries.length === 0 && B.entries.length === 0) {
    // Not a history-loss refusal: with no entries on either side there is no entry to lose, and
    // git's textual three-way is precisely what this path did before the driver existed.
    return { ok: false, reason: 'neither side parses as an entry log', wouldLoseEntries: false }
  }

  // A WHOLESALE TRUNCATION GETS ITS OWN SENTENCE. The per-entry rule further down already refuses
  // this case, and would refuse it correctly; this guard runs first only so the operator reading
  // the driver's stderr is told "one side kept none of the 308 entries" instead of being told the
  // name of whichever entry happened to be examined first. Refusing on what SURVIVED rather than on
  // the entry count also names a wholesale REWRITE — a side with plenty of entries, none of them
  // the base's — in the same words.
  if (O.entries.length > 0) {
    const keptByUs = O.entries.filter((entry) => inA.has(entry.key)).length
    const keptByThem = O.entries.filter((entry) => inB.has(entry.key)).length
    if (keptByUs === 0 || keptByThem === 0) {
      const side = keptByUs === 0 ? 'ours' : 'theirs'
      return {
        ok: false,
        reason: `the ${side} side keeps none of the ${O.entries.length} entries the base had — refusing to merge what looks like a truncated log`,
        wouldLoseEntries: true,
      }
    }
  }

  const preambleA = A.preamble.join('\n')
  const preambleB = B.preamble.join('\n')
  const preambleO = O.preamble.join('\n')
  let preamble: string[]
  if (preambleA === preambleB || preambleB === preambleO) preamble = A.preamble
  else if (preambleA === preambleO) preamble = B.preamble
  else return { ok: false, reason: 'both sides changed the log header differently', wouldLoseEntries: false }

  // (1) Entries the base already had, in the base's order, with each side's edits applied.
  const retained: LogEntry[] = []
  for (const original of O.entries) {
    const ours_ = inA.get(original.key)
    const theirs_ = inB.get(original.key)
    if (ours_ === undefined && theirs_ === undefined) continue // both deleted it — agreed

    // ONE SIDE MISSING AN ENTRY THE OTHER STILL HAS IS A REFUSAL, WHATEVER THE OTHER SIDE DID TO
    // IT. This used to drop the entry whenever the surviving side had not also edited it, on the
    // reading that "absent here, unchanged there" is a clean deletion. For an append-only log that
    // reading is wrong far more often than it is right: a truncated apply, a bad 3-way, a partial
    // checkout and a genuine deletion all present identically, and only one of them wants the
    // entry gone. MEASURED, against the real 308-entry log rather than a fixture: `ours` truncated
    // newest-first to ONE base entry, `theirs` an ordinary concurrent build, and the previous code
    // returned `ok: true` having DELETED 307 entries. The cost of refusing instead is one conflict a
    // human resolves, which is what this path did before the driver existed. So a removal is
    // honoured only when BOTH sides made it — agreement, above, is the only evidence of intent
    // this file will accept.
    if (ours_ === undefined || theirs_ === undefined) {
      const side = ours_ === undefined ? 'ours' : 'theirs'
      return {
        ok: false,
        reason: `the ${side} side is missing an entry the other still has, and an append-only log does not lose entries by accident: ${original.key}`,
        // THE REFUSAL GIT MUST NOT BE ASKED TO FINISH. A one-sided deletion is a clean hunk to a
        // line-based merge — delegating this is how the entries left anyway. See `MergeRefusal`.
        wouldLoseEntries: true,
      }
    }
    if (body(ours_) === body(theirs_)) retained.push(ours_)
    else if (body(ours_) === body(original)) retained.push(theirs_)
    else if (body(theirs_) === body(original)) retained.push(ours_)
    else {
      // Both sides rewrote one entry. Nothing is being DELETED here, so git's line-level three-way
      // is a real answer: it merges disjoint edits inside the entry and conflicts on overlapping
      // ones, which is exactly what this file's merges did before the driver existed.
      return { ok: false, reason: `both sides edited the same entry differently: ${original.key}`, wouldLoseEntries: false }
    }
  }

  // (2) Additions — an entry present on a side and absent from the base. THIS is the union that
  //     makes two concurrent builds land together.
  for (const entry of B.entries) {
    if (inO.has(entry.key)) continue
    const alsoOurs = inA.get(entry.key)
    // Both sides added an entry with the same heading. Identical bytes → one copy (taken from ours
    // below). Different bytes → two different entries that collide on identity; refuse rather than
    // pick. Nothing is deleted either way, so git's own three-way is a fair fallback.
    if (alsoOurs !== undefined && body(alsoOurs) !== body(entry)) {
      return {
        ok: false,
        reason: `both sides added a different entry under the same heading: ${entry.key}`,
        wouldLoseEntries: false,
      }
    }
  }
  const added = [
    ...additionsFrom(A, (entry) => !inO.has(entry.key)),
    ...additionsFrom(B, (entry) => !inO.has(entry.key) && !inA.has(entry.key)),
  ]

  // (3) Place the additions among the retained entries, newest-first. A same-day addition sorts
  //     ABOVE a same-day retained entry, which is where a build prepending by hand would put it —
  //     except for an undated section added as a CONTINUATION of a retained entry, which is emitted
  //     directly after the entry it continues, because that is the only place it means anything.
  const dates = effectiveDates(retained)
  const retainedKeys = new Set(retained.map((entry) => entry.key))
  const continuations = new Map<string, LogEntry[]>()
  const free: Addition[] = []
  for (const addition of added) {
    if (addition.attachAfter !== null && retainedKeys.has(addition.attachAfter)) {
      const list = continuations.get(addition.attachAfter) ?? []
      list.push(...addition.entries)
      continuations.set(addition.attachAfter, list)
    } else free.push(addition)
  }

  // Newest first, then by heading — a plain string compare, NOT `localeCompare`, so the result
  // cannot depend on the locale of whichever machine ran the merge.
  free.sort((x, y) => {
    if (x.sortDate !== y.sortDate) return x.sortDate < y.sortDate ? 1 : -1
    const xKey = x.entries[0]!.key
    const yKey = y.entries[0]!.key
    return xKey < yKey ? -1 : xKey > yKey ? 1 : 0
  })

  const merged: LogEntry[] = []
  let next = 0
  for (let i = 0; i < retained.length; i++) {
    while (next < free.length && free[next]!.sortDate >= dates[i]!) merged.push(...free[next++]!.entries)
    merged.push(retained[i]!)
    const continuation = continuations.get(retained[i]!.key)
    if (continuation !== undefined) merged.push(...continuation)
  }
  while (next < free.length) merged.push(...free[next++]!.entries)

  return { ok: true, text: serializeLog({ preamble, entries: merged }) }
}
