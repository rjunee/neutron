/**
 * @neutronai/scribe — the VERBATIM GUARD for captured originals.
 *
 * WHY THIS EXISTS. the legacy harness's scribe captured Ryan's reflective passages
 * unparaphrased into `entities/originals/` — 949 pages, his largest entity
 * class, and the entire value is that the words are HIS. Neutron already has
 * the `original` entity kind but only ever wrote a one-line LLM-synthesised
 * fact (`scribe/reflect/reserved-kinds.ts:48,55`), so ongoing capture would
 * accrete summaries instead of the man's own sentences. This module is the
 * missing half: passages come back from the extractor, and NOTHING is stored
 * as "the owner's own words" unless it is PROVEN to be a copy of them.
 *
 * AN LLM TOLD "COPY EXACTLY" STILL PARAPHRASES. A paraphrase silently filed as
 * a verbatim original is strictly worse than storing nothing — it is a forged
 * quotation in the owner's own memory. So the guard is a proof, not a hope:
 *
 *   1. Normalise BOTH the source turn and the candidate passage over a
 *      deliberately NARROW set (below).
 *   2. Require the normalised passage to appear as a CONTIGUOUS SUBSTRING of
 *      the normalised source. A paraphrase, a reordering, or a passage stitched
 *      from two distant fragments has no contiguous match and is DROPPED.
 *   3. RECOVER the exact source byte range that produced the match and store
 *      THAT — never the model's copy. So the stored passage is byte-identical
 *      to the owner's message by CONSTRUCTION, not by the model's good manners.
 *
 * THE NORMALISATION SET (exhaustive — anything not listed is compared as-is):
 *   - whitespace runs (any Unicode whitespace, including newlines) → one space;
 *     leading/trailing whitespace trimmed
 *   - zero-width / invisible formatting characters → removed
 *   - curly quotes and primes → the straight ASCII `'` / `"`
 *   - Unicode dashes/minus (‐ ‑ ‒ – — ― − and the width variants) → ASCII `-`
 *   - the ellipsis character `…` → `...`
 *
 * DELIBERATELY **NOT** NORMALISED, because each would let a real paraphrase
 * through: case, punctuation presence/absence, stop words, stemming, word
 * order. Also NOT normalised: Unicode normal form (NFC/NFD). A form flip is not
 * a realistic model rewrite (the model is copying from the very bytes it was
 * handed), and a global NFC pass would shift character offsets and so break the
 * exact-source-range recovery that makes step 3 sound. Given the choice between
 * a theoretical false-negative (a passage dropped over an NFC flip) and a
 * theoretical false-positive (a stored passage that is not byte-exact), the
 * guard takes the false-negative every time: over-capture is worse than
 * under-capture, exactly as the rest of the scribe prompt insists.
 *
 * MINIMUM LENGTH — {@link MIN_VERBATIM_PASSAGE_CHARS} = 40 normalised chars
 * (~7-8 words). Justification, since "verbatim but trivial" is a real category:
 *   - A short fragment is the one case where a contiguous substring match is
 *     WEAK evidence. "I think that's right." occurs verbatim inside a message
 *     the model otherwise paraphrased, so a low floor converts the guard from a
 *     proof into a coincidence detector.
 *   - A sub-40-char first-person fragment cannot carry a durable reflective
 *     thought — it is the chit-chat the prompt already tells the extractor to
 *     skip. Keeping it would grow the originals corpus with noise, and the
 *     value of that corpus is its signal density.
 *   - It sits well under the scribe's existing 80-char whole-turn floor
 *     (`scribe/scribe-budget.ts:80` SCRIBE_MIN_CHARS), so it never becomes the
 *     binding constraint on which turns get looked at at all.
 * A dropped-for-length passage is REPORTED (`reason: 'too_short'`), not
 * swallowed, so the floor's cost is observable rather than invisible.
 *
 * OBSERVABILITY. Every rejection returns a {@link DroppedOriginal} carrying the
 * title, the machine reason, and a short excerpt. `scribe/index.ts` logs these
 * through its failure sink — a silent drop would leave "my originals stopped
 * growing" undiagnosable, which is the failure mode this whole module exists to
 * prevent.
 */

/** One verbatim passage captured from a turn. */
export interface ExtractedOriginal {
  /**
   * What the passage is ABOUT — used as the `original` entity page's name/slug.
   * This is the ONE field the model may compose; it is a label, not a quote.
   */
  title: string
  /**
   * The owner's words. After {@link verifyOriginals} this is ALWAYS an exact
   * byte-range slice of the source turn (the model's copy is discarded in
   * favour of the recovered source range).
   */
  passage: string
}

/** Why the guard refused a candidate passage. */
export type VerbatimDropReason =
  /** The passage is not a contiguous copy of the source (paraphrase, reorder,
   *  stitched fragments, or invented text). */
  | 'not_verbatim'
  /** Verbatim, but under {@link MIN_VERBATIM_PASSAGE_CHARS}. */
  | 'too_short'
  /** Missing/blank title, or a title that yields no usable entity slug. */
  | 'invalid_title'
  /** The recovered slice contains a line that would corrupt the entity-page
   *  format (a bare `---` fence line, or a `## Timeline` header). */
  | 'structural_marker'
  /** No source turn was supplied, so verbatimness is UNPROVABLE. Fail closed. */
  | 'unverifiable_no_source'
  /** An identical passage was already captured from this same turn. */
  | 'duplicate'

/** A rejected candidate, surfaced to the caller for logging. */
export interface DroppedOriginal {
  title: string
  reason: VerbatimDropReason
  /** First 80 chars of the rejected passage — enough to diagnose, short enough
   *  to log. */
  excerpt: string
}

/**
 * Minimum length (in NORMALISED characters) for a captured passage. See the
 * module header for the justification of this specific floor.
 */
export const MIN_VERBATIM_PASSAGE_CHARS = 40

/** Invisible formatting characters that are deleted outright. */
const ZERO_WIDTH = new Set(['​', '‌', '‍', '⁠', '﻿'])

/** Curly single quotes / primes → `'`. */
const SINGLE_QUOTES = new Set(['‘', '’', '‚', '‛', '′', '´'])

/** Curly double quotes / double primes → `"`. */
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟', '″'])

/** Every Unicode dash/minus variant → ASCII `-`. */
const DASHES = new Set([
  '‐',
  '‑',
  '‒',
  '–',
  '—',
  '―',
  '−',
  '﹘',
  '﹣',
  '－',
])

/** Per-character substitution. Returns the replacement (possibly multi-char) or
 *  the character itself. NEVER case-folds and NEVER drops punctuation. */
function substitute(ch: string): string {
  if (SINGLE_QUOTES.has(ch)) return "'"
  if (DOUBLE_QUOTES.has(ch)) return '"'
  if (DASHES.has(ch)) return '-'
  if (ch === '…') return '...'
  return ch
}

const WS = /\s/

/**
 * Normalise `s` AND return, for every character of the result, the index in `s`
 * that produced it. The map is what lets the guard recover the EXACT source
 * byte range behind a normalised match, so the stored passage is the owner's
 * bytes rather than the model's transcription of them.
 *
 * Whitespace runs collapse to one space; leading/trailing whitespace is
 * dropped (so the result is trimmed). A multi-character substitution (`…` →
 * `...`) maps all of its output characters back to the single source index,
 * which keeps the recovered range correct at both ends.
 */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  let pendingSpaceAt = -1
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!
    if (ZERO_WIDTH.has(ch)) continue
    if (WS.test(ch)) {
      // Only remember a separator once we have emitted something (left-trim);
      // a run that never gets flushed is the right-trim.
      if (norm.length > 0 && pendingSpaceAt === -1) pendingSpaceAt = i
      continue
    }
    if (pendingSpaceAt !== -1) {
      norm += ' '
      map.push(pendingSpaceAt)
      pendingSpaceAt = -1
    }
    const rep = substitute(ch)
    for (let k = 0; k < rep.length; k += 1) {
      norm += rep[k]!
      map.push(i)
    }
  }
  return { norm, map }
}

/** The normalised form of `s` (the comparison key). Shares one implementation
 *  with {@link normalizeWithMap} so the two can never drift. */
export function normalizeForVerbatim(s: string): string {
  return normalizeWithMap(s).norm
}

/** A line that would corrupt the entity-page codec if it landed in a page's
 *  compiled-truth: a bare `---` fence, or a `## Timeline` section header
 *  (`runtime/entity-format.ts:369` `extractCompiledTruth` /
 *  `runtime/entity-format.ts` `extractTimeline` both key on these). */
const STRUCTURAL_MARKER = /^[ \t]*(?:-{3,}[ \t]*|#{1,6}[ \t]+Timeline[ \t]*)$/im

export interface VerifyOriginalsResult {
  /** Passages PROVEN to be contiguous copies of the source, each rewritten to
   *  the exact source byte range it matched. */
  kept: ExtractedOriginal[]
  /** Every rejection, with its reason. */
  dropped: DroppedOriginal[]
}

function excerptOf(passage: string): string {
  const flat = passage.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}

/**
 * THE GUARD. Keep only those candidates that are contiguous copies of
 * `sourceText`; rewrite each keeper to the exact source slice; report every
 * rejection with a reason.
 *
 * Pass `sourceText === undefined`/empty and EVERY candidate is dropped as
 * `unverifiable_no_source` — the guard fails CLOSED, so there is no code path
 * anywhere that yields an unverified "original".
 */
export function verifyOriginals(
  candidates: ReadonlyArray<ExtractedOriginal>,
  sourceText: string | undefined,
): VerifyOriginalsResult {
  const kept: ExtractedOriginal[] = []
  const dropped: DroppedOriginal[] = []
  if (candidates.length === 0) return { kept, dropped }

  const drop = (title: string, passage: string, reason: VerbatimDropReason): void => {
    dropped.push({ title: title.trim(), reason, excerpt: excerptOf(passage) })
  }

  if (sourceText === undefined || sourceText.trim().length === 0) {
    for (const c of candidates) drop(c.title, c.passage, 'unverifiable_no_source')
    return { kept, dropped }
  }

  const src = normalizeWithMap(sourceText)
  const seen = new Set<string>()

  for (const c of candidates) {
    const title = typeof c.title === 'string' ? c.title.trim() : ''
    const passage = typeof c.passage === 'string' ? c.passage : ''
    if (title.length === 0) {
      drop(title, passage, 'invalid_title')
      continue
    }
    const norm = normalizeForVerbatim(passage)
    if (norm.length < MIN_VERBATIM_PASSAGE_CHARS) {
      drop(title, passage, 'too_short')
      continue
    }
    const idx = src.norm.indexOf(norm)
    if (idx === -1) {
      // Not a contiguous copy: paraphrased, reordered, stitched from distant
      // fragments, or invented. THIS is the case the whole module exists for.
      drop(title, passage, 'not_verbatim')
      continue
    }
    if (seen.has(norm)) {
      drop(title, passage, 'duplicate')
      continue
    }
    seen.add(norm)
    // Recover the EXACT source range that produced the match. From here on the
    // stored passage is the owner's bytes, not the model's copy.
    const start = src.map[idx]!
    const end = src.map[idx + norm.length - 1]! + 1
    const exact = sourceText.slice(start, end)
    if (STRUCTURAL_MARKER.test(exact)) {
      drop(title, exact, 'structural_marker')
      continue
    }
    kept.push({ title, passage: exact })
  }
  return { kept, dropped }
}
