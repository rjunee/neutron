/**
 * @neutronai/scribe — reflect: Jaccard near-duplicate clustering (pure leaf).
 *
 * RB3 consolidation, job 2 (dedup near-duplicate pages). Deterministic, no I/O,
 * no LLM: tokenise each page's (title + boilerplate-stripped compiled-truth),
 * compute pairwise Jaccard similarity over the token SETS, and group pages that
 * form a CLIQUE at the threshold (every pair in a cluster is pairwise-similar —
 * NOT connected components, so a chain `A~B~C` where `A~C` is below the bar does
 * NOT fuse). This is the CHEAP, always-safe half of the reflect pass — it runs
 * with no substrate and its output is fully determined by the corpus.
 *
 * DATA-INTEGRITY (memory-system-design-2026-07-20 blockers 1 & 3): a fact-less
 * page's body is generated boilerplate (`# <Name>` + `Mentioned in chat (kind:
 * X).`). Scoring the raw body fused UNRELATED entities (all boilerplate tokens
 * overlap, only the name differs). Three guards prevent that here:
 *   (1a) `stripBoilerplate` removes ONLY generated boilerplate before scoring —
 *        the generated title H1, generated section headings, and the fact-less
 *        `Mentioned in chat` line — NEVER a hand-authored factual heading.
 *   (1b) `tokenize` KEEPS numeric/alphanumeric tokens (`2024`, `q1`, `v2`) that
 *        `Intl.Segmenter` marks non-word-like — otherwise fiscal-year / versioned
 *        pages lose their only discriminator and collapse (ISSUES #373).
 *   (1c) clustering requires a CLIQUE (no transitive closure) and a page must
 *        carry `MIN_DISTINGUISHING_TOKENS` non-boilerplate tokens to be a merge
 *        candidate at all.
 */

/**
 * Default similarity bar for "near-duplicate". A high-but-not-identical cut so
 * cosmetic variants collapse while genuinely distinct pages stay apart.
 *
 * UNVALIDATED as a TUNING constant — the exact 0.7 cut has NOT been measured
 * against a real corpus, and it SHOULD be re-measured (false-merge rate on Ryan's
 * actual `entities/`) and tuned. It is `deps.jaccardThreshold`-configurable so
 * measurement can move it without a code change. Consolidation is now ARMED by
 * default (6h reflect loop, M2-3/P0-4) — the two false-positive signatures the 0.7
 * cut alone would let through are NOT left to threshold-tuning; they are blocked
 * outright by the `isMergeSafeCluster` gate applied to every candidate cluster
 * before it is merged (both signatures HELD, never fused — see that function):
 *   (A) two DISTINCT fact-less entities sharing an identical ≥ 2-word NAME (two
 *       "John Smith" pages) — similar ONLY via the name; and
 *   (B) two DIFFERENT-named entities (`Bob`/`Carol`) that each assert the SAME set
 *       of ≥ 3 relation TARGETS (score 5/7 = 0.714 ≥ 0.7 because `stripBoilerplate`
 *       does NOT strip relation-VERB tokens and shared targets inflate overlap).
 * Tuning the threshold down would still be worthwhile (fewer clusters reach the
 * gate at all), but a mis-tuned threshold can no longer cause an IRREVERSIBLE false
 * fusion of either signature — the gate is the safety property, the threshold is an
 * efficiency knob.
 */
export const DEFAULT_JACCARD_THRESHOLD = 0.7

/**
 * Minimum count of non-boilerplate distinguishing tokens a page must carry to be
 * eligible as a MERGE candidate. A page below this is always its own singleton.
 *
 * N = 2 justification: a single-token distinguishing set is just a bare name or
 * one lone word — too little signal to safely assert two pages are the SAME
 * entity, and a false merge is irreversible. Genuine near-duplicates of a real
 * entity always share several factual tokens, so requiring ≥ 2 costs no real
 * merges while it removes every fact-less page (which strips to ~0 tokens) from
 * the candidate set. RESIDUAL, now GATED: two DISTINCT fact-less entities that
 * share an identical ≥ N-word NAME (e.g. two different "John Smith" pages with no
 * facts) still CLUSTER here (identical name tokens → similarity 1.0) — but the
 * cluster is HELD, never merged, by `isMergeSafeCluster` (§7.2 merge safety gate:
 * pages similar ONLY via a shared name, with no corroborating body content, are
 * not fused). Clustering flags the candidacy; the merge gate makes the fusion
 * decision.
 */
export const MIN_DISTINGUISHING_TOKENS = 2

/** One page's dedup-relevant surface — its identity + the text Jaccard runs on. */
export interface DedupCandidate {
  /** Stable key (the entity slug) — unique within a kind. */
  readonly slug: string
  /** Entity title/name. Its tokens are ALWAYS kept as discriminators, and it
   *  identifies the generated title H1 that `stripBoilerplate` removes. */
  readonly title: string
  /** Compiled-truth. Generated boilerplate is stripped before scoring. */
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
 * A SET, not a bag (Jaccard is set-based, so repeats don't skew the score).
 *
 * KEPT segments (blocker 3 / ISSUES #373): every word-like segment PLUS every
 * non-word-like segment that still carries a letter or digit — because
 * `Intl.Segmenter` marks bare numeric/alphanumeric tokens like `2024`, `q1`,
 * `v2` as `isWordLike=false`, and the old unconditional `continue` DROPPED them.
 * That made `Fiscal Year 2023 Budget` and `Fiscal Year 2024 Budget` tokenise
 * identically and collapse at any threshold ≤ 1. Pure punctuation/whitespace
 * (no letter/digit) still falls out. A single ASCII LETTER (`a`, English filler)
 * is dropped; single DIGITS (`5`) and single non-ASCII words (a CJK character)
 * are kept, since either can be a real discriminator/word.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const { segment, isWordLike } of WORD_SEGMENTER.segment(text.toLowerCase())) {
    // Keep word-like segments AND non-word-like segments carrying a letter/digit
    // (numeric/alphanumeric discriminators); drop pure punctuation/whitespace.
    if (isWordLike !== true && !HAS_ALNUM.test(segment)) continue
    // Drop ONLY a single ASCII letter (English filler like `a`). Keep single
    // digits and every non-ASCII word (a single CJK word is a whole word).
    if (segment.length < 2 && /^[a-z]$/.test(segment)) continue
    out.add(segment)
  }
  return out
}

/** True iff the segment carries at least one Unicode letter or digit. */
const HAS_ALNUM = /[\p{L}\p{N}]/u

/**
 * Strip GENERATED boilerplate from a compiled-truth body BEFORE similarity
 * scoring — and ONLY generated boilerplate. A fact-less page's body is
 * `# <Name>\n\nMentioned in chat (kind: X).`; leaving it in makes every fact-less
 * page ~identical and fuses unrelated entities (blocker 1a). What is stripped:
 *   (i)  the generated title H1 (`# <Name>`) whose label EQUALS the entity title;
 *   (ii) the generated section headings the writer emits (`## Relationships`,
 *        `## Merged`);
 *   (iii)the generated fact-less body line `Mentioned in chat (kind: X).`.
 *
 * What is NEVER stripped: a HAND-AUTHORED factual heading at ANY level (`# Acquired
 * by Globex`, `## Acquired by Globex`). The #415 over-reach stripped ALL H1s
 * (and `level===1` headings), which removed distinguishing FACTUAL tokens and
 * caused irreversible false merges (codex VETO). Here only an H1 whose text
 * equals the page title, and the two known generated section headings, are
 * removed — a factual heading survives because its label is not the title and
 * not in the generated-heading allow-list.
 */
export function stripBoilerplate(compiledTruth: string, title: string): string {
  const titleNorm = title.trim().toLowerCase()
  const kept: string[] = []
  for (const line of compiledTruth.split('\n')) {
    const t = line.trim()
    // (i) generated title H1 whose label EQUALS the entity title — drop. Any
    // other H1 (a hand-authored factual heading) is KEPT.
    const h1 = /^#\s+(.*\S)\s*$/.exec(t)
    if (h1 !== null && h1[1]!.trim().toLowerCase() === titleNorm) continue
    // (ii) known GENERATED section headings — drop. Never a hand-authored heading.
    if (/^##\s+(?:Relationships|Merged)\s*$/i.test(t)) continue
    // (iii) generated fact-less body line — drop.
    if (/^Mentioned in chat \(kind:\s*[^)]*\)\.?$/i.test(t)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/** The scoring token set for a candidate: its title tokens (always kept as
 *  discriminators) UNION the tokens of its boilerplate-stripped compiled-truth. */
function scoreTokens(c: DedupCandidate): Set<string> {
  const out = tokenize(c.title)
  for (const tok of tokenize(stripBoilerplate(c.text, c.title))) out.add(tok)
  return out
}

/** One shared word segmenter (locale-agnostic). Construction is non-trivial, so
 *  it is hoisted out of the hot `tokenize` loop. */
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

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
 * Group candidates into near-duplicate CLIQUES at `threshold`. Deterministic:
 * input order is preserved within clusters and clusters come out in
 * first-appearance order. Singletons (a page similar to nothing else, OR a page
 * with too few distinguishing tokens to merge) are INCLUDED as one-element
 * clusters, so the caller can treat "cluster.length > 1" as "has duplicates".
 *
 * CLIQUE, not connected components (blocker 1c-i): a page joins an existing
 * cluster ONLY if it is `>= threshold` similar to EVERY member already in it, so
 * every cluster is a clique — a chain `A~B~C` where `A~C` is below the bar does
 * NOT fuse `{A,B,C}`. This is greedy and order-dependent, and CAN miss a merge
 * (the safe direction — a missed merge is a later pass or a no-op, never an
 * irreversible false fusion). Over-merging is the only unsafe direction and this
 * never does it.
 *
 * MIN-TOKEN GATE (blocker 1c-ii): a page whose non-boilerplate distinguishing
 * token set is smaller than `minTokens` (`MIN_DISTINGUISHING_TOKENS`) is NEVER a
 * merge candidate — it is emitted as its own singleton and no other page ever
 * joins it. This is what removes fact-less boilerplate pages (which strip to ~0
 * tokens) from the candidate set entirely.
 *
 * O(n²) pairwise over the token sets — the corpus is the owner's own entity set
 * (hundreds→low thousands), tokenised once up front, so the quadratic scan is
 * fine for a batch pass. A future scale lever (blocking by shared token) is a
 * pure optimisation.
 */
export function clusterNearDuplicates(
  candidates: ReadonlyArray<DedupCandidate>,
  threshold: number = DEFAULT_JACCARD_THRESHOLD,
  minTokens: number = MIN_DISTINGUISHING_TOKENS,
): DedupCandidate[][] {
  const tokens = candidates.map(scoreTokens)
  // Clusters as index lists, in first-appearance order.
  const clusters: number[][] = []
  for (let i = 0; i < candidates.length; i += 1) {
    // MIN-TOKEN GATE: a page with too few distinguishing tokens is never a merge
    // candidate — straight to its own singleton, and (because its own set is
    // below the gate) no later page will ever be tested against it either.
    if (tokens[i]!.size < minTokens) {
      clusters.push([i])
      continue
    }
    let placed = false
    for (const cluster of clusters) {
      // Skip clusters seeded by a below-gate page (a tiny singleton).
      if (tokens[cluster[0]!]!.size < minTokens) continue
      // CLIQUE: i must be >= threshold to EVERY current member.
      let all = true
      for (const j of cluster) {
        if (jaccard(tokens[i]!, tokens[j]!) < threshold) {
          all = false
          break
        }
      }
      if (all) {
        cluster.push(i)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([i])
  }
  return clusters.map((cluster) => cluster.map((idx) => candidates[idx]!))
}

/**
 * §7.2 MERGE SAFETY GATE — the last check before a near-duplicate cluster is
 * actually FUSED. Jaccard clustering reaches the bar on similar TOKEN SETS, but
 * high token similarity is NOT proof two pages are the SAME entity. Consolidation
 * is armed by default (6h, M2-3/P0-4) and a merge is IRREVERSIBLE (the loser's
 * content is folded into the survivor and the loser page is deleted), so the two
 * false-positive signatures documented on `DEFAULT_JACCARD_THRESHOLD` must be
 * blocked BEFORE the fuse, not merely tuned against:
 *
 *   Gate A — SHARED NAME TOKEN. The cluster's members must share at least one
 *     common name token (intersection of each title's tokens is non-empty). Two
 *     DIFFERENT-named entities that merely assert the SAME relation TARGETS
 *     (`Bob` / `Carol` each `Works at [[org0]]/[[org1]]/[[org2]]`) reach 0.714 on
 *     the shared targets but share NO name token → HELD (residual B). Genuine
 *     near-duplicates of one entity always share a name token (`Acme` / `Acme
 *     Inc` share `acme`), so this costs no real merge.
 *
 *   Gate B — CORROBORATION BEYOND THE NAME. Excluding the name, the members must
 *     still be pairwise `>= threshold` similar on their BODY-ONLY token sets
 *     (`tokenize(stripBoilerplate(text, title))` — title tokens removed, generated
 *     boilerplate stripped). Two fact-less pages sharing an identical name (two
 *     "John Smith" pages) collapse to EMPTY body sets once the name is excluded →
 *     body similarity 0 < threshold → HELD (residual A). Real near-duplicates carry
 *     substantial shared factual body text beyond the name, so they clear the bar.
 *
 * HELD == NOT MERGED: the caller keeps every member as its own survivor. A held
 * cluster is a MISSED merge — the pass's own always-safe direction (a later pass
 * or a no-op, never an irreversible false fusion). Callers log every hold LOUDLY
 * so the owner can hand-merge a genuine duplicate the gate was conservative on.
 *
 * Pure (no I/O). Operates on the SAME `DedupCandidate` surface as clustering, so a
 * cluster returned by `clusterNearDuplicates` is checked as-is.
 */
export function isMergeSafeCluster(
  cluster: ReadonlyArray<DedupCandidate>,
  threshold: number = DEFAULT_JACCARD_THRESHOLD,
): { safe: true } | { safe: false; reason: string } {
  // A singleton (or empty) is never a fuse — trivially safe.
  if (cluster.length <= 1) return { safe: true }

  // Gate A — the members must share at least one common NAME token.
  let commonName: Set<string> | null = null
  for (const c of cluster) {
    const nameTokens = tokenize(c.title)
    if (commonName === null) {
      commonName = new Set(nameTokens)
    } else {
      for (const t of [...commonName]) if (!nameTokens.has(t)) commonName.delete(t)
    }
    if (commonName.size === 0) break
  }
  if (commonName === null || commonName.size === 0) {
    return {
      safe: false,
      reason: 'members share no common name token — similarity is relation/body-only (different-name signature, §7.2 residual B)',
    }
  }

  // Gate B — excluding the name, the members must still corroborate each other on
  // body content (pairwise body-only Jaccard >= threshold). `jaccard` defines two
  // empty sets as similarity 0, so two fact-less same-name pages fall out here.
  //
  // NAME EXCLUSION IS EXPLICIT (blocker): `stripBoilerplate` only removes the
  // GENERATED title H1 (`# <Name>`), not name tokens that appear in prose (`John
  // Smith is an engineer …`). Leaving those in lets two DISTINCT same-name entities
  // (`John Smith … at Google` vs `John Smith … at Facebook`) corroborate each other
  // on the shared NAME tokens and clear the bar → irreversible false merge. So we
  // subtract each candidate's own title tokens from its body set here; only genuine
  // shared FACTUAL body tokens can then satisfy the corroboration requirement.
  const bodyTokens = cluster.map((c) => {
    const body = tokenize(stripBoilerplate(c.text, c.title))
    for (const nameTok of tokenize(c.title)) body.delete(nameTok)
    return body
  })
  for (let i = 0; i < bodyTokens.length; i += 1) {
    for (let j = i + 1; j < bodyTokens.length; j += 1) {
      if (jaccard(bodyTokens[i]!, bodyTokens[j]!) < threshold) {
        return {
          safe: false,
          reason: 'members are near-duplicate only via a shared name — body content does not corroborate the same entity (same-name-different-entity signature, §7.2 residual A)',
        }
      }
    }
  }

  return { safe: true }
}
