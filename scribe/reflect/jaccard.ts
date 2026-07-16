/**
 * @neutronai/scribe — reflect: Jaccard near-duplicate clustering (pure leaf).
 *
 * RB3 consolidation, job 2 (dedup near-duplicate pages). Deterministic, no I/O,
 * no LLM: tokenise each page's (title + compiled-truth), compute pairwise
 * Jaccard similarity over the token SETS, and group pages whose similarity meets
 * the threshold into clusters (connected components — so `A~B` and `B~C` collapse
 * `{A,B,C}` even if `A` and `C` alone are below the bar).
 *
 * This is the CHEAP, always-safe half of the reflect pass — it runs with no
 * substrate and its output is fully determined by the corpus, so the dedup
 * acceptance test needs no LLM mock at all.
 */

/** Default similarity bar for "near-duplicate". A high-but-not-identical cut so
 *  cosmetic variants collapse while genuinely distinct pages stay apart. */
export const DEFAULT_JACCARD_THRESHOLD = 0.7

/** One page's dedup-relevant surface — its identity + the text Jaccard runs on. */
export interface DedupCandidate {
  /** Stable key (the entity slug) — unique within a kind. */
  readonly slug: string
  /** Text the similarity is computed over (title + compiled-truth). */
  readonly text: string
}

/**
 * Tokenise text into a lowercased set of word tokens (length >= 2, split on any
 * non-alphanumeric run). A SET, not a bag: Jaccard is set-based, so repeated
 * words don't skew the score. Wikilink brackets/punctuation fall out naturally,
 * leaving the bare slug/word tokens, so two pages asserting the same relation in
 * different prose still overlap on the entity tokens.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 2) out.add(tok)
  }
  return out
}

/**
 * Jaccard similarity |A∩B| / |A∪B| over two token sets. Two empty sets are
 * defined as similarity 0 (nothing to compare — never a "duplicate"), so a pair
 * of content-free pages is never collapsed.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  // Iterate the smaller set for the intersection count.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (large.has(t)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Group candidates into near-duplicate clusters by connected components over the
 * "similarity >= threshold" relation. Deterministic: input order is preserved
 * within clusters and clusters come out in first-appearance order. Singletons
 * (a page similar to nothing else) are INCLUDED as one-element clusters, so the
 * caller can treat "cluster.length > 1" as "has duplicates".
 *
 * O(n²) pairwise — the corpus is the owner's own entity set (hundreds→low
 * thousands), tokenised once up front, so the quadratic scan is fine for a batch
 * pass. A future scale lever (blocking by shared token) is a pure optimisation.
 */
export function clusterNearDuplicates(
  candidates: ReadonlyArray<DedupCandidate>,
  threshold: number = DEFAULT_JACCARD_THRESHOLD,
): DedupCandidate[][] {
  const n = candidates.length
  const tokens = candidates.map((c) => tokenize(c.text))
  // Union-find over indices.
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r] as number
    // Path-compress.
    let cur = x
    while (parent[cur] !== r) {
      const next = parent[cur] as number
      parent[cur] = r
      cur = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (jaccard(tokens[i]!, tokens[j]!) >= threshold) union(i, j)
    }
  }
  // Bucket by root, preserving first-appearance order of both roots and members.
  const order: number[] = []
  const buckets = new Map<number, DedupCandidate[]>()
  for (let i = 0; i < n; i += 1) {
    const r = find(i)
    let bucket = buckets.get(r)
    if (bucket === undefined) {
      bucket = []
      buckets.set(r, bucket)
      order.push(r)
    }
    bucket.push(candidates[i]!)
  }
  return order.map((r) => buckets.get(r) as DedupCandidate[])
}
