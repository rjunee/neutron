/**
 * The as-built log's own contract, made mechanical.
 *
 * It lives beside {@link ./as-built-log-merge.ts} rather than under `trident/`
 * on purpose: it SHARES that file's parser, and a gate whose idea of an entry
 * can drift from the merge driver's is worse than no gate — see the bottom of
 * this comment for the three ways the first version had already drifted.
 *
 * `docs/AS_BUILT.md` line 3 says "One entry per merged change." Nothing checked
 * it, and four `##` headings had collided on `main` at f99d6d49 by two DIFFERENT
 * routes — which is the argument for a standing gate rather than a one-off tidy,
 * because no single review would have caught both.
 *
 * THREE were minted by folding 46 per-entry files back into the one canonical
 * log (bb90794b, #304), which NORMALISED each folded file's `# Title` into the
 * log's `## YYYY-MM-DD — title` shape and thereby produced a heading no author
 * ever typed. Measured across that commit: each of the three reads 1 at
 * `bb90794b^` and 2 at `bb90794b`. #304 verified that every original heading was
 * still PRESENT; it had no reason to check that none had become a twin.
 *
 * The FOURTH predates the fold and has nothing to do with it. `## 2026-08-14 —
 * the by-path build brief is proven in lockstep, prompt to receipt` was written
 * by a84d6cbb (#261) and re-appended VERBATIM by 6da6ddb9 (#275) alongside that
 * PR's own new entry — a plain merge artefact. It already reads 2 at
 * `bb90794b^`, so it is the one collision the fold neither created nor noticed.
 *
 * ⚠️ THE MERGE BEHAVIOUR IS WHY THIS IS A GATE AND NOT A CLEANUP — under EITHER
 * driver this path can carry. Tracked `.gitattributes` binds `merge=union`
 * (cb39016f), which keeps BOTH sides of a conflicting hunk instead of raising,
 * so two builds appending near the same offset COMPOUND rather than conflict. A
 * clone that has run `scripts/install-merge-drivers.sh` instead gets
 * `merge=as-built-log` from `$GIT_COMMON_DIR/info/attributes`, which OUTRANKS
 * `.gitattributes` — and that entry-aware driver names this exact case as its
 * one known limit (`scripts/git/as-built-log-merge.ts` "KNOWN LIMIT"): a new
 * entry colliding with an old one shifts occurrence indices and the entries come
 * back in an odd order. Neither driver ever says the word "duplicate". This is
 * the silent failure mode, not the loud one, and the only thing that will ever
 * notice it is something that looks.
 *
 * Keyed on the WHOLE heading line, never on the date. The log legitimately
 * carries dozens of entries dated the same day — 2026-08-09 alone has more than
 * twenty — so a date-keyed check would be a wall of false positives, and a gate
 * that cries wolf gets waved through, which is worse than no gate.
 *
 * WHAT COUNTS AS AN ENTRY IS NOT DECIDED HERE. It delegates to {@link parseLog},
 * the merge driver's own parser, so the gate and the driver can never disagree
 * about where an entry begins. The first shape of this file re-derived that
 * parsing from scratch under `trident/`, and it had already drifted three ways
 * before it ever shipped:
 *
 *   - `~~~` fences unrecognised → a heading quoted inside one reads as a real
 *     entry, and the gate blocks a merge over prose (loud, expensive, wrong).
 *   - an indented fence CLOSER not matched → the scanner stays stuck open and
 *     every heading below it goes uncounted, so a real collision reports clean
 *     (silent, and the direction nobody ever finds out about).
 *   - `##\ttitle` counted by the driver, missed here → the driver merges two
 *     entries the gate swears are one.
 *
 * All three are regression cases in the test file next to this one.
 */

import { parseLog } from './as-built-log-merge.ts'

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
