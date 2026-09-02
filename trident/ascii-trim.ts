/**
 * trimAsciiWs — strip LEADING and TRAILING runs of exactly the six ASCII
 * whitespace characters: SPACE, TAB, LF, VT, FF, CR.
 *
 * THE CHARACTER SET IS THE CONTRACT (Argus r4). `String.prototype.trim` also
 * strips NBSP, the Unicode space separators and the BOM, so it disagreed with
 * the two mirrors that cannot express those: the explicit six-character trim in
 * `trident/checkpoint.sh` (whose earlier `[[:space:]]` matched U+2003 under
 * glibc UTF-8 locales, measured) and the
 * `TRIM(col, ' '||CHAR(9)||CHAR(10)||CHAR(11)||CHAR(12)||CHAR(13))` in the
 * canonical disposition SQL published in `docs/AS_BUILT.md`. All three dialects
 * name the same six characters, and `as-built-disposition-sql.test.ts` executes
 * them against each other row for row.
 *
 * A TWO-POINTER SCAN, NOT A REGEX (CodeQL js/polynomial-redos HIGH, Argus r7).
 * The previous `/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g` backtracked quadratically on
 * a long interior run of whitespace, and it was applied to `inner_checkpoint`,
 * which comes from stored state. Same six characters, linear time.
 */
export function trimAsciiWs(raw: string): string {
  let start = 0
  let end = raw.length
  while (start < end && isAsciiWs(raw.charCodeAt(start))) start++
  while (end > start && isAsciiWs(raw.charCodeAt(end - 1))) end--
  return start === 0 && end === raw.length ? raw : raw.slice(start, end)
}

function isAsciiWs(c: number): boolean {
  // TAB 0x09, LF 0x0A, VT 0x0B, FF 0x0C, CR 0x0D, SPACE 0x20 — and nothing else.
  return c === 0x20 || (c >= 0x09 && c <= 0x0d)
}
