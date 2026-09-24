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
    // The recognizer is the sole owner of masking: rejected candidates (such
    // as Edit/update) remain instruction text. Keep offsets in UTF-16 units.
    const masked = line.split('')
    for (const path of paths) masked.fill(' ', path.start, path.end)
    const instructions = masked.join('')
    let cursor = 0
    let writing = false
    let reading = false
    let negated = false
    const words = instructions.matchAll(/\b[a-z]+(?:'[a-z]+)?\b|[.;!?]/gi)
    for (const word of words) {
      while (cursor < paths.length && paths[cursor]!.start < word.index) {
        if (writing && !negated) take(paths[cursor]!.path)
        cursor++
      }
      const token = word[0].toLowerCase()
      if (/^[.;!?]$/.test(token)) {
        writing = reading = negated = false
      } else if (['but', 'then', 'before', 'after'].includes(token)) {
        negated = false
      } else if (['not', "don't", 'never', 'avoid', 'without'].includes(token)) {
        negated = true
      } else if (READ_ACTIONS.has(token)) {
        reading = true
        writing = false
      } else if (WRITE_ACTIONS.has(token)) {
        // "run build checks" is execution; explicit edit/create/etc. still
        // wins in mixed prose even with previously unseen intervening words.
        if (token !== 'build' || !reading) {
          writing = true
          reading = false
        }
      }
    }
    while (cursor < paths.length) {
      if (writing && !negated) take(paths[cursor]!.path)
      cursor++
    }
  }
  return out
}

const WRITE_ACTIONS = new Set('add append build change create edit fix implement modify move publish remove rename replace rewrite touch update wire editing touching changing'.split(' '))
const READ_ACTIONS = new Set('run execute test inspect review read check verify validate consult see'.split(' '))

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
