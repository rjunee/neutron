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
import {
  ENTITY_KINDS,
  EntityWriteError,
  KIND_TO_DIR,
  ensureTrailingNewline,
  extractCompiledTruth,
  extractTimeline,
  mergeTimeline,
  renderEntityPage,
  type EntityKind,
  type TimelineEntry,
} from './entity-format.ts'
import { SLUG_REGEX } from './entity-slug.ts'
import { fireAndForget, neutralizeAbandonedSettle } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('entity-writer')

// The page codec (render + parse + KIND_TO_DIR + extractCompiledTruth) lives
// in the `./entity-format.ts` leaf (refactor P8). Re-export the shared
// types/values so this module's existing callers keep their import surface.
export {
  ENTITY_KINDS,
  EntityWriteError,
  type EntityKind,
  type TimelineEntry,
}

// NOTE: the content-sync quarantine guard (the old `assertPersistable` /
// privacy-quarantine chain) was REMOVED with the Connect content-sync mesh
// (connect-spec §2.1, §1.4). Under the Slack-Connect model a shared project is
// single-hosted with one memory — there is no foreign content to quarantine, so
// no write into this boundary is refused on origin grounds. The `originInstance` /
// `receivingInstanceSlug` provenance fields are RETAINED on EntityWriteInput as
// author attribution (forward-compatible with connect-spec §4 multi-author);
// they no longer gate persistence.

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
   * New timeline entry (or entries) to merge. If a row with the same `(ts,
   * source, body)` already exists on disk, that row is a no-op. The writer keeps
   * timeline rows in reverse-chronological order (newest first). An ARRAY lets a
   * caller fold several rows in ONE atomic write (e.g. the reflect dedup merge
   * moving a loser's whole timeline onto the survivor without N separate writes).
   */
  timelineAppend: TimelineEntry | readonly TimelineEntry[]
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
  /**
   * OPTIMISTIC-CONCURRENCY precondition (RB3). When set, the write is committed
   * ONLY if the current on-disk body still matches the expectation — the check
   * runs INSIDE the per-(kind,slug) write lock, after the writer's own read and
   * before the render/rename, so it is ATOMIC with respect to every other
   * `writeEntity` on the same key. A mismatch returns `{ changed: false,
   * conflict: true }` WITHOUT writing (never clobbers the concurrent change).
   * Absent → today's unconditional behaviour.
   *
   * This is what lets a long-running batch (the reflect pass) full-replace a
   * page's compiled-truth safely: it snapshots the raw body, does its
   * (LLM / merge) work, then writes with `ifBodyEquals: <snapshot>` — a user
   * write that landed meanwhile flips the write to a no-op conflict.
   */
  precondition?: {
    /** Commit only if the current on-disk body EXACTLY equals this string;
     *  `null` asserts the page must NOT exist yet (guards a fresh-compose). */
    readonly ifBodyEquals: string | null
  }
}

export interface EntityWriteOutput {
  /** Absolute path written (or that would have been written). */
  path: string
  /** Typed links extracted from the rendered body. */
  newLinks: Triple[]
  /** `false` when the rendered body matches what's already on disk. */
  changed: boolean
  /**
   * RB3 — `true` when a `precondition` was supplied and the current on-disk body
   * did NOT match it, so the write was SKIPPED to avoid clobbering a concurrent
   * change. `changed` is false in this case. Absent/false otherwise.
   */
  conflict?: boolean
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
  // `settled` is a deliberately never-rejecting sequencing baton (both outcomes
  // mapped to undefined) and this only cleans up the lock map — there is no
  // rejection to surface here (the real write error is returned to the caller
  // via `next`). Silent neutralize, not fireAndForget.
  neutralizeAbandonedSettle(settled.then(() => {
    // Only clean up if no later writer has already chained past us.
    if (writeLocks.get(key) === settled) writeLocks.delete(key)
  }))
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

export interface DeleteEntityInput {
  ownerDataDir: string
  kind: EntityKind
  slug: string
  /**
   * Optimistic-concurrency guard: delete ONLY if the current on-disk body still
   * equals this exactly. Runs INSIDE the same per-(kind,slug) lock as
   * `writeEntity`, so no concurrent same-key write can interleave between the
   * check and the unlink — the delete is atomic vs writes (RB3). Absent →
   * unconditional delete.
   */
  precondition?: { ifBodyEquals: string }
}

export interface DeleteEntityOutput {
  path: string
  /** True when the page was removed (or was already absent). */
  deleted: boolean
  /** True when a `precondition` was supplied but the current body didn't match
   *  (nothing deleted). */
  conflict: boolean
}

/**
 * RB3 — atomically delete an entity page under the SAME per-(kind,slug) write
 * lock as `writeEntity`, with an optional body precondition. Because it shares
 * the lock map, a concurrent `writeEntity` on the same key CANNOT land between
 * the precondition read and the unlink — so a fresh write is never silently
 * deleted (the reflect dedup loser-deletion race). Path is symlink-contained
 * exactly like the write path. An already-absent file is `deleted: true` (the
 * desired end state); a precondition mismatch is `conflict: true, deleted: false`.
 */
export async function deleteEntity(input: DeleteEntityInput): Promise<DeleteEntityOutput> {
  if (!ENTITY_KINDS.includes(input.kind)) {
    throw new EntityWriteError('invalid_kind', `unknown kind: ${input.kind}`)
  }
  if (typeof input.slug !== 'string' || !SLUG_REGEX.test(input.slug)) {
    throw new EntityWriteError('invalid_slug', `slug must match [a-z0-9][a-z0-9-]*, got "${input.slug}"`)
  }
  return withWriteLock(`${input.kind}/${input.slug}`, () => deleteEntityLocked(input))
}

async function deleteEntityLocked(input: DeleteEntityInput): Promise<DeleteEntityOutput> {
  const entitiesRoot = resolve(input.ownerDataDir, 'entities')
  const targetDir = resolve(entitiesRoot, KIND_TO_DIR[input.kind])
  const targetPath = resolve(targetDir, `${input.slug}.md`)
  if (!isUnder(entitiesRoot, targetPath)) {
    throw new EntityWriteError('path_escape', `target path escapes entities root: ${targetPath}`)
  }
  // Reject a symlink on any segment we delete through — an ancestor swapped to a
  // symlink-to-outside can't redirect the unlink. Checked INSIDE the lock, so it
  // is TOCTOU-atomic vs same-key writes.
  await rejectSymlinkAt(entitiesRoot)
  await rejectSymlinkAt(targetDir)
  await rejectSymlinkAt(targetPath)

  let existing: string | undefined
  try {
    existing = await fs.readFile(targetPath, 'utf8')
  } catch (err) {
    if (isENOENT(err)) return { path: targetPath, deleted: true, conflict: false } // already gone
    throw new EntityWriteError('read_failed', `failed to read ${targetPath}: ${errMsg(err)}`)
  }
  if (input.precondition !== undefined && existing !== input.precondition.ifBodyEquals) {
    return { path: targetPath, deleted: false, conflict: true }
  }
  try {
    await fs.unlink(targetPath)
  } catch (err) {
    if (isENOENT(err)) return { path: targetPath, deleted: true, conflict: false }
    throw new EntityWriteError('write_failed', `failed to unlink ${targetPath}: ${errMsg(err)}`)
  }
  return { path: targetPath, deleted: true, conflict: false }
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

  // RB3 optimistic-concurrency precondition — checked HERE, inside the write lock,
  // against the body we just read, so it is atomic vs every other same-key write.
  // A mismatch aborts WITHOUT writing (never clobbers a concurrent change).
  if (input.precondition !== undefined) {
    const { ifBodyEquals } = input.precondition
    const matches = ifBodyEquals === null ? existing === undefined : existing === ifBodyEquals
    if (!matches) {
      return { path: targetPath, newLinks: [], changed: false, conflict: true }
    }
  }

  // Fold one OR many timeline rows in a single write (dedup on ts/source/body).
  const appends: readonly TimelineEntry[] = Array.isArray(body.timelineAppend)
    ? body.timelineAppend
    : [body.timelineAppend as TimelineEntry]
  let mergedTimeline = existing !== undefined ? extractTimeline(existing) : []
  for (const entry of appends) mergedTimeline = mergeTimeline(mergedTimeline, entry)
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
    fireAndForget('entity-writer.rm', fs.rm(tmpPath, { force: true }))
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
  log.error('sync_hook_failed', { path, error: msg })
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
  const appends = Array.isArray(input.body.timelineAppend)
    ? input.body.timelineAppend
    : [input.body.timelineAppend as TimelineEntry]
  for (const entry of appends) validateTimelineEntry(entry)
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
  // Exported for unit tests only. Not part of the public surface. The codec
  // pieces themselves live in (and are re-exported from) `./entity-format.ts`.
  renderEntityPage as _renderEntityPage,
  extractCompiledTruth as _extractCompiledTruth,
  diffTriples as _diffTriples,
}
