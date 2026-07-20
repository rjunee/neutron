/**
 * @neutronai/scribe — reflect: Jaccard near-duplicate clustering (pure leaf).
 *
 * RB3 consolidation, job 2 (dedup near-duplicate pages). Deterministic, no I/O,
 * no LLM: strip BOILERPLATE (see `stripBoilerplate`), tokenise each page's
 * (title + compiled-truth), compute pairwise Jaccard similarity over the token
 * SETS, and group pages into CLIQUES — a page joins a cluster only when it meets
 * the threshold against EVERY current member (NOT connected components; see
 * `clusterNearDuplicates`).
 *
 * This is the CHEAP, always-safe half of the reflect pass — it runs with no
 * substrate and its output is fully determined by the corpus, so the dedup
 * acceptance test needs no LLM mock at all.
 *
 * DATA-INTEGRITY (memory blocker 1, 2026-07-20): dedup is the irreversible pass
 * that fuses entity pages. A fact-less page's body is pure boilerplate
 * (`# <Name>\n\nMentioned in chat (kind: <kind>).` — write-to-gbrain
 * `composeNewCompiledTruth`), so six of its ~seven tokens are shared template
 * and any two fact-less pages scored ~0.71 Jaccard on boilerplate ALONE — the
 * reproduced defect where five unrelated companies (Acme/Globex/…) collapsed into
 * one entity in a single pass. Three guards close it: (a) `stripBoilerplate`
 * removes the template tokens before scoring; (b) a page with fewer than
 * `DEFAULT_MIN_DISTINGUISHING_TOKENS` non-boilerplate tokens can NEVER anchor a
 * merge; (c) clusters are cliques (pairwise-similar throughout), not transitive
 * chains. `DEFAULT_JACCARD_THRESHOLD` stays configurable and MUST be re-measured
 * against the owner's real corpus before consolidation is ever armed.
 */

/** Default similarity bar for "near-duplicate". A high-but-not-identical cut so
 *  cosmetic variants collapse while genuinely distinct pages stay apart.
 *
 *  UNVALIDATED against a real corpus — this constant was chosen a priori. Before
 *  consolidation arms (flips `NEUTRON_PERFECT_RECALL` on for real memory), the
 *  false-merge rate at this threshold MUST be measured on the owner's actual
 *  `entities/` set and re-tuned; the value is plumbed through `deps.jaccardThreshold`
 *  so a measured value can override it without a code change. */
export const DEFAULT_JACCARD_THRESHOLD = 0.7

/** A page whose non-boilerplate token set is smaller than this is NEVER a merge
 *  candidate (emitted as its own singleton). Rationale: after `stripBoilerplate`,
 *  a page reduced to a single distinguishing token carries at most its own name
 *  and NO comparable factual content — merging it is pure name-collision risk.
 *  Requiring >= 2 non-boilerplate tokens means a page must have its name PLUS at
 *  least one real content token before it can ever anchor a merge. This is the
 *  conservative (under-merge) direction, correct for an irreversible pass, and it
 *  is what kills the fact-less fusion class: those pages strip down to `{name}`. */
export const DEFAULT_MIN_DISTINGUISHING_TOKENS = 2

/** One page's dedup-relevant surface — its identity + the text Jaccard runs on. */
export interface DedupCandidate {
  /** Stable key (the entity slug) — unique within a kind. */
  readonly slug: string
  /** Text the similarity is computed over (title + compiled-truth). */
  readonly text: string
}

/**
 * Tokenise text into a lowercased SET of word tokens using Unicode-aware
 * segmentation (`Intl.Segmenter`, word granularity). This matters for scripts
 * WITHOUT spaces (Japanese, Chinese, …): a plain `[^a-z0-9]` split would drop
 * every non-ASCII character, so two identical CJK pages would tokenise to the
 * empty set and could never be detected as duplicates. Segmentation splits
 * `株式会社アクメは…` into real word tokens instead.
 *
 * A SET, not a bag (Jaccard is set-based, so repeats don't skew the score). Only
 * word-like segments are kept, punctuation/whitespace/brackets fall out, and a
 * length-1 ASCII token (`a`, English filler) is dropped — but a length-1
 * NON-ASCII token (a single CJK word) is kept, since it can be a whole word.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const { segment, isWordLike } of WORD_SEGMENTER.segment(text.toLowerCase())) {
    if (isWordLike !== true) continue
    // Drop only short PURELY-ASCII tokens (English filler like `a`); keep every
    // non-ASCII word, including single CJK characters.
    if (segment.length < 2 && /^[\x00-\x7f]*$/.test(segment)) continue
    out.add(segment)
  }
  return out
}

/** One shared word segmenter (locale-agnostic). Construction is non-trivial, so
 *  it is hoisted out of the hot `tokenize` loop. */
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

/**
 * Remove BOILERPLATE that carries no distinguishing signal before the text is
 * tokenised for similarity (memory blocker 1). Two constructs are stripped:
 *
 *  1. Markdown heading lines (`# <Name>`, `## Relationships`) — structural
 *     scaffolding identical across pages. The entity NAME is not lost: the
 *     dedup candidate prepends the page title separately, so the name still
 *     reaches the token set via the title.
 *  2. The fact-less page's generated body sentence `Mentioned in chat (kind:
 *     <kind>).` — emitted verbatim by write-to-gbrain `composeNewCompiledTruth`
 *     for any entity with no extracted fact. Left in, its `{mentioned, in, chat,
 *     kind, <kind>}` tokens are ~6 of a fact-less page's ~7 tokens, so two
 *     unrelated fact-less pages score ~0.71 Jaccard on this template alone.
 *
 * Only the EXACT generated template is matched, so a real prose sentence that
 * happens to contain the word "company" (a legitimate fact) is untouched — the
 * strip removes the machine boilerplate, never hand-authored content.
 */
export function stripBoilerplate(text: string): string {
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+.*$/gm, '')
    .replace(/Mentioned in chat \(kind:\s*[^)]*\)\.?/gi, '')
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
 * Group candidates into near-duplicate CLIQUES over the "similarity >= threshold"
 * relation. A page joins an existing cluster only when it meets the threshold
 * against EVERY member already in it, so every pair inside a returned cluster is
 * a true near-duplicate. This deliberately DROPS the old connected-component
 * transitivity (`A~B` + `B~C` ⇒ `{A,B,C}` even when `A` and `C` were dissimilar):
 * transitive closure over an irreversible merge lets a chain of pairwise-similar
 * pages fuse endpoints that share almost nothing (memory blocker 1, guard c).
 *
 * Before scoring, each candidate's text is passed through `stripBoilerplate` and
 * a page left with fewer than `minDistinguishingTokens` tokens is forced to a
 * singleton and never allowed to anchor OR join a merge (guards a + b) — this is
 * what stops fact-less pages (which strip down to just their name) from fusing.
 *
 * Deterministic: candidates are visited in input order, a page joins the FIRST
 * clique it is compatible with (in cluster-creation order), and singletons are
 * INCLUDED as one-element clusters, so the caller can treat "cluster.length > 1"
 * as "has duplicates".
 *
 * O(n²) pairwise — the corpus is the owner's own entity set (hundreds→low
 * thousands), tokenised once up front, so the quadratic scan is fine for a batch
 * pass. A future scale lever (blocking by shared token) is a pure optimisation.
 */
export function clusterNearDuplicates(
  candidates: ReadonlyArray<DedupCandidate>,
  threshold: number = DEFAULT_JACCARD_THRESHOLD,
  minDistinguishingTokens: number = DEFAULT_MIN_DISTINGUISHING_TOKENS,
): DedupCandidate[][] {
  const n = candidates.length
  const tokens = candidates.map((c) => tokenize(stripBoilerplate(c.text)))
  // A page with too few non-boilerplate tokens has no comparable factual content
  // (at most its own name) and can neither anchor nor join a merge — it is always
  // emitted as its own singleton.
  const mergeable = tokens.map((t) => t.size >= minDistinguishingTokens)

  // Greedy CLIQUE clustering: each candidate joins the first existing cluster
  // whose EVERY member it meets the threshold against; else it starts its own.
  // Clique-completeness holds by induction — a cluster is only ever grown by a
  // page similar to all its current members — so no two pages in one cluster are
  // ever below the bar. Order-stable given the (already deterministic) input.
  const clusters: number[][] = []
  for (let i = 0; i < n; i += 1) {
    if (!mergeable[i]) {
      clusters.push([i]) // thin page → forced singleton
      continue
    }
    let placed = false
    for (const cluster of clusters) {
      // A cluster anchored by a non-mergeable (thin) page can never accept members.
      if (!mergeable[cluster[0]!]) continue
      if (cluster.every((j) => jaccard(tokens[i]!, tokens[j]!) >= threshold)) {
        cluster.push(i)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([i])
  }
  return clusters.map((c) => c.map((i) => candidates[i]!))
}
