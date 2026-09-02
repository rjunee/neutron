/**
 * SQLite's JSON parser enforces a maximum nesting depth (JSON_MAX_DEPTH,
 * 1000 at the default compile) — measured on BOTH engines this project actually
 * runs, and they are different builds: the `sqlite3` CLI `checkpoint.sh` invokes
 * (3.45.1) and the `bun:sqlite` the store and these tests use (3.51.2).
 * `'['.repeat(1000)+'0'+']'.repeat(1000)` is valid on both, one level deeper is
 * `json_valid(...) = 0` on both. `JSON.parse` has no such bound, so without this
 * explicit one the store guard accepted as non-empty findings what
 * `checkpoint.sh`'s json_valid CASE records as REVIEW_NOT_RUN and the canonical
 * counting SQL scores as legacy (Argus r7, reproduced). The whole card rests on
 * "real rejections" being one trustworthy number, so the two write sites and the
 * SQL must agree at this boundary; the corpus in
 * `as-built-disposition-sql.test.ts` executes the agreement.
 */
import { trimAsciiWs } from './ascii-trim.ts'

const SQLITE_JSON_MAX_DEPTH = 1000

/** Container nesting depth exceeds SQLite's bound? Linear scan; brackets inside
 * string literals (and escaped quotes) do not count. Only inputs JSON.parse
 * accepts can change answer here — garbage already returns []. */
function exceedsSqliteJsonDepth(raw: string): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x5b || c === 0x7b) {
      depth++
      if (depth > SQLITE_JSON_MAX_DEPTH) return true
    } else if (c === 0x5d || c === 0x7d) depth--
  }
  return false
}

/**
 * Decode the findings a checkpoint was recorded with
 * (`code_trident_runs.inner_checkpoint_findings`) for the resumed fix round.
 *
 * Returns `[]` for null/empty/unparseable/non-array content, and that empty array
 * is load-bearing rather than merely tidy: the workflow treats "no recorded
 * findings" as a reason to RE-REVIEW instead of skipping forward, so a column
 * written by an older or garbled writer degrades into paying for the review again
 * — never into a fix round with nothing to fix. Entries are passed through
 * verbatim (the workflow embeds them in the fix prompt exactly as the synthesis
 * produced them); this decoder's only job is to guarantee an array.
 *
 * Content nested DEEPER THAN SQLITE ACCEPTS decodes as `[]` as well, so that this
 * validator, `checkpoint.sh`'s `json_valid` CASE and the canonical counting SQL
 * give ONE answer at the nesting boundary — see `SQLITE_JSON_MAX_DEPTH` above.
 */
export function parseCheckpointFindings(raw: string | null | undefined): unknown[] {
  // THE SIX-CHARACTER TRIM, like the rest of this family (Argus r29, nit).
  // `String.prototype.trim` also strips NBSP, the Unicode space separators and the
  // BOM, which neither `checkpoint.sh` nor the canonical counting SQL can express;
  // no divergence is measurable today (all three answer "no findings" on those
  // inputs by other routes), and naming the same six characters here is what keeps
  // it that way — see `trident/ascii-trim.ts`.
  if (typeof raw !== 'string' || trimAsciiWs(raw).length === 0) return []
  // A LEADING BYTE-ORDER MARK IS NOT FINDINGS, stated explicitly rather than left to
  // `JSON.parse` to throw on (Argus r1, minor). RE-MEASURED IN r15, because the note
  // that stood here claimed the two SQLite builds DISAGREE about `'\uFEFF[1]'` and
  // they do not: over a value whose STORED BYTES begin EF BB BF, `json_valid` answers
  // 0 on the CLI `checkpoint.sh` invokes (3.45.1) AND on `bun:sqlite` (3.51.2). The
  // reported `json_valid = 1` came from BINDING the marked text as a parameter —
  // bun's driver strips the mark before SQLite sees it, so the stored value carried no
  // mark at all and was honestly valid JSON. So the three copies of this test agree
  // today; they agree BY VERSION, and this line — with the matching
  // `SUBSTR(…, 1, 1) <> CHAR(65279)` in `checkpoint.sh`'s `findings_case` and in the
  // canonical counting SQL — makes them agree BY CONSTRUCTION, so an engine that
  // started tolerating the mark could not score as a real rejection bytes this decoder
  // reads as empty.
  if (raw.charCodeAt(0) === 0xfeff) return []
  if (exceedsSqliteJsonDepth(raw)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed) ? parsed : []
}
