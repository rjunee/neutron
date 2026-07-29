/**
 * @neutronai/gateway/comments — banded Levenshtein matcher (P7.2 S2).
 *
 * Per docs/plans/P7.2-inline-comments-sprint-brief.md § 4.3.
 *
 * The re-anchor walker calls `bestFuzzyWindow` to find the best place to
 * relocate a comment whose surrounding context drifted after a doc edit.
 * Two pure helpers, no I/O, no mutable global state — both are exercised
 * by the lev.test.ts unit suite and indirectly by the anchor-walker
 * integration suite.
 *
 * Why banded: the matcher only cares about distances up to `tolerance`
 * (default 25% of the needle length). A full O(n × m) DP is wasteful
 * when we can drop every cell outside the [-tolerance, +tolerance]
 * diagonal band. The classic "edit distance with a band" trick reduces
 * the inner DP to O(n × k) where k = 2 × tolerance + 1, and lets us
 * return early as soon as every reachable cell in the current row
 * exceeds the cap.
 *
 * The window scanner is a separate primitive — it slides candidate
 * windows of size `needle.length ± slack` across the haystack and asks
 * the banded matcher for each window's distance, keeping the best
 * candidate. The "± slack" lets the matcher pick up the case where text
 * was edited inside the anchored region (e.g. typo fixed inside the
 * highlighted excerpt), which the strict equal-length window would miss.
 */

/**
 * Banded Levenshtein distance between two strings, capped at `cap`.
 *
 * Returns either:
 *   - The exact edit distance when it is ≤ `cap`.
 *   - `cap + 1` when every reachable cell in the DP exceeds `cap`
 *     (a strict "above cap" sentinel — callers compare against `cap`).
 *
 * The 2-row DP is band-limited so we only ever fill O(min(n, m) × k)
 * cells, where k = 2 × cap + 1. The function is pure.
 */
export function bandedLevenshtein(a: string, b: string, cap: number): number {
  if (cap < 0) return Math.max(a.length, b.length)
  // Quick rejections that the banded DP would catch anyway, but cheaper here.
  const lenA = a.length
  const lenB = b.length
  if (lenA === 0) return lenB <= cap ? lenB : cap + 1
  if (lenB === 0) return lenA <= cap ? lenA : cap + 1
  // |lenA - lenB| > cap → cannot possibly satisfy the cap.
  const diff = Math.abs(lenA - lenB)
  if (diff > cap) return cap + 1
  // Force a ≤ b so the rolling row is the shorter of the two — saves
  // memory + cache.
  let s1 = a
  let s2 = b
  if (s1.length > s2.length) {
    const tmp = s1
    s1 = s2
    s2 = tmp
  }
  const m = s1.length
  const n = s2.length
  // Two rolling rows of size (m + 1).
  let prev = new Array<number>(m + 1)
  let curr = new Array<number>(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    curr[0] = i
    // Band window: j ∈ [max(1, i-cap), min(m, i+cap)]. Cells outside
    // are pinned at `cap + 1` (treated as "above cap" so they never
    // propagate as a winning min).
    const lo = Math.max(1, i - cap)
    const hi = Math.min(m, i + cap)
    if (lo > 1) curr[lo - 1] = cap + 1
    let rowMin = curr[0] ?? 0
    for (let j = lo; j <= hi; j++) {
      const sCost = (s1.charCodeAt(j - 1) === s2.charCodeAt(i - 1)) ? 0 : 1
      const left = curr[j - 1] ?? cap + 1
      const up = prev[j] ?? cap + 1
      const diag = prev[j - 1] ?? cap + 1
      let cell = diag + sCost
      if (left + 1 < cell) cell = left + 1
      if (up + 1 < cell) cell = up + 1
      if (cell > cap + 1) cell = cap + 1
      curr[j] = cell
      if (cell < rowMin) rowMin = cell
    }
    if (hi < m) curr[hi + 1] = cap + 1
    // Early-exit: if every cell in the band exceeds cap, no continuation
    // can recover. Bail with the sentinel.
    if (rowMin > cap) return cap + 1
    const tmp = prev
    prev = curr
    curr = tmp
  }
  const last = prev[m] ?? cap + 1
  return last > cap ? cap + 1 : last
}

export interface BestFuzzyWindowOptions {
  /**
   * Fraction of `needle.length` (0..1) used as the Levenshtein cap.
   * 0.25 (= 75% similarity threshold) is the brief default.
   */
  tolerance: number
  /**
   * Half-width of the size-variation slack around `needle.length`.
   * Defaults to 20% — the matcher will try windows from
   * (needle.length × 0.8) up to (needle.length × 1.2). The brief
   * specifies "anchored.length ± 20%" in § 4.3.
   */
  slack?: number
  /**
   * Optional stride for the sliding window. Default 1 (every offset).
   * Larger strides skip candidates — used by `relocateAnchor`'s step 4
   * (global widen, `gateway/comments/anchor-walker.ts`) to keep the
   * cost bounded on docs near the 256 KB step-4 ceiling. Step 3 (local
   * radius) still scans every offset because its radius is already
   * bounded at `max(2000, anchored.length × 4)`.
   *
   * Recall trade-off: a match whose start offset falls strictly
   * between two strided sample points is missed — the matcher returns
   * a higher-distance match (or `null`), and the anchor flips
   * `drifted` / `dead`. Per brief § 4.3, this is the conservative
   * fallback we accept ("better to mark drifted/dead than confidently
   * relocate to the wrong place"). The local radius covers shifts of
   * up to `anchored.length × 4`; step 4 is the last-chance pass for
   * anchors that moved further, where precision already degrades.
   */
  stride?: number
}

export interface BestFuzzyWindow {
  /** Offset of the best window inside the haystack. */
  window_start: number
  /** Length of the best window inside the haystack. */
  window_length: number
  /** Levenshtein distance between needle and the best window. */
  lev_distance: number
}

/**
 * Slide candidate windows of size `needle.length ± slack` across the
 * haystack and return the window with the smallest Levenshtein
 * distance from `needle`, IF that distance is within the tolerance
 * cap. Returns `null` when no candidate meets the cap.
 *
 * The matcher is intentionally exhaustive (O(haystack × slack × cap))
 * within the search radius the caller already narrowed in
 * `relocateAnchor`. The caller's radius is bounded at `max(2000,
 * anchored.length × 4)`, so this loop scales with the local
 * neighborhood, not the full doc body.
 */
export function bestFuzzyWindow(
  haystack: string,
  needle: string,
  opts: BestFuzzyWindowOptions,
): BestFuzzyWindow | null {
  const needleLen = needle.length
  if (needleLen === 0) return null
  const cap = Math.max(0, Math.floor(needleLen * opts.tolerance))
  const slack = Math.max(
    0,
    Math.floor(needleLen * (opts.slack ?? 0.2)),
  )
  const stride = Math.max(1, opts.stride ?? 1)
  const minLen = Math.max(1, needleLen - slack)
  const maxLen = Math.min(haystack.length, needleLen + slack)
  if (haystack.length === 0) return null

  let best: BestFuzzyWindow | null = null
  // Outer loop on length variations — cap the loop bound at maxLen
  // inclusive so a window the same size as the haystack is considered.
  for (let winLen = minLen; winLen <= maxLen; winLen++) {
    const lastStart = haystack.length - winLen
    if (lastStart < 0) continue
    for (let start = 0; start <= lastStart; start += stride) {
      const window = haystack.slice(start, start + winLen)
      const distance = bandedLevenshtein(needle, window, cap)
      if (distance > cap) continue
      if (best === null || distance < best.lev_distance) {
        best = {
          window_start: start,
          window_length: winLen,
          lev_distance: distance,
        }
        if (distance === 0) return best
      }
    }
  }
  return best
}

/**
 * Return every byte offset where `needle` appears in `haystack`. Used
 * by `relocateAnchor`'s step 2 (excerpt-exact-match) to disambiguate
 * single vs multi-match candidates.
 *
 * Empty needle / empty haystack → empty array (callers handle these
 * defensively elsewhere; returning `[]` keeps the function total).
 */
export function allIndicesOf(haystack: string, needle: string): number[] {
  if (needle.length === 0 || haystack.length === 0) return []
  const out: number[] = []
  let from = 0
  while (true) {
    const ix = haystack.indexOf(needle, from)
    if (ix === -1) break
    out.push(ix)
    from = ix + 1
  }
  return out
}

/**
 * From a non-empty list of candidate offsets, pick the one closest to
 * `target`. Tie-broken by the smaller offset (= earlier position) for
 * determinism. Throws on an empty input — callers guarantee non-empty.
 */
export function pickClosest(offsets: number[], target: number): number {
  if (offsets.length === 0) {
    throw new Error('pickClosest: offsets must be non-empty')
  }
  let bestIx = offsets[0] ?? 0
  let bestDelta = Math.abs(bestIx - target)
  for (let i = 1; i < offsets.length; i++) {
    const candidate = offsets[i] ?? 0
    const delta = Math.abs(candidate - target)
    if (delta < bestDelta || (delta === bestDelta && candidate < bestIx)) {
      bestIx = candidate
      bestDelta = delta
    }
  }
  return bestIx
}
