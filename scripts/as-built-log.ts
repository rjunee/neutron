/**
 * The as-built changelog's STORAGE LAYOUT and its renderer.
 *
 * THE LAYOUT IS NOT NEW — THE WIRING IS. `docs/as-built/` and its README have existed
 * since 2026-07-28, and that README declares `docs/AS_BUILT.md` "closed for new
 * entries". The closed file then gained an entry on essentially every day since, right
 * through 2026-08-15, because the convention lived only in a README that no build's
 * prompt reads and no gate checks. On 2026-08-15T23:20Z three concurrent builds all
 * failed at publish on `docs/AS_BUILT.md` and on nothing else — a conflict a rule
 * written 18 days earlier already forbade. This module is the machine-readable half of
 * that rule: the layout expressed as code, a renderer, and (with
 * `scripts/ci/as-built-closed-log-guard.sh`) something that fails a PR instead of a
 * merge.
 *
 * THE LAYOUT. One entry, one file:
 *
 *     docs/as-built/<YYYY-MM-DD>-<slug>.md
 *
 * Two builds then never touch the same bytes, so git has nothing to reconcile and the
 * merge is clean by construction rather than by resolution. The sibling shared-scratch
 * file was fixed the same way — per-build plans at `.trident/plans/<branch>.md`
 * (`trident/inner-workflow.mjs:1709`).
 *
 * WHY NOT A UNION MERGE DRIVER. A `merge=union` on the shared log looks like it costs
 * nothing, and it is the option this layout deliberately rejects: union merges
 * LINE-WISE, so two entries sharing any common line (a blank line, a `**Tests.**`
 * lead-in, a closing sentence) are spliced into each other and the result is two
 * half-entries wearing one heading — with git reporting success.
 * `scripts/as-built-concurrent-realgit.test.ts` demonstrates that against real git
 * rather than asserting it.
 *
 * WHAT HAPPENS TO THE HISTORY. Nothing. `docs/AS_BUILT.md` keeps every byte it has and
 * is the tail of the rendered log; `docs/as-built/` is the head. Re-chunking 12k lines
 * of existing prose would add risk and remove no conflict — the conflict stops the
 * moment the file stops being written, which is what the guard enforces.
 */

/** The directory that holds one file per as-built entry. Repo-relative. */
export const AS_BUILT_ENTRY_DIR = 'docs/as-built'

/** The frozen pre-split log. Repo-relative. Read-only from here on. */
export const AS_BUILT_ARCHIVE = 'docs/AS_BUILT.md'

/**
 * The ONLY filename shape the renderer reads: `<YYYY-MM-DD>-<slug>.md`.
 *
 * Anchored and date-prefixed on purpose — it is also the exclusion rule. `README.md`
 * (the convention doc that makes the directory tracked) does not match, so no
 * companion file can ever leak into the log body as a phantom entry.
 */
export const ENTRY_FILE_RE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

/** A parsed entry file: its name, and the whole entry body it holds. */
export interface AsBuiltEntry {
  /** Basename inside `AS_BUILT_ENTRY_DIR`, e.g. `2026-08-15-the-log-stops-sharing-bytes.md`. */
  name: string
  /** The entry, verbatim. Must open with its own `## ` heading. */
  body: string
}

/** `docs/as-built/<date>-<slug>.md`'s basename, for a build about to write one. */
export function entryFileName(date: string, slug: string): string {
  const name = `${date}-${slug}.md`
  if (!ENTRY_FILE_RE.test(name)) {
    throw new Error(
      `as-built entry name is not <YYYY-MM-DD>-<slug>.md: ${name} (slug must be lowercase a-z0-9 separated by single hyphens)`,
    )
  }
  return name
}

/**
 * Newest-first order over entry basenames.
 *
 * Date DESCENDING (ISO dates are fixed-width, so a plain string compare is a date
 * compare), then slug ASCENDING within the same day. The same-day tiebreak is
 * arbitrary — the log's granularity is the day and nothing records intra-day order —
 * but it is DETERMINISTIC, which is the property that matters: the rendered log must
 * not depend on directory-read order, or two people rendering the same commit get
 * different documents.
 *
 * Names that are not entry files are dropped, not sorted.
 */
export function orderEntryFiles(names: readonly string[]): string[] {
  const parsed = names.flatMap((name) => {
    const m = ENTRY_FILE_RE.exec(name)
    return m ? [{ name, date: m[1] ?? '', slug: m[2] ?? '' }] : []
  })
  parsed.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)))
  return parsed.map((p) => p.name)
}

/**
 * The archive contributes only its ENTRIES — everything from its first `## ` heading
 * on. Its own title/preamble is replaced by the rendered log's, so the output has one
 * header rather than one per storage shape.
 */
export function archiveEntries(archive: string): string {
  const lines = archive.split('\n')
  const first = lines.findIndex((l) => l.startsWith('## '))
  return first === -1 ? '' : lines.slice(first).join('\n').trimEnd()
}

const RENDER_HEADER =
  '<!-- RENDERED by `bun scripts/render-as-built.ts` — do not commit this file. Entries live in docs/as-built/. -->\n\n# AS_BUILT\n\nRunning log of what shipped, newest first. One entry per merged change.'

/** An ATX heading — `#` through `######` followed by a space. */
const HEADING_RE = /^#{1,6} /

/**
 * The whole log, newest-first: `docs/as-built/` entries (ordered) then the archive's
 * entries.
 *
 * Every entry is emitted as ONE contiguous block, VERBATIM apart from edge whitespace,
 * joined by a blank line. The renderer deliberately never looks inside an entry and
 * never rewrites a byte of one — that is the whole safety property, and it is why the
 * corpus's mix of `#`-titled and `##`-titled entries is left exactly as their authors
 * wrote it rather than "normalised" by a transform that would have to understand code
 * fences to be safe.
 *
 * An entry whose first line is not a heading is malformed — that is the shape a
 * line-wise merge leaves behind — and it throws here rather than being silently glued
 * onto its predecessor's tail.
 */
export function renderLog(opts: { entries: readonly AsBuiltEntry[]; archive: string }): string {
  const blocks = opts.entries.map((e) => {
    const body = e.body.trim()
    if (!HEADING_RE.test(body)) {
      throw new Error(`as-built entry ${e.name} does not open with a markdown heading — it is not a whole entry`)
    }
    return body
  })
  const tail = archiveEntries(opts.archive)
  if (tail) blocks.push(tail)
  return `${[RENDER_HEADER, ...blocks].join('\n\n')}\n`
}
