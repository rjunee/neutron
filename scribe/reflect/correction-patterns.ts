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

/**
 * The `source` stamped on every occurrence timeline row a promoted correction-
 * pattern page carries. SINGLE SOURCE OF TRUTH — `composePatternPage` writes rows
 * with this source and the reflect pass filters an existing page's rows by it to
 * reconstruct a cluster's PERSISTED identity (see `priorPatternIdentities`).
 */
export const CORRECTION_PATTERN_TIMELINE_SOURCE = 'reflect:correction-pattern'

/** The token surface of one correction — its (wrong + right + why) text. */
function correctionText(c: CorrectionEntry): string {
  return `${c.wrong} ${c.right} ${c.why}`
}

/**
 * Deterministic oldest-first order for a correction set. Primary key `ts` ASC;
 * SECONDARY key `id` ASC so equal-timestamp members can NEVER let the seed (and
 * therefore the fallback slug) depend on DB-scan / input insertion order — JS's
 * stable sort would otherwise preserve arrival order for ts-ties (Argus r3 nit).
 */
function byTsThenId(a: CorrectionEntry, b: CorrectionEntry): number {
  if (a.ts < b.ts) return -1
  if (a.ts > b.ts) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The one-lined, truncated `<wrong> → <right>` body a promoted page records for an
 * occurrence — computed IDENTICALLY here and in `composePatternPage` so a cluster's
 * live occurrence key byte-matches the on-disk row it produced.
 *
 * TRIM AFTER TRUNCATE (Argus r2 blocker, 2026-07-22): `oneLine` trims the ends, but
 * the 500-char `truncate` cut can land right AFTER a space, stranding a trailing
 * space in the live body. Every disk path `.trim()`s a timeline-row body — the
 * writer's render (`entity-format.ts` render), `extractTimeline`, and
 * `mergeTimeline` all trim — so an UNtrimmed live body would never byte-match the
 * row reconstructed from disk, `resolveClusterSlug`'s occurrence overlap would
 * silently drop to 0, and the seed-eviction identity drift the persisted-identity
 * fix closes would reappear for any correction whose one-lined `<wrong> → <right>`
 * exceeds 500 chars. Trimming here keeps the live key symmetric with the persisted
 * row on BOTH sides.
 */
function occurrenceBody(c: CorrectionEntry): string {
  return truncate(oneLine(`${c.wrong} → ${c.right}`), TIMELINE_BODY_TRUNCATE).trim()
}

/**
 * A DURABLE, order-independent identity key for ONE correction occurrence:
 * `<ts>\x1f<occurrenceBody>`. A correction's timestamp + its wrong→right text never
 * change once logged, and both are recorded verbatim on the promoted page's
 * timeline row — so this key is reconstructable from an already-promoted page and
 * survives the correction aging out of the scan window (unlike any slug derived
 * from a single member's identity). `ts` alone would false-collide two DISTINCT
 * lessons that share a millisecond; pairing it with the body makes the key
 * effectively unique per occurrence.
 */
export function correctionOccurrenceKey(c: CorrectionEntry): string {
  return `${c.ts}\x1f${occurrenceBody(c)}`
}

/** The persisted identity of an already-promoted correction-pattern page: its slug
 *  + the set of occurrence keys (`correctionOccurrenceKey`) it currently records. */
export interface PriorPatternIdentity {
  slug: string
  occurrenceKeys: ReadonlySet<string>
}

/**
 * Resolve the slug for a cluster, PRESERVING a previously-established identity
 * across seed eviction. `stablePatternSlug` derives a slug from the current SEED's
 * `right` vocabulary; when the scan window ages the original seed out, the next
 * seed's `right` can differ enough to mint a DIFFERENT slug for the SAME recurring
 * lesson — a duplicate/orphan concept page (Argus r3 VETO).
 *
 * The fix: a cluster's identity is CANONICALISED the first time it is promoted (the
 * on-disk page IS the persistent identity store — no new I/O path, no unbounded
 * growth). On every later pass, before deriving a fresh slug, match the cluster
 * against the occurrences ALREADY recorded on the promoted pages: if the cluster
 * shares ≥1 occurrence with a promoted page, REUSE that page's slug. Because the
 * page accumulates every occurrence it ever saw and consecutive scan windows
 * overlap heavily, the shared-occurrence link chains identity forward even as the
 * membership fully turns over — independent of which member is the current seed.
 * Only a genuinely NEW cluster (no occurrence overlap with any promoted page) falls
 * back to `stablePatternSlug`.
 *
 * Deterministic tie-break: greatest overlap wins; equal overlap → lexicographically
 * smallest slug (so a cluster overlapping two legacy duplicates converges on one,
 * never oscillates).
 */
export function resolveClusterSlug(
  cluster: ReadonlyArray<CorrectionEntry>,
  priorIdentities: ReadonlyArray<PriorPatternIdentity>,
): string {
  const keys = new Set(cluster.map(correctionOccurrenceKey))
  let best: { slug: string; overlap: number } | null = null
  for (const prior of priorIdentities) {
    let overlap = 0
    for (const k of keys) if (prior.occurrenceKeys.has(k)) overlap += 1
    if (overlap === 0) continue
    if (
      best === null ||
      overlap > best.overlap ||
      (overlap === best.overlap && prior.slug < best.slug)
    ) {
      best = { slug: prior.slug, overlap }
    }
  }
  return best !== null ? best.slug : stablePatternSlug(cluster)
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
 * non-seed members age in/out of the window.
 *
 * This is the FALLBACK identity for a genuinely NEW cluster (never promoted before).
 * It is not window-invariant across SEED eviction — if the seed itself ages out of
 * the scan window, the next-oldest member becomes the seed and its `right` can
 * differ enough to mint a different slug. That residual is closed at the pass level
 * by `resolveClusterSlug`, which reuses an already-promoted page's persisted
 * identity whenever the cluster still shares an occurrence with it — so a recurring
 * lesson keeps ONE page even after every original member has aged out. See
 * `resolveClusterSlug`.
 */
export function stablePatternSlug(cluster: ReadonlyArray<CorrectionEntry>): string {
  // The seed is the OLDEST member — sort ASC (ts, then id) here so identity does not
  // depend on the caller's ordering, and a ts-tie is broken deterministically by id.
  const seed = [...cluster].sort(byTsThenId)[0]
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
  const sorted = [...entries].sort(byTsThenId)
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
export function composePatternPage(
  cluster: ReadonlyArray<CorrectionEntry>,
  slugOverride?: string,
  priorOccurrences?: ReadonlyArray<{ ts: string; body: string }>,
): {
  slug: string
  title: string
  compiledTruth: string
  timelineRows: Array<{ ts: string; source: string; body: string }>
} {
  // Sort ASC (ts, then id) so [last] is the newest (the durable-learning line uses
  // it) and a ts-tie is broken deterministically.
  const sorted = [...cluster].sort(byTsThenId)
  const newest = sorted[sorted.length - 1]!
  // Identity: the pass-resolved slug when supplied (preserves a promoted cluster's
  // persisted identity across seed eviction — `resolveClusterSlug`); else the
  // seed-`right`-vocabulary fallback for a genuinely new cluster (`stablePatternSlug`).
  const slug = slugOverride ?? stablePatternSlug(sorted)
  const learning = oneLine(newest.right)
  const title = `Correction pattern: ${truncate(learning, SLUG_TRUNCATE_TITLE)}`
  const why = oneLine(newest.why)

  // CUMULATIVE occurrence set. `writeEntity` renders `compiledTruth` as a FULL
  // REPLACEMENT, so composing the count + Occurrences list from the current scan
  // window ALONE would shrink an already-promoted page every time an older
  // occurrence ages out of the window (Argus r2). Union the current cluster with
  // the page's already-persisted occurrence rows (keyed `<ts>\x1f<body>`, byte-
  // identical to `correctionOccurrenceKey`) so the durable page never loses a
  // count it once recorded. The timeline itself is preserved separately by the
  // writer's append+dedupe — this restores the human-readable body to match.
  const occTsByKey = new Map<string, string>()
  for (const m of sorted) occTsByKey.set(correctionOccurrenceKey(m), m.ts)
  for (const o of priorOccurrences ?? []) {
    const key = `${o.ts}\x1f${o.body}`
    if (!occTsByKey.has(key)) occTsByKey.set(key, o.ts)
  }
  const occurrenceTimestamps = [...occTsByKey.values()].sort()

  const lines: string[] = [
    `# ${title}`,
    '',
    `Observed ${occurrenceTimestamps.length} times — a recurring correction promoted to durable memory.`,
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
  for (const ts of occurrenceTimestamps) lines.push(`- ${ts}`)
  const compiledTruth = lines.join('\n')

  const timelineRows = sorted.map((m) => ({
    ts: m.ts,
    source: CORRECTION_PATTERN_TIMELINE_SOURCE,
    // Byte-identical to `correctionOccurrenceKey`'s body half, so a later pass can
    // reconstruct this cluster's persisted occurrence keys from the on-disk rows.
    body: occurrenceBody(m),
  }))

  return { slug, title, compiledTruth, timelineRows }
}
