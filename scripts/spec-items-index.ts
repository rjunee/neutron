/**
 * Renders `docs/spec-items/README.md` — the rollup index over the spec-item queue.
 *
 * WHY THIS IS A SCRIPT AND NOT A HAND-MAINTAINED LIST. The work-tracking standard
 * (`docs/process/work-tracking.md` §6) is explicit: "Splitting a monolith into dozens
 * of files without a rendered index gives you all the cost and none of the benefit …
 * Either build the rollup in the same change, or make it a query against something
 * that already exists." A list typed by hand is a second queue that disagrees with the
 * first within a week, which is the exact failure §3.4 names. So the index is DERIVED,
 * and `scripts/__tests__/spec-items-index.test.ts` fails the build when the committed
 * file and this renderer disagree.
 *
 * Run `bun run scripts/spec-items-index.ts` to rewrite the index after adding,
 * retitling or reprioritising an item. Adding a file is enough; nothing else to edit.
 *
 * A SLUG IS IMMUTABLE ONCE MERGED (standard §5 step 1) — identity is the filename, so
 * renaming destroys one item and creates another while every external reference still
 * points at the old name. Retitle via `title:`; this renderer reads the title from the
 * frontmatter and never from the filename, which is what makes that possible.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The directory the queue lives in, relative to the repo root. */
export const SPEC_ITEMS_DIR = 'docs/spec-items'

/** The rendered rollup. Committed, and checked by the test. */
export const INDEX_FILENAME = 'README.md'

/** Closed set. A new group is a deliberate edit here, not a typo that silently
 *  creates a one-item category nobody reads. */
export const GROUPS = ['trident', 'deploy', 'work-board', 'email-core', 'app', 'platform', 'security'] as const
export type Group = (typeof GROUPS)[number]

/** P0 is reserved for work the harness-orchestrator cutover is blocked on. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type Priority = (typeof PRIORITIES)[number]

export const STATUSES = ['open', 'done', 'wont-do'] as const
export type Status = (typeof STATUSES)[number]

export interface SpecItem {
  /** The filename without `.md`. IMMUTABLE once merged — this is the item's identity. */
  slug: string
  title: string
  group: Group
  status: Status
  priority: Priority
  /** True when the harness-orchestrator cutover is blocked on this item. */
  cutover: boolean
  /** True when the item cannot be built as it stands — an open question is at the top
   *  of its body and must be answered first (standard §3.2). */
  needs_spec: boolean
}

/**
 * Minimal frontmatter reader: `key: value` lines between the opening and closing `---`.
 *
 * Deliberately NOT a YAML parser. The frontmatter here is a flat scalar map by
 * construction, and a real parser would accept shapes this renderer cannot render —
 * the narrow reader turns those into a loud failure at the point they are introduced,
 * which is the behaviour we want from a validator.
 */
export function parseFrontmatter(text: string, slug: string): Record<string, string> {
  const lines = text.split('\n')
  if (lines[0] !== '---') throw new Error(`${slug}: no frontmatter (first line must be '---')`)
  const close = lines.indexOf('---', 1)
  if (close === -1) throw new Error(`${slug}: unterminated frontmatter`)
  const out: Record<string, string> = {}
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '') continue
    const at = line.indexOf(':')
    if (at === -1) throw new Error(`${slug}: frontmatter line is not 'key: value': ${line}`)
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function must<T extends string>(slug: string, key: string, raw: string | undefined, allowed: readonly T[]): T {
  if (raw === undefined) throw new Error(`${slug}: missing required frontmatter '${key}'`)
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${slug}: '${key}' is '${raw}', must be one of ${allowed.join(', ')}`)
  }
  return raw as T
}

/** Slug rule, mirroring `docs/as-built/README.md`: `A-Za-z0-9._-` and no leading dot,
 *  because the name is written by a tool and read by a filesystem. */
const SLUG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function readSpecItem(dir: string, filename: string): SpecItem {
  const slug = filename.replace(/\.md$/, '')
  if (!SLUG_RE.test(slug)) throw new Error(`${slug}: slug must match ${SLUG_RE} (no leading dot)`)
  const text = readFileSync(join(dir, filename), 'utf8')
  const fm = parseFrontmatter(text, slug)
  checkDeclaredStructure(slug, fm, text)
  const title = fm.title
  if (title === undefined || title === '') throw new Error(`${slug}: missing required frontmatter 'title'`)
  if (title.length > 70) throw new Error(`${slug}: title is ${title.length} chars, max 70`)
  const cutover = must(slug, 'cutover', fm.cutover, ['true', 'false'] as const) === 'true'
  const needs_spec = fm.needs_spec === undefined ? false : must(slug, 'needs_spec', fm.needs_spec, ['true', 'false'] as const) === 'true'
  return {
    slug,
    title,
    group: must(slug, 'group', fm.group, GROUPS),
    status: must(slug, 'status', fm.status, STATUSES),
    priority: must(slug, 'priority', fm.priority, PRIORITIES),
    cutover,
    needs_spec,
  }
}

/**
 * Counts of a spec item's load-bearing structure: `## ` sections, `- [ ] ` acceptance
 * criteria, and top-level numbered contract items.
 *
 * WHY THIS EXISTS. An editing script that replaced "from this heading to end of file"
 * silently dropped a whole trailing section of a spec item, and nothing noticed until an
 * unrelated tool threw on the missing heading. Truncation is invisible to every other check
 * here: the frontmatter still parses, the index still renders, and the remaining prose still
 * reads correctly. An item that declares its own shape turns that class of edit into a
 * failure at the moment it happens, which is the only kind of guard worth having.
 */
export interface SpecItemStructure {
  sections: number
  criteria: number
  contract_items: number
}

/**
 * FENCE-AWARE ON PURPOSE. Raw line-prefix matching counts Markdown-shaped text inside a code
 * fence as real structure — `countStructure('```\n## fake\n```')` reported one section — so a
 * dropped section could be BALANCED BACK by an example in a fence and the declaration would
 * still pass. Spec items quote commands and file excerpts, so that is the likely shape of an
 * edit rather than a contrived one.
 *
 * Fence rules follow CommonMark closely enough for this purpose: an opener is three or more
 * backticks or tildes after at most three spaces of indent; it closes on a run of the SAME
 * character, at least as long, carrying no info string. A fence-shaped line inside a fence is
 * content.
 *
 * AN UNTERMINATED FENCE THROWS rather than silently swallowing the rest of the file — which is
 * the same miscount in the other direction, and the more dangerous one because it under-counts
 * without limit. `checkDeclaredStructure` only calls this for an item that declares a count, so
 * a document with an unterminated fence and no declaration is still unconstrained.
 */
export function countStructure(text: string): SpecItemStructure {
  const out: SpecItemStructure = { sections: 0, criteria: 0, contract_items: 0 }
  let fence: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^ {0,3}/, '')
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenceMatch !== null) {
      const run = fenceMatch[1]!
      const info = fenceMatch[2]!
      if (fence === null) {
        fence = run
      } else if (run[0] === fence[0] && run.length >= fence.length && info.trim() === '') {
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    if (line.startsWith('## ')) out.sections += 1
    else if (line.startsWith('- [ ] ')) out.criteria += 1
    else if (/^[0-9]+\. \*\*/.test(line)) out.contract_items += 1
  }
  if (fence !== null) {
    throw new Error('unterminated code fence: every structure count after it would be unreliable')
  }
  return out
}

/**
 * Verify an item whose frontmatter DECLARES its structure. Opt-in per item: an item with
 * none of the three keys is unconstrained, so this cannot make ordinary edits fail. An
 * item that declares a count and drifts from it fails loudly, naming both numbers.
 */
export function checkDeclaredStructure(slug: string, fm: Record<string, string>, text: string): void {
  const keys = ['sections', 'criteria', 'contract_items'] as const
  // Opt-in: count nothing for an item that declares nothing, so neither a miscount nor an
  // unterminated fence can fail an item that never asked to be checked.
  if (keys.every((k) => fm[k] === undefined)) return
  let actual: SpecItemStructure
  try {
    actual = countStructure(text)
  } catch (error) {
    throw new Error(`${slug}: ${(error as Error).message}`)
  }
  for (const key of keys) {
    const declared = fm[key]
    if (declared === undefined) continue
    const want = Number(declared)
    if (!Number.isInteger(want)) throw new Error(`${slug}: frontmatter '${key}' is '${declared}', must be an integer`)
    if (actual[key] !== want) {
      throw new Error(
        `${slug}: declares ${key}: ${want} but the body has ${actual[key]}. ` +
          `If the change is intended, update the frontmatter in the same commit.`,
      )
    }
  }
}

/** Every item in the queue, ordered by group (declaration order), then priority, then slug. */
export function readSpecItems(dir: string): SpecItem[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== INDEX_FILENAME).sort()
  const items = files.map((f) => readSpecItem(dir, f))
  return items.sort(
    (a, b) =>
      GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) ||
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) ||
      a.slug.localeCompare(b.slug),
  )
}

/** Markdown table-cell escaping. BACKSLASHES FIRST, then pipes — escaping the pipe
 *  alone is incomplete: a title containing a literal `\|` would become `\\|`, which
 *  renders as an escaped BACKSLASH followed by a live cell separator, so the text
 *  would break out of its own column. Order is the whole correctness argument here. */
export function escapeCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/** Pure: the same items always render the same bytes. That is what makes the test a
 *  drift check rather than a re-implementation of the renderer. */
export function renderIndex(items: SpecItem[]): string {
  // OPEN cutover items only. `cutover` records that an item GATES the cutover; it stays
  // true after the work lands, because it is provenance rather than state. The blocker
  // LIST is a different question — what is still in the way — and filtering on the flag
  // alone answered the first question while the heading asked the second. Invisible until
  // the first item was ever both `done` and `cutover`, which is exactly when it mattered:
  // the index went on naming two finished items as things the cutover is gated on.
  const cutover = items.filter((i) => i.cutover && i.status === 'open')
  const needsSpec = items.filter((i) => i.needs_spec)
  const out: string[] = []
  out.push('<!-- GENERATED FILE — do not edit by hand.')
  out.push('     Regenerate with: bun run scripts/spec-items-index.ts')
  out.push('     `scripts/__tests__/spec-items-index.test.ts` fails when this drifts. -->')
  out.push('')
  out.push('# Spec items — the queue')
  out.push('')
  out.push('One file per work item, per the Neutron work-tracking standard')
  out.push('(`docs/process/work-tracking.md` §5 step 1). This index is **generated** — add a')
  out.push('file and re-run the script; never edit the table by hand.')
  out.push('')
  out.push('A **slug is immutable once merged**: identity is the filename, so renaming')
  out.push('destroys one item and creates another while every external reference still points')
  out.push('at the old name. Retitle through the `title:` frontmatter instead.')
  out.push('')
  const blocks = cutover.length === 1 ? 'blocks' : 'block'
  const needs = needsSpec.length === 1 ? 'needs' : 'need'
  out.push(`**${items.length} items.** ${cutover.length} ${blocks} the harness-orchestrator cutover; ${needsSpec.length} still ${needs} a spec.`)
  out.push('')

  if (cutover.length > 0) {
    out.push('## Blocking the cutover')
    out.push('')
    out.push('These are the items the harness-orchestrator cutover is gated on.')
    out.push('')
    for (const i of cutover) out.push(`- [\`${i.slug}\`](${i.slug}.md) — ${escapeCell(i.title)}`)
    out.push('')
  }

  if (needsSpec.length > 0) {
    out.push('## Not buildable yet')
    out.push('')
    out.push('An open question sits at the top of each body and must be answered before a')
    out.push('branch is cut (standard §3.1, §3.2).')
    out.push('')
    for (const i of needsSpec) out.push(`- [\`${i.slug}\`](${i.slug}.md) — ${escapeCell(i.title)}`)
    out.push('')
  }

  out.push('## All items')
  out.push('')
  for (const group of GROUPS) {
    const inGroup = items.filter((i) => i.group === group)
    if (inGroup.length === 0) continue
    out.push(`### ${group}`)
    out.push('')
    out.push('| Item | Title | Priority | Cutover |')
    out.push('|---|---|---|---|')
    for (const i of inGroup) {
      const flags = [i.cutover ? 'yes' : '—', i.needs_spec ? ' · needs-spec' : ''].join('')
      out.push(`| [\`${i.slug}\`](${i.slug}.md) | ${escapeCell(i.title)} | ${i.priority} | ${flags} |`)
    }
    out.push('')
  }
  return out.join('\n')
}

export function buildIndex(dir: string): string {
  return renderIndex(readSpecItems(dir))
}

if (import.meta.main) {
  const dir = process.argv[2] ?? SPEC_ITEMS_DIR
  const rendered = buildIndex(dir)
  writeFileSync(join(dir, INDEX_FILENAME), rendered)
  console.log(`wrote ${join(dir, INDEX_FILENAME)}`)
}
