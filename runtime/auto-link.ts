/**
 * @neutronai/runtime — auto-link extractor.
 *
 * Sprint B — GBrain methodology integration v2 (2026-05-12).
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.3.
 *
 * Pure function. No I/O. Given a markdown body (the compiled-truth + timeline
 * for an entity page) and the source entity's slug, extracts typed links to
 * other entities and returns them as `Triple{subject, predicate, object,
 * source}` records.
 *
 * Per `gbrain_README.md` L573-577 the extractor MUST strip code fences before
 * scanning — entity-slug-shaped strings inside ``` fences (or `code spans`)
 * are part of an example, not a real reference, and must not yield triples.
 *
 * Predicate vocabulary (initial seven; extensible — adding a predicate is a
 * one-line addition to `PREDICATES` + the appropriate `VERB_PATTERNS` row):
 *
 *   - `founded`      — "<subject> founded <slug>" / "co-founded <slug>"
 *   - `invested_in`  — "<subject> invested in <slug>" /
 *                       "led the round in <slug>"
 *   - `advises`      — "<subject> advises <slug>" / "advisor to <slug>"
 *   - `works_at`     — "CEO of <slug>" / "works at <slug>" / "joined <slug>"
 *   - `attended`     — "attended <slug>" / page-role prior for `meeting`
 *                       pages: every [[person]] ref becomes `attended`
 *   - `met`          — "met with <slug>" / "had coffee with <slug>" /
 *                       "1:1 with <slug>"
 *   - `mentions`     — fallback: any other [[slug]] reference becomes a
 *                       `mentions` triple. Catch-all so the graph never
 *                       loses a back-link.
 *
 * Reference shapes the extractor recognises:
 *
 *   1. `[[entity-slug]]`                       — wikilink (preferred shape)
 *   2. `[[entity-slug|Display Text]]`          — wikilink with alias
 *   3. `[Display Text](entity-slug)`           — markdown link with bare slug
 *   4. `[Display Text](people/entity-slug.md)` — markdown link, prefixed slug
 *
 * Inside a code fence or inline code span the extractor MUST NOT yield any
 * triple — verified by the `code-fence false positive` regression suite in
 * `runtime/__tests__/auto-link.test.ts`.
 *
 * Within-page dedup: same (subject, predicate, object) collapses to one
 * triple, even if mentioned five times. The `source` is the source-page
 * slug (or `opts.source` override); per-mention provenance lives in the
 * page's timeline.
 */

export interface Triple {
  /** Source entity slug (the page being written). */
  subject: string
  /** One of the allow-listed predicates. */
  predicate: string
  /** Target entity slug. */
  object: string
  /** Source pointer — file path or external URI. */
  source: string
}

/**
 * Predicate allow-list. Extending this is a one-line change.
 *
 * Order encodes the inference cascade: if a single sentence matches both
 * `founded` and `works_at`, the earlier predicate wins. Mirrors gbrain's
 * `FOUNDED → INVESTED → ADVISES → WORKS_AT` cascade (`gbrain_README.md`
 * L577).
 */
export const PREDICATES = [
  'founded',
  'invested_in',
  'advises',
  'works_at',
  'attended',
  'met',
  'mentions',
] as const

export type Predicate = (typeof PREDICATES)[number]

/**
 * Page-role priors: when the source page is a `meeting`, every reference
 * becomes an `attended` triple even absent an explicit verb match. Mirrors
 * gbrain's "meeting page + person ref => attended" rule
 * (`gbrain_README.md` L520).
 */
const PAGE_ROLE_PRIORS: Readonly<Record<string, Predicate>> = Object.freeze({
  meeting: 'attended',
})

const SLUG_CHARS = '[a-z0-9][a-z0-9-]*'

interface VerbPattern {
  predicate: Predicate
  regex: RegExp
}

/**
 * Verb-based inference patterns. The regex runs against the
 * code-stripped, slug-normalised sentence containing the reference; it
 * MUST include a `(slug)` capture group naming the target slug.
 */
const VERB_PATTERNS: ReadonlyArray<VerbPattern> = Object.freeze([
  // founded / co-founded
  {
    predicate: 'founded',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])(?:co-?founded|founded)(?:\\s+the)?(?:\\s+company)?\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // invested $N in / invested in
  {
    predicate: 'invested_in',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])invested(?:\\s+\\$?[0-9][0-9.]*[kKmMbB]?)?\\s+in\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // led the round in / led the series A at
  {
    predicate: 'invested_in',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])led\\s+(?:the\\s+)?(?:round|raise|seed|series\\s+\\w)\\s+(?:in|at)\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // advises / advised
  {
    predicate: 'advises',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])advise[sd]?\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // advisor to / advisor at / advisor of
  {
    predicate: 'advises',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])(?:advisor|advisory\\s+board)\\s+(?:to|at|of|for)\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // CEO of / CTO of / Founder of / Head of …
  {
    predicate: 'works_at',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])(?:ceo|cto|coo|cfo|cmo|vp|svp|evp|founder|engineer|designer|director|manager|head|chief)\\s+(?:of|at)\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // works at / working at / works for / working for
  {
    predicate: 'works_at',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])(?:works|working)\\s+(?:at|for)\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // joined <slug> (bare) / joined <slug> as X / joined X at <slug>
  // (`joined acme`, `joined acme as a PM`, `joined as a PM at acme`).
  // Each is a `works_at` employment signal — covers the common phrasings
  // surfaced in Codex r1 P2 (2026-05-13).
  {
    predicate: 'works_at',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])joined\\s+(?:as\\s+[a-z][a-z\\s]*?\\s+(?:at|for)\\s+)?(${SLUG_CHARS})`,
      'i',
    ),
  },
  // attended / presented at / spoke at / hosted
  {
    predicate: 'attended',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])(?:attended|presented\\s+at|spoke\\s+at|hosted)\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
  // met with / had coffee with / 1:1 with / caught up with
  {
    predicate: 'met',
    regex: new RegExp(
      `(?:^|[^a-z0-9-])(?:met(?:\\s+with)?|had\\s+(?:coffee|lunch|breakfast|dinner|drinks|a\\s+meeting|a\\s+call)\\s+with|1[:]1\\s+with|caught\\s+up\\s+with)\\s+(${SLUG_CHARS})`,
      'i',
    ),
  },
])

export interface ExtractOptions {
  /**
   * The source page's kind. When `meeting`, every reference whose
   * sentence doesn't match a verb pattern becomes `attended` (page-role
   * prior). For other kinds the prior is `mentions`.
   */
  sourceKind?: string
  /**
   * Source pointer attached to every emitted triple. Defaults to the
   * source slug.
   */
  source?: string
}

/**
 * Extract typed links from a markdown body.
 *
 * @param body markdown body to scan (compiled-truth + timeline; caller
 *             concatenates them with the `---` separator first)
 * @param sourceSlug page's own slug — emitted as the `subject` of every
 *                   triple
 * @param opts optional source kind (enables page-role priors) and source
 *             pointer override
 *
 * Returns a deduplicated, deterministically-ordered array of triples.
 */
export function extractTypedLinks(
  body: string,
  sourceSlug: string,
  opts: ExtractOptions = {},
): Triple[] {
  if (typeof body !== 'string') return []
  if (typeof sourceSlug !== 'string' || sourceSlug.length === 0) return []

  const stripped = stripCode(body)
  const refs = collectRefs(stripped)
  if (refs.length === 0) return []

  const sentences = splitSentencesWithOffsets(stripped)
  const rolePrior =
    opts.sourceKind !== undefined ? PAGE_ROLE_PRIORS[opts.sourceKind] : undefined
  const source = opts.source ?? sourceSlug

  // First pass: collect a candidate predicate per reference occurrence.
  // Then collapse to one triple per (subject, object), keeping the
  // strongest predicate (lowest index in the PREDICATES cascade). Mirrors
  // gbrain's "FOUNDED → INVESTED → ADVISES → WORKS_AT" rule.
  const bestByObject = new Map<string, Predicate>()
  for (const ref of refs) {
    if (ref.slug === sourceSlug) continue
    const sentence = findSentence(sentences, ref.offset)
    const sentenceText = stripped.slice(sentence.start, sentence.end)
    const predicate = inferPredicate(sentenceText, ref.slug, rolePrior)
    const current = bestByObject.get(ref.slug)
    if (current === undefined) {
      bestByObject.set(ref.slug, predicate)
      continue
    }
    const a = PREDICATES.indexOf(current)
    const b = PREDICATES.indexOf(predicate)
    if (b < a) bestByObject.set(ref.slug, predicate)
  }

  const triples: Triple[] = []
  for (const [object, predicate] of bestByObject) {
    triples.push({ subject: sourceSlug, predicate, object, source })
  }
  triples.sort((a, b) => {
    const pa = PREDICATES.indexOf(a.predicate as Predicate)
    const pb = PREDICATES.indexOf(b.predicate as Predicate)
    if (pa !== pb) return pa - pb
    return a.object < b.object ? -1 : a.object > b.object ? 1 : 0
  })
  return triples
}

/**
 * Strip fenced code blocks (``` … ```) and inline code spans (`…`).
 * Replaces stripped characters with spaces (newlines preserved) so all
 * character offsets in the result stay aligned with the input.
 */
function stripCode(body: string): string {
  let out = ''
  let i = 0
  while (i < body.length) {
    if (atLineStart(body, i)) {
      const fenceLen = peekFence(body, i)
      if (fenceLen !== null) {
        // Replace the opening fence line with spaces.
        const lineEnd = body.indexOf('\n', i)
        const stopAt = lineEnd === -1 ? body.length : lineEnd
        for (let j = i; j < stopAt; j += 1) out += ' '
        i = stopAt
        if (i < body.length) {
          out += '\n' // preserve the line break
          i += 1
        }
        // Body of the fence: replace everything with spaces (keep newlines)
        // until the matching closing fence line.
        while (i < body.length) {
          if (atLineStart(body, i) && peekFence(body, i) === fenceLen) {
            const cLineEnd = body.indexOf('\n', i)
            const cStop = cLineEnd === -1 ? body.length : cLineEnd
            for (let j = i; j < cStop; j += 1) out += ' '
            i = cStop
            if (i < body.length) {
              out += '\n'
              i += 1
            }
            break
          }
          out += body[i] === '\n' ? '\n' : ' '
          i += 1
        }
        continue
      }
    }
    if (body[i] === '`') {
      let n = 0
      while (body[i + n] === '`') n += 1
      const close = findMatchingBackticks(body, i + n, n)
      if (close !== -1) {
        const spanEnd = close + n
        for (let j = i; j < spanEnd; j += 1) {
          out += body[j] === '\n' ? '\n' : ' '
        }
        i = spanEnd
        continue
      }
      // Unmatched run of backticks — treat as literal (rare; happens in
      // freeform prose).
      for (let j = 0; j < n; j += 1) out += '`'
      i += n
      continue
    }
    out += body[i]
    i += 1
  }
  return out
}

function atLineStart(body: string, i: number): boolean {
  if (i === 0) return true
  return body[i - 1] === '\n'
}

function peekFence(body: string, i: number): number | null {
  let j = i
  while (body[j] === ' ' || body[j] === '\t') j += 1
  const ch = body[j]
  if (ch !== '`' && ch !== '~') return null
  let n = 0
  while (body[j + n] === ch) n += 1
  if (n < 3) return null
  return n
}

function findMatchingBackticks(body: string, from: number, n: number): number {
  let i = from
  while (i < body.length) {
    if (body[i] === '`') {
      let m = 0
      while (body[i + m] === '`') m += 1
      if (m === n) return i
      i += m
      continue
    }
    if (body[i] === '\n' && body[i + 1] === '\n') {
      // Inline code spans don't cross blank lines.
      return -1
    }
    i += 1
  }
  return -1
}

interface EntityRef {
  slug: string
  offset: number
}

function collectRefs(body: string): EntityRef[] {
  const refs: EntityRef[] = []
  const wikilink = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikilink.exec(body)) !== null) {
    const slug = normaliseSlug(m[1]!)
    if (slug !== null) refs.push({ slug, offset: m.index })
  }
  const mdlink = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  while ((m = mdlink.exec(body)) !== null) {
    const target = m[2]!
    if (/^[a-z]+:/i.test(target)) continue
    if (target.startsWith('#')) continue
    if (target.startsWith('/')) continue
    if (target.includes('..')) continue
    const slug = normaliseSlug(target)
    if (slug !== null) refs.push({ slug, offset: m.index })
  }
  return refs
}

function normaliseSlug(raw: string): string | null {
  let s = raw.trim()
  if (s.endsWith('.md')) s = s.slice(0, -3)
  const slashIdx = s.indexOf('/')
  if (slashIdx !== -1) {
    const tail = s.slice(slashIdx + 1)
    if (tail.includes('/')) return null
    s = tail
  }
  s = s.toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length === 0) return null
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) return null
  return s
}

interface SentenceSpan {
  start: number
  end: number
}

function splitSentencesWithOffsets(body: string): SentenceSpan[] {
  // Treat `.`, `!`, `?` as terminators only when followed by whitespace,
  // EOL, or end-of-string. That keeps `.md`, `.com`, decimal numbers,
  // and the URL-shaped trailers inside markdown links intact. Newlines
  // are always terminators.
  const spans: SentenceSpan[] = []
  let start = 0
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '\n') {
      if (i > start) spans.push({ start, end: i })
      start = i + 1
      continue
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = body[i + 1]
      const isTerminal =
        next === undefined ||
        next === ' ' ||
        next === '\t' ||
        next === '\n' ||
        next === '\r'
      if (isTerminal) {
        if (i > start) spans.push({ start, end: i })
        start = i + 1
      }
    }
  }
  if (start < body.length) spans.push({ start, end: body.length })
  return spans
}

function findSentence(spans: SentenceSpan[], offset: number): SentenceSpan {
  for (const s of spans) {
    if (offset >= s.start && offset < s.end) return s
  }
  return spans[spans.length - 1] ?? { start: 0, end: 0 }
}

function inferPredicate(
  sentenceText: string,
  refSlug: string,
  rolePrior: Predicate | undefined,
): Predicate {
  // Normalise the sentence: replace wikilink + markdown-link references
  // with their bare slugs so the verb regex (which expects `verb <slug>`)
  // can match what's actually on the page.
  const normalised = normaliseSentence(sentenceText)
  // Cascade order: earlier predicates win. For each pattern, scan ALL
  // matches (the same sentence can name several targets); only count a
  // match whose captured slug equals the reference we're classifying.
  for (const pat of VERB_PATTERNS) {
    const globalRegex = new RegExp(pat.regex.source, `${pat.regex.flags.includes('g') ? '' : 'g'}${pat.regex.flags}`)
    let m: RegExpExecArray | null
    while ((m = globalRegex.exec(normalised)) !== null) {
      if (m[1] === undefined) continue
      const target = normaliseSlug(m[1])
      if (target !== null && target === refSlug) return pat.predicate
      // Avoid infinite-loop on zero-width matches.
      if (m.index === globalRegex.lastIndex) globalRegex.lastIndex += 1
    }
  }
  if (rolePrior !== undefined) return rolePrior
  return 'mentions'
}

/**
 * Rewrites `[[slug]]`, `[[slug|alias]]`, `[alias](slug)` and
 * `[alias](people/slug.md)` references to bare `slug` form so verb
 * regexes can match them as positional tokens. Non-reference text is
 * preserved verbatim.
 */
function normaliseSentence(text: string): string {
  let out = text
  out = out.replace(/\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (_full, raw: string) => {
    const slug = normaliseSlug(raw)
    return slug ?? raw
  })
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, _display: string, target: string) => {
      if (/^[a-z]+:/i.test(target)) return full
      if (target.startsWith('#') || target.startsWith('/') || target.includes('..')) {
        return full
      }
      const slug = normaliseSlug(target)
      return slug ?? full
    },
  )
  return out
}
