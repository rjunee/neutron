/**
 * @neutronai/trident — the as-built log's own contract, made mechanical.
 *
 * `docs/AS_BUILT.md` line 3 says "One entry per merged change." Nothing checked
 * it, and folding 46 per-entry files back into the one canonical log (#304)
 * produced four colliding `##` headings on the first attempt — three of them by
 * NORMALISING a folded file's `# Title` into the log's `## YYYY-MM-DD — title`
 * shape, which is a heading no author ever typed. #304 verified that every
 * original heading was still PRESENT; it had no reason to check that none had
 * become a twin.
 *
 * ⚠️ THE UNION MERGE IS WHY THIS IS A GATE AND NOT A CLEANUP. The log is
 * `merge=union` (see {@link ./as-built-union-attribute.ts}), so a conflicting
 * hunk keeps BOTH sides instead of raising. Two builds appending near the same
 * offset therefore COMPOUND rather than conflict: duplication here is the
 * silent failure mode, not the loud one, and the only thing that will ever
 * notice it is something that looks.
 *
 * Keyed on the WHOLE heading line, never on the date. The log legitimately
 * carries dozens of entries dated the same day — 2026-08-09 alone has more than
 * twenty — so a date-keyed check would be a wall of false positives, and a gate
 * that cries wolf gets waved through, which is worse than no gate.
 */

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
 * Only top-level `## ` headings count. `###` and deeper are an entry's internal
 * structure and repeat legitimately across entries ("### Verification" appears
 * in dozens). Lines inside a fenced code block are skipped: an entry quoting a
 * markdown snippet is prose, not a second entry, and a gate that blocks a merge
 * must not fire on one.
 */
export function findDuplicateEntryHeadings(log: string): DuplicateEntryHeading[] {
  const seen = new Map<string, number[]>()
  let fenced = false

  const lines = log.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced || !line.startsWith('## ')) continue
    const at = seen.get(line)
    if (at) at.push(i + 1)
    else seen.set(line, [i + 1])
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
    '   The log says "One entry per merged change", and it is merged with',
    '   `merge=union` — a conflicting hunk keeps BOTH sides rather than raising,',
    '   so a collision compounds silently instead of failing loudly.',
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
