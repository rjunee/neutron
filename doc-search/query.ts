/**
 * @neutronai/doc-search — FTS5 query sanitiser.
 *
 * Adapted from `cores/free/research/src/vault-search.ts:sanitizeFtsQuery`
 * (the in-repo precedent). User / agent queries are free text; we must
 * never let raw input reach FTS5's MATCH grammar where `NEAR`, `NOT`,
 * parens, a stray `"`, or a `-` (FTS5 parses a leading/embedded `-` as
 * query syntax, NOT a bareword char — an unquoted `daily-driver` throws
 * and the caller catches it as zero results) would be treated as
 * operators. Each whitespace token is passed through verbatim ONLY when
 * it is purely `[A-Za-z0-9_]+`; anything else (hyphenated terms
 * included) is double-quoted as a phrase literal so the tokenizer still
 * splits it into searchable terms. The query is thus always a safe
 * bag-of-terms / phrases.
 */

/**
 * Turn free text into a safe FTS5 MATCH expression. Returns '' for
 * empty / whitespace-only input (callers treat that as "no results").
 */
export function sanitizeFtsQuery(raw: string): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0)
  const cleaned = tokens.map((t) => {
    if (/^[A-Za-z0-9_]+$/.test(t)) return t
    return '"' + t.replace(/"/g, '""') + '"'
  })
  return cleaned.join(' ')
}
