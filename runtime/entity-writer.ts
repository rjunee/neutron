/**
 * @neutronai/runtime — entity-writer.
 *
 * Sprint B — GBrain methodology integration v2 (2026-05-12).
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.3.
 *
 * Writes a single entity page under `<ownerDataDir>/entities/<kind>/<slug>.md`
 * using the compiled-truth + timeline shape from gbrain (see
 * `docs/research/garry-tan-gbrain-source-2026-05-09/gbrain_docs_guides_compiled-truth.md`):
 *
 *     ---
 *     <YAML frontmatter>
 *     ---
 *
 *     <compiled-truth — current best understanding; rewritten on update>
 *
 *     ---
 *
 *     ## Timeline
 *     - <ISO ts> | <source> | <body>
 *
 * Transactional. Writes to a `.tmp` sibling and `rename(2)`s into place
 * (atomic on POSIX). Mid-process-kill leaves the existing page unchanged;
 * the tmp file may be left behind on disk for the caller to GC but the
 * canonical path is never half-written.
 *
 * Idempotent. If the rendered body (frontmatter + compiled-truth +
 * timeline-with-the-new-entry-merged-in) byte-equals what's already on
 * disk, the write is skipped and `changed: false` is returned. Repeated
 * appends of the same `(ts, source, body)` timeline triple deduplicate.
 *
 * Safety:
 *   - destination must lie under `<ownerDataDir>/entities/` (no `..`
 *     escape); enforced via `path.resolve` comparison
 *   - destination path must not pre-exist as a symlink (lstat-based);
 *     symlinks are rejected with `EntityWriteError('symlink_rejected')`
 *     to prevent the instance from causing writes to escape Zone B
 *   - kind must be one of the allow-listed values
 *   - slug must match `[a-z0-9][a-z0-9-]*`
 *   - frontmatter must validate against the per-kind schema
 *
 * After every successful write the function calls `extractTypedLinks` on
 * the new page body and returns the triples it found. The caller MAY also
 * pass a `syncHook` via the optional `deps` parameter; when provided, the
 * writer invokes `syncHook.onEntityWrite(...)` after a successful change
 * (Sprint B.1 — wires entities/ emissions to MemoryStore + the GBrain
 * KG). When omitted, the writer behaves exactly as it did pre-Sprint-B.1:
 * no I/O outside the file write, no error surface change.
 */

import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'
import { extractTypedLinks, type Triple } from './auto-link.ts'
import { SLUG_REGEX } from './entity-slug.ts'

// NOTE: the content-sync quarantine guard (the old `assertPersistable` /
// privacy-quarantine chain) was REMOVED with the Connect content-sync mesh
// (connect-spec §2.1, §1.4). Under the Slack-Connect model a shared project is
// single-hosted with one memory — there is no foreign content to quarantine, so
// no write into this boundary is refused on origin grounds. The `originInstance` /
// `receivingInstanceSlug` provenance fields are RETAINED on EntityWriteInput as
// author attribution (forward-compatible with connect-spec §4 multi-author);
// they no longer gate persistence.

export type EntityKind =
  | 'person'
  | 'company'
  | 'project'
  | 'meeting'
  | 'concept'
  | 'original'

export const ENTITY_KINDS: ReadonlyArray<EntityKind> = Object.freeze([
  'person',
  'company',
  'project',
  'meeting',
  'concept',
  'original',
])

const KIND_TO_DIR: Readonly<Record<EntityKind, string>> = Object.freeze({
  person: 'people',
  company: 'companies',
  project: 'projects',
  meeting: 'meetings',
  concept: 'concepts',
  original: 'originals',
})

export interface TimelineEntry {
  /** ISO-8601 timestamp. Caller is responsible for time-zone conventions. */
  ts: string
  /** Source pointer: file path or external URI. Single-line, <512 chars. */
  source: string
  /** One-line body. Newlines flattened to spaces by the writer. */
  body: string
}

export interface EntityWriteBody {
  /** YAML-serialisable frontmatter map. Validated against per-kind schema. */
  frontmatter: Record<string, unknown>
  /**
   * Compiled-truth body — everything between the frontmatter fence and the
   * `---` timeline separator. Caller passes the rewritten state; the
   * writer never edits it. Trailing newline normalised by the writer.
   */
  compiledTruth: string
  /**
   * One new timeline entry to merge. If a row with the same `(ts, source,
   * body)` already exists on disk, the merge is a no-op. The writer keeps
   * timeline rows in reverse-chronological order (newest first).
   */
  timelineAppend: TimelineEntry
}

export interface EntityWriteInput {
  /** Absolute path to the instance's Zone-B data dir. */
  ownerDataDir: string
  /** One of the six allow-listed kinds. */
  kind: EntityKind
  /** Pre-normalised slug. The writer re-validates and rejects on mismatch. */
  slug: string
  body: EntityWriteBody
  /**
   * ATTRIBUTION: slug of the member/instance that authored this content. An
   * own-origin write sets this equal to `receivingInstanceSlug`. Retained as the
   * author attribution (connect-spec §1.5 → §4 multi-author); it no longer
   * gates persistence (the quarantine guard was removed with the content-sync
   * mesh, connect-spec §2.1).
   */
  originInstance: string
  /**
   * The slug of the instance whose Zone-B store this is (the box owner). The
   * caller resolves it from the deployment's own identity. Retained as
   * provenance alongside `originInstance`; no longer a persistence gate.
   */
  receivingInstanceSlug: string
  /**
   * VESTIGIAL — was the content-sync owner-approval whitelist. The quarantine
   * chain it fed was deleted (connect-spec §1.4, §2.1); nothing reads this now.
   * Kept on the input shape to avoid churning the ~13 `writeEntity` call sites
   * in this trident; a later cleanup removes it.
   */
  allowPersistOrigins?: ReadonlyArray<string>
}

export interface EntityWriteOutput {
  /** Absolute path written (or that would have been written). */
  path: string
  /** Typed links extracted from the rendered body. */
  newLinks: Triple[]
  /** `false` when the rendered body matches what's already on disk. */
  changed: boolean
}

/**
 * Side-effect hook fired after a successful entity-page write. Implementations
 * forward the new page + extracted triples to downstream stores (e.g. the
 * GBrain KG via Sprint B.1's `GBrainSyncHook`).
 *
 * Contract:
 *   - Invoked ONLY when the writer actually changed the on-disk page.
 *     Idempotent re-writes (`changed: false`) do not invoke the hook —
 *     this is the explicit § 9.4 acceptance gate ("0 add calls + 0 kg_add
 *     calls on a byte-identical re-write").
 *   - `body` is the rendered canonical page (frontmatter + compiled-truth +
 *     timeline) — exactly what's on disk after the rename.
 *   - `newLinks` is the de-duplicated, cascade-resolved triple set extracted
 *     from the new compiled-truth (timeline-only mentions are excluded —
 *     Codex r1 P1 fix).
 *   - `removedLinks` is the set of triples that existed in the PREVIOUS
 *     compiled-truth (the page already on disk before this write) but are
 *     absent from the NEW compiled-truth. Empty when the page is new.
 *     Downstream stores SHOULD invalidate / retract these edges so the
 *     graph mirrors the writer's "compiled-truth is the only source of
 *     truth" invariant rather than accumulating a superset of past
 *     assertions (Codex r2 P1, 2026-05-13).
 *   - Errors thrown by the hook MUST NOT crash the writer. The writer's
 *     transactional commit is already complete by the time the hook runs;
 *     a hook failure is logged and swallowed so the on-disk state and the
 *     downstream-store state may diverge but the canonical truth is intact.
 *
 * Known limitation — post-commit hook failures are not auto-recoverable.
 * Because the writer guarantees `changed: false` on byte-identical re-writes
 * (and therefore doesn't re-invoke the hook), a hook failure on a write
 * that already committed to disk LEAVES the downstream store in a drifted
 * state. Concrete consequences:
 *   1. A failed `MemoryStore.add` cannot be re-attempted by re-running the
 *      same `writeEntity` call (the writer short-circuits on no-op).
 *   2. A failed `kg_invalidate` for a removed triple is permanent — the
 *      diff is computed pre-commit and isn't reconstructible from the
 *      on-disk page once the new compiled-truth has overwritten the old.
 * Recovery from either case is a separate graph-repair / re-index pass,
 * out of scope for B.1. Listed in plan § 10 risk register as "post-commit
 * sync drift". Logs surface every failure stage + path + triple so
 * operators have the data they need to drive repair.
 */
export interface SyncHook {
  onEntityWrite(input: {
    path: string
    body: string
    newLinks: Triple[]
    removedLinks: Triple[]
  }): Promise<void>
}

export interface WriteEntityDeps {
  /** Optional sync hook. When absent, the writer behaves as pre-B.1. */
  syncHook?: SyncHook
  /**
   * Override the sink for hook failures. Defaults to `console.error`. Tests
   * pass a capturing sink to assert on the log line without polluting the
   * runner output.
   */
  logSyncFailure?: (err: unknown, path: string) => void
}

export class EntityWriteError extends Error {
  constructor(
    public readonly code:
      | 'invalid_kind'
      | 'invalid_slug'
      | 'invalid_frontmatter'
      | 'invalid_timeline_entry'
      | 'invalid_owner_data_dir'
      | 'path_escape'
      | 'symlink_rejected'
      | 'read_failed'
      | 'write_failed',
    message: string,
  ) {
    super(message)
    this.name = 'EntityWriteError'
  }
}

/**
 * RA1 — per-(kind,slug) write serialization. The read→merge→render→rename
 * pipeline below is atomic (tmp + rename, byte-equal short-circuit) but on
 * its own it is NOT isolated: two concurrent same-slug writers (chat scribe
 * + a Cores calendar/email scribe, or scribe + onboarding import) would each
 * read the same base page, each merge only their OWN timelineAppend, and the
 * second rename would silently drop the first's timeline row (classic lost
 * update). Same-key writes therefore chain on a per-`${kind}/${slug}`
 * promise — the exact `withLock` idiom from `persistence/db.ts` — so the
 * full critical section runs one-after-another per key while different keys
 * proceed concurrently. The stored chain is rebuilt with a swallowing
 * `.then` so one caller's failure does NOT propagate as a rejection into
 * queued callers, and the map entry is deleted once its chain drains so the
 * lock table doesn't grow with every slug ever written.
 */
const writeLocks = new Map<string, Promise<void>>()

function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  writeLocks.set(key, settled)
  void settled.then(() => {
    // Only clean up if no later writer has already chained past us.
    if (writeLocks.get(key) === settled) writeLocks.delete(key)
  })
  return next
}

/**
 * Write a single entity page transactionally.
 *
 * @param input the page to write (instance data dir + kind + slug + body)
 * @param deps optional dependency overrides — passes a `syncHook` to wire
 *             this write into MemoryStore + the GBrain KG (Sprint B.1).
 *             When omitted the writer's behaviour is unchanged from B.0.
 */
export async function writeEntity(
  input: EntityWriteInput,
  deps: WriteEntityDeps = {},
): Promise<EntityWriteOutput> {
  validateInput(input)
  // Serialize the whole read→merge→render→rename critical section per
  // (kind,slug) so concurrent same-slug writes can't lose updates (RA1).
  return withWriteLock(`${input.kind}/${input.slug}`, () =>
    writeEntityLocked(input, deps),
  )
}

async function writeEntityLocked(
  input: EntityWriteInput,
  deps: WriteEntityDeps,
): Promise<EntityWriteOutput> {
  const { ownerDataDir, kind, slug, body } = input

  const entitiesRoot = resolve(ownerDataDir, 'entities')
  const subdir = KIND_TO_DIR[kind]
  const targetDir = resolve(entitiesRoot, subdir)
  const targetPath = resolve(targetDir, `${slug}.md`)

  if (!isUnder(entitiesRoot, targetPath)) {
    throw new EntityWriteError(
      'path_escape',
      `target path escapes entities root: ${targetPath}`,
    )
  }

  // Reject symlinks on every path segment we will write through. If the
  // the instance slipped a symlink at `<ownerDataDir>/entities/people/alice.md`
  // pointing elsewhere, an open(O_TRUNC) would happily follow it; we
  // refuse instead.
  await rejectSymlinkAt(targetPath)
  await rejectSymlinkAt(targetDir)
  await rejectSymlinkAt(entitiesRoot)

  await fs.mkdir(targetDir, { recursive: true })

  let existing: string | undefined
  try {
    existing = await fs.readFile(targetPath, 'utf8')
  } catch (err) {
    if (!isENOENT(err)) {
      throw new EntityWriteError(
        'read_failed',
        `failed to read existing page ${targetPath}: ${errMsg(err)}`,
      )
    }
  }

  const existingTimeline = existing !== undefined ? extractTimeline(existing) : []
  const mergedTimeline = mergeTimeline(existingTimeline, body.timelineAppend)
  const rendered = renderEntityPage({
    frontmatter: body.frontmatter,
    compiledTruth: body.compiledTruth,
    timeline: mergedTimeline,
  })

  // Triples are extracted from the *compiled truth only* (not the full
  // rendered page) so older timeline entries that mention an entity the
  // current synthesis no longer asserts don't re-emit stale graph edges
  // on every rewrite. Codex r1 P1 (2026-05-13). Timeline mentions still
  // surface via the page-write log; the GRAPH layer reflects today's
  // compiled truth, not a 6-month-old timeline footnote.
  const linkSource = ensureTrailingNewline(body.compiledTruth.trimEnd())

  // Codex r2 P1 (2026-05-13). To keep the KG mirroring today's compiled
  // truth (not a superset of every past assertion), compute the triples
  // that USED to be in the compiled truth and are NOT in the new one.
  // Downstream stores invalidate these via the sync hook's `removedLinks`.
  const previousLinks: Triple[] =
    existing !== undefined
      ? extractTypedLinks(
          ensureTrailingNewline(
            extractCompiledTruth(existing).trimEnd(),
          ),
          slug,
          { sourceKind: kind, source: targetPath },
        )
      : []

  if (existing !== undefined && existing === rendered) {
    return {
      path: targetPath,
      newLinks: extractTypedLinks(linkSource, slug, {
        sourceKind: kind,
        source: targetPath,
      }),
      changed: false,
    }
  }

  // Transactional write: tmp + rename. The tmp filename embeds the pid
  // and a counter so concurrent writers don't collide.
  const tmpPath = `${targetPath}.${process.pid}.${tmpCounter()}.tmp`
  try {
    await fs.writeFile(tmpPath, rendered, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmpPath, targetPath)
  } catch (err) {
    // Best-effort cleanup; ignore errors. The canonical path is still
    // whatever was there before, since rename(2) is atomic.
    void fs.rm(tmpPath, { force: true }).catch(() => undefined)
    throw new EntityWriteError(
      'write_failed',
      `failed to write entity page ${targetPath}: ${errMsg(err)}`,
    )
  }

  const newLinks = extractTypedLinks(linkSource, slug, {
    sourceKind: kind,
    source: targetPath,
  })
  const removedLinks = diffTriples(previousLinks, newLinks)

  // Sprint B.1 — fire the sync hook AFTER the canonical write commits.
  // Hook failures must NOT mutate the on-disk truth that's already
  // committed; the worst case is downstream-store drift, which is
  // recoverable by re-running the write. We swallow + log to keep the
  // writer's error surface unchanged for callers that don't pass a hook.
  if (deps.syncHook !== undefined) {
    try {
      await deps.syncHook.onEntityWrite({
        path: targetPath,
        body: rendered,
        newLinks,
        removedLinks,
      })
    } catch (err) {
      const sink = deps.logSyncFailure ?? defaultLogSyncFailure
      sink(err, targetPath)
    }
  }

  return { path: targetPath, newLinks, changed: true }
}

/**
 * Set difference: triples present in `previous` but not in `next`, keyed
 * on the canonical `(subject, predicate, object)` tuple. `source` is
 * deliberately excluded from the key — a triple's identity in the graph
 * is its semantic edge, not the file that asserted it.
 */
function diffTriples(previous: Triple[], next: Triple[]): Triple[] {
  if (previous.length === 0) return []
  const key = (t: Triple) => `${t.subject}\x1f${t.predicate}\x1f${t.object}`
  const seen = new Set(next.map(key))
  return previous.filter((t) => !seen.has(key(t)))
}

function defaultLogSyncFailure(err: unknown, path: string): void {
  const msg = err instanceof Error ? err.message : String(err)
  // Single-line, structured; the gateway log scraper can grep this prefix.
  console.error(`[entity-writer] syncHook failed path=${path} err=${msg}`)
}

function validateInput(input: EntityWriteInput): void {
  if (
    typeof input.ownerDataDir !== 'string' ||
    input.ownerDataDir.length === 0
  ) {
    throw new EntityWriteError(
      'invalid_owner_data_dir',
      'ownerDataDir must be a non-empty string',
    )
  }
  if (!ENTITY_KINDS.includes(input.kind)) {
    throw new EntityWriteError('invalid_kind', `unknown kind: ${input.kind}`)
  }
  if (typeof input.slug !== 'string' || !SLUG_REGEX.test(input.slug)) {
    throw new EntityWriteError(
      'invalid_slug',
      `slug must match [a-z0-9][a-z0-9-]*, got "${input.slug}"`,
    )
  }
  validateFrontmatter(input.body.frontmatter, input.kind, input.slug)
  validateTimelineEntry(input.body.timelineAppend)
  if (typeof input.body.compiledTruth !== 'string') {
    throw new EntityWriteError(
      'invalid_frontmatter',
      'compiledTruth must be a string',
    )
  }
}

/**
 * Per-kind frontmatter schema. Every kind REQUIRES `slug` and `type`
 * (the two self-describing entity identifiers downstream readers of
 * `entities/<kind>/<slug>.md` rely on). Optional fields are kind-specific.
 * Extra fields are allowed (forward-compat); unknown keys never reject.
 * Codex r1 P2 (2026-05-13).
 */
function validateFrontmatter(
  fm: unknown,
  kind: EntityKind,
  slug: string,
): void {
  if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) {
    throw new EntityWriteError(
      'invalid_frontmatter',
      'frontmatter must be a plain object',
    )
  }
  const map = fm as Record<string, unknown>
  if (map['slug'] === undefined) {
    throw new EntityWriteError(
      'invalid_frontmatter',
      `frontmatter.slug is required (expected "${slug}")`,
    )
  }
  if (map['slug'] !== slug) {
    throw new EntityWriteError(
      'invalid_frontmatter',
      `frontmatter.slug "${String(map['slug'])}" does not match input.slug "${slug}"`,
    )
  }
  if (map['type'] === undefined) {
    throw new EntityWriteError(
      'invalid_frontmatter',
      `frontmatter.type is required (expected "${kind}")`,
    )
  }
  if (map['type'] !== kind) {
    throw new EntityWriteError(
      'invalid_frontmatter',
      `frontmatter.type "${String(map['type'])}" does not match input.kind "${kind}"`,
    )
  }
}

function validateTimelineEntry(e: TimelineEntry): void {
  if (typeof e !== 'object' || e === null) {
    throw new EntityWriteError(
      'invalid_timeline_entry',
      'timelineAppend must be an object',
    )
  }
  if (typeof e.ts !== 'string' || e.ts.length === 0) {
    throw new EntityWriteError(
      'invalid_timeline_entry',
      'timelineAppend.ts must be a non-empty string',
    )
  }
  if (typeof e.source !== 'string' || e.source.length === 0) {
    throw new EntityWriteError(
      'invalid_timeline_entry',
      'timelineAppend.source must be a non-empty string',
    )
  }
  if (typeof e.body !== 'string') {
    throw new EntityWriteError(
      'invalid_timeline_entry',
      'timelineAppend.body must be a string',
    )
  }
}

/**
 * Render the final on-disk body. The order is locked:
 *
 *   1. `---\n` frontmatter open
 *   2. sorted-key YAML frontmatter
 *   3. `---\n\n` frontmatter close + blank line
 *   4. compiled-truth (with trailing newline normalised)
 *   5. `\n---\n\n## Timeline\n\n` separator
 *   6. timeline rows newest-first
 *
 * Deterministic so the roundtrip test can byte-compare.
 */
function renderEntityPage(input: {
  frontmatter: Record<string, unknown>
  compiledTruth: string
  timeline: TimelineEntry[]
}): string {
  const fm = renderYamlFrontmatter(input.frontmatter)
  const compiled = ensureTrailingNewline(input.compiledTruth.trimEnd())
  const sortedTimeline = [...input.timeline].sort((a, b) =>
    a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
  )
  const timeline =
    sortedTimeline.length === 0
      ? ''
      : sortedTimeline
          .map((e) => {
            const flat = e.body.replace(/\n+/g, ' ').trim()
            return `- ${e.ts} | ${e.source} | ${flat}\n`
          })
          .join('')
  return `---\n${fm}---\n\n${compiled}\n---\n\n## Timeline\n\n${timeline}`
}

/**
 * Tiny deterministic YAML emitter — covers strings, numbers, booleans,
 * null, arrays-of-scalars, and one level of object nesting. Quotes
 * strings only when ambiguity requires it (contains `:`, `#`, leading
 * `-`, or YAML keywords). Sorts top-level keys lexicographically so
 * roundtrip writes are byte-stable.
 *
 * Not a full YAML implementation. Throws on unsupported shapes so the
 * caller catches schema drift early.
 */
function renderYamlFrontmatter(fm: Record<string, unknown>): string {
  const keys = Object.keys(fm).sort()
  let out = ''
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new EntityWriteError(
        'invalid_frontmatter',
        `frontmatter key "${k}" is not a simple identifier`,
      )
    }
    const v = fm[k]
    out += `${k}: ${renderYamlValue(v)}\n`
  }
  return out
}

function renderYamlValue(v: unknown): string {
  if (v === null) return '~'
  if (v === undefined) return '~'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new EntityWriteError(
        'invalid_frontmatter',
        `non-finite number in frontmatter: ${v}`,
      )
    }
    return String(v)
  }
  if (typeof v === 'string') return renderYamlString(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    const items = v.map((x) => {
      if (
        x === null ||
        typeof x === 'boolean' ||
        typeof x === 'number' ||
        typeof x === 'string'
      ) {
        return renderYamlValue(x)
      }
      throw new EntityWriteError(
        'invalid_frontmatter',
        `arrays in frontmatter must be scalar — got ${typeof x}`,
      )
    })
    return `[${items.join(', ')}]`
  }
  throw new EntityWriteError(
    'invalid_frontmatter',
    `unsupported frontmatter value type: ${typeof v}`,
  )
}

const YAML_KEYWORDS = new Set([
  'true',
  'false',
  'null',
  '~',
  'yes',
  'no',
  'on',
  'off',
])

function renderYamlString(s: string): string {
  if (s.length === 0) return '""'
  if (s.includes('\n') || s.includes('\r')) {
    throw new EntityWriteError(
      'invalid_frontmatter',
      'multi-line strings in frontmatter are not supported',
    )
  }
  const needsQuotes =
    /[:#\[\]{},&*!|>'"%@`]/.test(s) ||
    /^[-?]/.test(s) ||
    /^\s|\s$/.test(s) ||
    YAML_KEYWORDS.has(s.toLowerCase()) ||
    /^[+-]?[0-9]/.test(s)
  if (!needsQuotes) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Pull the compiled-truth block out of an on-disk page. The renderer
 * emits the canonical shape `---\n<frontmatter>---\n\n<compiled>\n---\n\n##
 * Timeline\n\n...`; this helper scans for the second `---\n` (closing the
 * frontmatter), then for the `\n---\n\n## Timeline` separator (opening
 * the timeline). Everything in between is the compiled truth.
 *
 * Liberal parsing — if the page is hand-edited and doesn't match the
 * canonical shape, the helper returns the entire body (so a downstream
 * call to `extractTypedLinks` may include timeline references; that's a
 * larger surface than ideal but it's preferable to silently dropping
 * the previous-link set used for the removed-links diff).
 *
 * Used by the sync-hook removedLinks computation (Codex r2 P1).
 */
function extractCompiledTruth(body: string): string {
  // Find the frontmatter close: first `---\n` at column 0 after position 0.
  // The page starts with `---\n`, so we look for the NEXT line-anchored `---\n`.
  if (!body.startsWith('---\n')) return body
  const fmEnd = body.indexOf('\n---\n', 4)
  if (fmEnd === -1) return body
  let afterFm = fmEnd + '\n---\n'.length
  // The renderer emits `---\n\n${compiled}` — skip the separator blank line
  // so the returned slice is the compiled truth alone, without leading
  // structural whitespace.
  if (body[afterFm] === '\n') afterFm += 1
  // Find the timeline separator. Canonical form is `\n---\n\n## Timeline`.
  // Be liberal with the whitespace between the `---` and the `## Timeline`.
  const timelineMatch = body.slice(afterFm).match(
    /\n---\n+##\s+Timeline\s*\n/i,
  )
  const end =
    timelineMatch !== null && timelineMatch.index !== undefined
      ? afterFm + timelineMatch.index
      : body.length
  return body.slice(afterFm, end)
}

/**
 * Pull existing timeline rows out of an on-disk page. Recognises the
 * `## Timeline` section header (case-insensitive) and parses lines of
 * the form `- <ts> | <source> | <body>`. Lines that don't match are
 * skipped — the writer is deliberately liberal in what it accepts since
 * existing pages may have been hand-edited.
 */
function extractTimeline(body: string): TimelineEntry[] {
  const lines = body.split('\n')
  let i = 0
  for (; i < lines.length; i += 1) {
    if (/^##\s+timeline\s*$/i.test(lines[i]!.trim())) {
      i += 1
      break
    }
  }
  if (i >= lines.length) return []
  const entries: TimelineEntry[] = []
  for (; i < lines.length; i += 1) {
    const raw = lines[i]!
    const m = raw.match(/^-\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/)
    if (m === null) continue
    entries.push({ ts: m[1]!.trim(), source: m[2]!.trim(), body: m[3]!.trim() })
  }
  return entries
}

/**
 * Merge a new entry into an existing timeline. Dedup on `(ts, source,
 * body)`; sort newest-first by `ts` (lexicographic ISO-8601 sort).
 */
function mergeTimeline(
  existing: TimelineEntry[],
  next: TimelineEntry,
): TimelineEntry[] {
  const flatNext: TimelineEntry = {
    ts: next.ts,
    source: next.source,
    body: next.body.replace(/\n+/g, ' ').trim(),
  }
  const key = (e: TimelineEntry) => `${e.ts}\x1f${e.source}\x1f${e.body}`
  const seen = new Set<string>()
  const merged: TimelineEntry[] = []
  for (const e of [flatNext, ...existing]) {
    const k = key(e)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(e)
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return merged
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`
}

function isUnder(root: string, child: string): boolean {
  const r = resolve(root)
  const c = resolve(child)
  if (c === r) return false // must be strictly under
  return c.startsWith(r + sep)
}

async function rejectSymlinkAt(path: string): Promise<void> {
  try {
    const st = await fs.lstat(path)
    if (st.isSymbolicLink()) {
      throw new EntityWriteError(
        'symlink_rejected',
        `path is a symlink: ${path}`,
      )
    }
  } catch (err) {
    if (err instanceof EntityWriteError) throw err
    if (isENOENT(err)) return
    throw new EntityWriteError(
      'read_failed',
      `failed to lstat ${path}: ${errMsg(err)}`,
    )
  }
}

let _tmpCounter = 0
function tmpCounter(): number {
  _tmpCounter = (_tmpCounter + 1) >>> 0
  return _tmpCounter
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  )
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export {
  // Exported for unit tests only. Not part of the public surface.
  renderEntityPage as _renderEntityPage,
  renderYamlFrontmatter as _renderYamlFrontmatter,
  extractTimeline as _extractTimeline,
  extractCompiledTruth as _extractCompiledTruth,
  mergeTimeline as _mergeTimeline,
  diffTriples as _diffTriples,
  // G3 (mirror-parity guardrail): expose the kind→dir map so a golden-
  // roundtrip test can pin it against the hand mirrors in
  // scribe/write-to-gbrain.ts and the inverse in gbrain-memory/GBrainSyncHook.ts.
  KIND_TO_DIR as _KIND_TO_DIR,
}
