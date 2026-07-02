/**
 * @neutronai/work-board — Plan-card spec-doc persistence (M1 play-button +
 * on-disk spec).
 *
 * WHY this module exists (Ryan, 2026-07-02): a Plan card created from a
 * non-trivial ask used to persist ONLY its one-line `title`. The full
 * context/spec of the ask lived in session context and on disk only AFTER a
 * build started (`code_trident_runs.task`). So an `upcoming` card that never ran
 * had NO on-disk spec beyond the title — a ▶ (play) that survives a session
 * reset had nothing to build from. This module writes the FULL ask to a real,
 * user-visible markdown doc and records a pointer in the card's `design_doc_ref`
 * so the ▶ button (and the trident planning stage) can read it back verbatim.
 *
 * ── ONE canonical doc per card ──────────────────────────────────────────────
 * The doc is the SINGLE source of the card's spec. `▶ start` reads it as the
 * trident run's `task` (the build's spec input); there is no second competing
 * spec the user can't see. Trivial one-liner cards (e.g. "build a meditation
 * timer") skip the doc entirely — the title is enough — matching how the
 * seed cards behave today.
 *
 * ── Folder location (Ryan-locked 2026-07-02, with a verified path delta) ────
 * Ryan asked for the doc to live in the USER-VISIBLE project docs (the same
 * surface the Documents tab reads), NOT a hidden/build-internal folder. The
 * `DocStore` confines every served + tappable doc to `Projects/<id>/docs/`
 * (`gateway/http/doc-store.ts` resolves the docs root to
 * `<owner_home>/Projects/<id>/docs`; only the fixed `STATUS.md` basename is
 * surfaced from the project ROOT). A doc written to `Projects/<id>/plans/…`
 * (a SIBLING of `docs/`) would therefore NOT be served by the docs API nor show
 * in the Documents tab — breaking the spec's hard requirement that the doc is
 * "served by the existing docs store/API + shows in Documents + tappable". So
 * the plans folder is nested UNDER docs/: `Projects/<id>/docs/plans/<slug>.md`.
 * This honours the intent (user-visible project docs, a `plans/` folder,
 * tappable) exactly; the only delta from the literal path is the `docs/`
 * prefix, which is what makes it visible at all. See the PR's spec-delta note.
 *
 * ── design_doc_ref format ───────────────────────────────────────────────────
 * The card stores `neutron-docs:plans/<slug>.md` — the in-app docs deep-link
 * scheme already allow-listed by `validateDesignDocRef` (store.ts). The path
 * after the scheme is RELATIVE to the project docs root, so it feeds straight
 * into `DocStore.readDoc(project_slug, path)` and the Documents-tab open nav
 * (`onOpenDoc(projectId, path)`).
 *
 * The module is PURE: no I/O, no DB, no filesystem. The doc bytes are handed to
 * `DocStore.writeDoc` and the ref to `WorkBoardStore` by the composer-level
 * wiring; here we only decide *whether* to persist, *where*, and *what bytes*.
 */

/** The docs-root-relative folder every card spec-doc lives in. */
export const PLANS_DIR = 'plans'

/** The in-app docs deep-link scheme a `design_doc_ref` uses to point at a doc. */
export const NEUTRON_DOCS_SCHEME = 'neutron-docs:'

/**
 * Word count below which an ask is "trivial" even when a caller supplied a
 * `spec` — a single short sentence ("build a meditation timer") needs no doc.
 * Deliberately low: the goal is only to skip a doc for genuine one-liners while
 * capturing anything with real substance. Multi-line specs ALWAYS persist
 * regardless of word count (a newline is a strong signal of structure).
 */
export const MIN_SPEC_WORDS = 20

/**
 * Decide whether a card's ask warrants an on-disk spec doc. Deterministic +
 * documented so the behaviour is testable and never surprises the user.
 *
 * Rules (first match wins):
 *   1. No `spec` (absent / whitespace-only) → NO doc. The title is the whole
 *      ask; this is the web "Add item" composer path and trivial agent adds.
 *   2. `spec` spans multiple lines → doc. Any structure (bullets, headings,
 *      acceptance criteria, a paragraph + a list) is worth persisting.
 *   3. `spec` has ≥ {@link MIN_SPEC_WORDS} words → doc.
 *   4. Otherwise (a short single-line spec) → NO doc. Treated like a title.
 *
 * `title` is accepted for symmetry / future tuning but does not currently
 * force a doc on its own — a long title is still just a title (the ask-gate
 * already lets a detailed title dispatch without a doc).
 */
export function shouldPersistSpecDoc(
  spec: string | null | undefined,
  _title: string,
): boolean {
  const s = typeof spec === 'string' ? spec.trim() : ''
  if (s.length === 0) return false
  if (/\r?\n/.test(s)) return true
  return wordCount(s) >= MIN_SPEC_WORDS
}

function wordCount(s: string): number {
  const t = s.trim()
  if (t.length === 0) return 0
  return t.split(/\s+/).length
}

/**
 * Build a filesystem-safe, human-readable slug for a card's spec-doc filename.
 * `<title-slug>-<suffix>` where the suffix keeps two cards with the same title
 * from clobbering each other's doc. The suffix is caller-supplied (the card's
 * id tail at the wiring layer) so the mapping is stable + collision-free; when
 * omitted we fall back to a short time-based tag.
 *
 * Not exported for random use — the wiring layer passes the new card id's tail
 * as `suffix` so the doc path is deterministic given the card.
 */
export function specDocSlug(title: string, suffix: string): string {
  const base = slugifyTitle(title)
  const tail = sanitizeSuffix(suffix)
  const stem = base.length > 0 ? base : 'plan'
  return tail.length > 0 ? `${stem}-${tail}` : stem
}

/** Lowercase, hyphenate, strip to `[a-z0-9-]`, collapse + trim hyphens, cap. */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/g, '')
}

function sanitizeSuffix(suffix: string): string {
  return suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12)
}

/** The docs-root-relative path for a card spec-doc, given its slug. */
export function specDocRelPath(slug: string): string {
  return `${PLANS_DIR}/${slug}.md`
}

/**
 * Build the `design_doc_ref` value that points a card at a docs-root-relative
 * path — the in-app deep-link scheme `validateDesignDocRef` allow-lists.
 */
export function designDocRefForPath(relPath: string): string {
  return `${NEUTRON_DOCS_SCHEME}${relPath}`
}

/**
 * Inverse of {@link designDocRefForPath}: extract the docs-root-relative path a
 * `design_doc_ref` points at, or `null` when the ref is not an in-app docs link
 * this module can resolve (e.g. an external `https:` URL, or an absent ref).
 * Both accepted in-app forms map to a docs-relative path:
 *   - `neutron-docs:plans/foo.md`            → `plans/foo.md`
 *   - `/api/app/projects/<id>/docs/file?path=plans/foo.md` → `plans/foo.md`
 */
export function docPathFromDesignRef(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null
  const r = ref.trim()
  if (r.length === 0) return null
  if (r.startsWith(NEUTRON_DOCS_SCHEME)) {
    const p = r.slice(NEUTRON_DOCS_SCHEME.length).trim()
    return p.length > 0 ? stripLeadingSlashes(p) : null
  }
  // Absolute in-app docs API path carrying a `?path=` query — pull the path out.
  if (r.startsWith('/api/app/')) {
    const q = r.indexOf('?')
    if (q >= 0) {
      const params = new URLSearchParams(r.slice(q + 1))
      const p = params.get('path')
      if (p !== null && p.trim().length > 0) return stripLeadingSlashes(p.trim())
    }
    return null
  }
  return null
}

function stripLeadingSlashes(p: string): string {
  return p.replace(/^\/+/, '')
}

/**
 * A short display label for a card's doc link — the doc's basename without the
 * `.md` extension (e.g. `plans/meditation-timer-abc123.md` → `meditation-timer-abc123`).
 * Returns `null` for a ref this module can't resolve to a doc path.
 */
export function docLinkLabel(ref: string | null | undefined): string | null {
  const path = docPathFromDesignRef(ref)
  if (path === null) return null
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

export interface SpecDocInput {
  title: string
  spec: string
  /** ISO-8601 UTC creation stamp for the doc frontmatter. */
  created_at: string
}

/**
 * Render the markdown bytes for a card's spec doc. YAML frontmatter (hidden in
 * the Documents tab's rendered view via `stripFrontmatter`) records the card
 * title + creation time; the body is the FULL ask verbatim. The closing note
 * makes the doc's role explicit: it is the canonical spec the build reads and
 * the planning stage elaborates.
 */
export function buildSpecDocMarkdown(input: SpecDocInput): string {
  const title = input.title.trim()
  const spec = input.spec.trim()
  const front = [
    '---',
    'type: plan',
    `title: ${yamlScalar(title)}`,
    `created: ${input.created_at}`,
    '---',
  ].join('\n')
  const body = [
    `# ${title}`,
    '',
    spec,
    '',
    '---',
    '',
    '_Canonical plan for this Plan card. The build reads this doc as its spec; ' +
      'the planning stage elaborates it as work proceeds._',
    '',
  ].join('\n')
  return `${front}\n\n${body}`
}

/** Minimal YAML scalar quoting — wrap in double quotes + escape when the value
 *  contains a character that would break an unquoted scalar. */
function yamlScalar(v: string): string {
  if (v.length === 0) return '""'
  if (/[:#\-?*&!|>'"%@`{}[\],]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return v
}
