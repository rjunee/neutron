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
 * A membership-INDEPENDENT slug for a recurring correction cluster. Identity is
 * derived from the cluster SEED (its OLDEST member) alone — NOT from any statistic
 * over the cluster's current membership.
 *
 * History: `correction-pattern-<oldest-member-id>` drifted when the 200-scan window
 * slid past the seed (a new id → new slug → duplicate/orphan page); the follow-up
 * `<majority-`right`-vocabulary>` digest ALSO drifted, because "the tokens present
 * in a majority of the CURRENT members" is a function of which members happen to be
 * in the window — as membership shifts (a member ages out, another ages in) the
 * majority set changes even when the seed is unchanged (Argus r2 blocker, 2 reviewers:
 * `right` of `alpha beta`/`alpha gamma`/`beta gamma` → majority {alpha,beta,gamma};
 * swap one member for `gamma delta` → majority {alpha,gamma} → a DIFFERENT slug for
 * the SAME lesson). It also collided two distinct lessons that shared a majority
 * vocabulary onto one slug.
 *
 * The stable identity is the CORRECT BEHAVIOUR being taught — the seed's `right`
 * field. `clusterCorrections` seeds each cluster on its oldest member and later
 * occurrences JOIN that seed (they never reseed it), so the seed is the cluster's
 * anchor; and the owner repeats the same `right` near-verbatim every recurrence
 * (`wrong`/`why` phrasing drifts, `right` does not). Digesting the seed's sorted,
 * de-duplicated `right` vocabulary therefore yields a slug that does NOT move when
 * non-seed members age in/out of the window. (It is not absolutely window-invariant
 * — if the seed itself ages out, the next-oldest member becomes the seed; but its
 * `right` is near-identical by the same premise, so the slug is stable in practice
 * and strictly more so than either prior scheme.)
 */
export function stablePatternSlug(cluster: ReadonlyArray<CorrectionEntry>): string {
  // The seed is the OLDEST member — sort ASC here so identity does not depend on the
  // caller's ordering.
  const seed = [...cluster].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))[0]
  // Degenerate guards: seed's `right` vocabulary → seed's whole-correction
  // vocabulary → the cluster's whole-correction vocabulary — so the slug is always
  // deterministic and content-derived, never empty.
  let signature = seed ? [...new Set(tokenize(seed.right))].sort().join(' ') : ''
  if (signature.length === 0 && seed !== undefined) {
    signature = [...new Set(tokenize(correctionText(seed)))].sort().join(' ')
  }
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
 * joins an existing cluster rather than reseeding it, which keeps a cluster's
 * membership stable across passes. (The promoted page's SLUG is derived by
 * `stablePatternSlug` from the SEED's — oldest member's — `right` vocabulary, NOT
 * from any member's id nor a statistic over current membership — see that function;
 * stable seeding keeps the seed constant so the slug does not move as members age
 * in/out of the window.) Greedy: each entry
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
 *   - slug   `correction-pattern-<seed-`right`-vocabulary-digest>` (membership-
 *            independent — `stablePatternSlug`; does not move as non-seed members
 *            age in/out of the scan window)
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
  // Membership-independent identity — the seed's `right` vocabulary, NOT the
  // oldest member id (drifts when the window slides past it) nor a majority over
  // current membership (drifts as members age in/out). See `stablePatternSlug`.
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
