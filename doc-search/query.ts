/**
 * @neutronai/doc-search — FTS5 query sanitiser.
 *
 * Lifted from `cores/free/research/src/vault-search.ts:sanitizeFtsQuery`
 * (the in-repo precedent). User / agent queries are free text; we must
 * never let raw input reach FTS5's MATCH grammar where `NEAR`, `NOT`,
 * parens, or a stray `"` would be parsed as operators (or throw a
 * syntax error). Each whitespace token is passed through verbatim when
 * it is plain (`[A-Za-z0-9_-]+`) and double-quoted as a phrase literal
 * otherwise, so the query is always a safe bag-of-terms.
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
    if (/^[A-Za-z0-9_-]+$/.test(t)) return t
    return '"' + t.replace(/"/g, '""') + '"'
  })
  return cleaned.join(' ')
}
