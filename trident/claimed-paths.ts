/**
 * @neutronai/trident — derive the repo-relative paths a build is likely to touch.
 *
 * The FILE-CONTENTION half of dependency-aware dispatch. Before creating a run,
 * `dispatchBoardBoundBuild` derives this set from the two sources that actually
 * exist at dispatch time — the card's task text (always) and its plan doc (when
 * `design_doc_ref` is a resolvable `neutron-docs:` ref) — records it on the run
 * row (`code_trident_runs.claimed_paths`), and refuses to start a second build
 * whose derived set intersects a LIVE run's.
 *
 * DELIBERATELY NO FILESYSTEM EXISTENCE CHECK. A path the build is going to
 * CREATE collides just as hard as one it will edit (two lanes both creating
 * `trident/claimed-paths.ts` is exactly the conflict this prevents), and an
 * `fs.stat` per token would make a pure gate into an I/O gate for no gain.
 *
 * Pure, no I/O, no imports — so it is unit-testable and cheap enough to run on
 * every dispatch.
 */

/** A defensive cap: a plan doc listing hundreds of files claims the first 64. */
const MAX_CLAIMED_PATHS = 64

/**
 * Extensions worth claiming on a backticked token that has no `/` — a bare
 * `SPEC.md` or `bun.lock` at the repo root is a real contention point. A
 * backticked token WITH a `/` is taken on the slash alone.
 */
const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'sql', 'md', 'sh', 'yml', 'yaml',
  'toml', 'css', 'html', 'txt', 'lock', 'env', 'py', 'rs', 'go',
])

/** ``…`` spans: the tokens an author explicitly marked as code/paths. */
const BACKTICKED = /`([^`\n]{1,200})`/g

/**
 * Bare prose tokens shaped like a repo-relative file path: at least one `/`
 * segment followed by a `name.ext` leaf. Anchored on a boundary so a URL's
 * `//host/…` tail and a mid-word match are not picked up as their own token.
 */
const BARE_PATH = /(?:^|[\s,'"(\[{])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)/g

/**
 * Normalize one candidate token, or return null when it is not a repo-relative
 * path we are willing to claim.
 *
 * Rejected: URLs (`https://a.b/c.d` — a link is not a file), absolute paths
 * (outside the repo), and anything containing `..` (an escape we will not
 * reason about). Version-ish tokens (`v1.2.3`) have no `/` and no known
 * extension, so they fall out naturally.
 */
function normalize(raw: string): string | null {
  let token = raw.trim()
  // Trailing sentence punctuation from prose ("edit trident/store.ts, then …").
  //
  // Trimmed by a LINEAR scan, not `/[.,;:)\]}]+$/`. That regex is quadratic on a
  // token of many `)` (CodeQL js/polynomial-redos, high): anchoring `+$` makes
  // the engine re-scan the whole run from each starting offset. The input here
  // is a card's task text and plan doc, which reach this code unvalidated, so
  // the bound has to come from the algorithm rather than from trusting the
  // caller.
  let end = token.length
  while (end > 0 && '.,;:)]}'.includes(token[end - 1] as string)) end--
  token = token.slice(0, end)
  if (token.startsWith('./')) token = token.slice(2)
  if (token.length === 0) return null
  if (token.includes('://')) return null
  if (token.startsWith('/')) return null
  if (token.startsWith('~') || token.startsWith('@')) return null
  if (token.includes('..')) return null
  // Source references commonly carry a line suffix; it is not part of the path.
  token = token.replace(/:\d+(?::\d+)?$/, '')
  if (token.includes('/')) {
    const leaf = token.slice(token.lastIndexOf('/') + 1)
    const dot = leaf.lastIndexOf('.')
    if (dot <= 0 || !KNOWN_EXTENSIONS.has(leaf.slice(dot + 1).toLowerCase())) return null
    return token
  }
  // No slash: only a bare repo-root file with a known extension qualifies.
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  return KNOWN_EXTENSIONS.has(token.slice(dot + 1).toLowerCase()) ? token : null
}

/**
 * Extract the repo-relative file paths named by a card's task text and plan doc.
 * Deduped, first-seen order preserved, capped at {@link MAX_CLAIMED_PATHS}.
 * An empty result claims nothing and can therefore never hold a dispatch — the
 * gate cannot hold on what it could not measure.
 */
export function deriveClaimedPaths(sources: { task: string; planDoc?: string | null }): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const take = (path: string): void => {
    if (out.length >= MAX_CLAIMED_PATHS) return
    if (seen.has(path)) return
    seen.add(path)
    out.push(path)
  }
  const text = `${sources.task}\n${sources.planDoc ?? ''}`
  for (const line of text.split('\n')) {
    const paths = recognizePaths(line)
    for (const clause of clauses(line, paths)) {
      // Unknown prose is not evidence of read-only scope. An exemption must
      // consume the WHOLE clause; later nouns can never cancel a write.
      if (!isExemptClause(clause.map(token => token.word))) {
        for (const token of clause) if (token.path !== undefined) take(token.path)
      }
    }
  }
  return out
}

type ClaimToken = { word: string; path?: string }
const PATH_WORD = '@path'

/** Only accepted path ranges are replaced; all other source text stays visible. */
function clauses(line: string, paths: PathRange[]): ClaimToken[][] {
  const tokens: ClaimToken[] = []
  const prose = (text: string): void => {
    for (const match of text.matchAll(/[a-z0-9_]+(?:[-'][a-z0-9_]+)*|[^\s`]/gi)) {
      tokens.push({ word: match[0].toLowerCase() })
    }
  }
  let cursor = 0
  for (const path of paths) {
    prose(line.slice(cursor, path.start))
    tokens.push({ word: PATH_WORD, path: path.path })
    cursor = path.end
  }
  prose(line.slice(cursor))
  const result: ClaimToken[][] = [[]]
  for (const token of tokens) {
    // A bare "and" may join verbs sharing an object ("edit and test X").
    // Only clear boundaries separate independently exemptible instructions.
    if (['.', ';', '!', '?', 'but', 'then', 'before', 'after'].includes(token.word)) {
      result.push([])
    } else result[result.length - 1]!.push(token)
  }
  // A boundary cannot discard an incomplete request: "Edit then run X"
  // still has an unresolved prefix. Keep its boundary token too, so joining
  // fragments cannot manufacture a newly valid exemption ("Do not; edit X").
  const complete: ClaimToken[][] = []
  let pending: ClaimToken[] = []
  for (const clause of result) {
    if (clause.length === 0) continue
    if (clause.some(token => token.path !== undefined)) {
      complete.push([...pending, ...clause])
      pending = []
    } else if (pending.length > 0 || !isExemptClause(clause.map(token => token.word))) {
      for (const token of clause) pending.push(token)
      pending.push({ word: '@boundary' })
    }
  }
  return complete
}

/** A small complete grammar, deliberately not a natural-language classifier. */
function isExemptClause(input: string[]): boolean {
  let start = 0
  while (input[start] === '-' || input[start] === '#') start++
  const words = input.slice(start)
  while (words.at(-1) === ',') words.pop()
  if (words[0] === 'read-only' && ['check', 'checks', 'reference', 'references'].includes(words[1] ?? '') && words[2] === ':') {
    words.splice(0, 3)
    if (pathList(words)) return true
  }
  if (words[0] === 'tests' && words[1] === ':') words.splice(0, 2)
  if (words[0] === 'reference' && words[1] === ':') return pathList(words.slice(2))

  if (words[0] === 'do' && words[1] === 'not') words.splice(0, 2)
  else if (["don't", 'never', 'avoid', 'without'].includes(words[0] ?? '')) {
    const prefix = words.shift()
    if (prefix === 'avoid') {
      if (words.at(-1) === 'entirely') words.pop()
      return pathList(words)
    }
  } else {
    if (['run', 'execute', 'inspect', 'review', 'read', 'check', 'verify', 'validate', 'see', 'consult'].includes(words[0] ?? '')) {
      words.shift()
      // Canonical test-run framing, not arbitrary words between a read verb
      // and its objects. Anything outside these complete forms stays claimed.
      if (words.slice(0, 5).join(' ') === 'the build checks in @path') words.splice(0, 4)
      return readTargets(words)
    }
    return command(words)
  }
  if (!['edit', 'touch', 'change', 'modify', 'create', 'remove', 'update', 'editing', 'touching', 'changing'].includes(words.shift() ?? '')) return false
  // A complete objectless prohibition is independently read-only; it must
  // not taint a later canonical execution clause with unresolved write scope.
  return words.length === 0 || pathList(words)
}

function pathList(words: string[]): boolean {
  if (words[0] !== PATH_WORD) return false
  let index = 1
  while (index < words.length) {
    if (words[index] === ',') index++
    if (words[index] === 'and' || words[index] === 'or') index++
    if (words[index] !== PATH_WORD) return false
    index++
  }
  return true
}

function command(words: string[]): boolean {
  if (words[0] === 'bun' && words[1] === 'test') return pathList(words.slice(2))
  if (words.slice(0, 4).join(' ') === 'bun run build with') return pathList(words.slice(4))
  if (words.slice(0, 3).join(' ') === 'tsc - p') return words.length === 4 && words[3] === PATH_WORD
  return words.length === 2 && words[0] === 'bash' && words[1] === PATH_WORD
}

function readTargets(words: string[]): boolean {
  if (pathList(words) || command(words)) return true
  // Lists of complete invocations, e.g. bun test X, tsc -p Y, and bash Z.
  const groups: string[][] = [[]]
  for (const word of words) {
    if (word === ',' || word === 'and') {
      if (groups.at(-1)!.length > 0) groups.push([])
    } else groups.at(-1)!.push(word)
  }
  return groups.length > 1 && groups.every(group => pathList(group) || command(group))
}

type PathRange = { start: number; end: number; path: string }

/** Extract and normalize once; only these exact source ranges may be masked. */
function recognizePaths(line: string): PathRange[] {
  const paths: PathRange[] = []
  const accept = (raw: string, start: number): void => {
    const path = normalize(raw)
    if (path !== null) paths.push({ start, end: start + raw.length, path })
  }
  for (const span of line.matchAll(BACKTICKED)) {
    for (const token of span[1]!.matchAll(/[^\s,]+/g)) {
      accept(token[0], span.index + 1 + token.index)
    }
  }
  for (const token of line.matchAll(BARE_PATH)) {
    accept(token[1]!, token.index + token[0].length - token[1]!.length)
  }
  paths.sort((a, b) => a.start - b.start || b.end - a.end)
  return paths.filter((path, index) => index === 0 || path.start >= paths[index - 1]!.end)
}
