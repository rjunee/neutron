/**
 * @neutronai/scribe — reflect: deterministic CORRECTION-PATTERN promotion (Q2
 * overturn 2, the CORE-MEMORY tier that rides the reflect pass).
 *
 * Spec of record: `docs/plans/executor-mode-reminders-2026-07-20.md` — "Ryan's Q2,
 * split by tier" (line ~131): "correction-pattern promotion → the reflect pass".
 * When the SAME correction recurs (the owner keeps re-teaching the agent the same
 * lesson), that repeated learning is DURABLE knowledge and belongs in core memory,
 * not just the append-only corrections log. This module clusters recurring
 * corrections (deterministic Jaccard, NO LLM) and shapes each ≥ N-occurrence
 * cluster into a kind-`concept` entity page — promoted through the pass's own
 * `writeEntity` + `syncHook`, so it reaches GBrain + `entities/INDEX.md` and is read
 * back into future sessions automatically.
 *
 * PURE + deterministic — no I/O, no LLM. The reflect pass injects a `readCorrections`
 * seam and drives clustering + composition here; the write happens in the pass.
 */

import { tokenize, jaccard } from './jaccard.ts'

/**
 * A structural subset of reflection's `Correction` — DELIBERATELY re-declared
 * (not imported from `@neutronai/reflection`) so scribe gains NO package edge onto
 * reflection. `Correction` is structurally assignable to this, so the wiring layer
 * hands the real reader straight in.
 */
export interface CorrectionEntry {
  id: string
  ts: string
  wrong: string
  right: string
  why: string
}

/** Default min occurrences before a recurring correction is promoted. */
export const DEFAULT_CORRECTION_PATTERN_MIN_OCCURRENCES = 3

/** Default Jaccard bar for two corrections to be "the same lesson". */
export const DEFAULT_CORRECTION_PATTERN_JACCARD = 0.5

/** Default cap on corrections scanned per pass (the reader's `limit`). */
export const DEFAULT_CORRECTION_SCAN_LIMIT = 200

/** SLUG_REGEX-safe by construction check reused by the caller. */
const SLUG_TRUNCATE_TITLE = 60
const TIMELINE_BODY_TRUNCATE = 500

/** The token surface of one correction — its (wrong + right + why) text. */
function correctionText(c: CorrectionEntry): string {
  return `${c.wrong} ${c.right} ${c.why}`
}

/** Collapse newlines/tabs to single spaces + trim. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}

/** Small deterministic FNV-1a-32 → base36 digest. Pure; SLUG_REGEX-safe. */
function stableDigest(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * A WINDOW-INVARIANT slug for a recurring correction cluster (Argus r2 minor:
 * the old `correction-pattern-<oldest-member-id>` drifted every time the 200-scan
 * window slid past the cluster's oldest member — a NEW slug → a DUPLICATE stale
 * page while the prior page orphaned). The stable identity of a recurring lesson
 * is the CORRECT BEHAVIOUR being taught — the `right` field, which the owner
 * repeats near-verbatim every time the same lesson recurs (`wrong`/`why` phrasing
 * drifts occurrence-to-occurrence; `right` does not). Take the `right` tokens
 * present in a MAJORITY of members, sort them, and digest. Occurrence-specific
 * phrasing and filler are excluded, so a pass that sees occurrences 1-3 and a
 * later pass that sees 2-4 of the SAME lesson land on the SAME slug — no
 * duplicate/orphan page as the window slides.
 */
export function stablePatternSlug(cluster: ReadonlyArray<CorrectionEntry>): string {
  const freq = new Map<string, number>()
  for (const m of cluster) {
    for (const tok of tokenize(m.right)) {
      freq.set(tok, (freq.get(tok) ?? 0) + 1)
    }
  }
  const majority = Math.ceil(cluster.length / 2)
  const core = [...freq.entries()]
    .filter(([, n]) => n >= majority)
    .map(([t]) => t)
    .sort()
  // Degenerate guard: a cluster whose members share NO majority `right` token
  // falls back to the sorted full `right` vocabulary, then (if even that is empty)
  // the whole-correction vocabulary — so the slug is always deterministic and
  // content-derived, never empty.
  let signature = core.join(' ')
  if (signature.length === 0) signature = [...freq.keys()].sort().join(' ')
  if (signature.length === 0) {
    const all = new Set<string>()
    for (const m of cluster) for (const tok of tokenize(correctionText(m))) all.add(tok)
    signature = [...all].sort().join(' ')
  }
  return `correction-pattern-${stableDigest(signature)}`
}

/**
 * Cluster corrections that express the SAME lesson. Sort by `ts` ASCENDING (oldest
 * first) so cluster SEEDS are stable as the log grows — a later-arriving correction
 * joins an existing cluster rather than reseeding it, which keeps the promoted
 * page's slug (derived from the seed's id) stable across passes. Greedy: each entry
 * joins the FIRST cluster whose SEED (oldest member) is `>= threshold` similar,
 * else it seeds a new cluster.
 */
export function clusterCorrections(
  entries: ReadonlyArray<CorrectionEntry>,
  threshold: number = DEFAULT_CORRECTION_PATTERN_JACCARD,
): CorrectionEntry[][] {
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const clusters: CorrectionEntry[][] = []
  const seedTokens: Array<ReturnType<typeof tokenize>> = []
  for (const entry of sorted) {
    const tok = tokenize(correctionText(entry))
    let placed = false
    for (let i = 0; i < clusters.length; i += 1) {
      if (jaccard(tok, seedTokens[i]!) >= threshold) {
        clusters[i]!.push(entry)
        placed = true
        break
      }
    }
    if (!placed) {
      clusters.push([entry])
      seedTokens.push(tok)
    }
  }
  return clusters
}

/**
 * Shape a cluster into a promotable concept page. Deterministic template:
 *   - slug   `correction-pattern-<majority-vocabulary-digest>` (WINDOW-INVARIANT —
 *            `stablePatternSlug`; survives occurrences ageing out of the scan window)
 *   - title  `Correction pattern: <right of NEWEST member, truncated 60>`
 *   - compiledTruth: occurrence count + the newest `right` as the durable learning
 *     line + the newest `why` + a bullet list of occurrence timestamps
 *   - timelineRows: one per member `{ ts, source:'reflect:correction-pattern',
 *     body: '<wrong> → <right>' }` (one-lined, truncated 500)
 * The cluster MUST be non-empty (the caller filters by min occurrences first).
 */
export function composePatternPage(cluster: ReadonlyArray<CorrectionEntry>): {
  slug: string
  title: string
  compiledTruth: string
  timelineRows: Array<{ ts: string; source: string; body: string }>
} {
  // Sort ASC so [last] is the newest (the durable-learning line uses it).
  const sorted = [...cluster].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const newest = sorted[sorted.length - 1]!
  // Window-invariant identity — NOT the oldest member id, which drifts as the
  // 200-scan window slides past it (Argus r2 minor). See `stablePatternSlug`.
  const slug = stablePatternSlug(sorted)
  const learning = oneLine(newest.right)
  const title = `Correction pattern: ${truncate(learning, SLUG_TRUNCATE_TITLE)}`
  const why = oneLine(newest.why)

  const lines: string[] = [
    `# ${title}`,
    '',
    `Observed ${sorted.length} times — a recurring correction promoted to durable memory.`,
    '',
    '## Learning',
    '',
    learning,
    '',
  ]
  if (why.length > 0) {
    lines.push('## Why', '', why, '')
  }
  lines.push('## Occurrences', '')
  for (const m of sorted) lines.push(`- ${m.ts}`)
  const compiledTruth = lines.join('\n')

  const timelineRows = sorted.map((m) => ({
    ts: m.ts,
    source: 'reflect:correction-pattern',
    body: truncate(oneLine(`${m.wrong} → ${m.right}`), TIMELINE_BODY_TRUNCATE),
  }))

  return { slug, title, compiledTruth, timelineRows }
}
