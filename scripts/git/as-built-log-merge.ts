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
 * WHAT IT REFUSES. If both sides modify the SAME existing entry differently, or one deletes what
 * the other edits, or the preamble diverges, that is a genuine semantic conflict and this returns
 * `{ ok: false }`. The caller then falls back to `git merge-file`, so the floor of this whole
 * mechanism is exactly today's behaviour — conflict markers a human reads — never a silent
 * mis-merge. A driver that guessed here would be worse than the conflict it replaced.
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
 */
const FENCE = /^\s*(```|~~~)/

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
  let fenced = false

  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced
    if (!fenced && HEADING.test(line)) {
      if (current !== null) entries.push(current)
      const heading = line.trimEnd()
      const occurrence = (seen.get(heading) ?? 0) + 1
      seen.set(heading, occurrence)
      current = {
        key: `${heading} ${occurrence}`,
        date: DATE_IN_HEADING.exec(line)?.[1] ?? '',
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

export type MergeResult = { ok: true; text: string } | { ok: false; reason: string }

/**
 * Three-way merge of the log. `base` is the common ancestor, `ours` the side being merged into,
 * `theirs` the side being merged in.
 */
export function mergeAsBuiltLog(base: string, ours: string, theirs: string): MergeResult {
  const O = parseLog(base)
  const A = parseLog(ours)
  const B = parseLog(theirs)

  // A file with no entries is not this log — a rename, a truncation, something unexpected. Let
  // git's own merge handle it rather than inventing structure that is not there.
  if (A.entries.length === 0 && B.entries.length === 0) {
    return { ok: false, reason: 'neither side parses as an entry log' }
  }

  const preambleA = A.preamble.join('\n')
  const preambleB = B.preamble.join('\n')
  const preambleO = O.preamble.join('\n')
  let preamble: string[]
  if (preambleA === preambleB || preambleB === preambleO) preamble = A.preamble
  else if (preambleA === preambleO) preamble = B.preamble
  else return { ok: false, reason: 'both sides changed the log header differently' }

  const inO = index(O)
  const inA = index(A)
  const inB = index(B)

  // (1) Entries the base already had, in the base's order, with each side's edits applied.
  const retained: LogEntry[] = []
  for (const original of O.entries) {
    const ours_ = inA.get(original.key)
    const theirs_ = inB.get(original.key)
    if (ours_ === undefined && theirs_ === undefined) continue // both deleted it — agreed
    if (ours_ === undefined) {
      if (body(theirs_ as LogEntry) !== body(original)) {
        return { ok: false, reason: `one side deleted an entry the other edited: ${original.key}` }
      }
      continue // deleted by us, untouched by them
    }
    if (theirs_ === undefined) {
      if (body(ours_) !== body(original)) {
        return { ok: false, reason: `one side deleted an entry the other edited: ${original.key}` }
      }
      continue
    }
    if (body(ours_) === body(theirs_)) retained.push(ours_)
    else if (body(ours_) === body(original)) retained.push(theirs_)
    else if (body(theirs_) === body(original)) retained.push(ours_)
    else return { ok: false, reason: `both sides edited the same entry differently: ${original.key}` }
  }

  // (2) Additions — an entry present on a side and absent from the base. THIS is the union that
  //     makes two concurrent builds land together.
  const added: LogEntry[] = []
  for (const entry of A.entries) if (!inO.has(entry.key)) added.push(entry)
  for (const entry of B.entries) {
    if (inO.has(entry.key)) continue
    const alsoOurs = inA.get(entry.key)
    if (alsoOurs !== undefined) {
      // Both sides added an entry with the same heading. Identical bytes → one copy. Different
      // bytes → two different entries that collide on identity; refuse rather than pick.
      if (body(alsoOurs) !== body(entry)) {
        return { ok: false, reason: `both sides added a different entry under the same heading: ${entry.key}` }
      }
      continue
    }
    added.push(entry)
  }

  // Newest first, then by heading — a plain string compare, NOT `localeCompare`, so the result
  // cannot depend on the locale of whichever machine ran the merge.
  added.sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? 1 : -1
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0
  })

  // (3) Place the additions among the retained entries, newest-first. A same-day addition sorts
  //     ABOVE a same-day retained entry, which is where a build prepending by hand would put it.
  const dates = effectiveDates(retained)
  const merged: LogEntry[] = []
  let next = 0
  for (let i = 0; i < retained.length; i++) {
    while (next < added.length && added[next]!.date >= dates[i]!) merged.push(added[next++]!)
    merged.push(retained[i]!)
  }
  while (next < added.length) merged.push(added[next++]!)

  return { ok: true, text: serializeLog({ preamble, entries: merged }) }
}
