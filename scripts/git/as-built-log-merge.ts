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
 * ENTRY-AWARE, NOT LINE-AWARE — THIS IS THE WHOLE POINT, AND IT IS MEASURED, NOT ASSERTED.
 * #308 bound this path to git's built-in `union` driver, which resolves a conflicting hunk by
 * taking both sides' lines. That is right about the goal and wrong about the unit. Union diffs the
 * two additions against the base and emits each side's UNIQUE lines around the lines they SHARE —
 * and two entries written by the same generator share plenty. Real git, real merge, the exact
 * attribute #308 shipped:
 *
 *     ours:   ## 2026-08-15 - alpha change / "What changed:" / - alpha detail one / "Verified with a control."
 *     theirs: ## 2026-08-17 - beta change  / "What changed:" / - beta detail one  / "Verified with a control."
 *
 *     result: ## 2026-08-15 - alpha change / "What changed:" / - alpha detail one
 *             ## 2026-08-17 - beta change  / "What changed:" / - beta detail one / "Verified with a control."
 *
 * The shared trailing line was emitted ONCE, at the end, so alpha's entry silently LOST its last
 * line to beta's — exit 0, no conflict, no marker, nothing to review. That is the interleave that
 * produced broken TypeScript in an earlier incident, reproduced here on a documentation log where
 * it is quieter and therefore worse. Note also the ordering: 08-15 above 08-17 in a file whose
 * first line promises newest-first.
 *
 * So the unit of merge here is a WHOLE ENTRY (a `## ` heading and everything under it up to the
 * next heading). Two entries are never spliced together, an entry's bytes are either taken intact
 * or not at all, and the result is ordered newest-first.
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
 * is the property that actually matters — but their ORDER can come out odd. The real log contains
 * four verbatim-duplicated headings, all historical, so this needs a new entry to collide exactly
 * with an old one to trigger. Keying on a content hash instead would fix it and would break
 * something worse: an ordinary edit to an entry would read as a delete plus an add.
 */

/** An entry begins at a `## ` heading. `#` (the file title) and `### ` (subsections) do not. */
const HEADING = /^##[^#]/
/** `## 2026-08-15 — title`. Undated sections inherit a date; see `effectiveDates`. */
const DATE_IN_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\b/
/**
 * A fence opens or closes a code block. Entries in this log quote shell and markdown, so a
 * `## ` INSIDE a fence is sample text, not a heading — treating it as one would cut an entry in
 * half and let a merge place another entry between the halves.
 *
 * The CHARACTER AND LENGTH are captured, not just the presence of a fence, because this log quotes
 * markdown: a four-backtick fence whose whole point is to quote a three-backtick block appears in
 * exactly the kind of entry that documents a fenced format. A naive boolean toggle closes on that
 * inner three-backtick line, re-opens on the next one, and a `## ` sample heading in between is
 * then read as a real entry — splitting one entry into two that this merge will sort independently.
 * CommonMark's rule is the fix and it is one comparison: a fence closes only on the SAME character,
 * at a length GREATER THAN OR EQUAL TO the opener's.
 */
const FENCE = /^\s*(`{3,}|~{3,})/

export interface LogEntry {
  /**
   * Identity of the entry. The heading line plus an OCCURRENCE INDEX, because the real log
   * genuinely repeats four headings verbatim (e.g. `## 2026-08-09 — Model usage on the phone`).
   * Keying on the bare heading would silently fold two distinct entries into one and DELETE
   * history — the one outcome this file must never produce.
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
  /** The OPEN fence's delimiter, or null outside a code block. */
  let fence: { char: string; len: number } | null = null

  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1]
    if (marker !== undefined) {
      const char = marker[0] as string
      if (fence === null) fence = { char, len: marker.length }
      else if (char === fence.char && marker.length >= fence.len) fence = null
    }
    if (fence === null && HEADING.test(line)) {
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
 * The date each entry sorts AT.
 *
 * MEASURED, NOT ASSUMED: every one of the 304 entries in `docs/AS_BUILT.md` carries a date today
 * (`grep -E '^##[^#]' docs/AS_BUILT.md | grep -vcE '^##\s+[0-9]{4}-[0-9]{2}-[0-9]{2}'` → 0). An
 * earlier draft of this file justified the function by claiming ten undated sections exist; they do
 * not, and that claim is removed rather than left to be believed.
 *
 * It still earns its place, for the shape rather than the count. An undated CONTINUATION section —
 * a `## ` with no date that belongs to the entry above it — is a shape this log has carried before
 * and can carry again. Without inheritance its date is `''`, which sorts BELOW every real date, so
 * such a section would be flung to the bottom of the file away from the entry it continues, and a
 * newly-merged entry could be placed between an entry and its own continuation. Inheriting the
 * predecessor's date keeps a continuation welded to its parent.
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

  // A side with no entries is not this log — a rename, a truncation, a file replaced wholesale.
  // Let git's own merge handle it rather than inventing structure that is not there.
  //
  // EITHER side, not both. This guard used to read `A === 0 && B === 0`, and the one-sided case is
  // the dangerous one: with `ours` truncated to zero entries and `theirs` a normal append, every
  // base entry is present in `theirs` and absent from `ours`, which the retention loop below reads
  // as "deleted by us, untouched by them" — a legitimate deletion — for all 304 of them at once. It
  // returned `ok: true` with the entire canonical history replaced by the single new entry. A
  // truncation is exactly when a human has to look, so it must reach the conflict fallback.
  if (A.entries.length === 0 || B.entries.length === 0) {
    return { ok: false, reason: 'a side has no entries — a truncation or a rename, not a log append' }
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

  // (1b) WHOSE ORDER THE RETAINED ENTRIES KEEP.
  //
  //      Every retained key is present in all three texts by construction — an entry deleted on
  //      either side took a `continue` above and never reached `retained` — so the three orderings
  //      below are permutations of one set and can be compared directly.
  //
  //      This used to be unconditionally the BASE's order, which silently discarded a side that
  //      reordered existing entries and still reported a clean merge: a restructuring pass over
  //      this file (#304 was one) would land, report success, and be reverted to the old order by
  //      the merge. Honouring the single side that reordered costs one comparison; both sides
  //      reordering differently is a genuine semantic conflict and goes to the fallback.
  const retainedByKey = new Map(retained.map((entry) => [entry.key, entry]))
  const orderOf = (log: ParsedLog): string[] =>
    log.entries.filter((entry) => retainedByKey.has(entry.key)).map((entry) => entry.key)
  const sameOrder = (x: string[], y: string[]): boolean =>
    x.length === y.length && x.every((key, i) => key === y[i])
  const orderO = orderOf(O)
  const orderA = orderOf(A)
  const orderB = orderOf(B)
  let order: string[]
  if (sameOrder(orderA, orderB)) order = orderA
  else if (sameOrder(orderA, orderO)) order = orderB
  else if (sameOrder(orderB, orderO)) order = orderA
  else return { ok: false, reason: 'both sides reordered existing entries differently' }
  const ordered = order.map((key) => retainedByKey.get(key) as LogEntry)

  // (2) Additions — an entry present on a side and absent from the base. THIS is the union that
  //     makes two concurrent builds land together.
  //
  //     Each addition carries the EFFECTIVE date it had on its own side, not the bare date in its
  //     heading. An added entry with no date of its own is a continuation of the entry above it;
  //     keying the sort on the bare `date` would send it to the bottom of the file, away from the
  //     parent it continues, because `''` sorts below every real date.
  interface Addition {
    entry: LogEntry
    date: string
  }
  const added: Addition[] = []
  const datesA = effectiveDates(A.entries)
  const datesB = effectiveDates(B.entries)
  for (const [i, entry] of A.entries.entries()) {
    if (!inO.has(entry.key)) added.push({ entry, date: datesA[i] as string })
  }
  for (const [i, entry] of B.entries.entries()) {
    if (inO.has(entry.key)) continue
    const alsoOurs = inA.get(entry.key)
    if (alsoOurs !== undefined) {
      // Both sides added an entry with the same heading. Identical bytes → one copy, already
      // collected from `ours`. Different bytes → two different entries colliding on identity, and
      // picking either would drop the other; refuse and let a human read the conflict.
      if (body(alsoOurs) !== body(entry)) {
        return { ok: false, reason: `both sides added a different entry under the same heading: ${entry.key}` }
      }
      continue
    }
    added.push({ entry, date: datesB[i] as string })
  }

  // Newest first, then by heading — a plain string compare, NOT `localeCompare`, so the result
  // cannot depend on the locale of whichever machine ran the merge.
  added.sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? 1 : -1
    return x.entry.key < y.entry.key ? -1 : x.entry.key > y.entry.key ? 1 : 0
  })

  // (3) Place the additions among the retained entries, newest-first. A same-day addition sorts
  //     ABOVE a same-day retained entry, which is where a build prepending by hand would put it.
  const dates = effectiveDates(ordered)
  const merged: LogEntry[] = []
  let next = 0
  for (let i = 0; i < ordered.length; i++) {
    while (next < added.length && (added[next] as Addition).date >= (dates[i] as string))
      merged.push((added[next++] as Addition).entry)
    merged.push(ordered[i] as LogEntry)
  }
  while (next < added.length) merged.push((added[next++] as Addition).entry)

  return { ok: true, text: serializeLog({ preamble, entries: merged }) }
}
