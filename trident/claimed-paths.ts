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
  token = token.replace(/[.,;:)\]}]+$/, '')
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
  const take = (candidate: string): void => {
    if (out.length >= MAX_CLAIMED_PATHS) return
    const path = normalize(candidate)
    if (path === null || seen.has(path)) return
    seen.add(path)
    out.push(path)
  }
  // Claims come only from actionable sentences. Design docs routinely mention
  // reference files, historical evidence and explicit "do not touch" guard
  // rails; treating every slash token as an intended edit serialises unrelated
  // lanes. Split backtick spans and comma/"and" lists into individual paths.
  const text = `${sources.task}\n${sources.planDoc ?? ''}`
  for (const line of text.split('\n')) {
    if (/\b(?:do not|don't|never|avoid|without (?:editing|touching|changing))\b/i.test(line)) continue
    if (!/\b(?:add|append|build|change|create|edit|fix|implement|modify|move|publish|remove|rename|replace|rewrite|touch|update|wire)\b/i.test(line)) continue
    for (const m of line.matchAll(BACKTICKED)) {
      const span = m[1] ?? ''
      for (const candidate of span.split(/\s+(?:and|or)\s+|\s*,\s*/i)) take(candidate)
    }
    for (const m of line.matchAll(BARE_PATH)) take(m[1] ?? '')
  }
  return out
}
