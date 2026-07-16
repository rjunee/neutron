/**
 * @neutronai/scribe — reflect: the consolidation batch pass (RB3 §substrate).
 *
 * The autonomous "reflect" pass (gbrain's cron-skill pattern; Hindsight
 * belief-consolidation). One batched pass over the owner's accumulated entity
 * corpus that does THREE things:
 *
 *   1. DEDUP near-duplicate pages — deterministic Jaccard over (title + body),
 *      merge each cluster into a survivor (union timelines, fold in the losers'
 *      compiled-truth so their graph edges carry over), delete the losers. No LLM.
 *   2. RE-SYNTHESIZE compiled-truth from timelines — belief consolidation: hand
 *      each surviving page's compiled-truth + timeline to the LLM to tidy the
 *      current best understanding, guarded so it can NEVER drop a graph edge
 *      (the re-synthesis is rejected unless every prior `[[wikilink]]` survives).
 *   3. EXTRACT the RESERVED kinds — meeting / project / original, which Scribe
 *      reserves in the kind space but never writes; a batched LLM extraction over
 *      the corpus digest writes them through the same entity-writer → GBrain path.
 *
 * TIERED-WRITE DISCIPLINE (the cost-control invariant): deterministic work runs
 * on every save (that is the existing Scribe/entity-writer path — untouched
 * here); the LLM is invoked ONLY inside this batch pass. This module adds ZERO
 * per-save cost: nothing here hangs off `writeEntity`'s hook. When no substrate
 * is supplied (LLM-less box) steps 2 and 3 are skipped and only the deterministic
 * dedup runs. Every LLM dispatch increments `report.llmCalls`, so the
 * cost-confinement acceptance is directly observable.
 *
 * SAFETY: the pass operates on the owner's on-disk entity pages via the
 * backend-neutral enumeration (`runtime/memory-index.ts`) and writes through the
 * injected `writeEntity` + `syncHook` — the exact seam Scribe uses. Tests inject
 * a fake substrate + a temp `ownerDataDir`, so the pass NEVER touches live memory
 * and NEVER incurs LLM cost under test.
 */

import { readdir, realpath, open as fsOpen } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import {
  ENTITY_KINDS,
  KIND_TO_DIR,
  type EntityKind,
  type TimelineEntry,
  extractCompiledTruth,
  extractTimeline,
  parseFrontmatter,
  mergeTimeline,
} from '@neutronai/runtime/entity-format.ts'
import { SLUG_REGEX } from '@neutronai/runtime/entity-slug.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import { drainToText } from '@neutronai/runtime/substrate-text.ts'
import { createLogger } from '@neutronai/logger'
import { slugify } from '../write-to-gbrain.ts'
import { deleteEntity as realDeleteEntity, type SyncHook } from '@neutronai/runtime/entity-writer.ts'

/**
 * Atomic entity-page delete surface (RB3). Shares the entity-writer's per-key
 * lock, so a concurrent same-key write cannot interleave between the precondition
 * check and the unlink. The real `runtime/entity-writer.ts:deleteEntity`
 * satisfies it; tests inject a recorder.
 */
export type ReflectDeleteEntity = (input: {
  ownerDataDir: string
  kind: EntityKind
  slug: string
  precondition?: { ifBodyEquals: string }
}) => Promise<{ deleted: boolean; conflict: boolean }>

/**
 * The entity-writer surface the reflect pass needs — a superset of scribe's
 * `WriteEntityFn` that also carries the RB3 optimistic-concurrency `precondition`
 * (atomic CAS inside the writer's per-key lock) + the `conflict` result and the
 * multi-row `timelineAppend`. The real `runtime/entity-writer.ts:writeEntity`
 * satisfies it; tests inject a matching recorder.
 */
export type ReflectWriteEntity = (
  input: {
    ownerDataDir: string
    kind: EntityKind
    slug: string
    body: {
      frontmatter: Record<string, unknown>
      compiledTruth: string
      timelineAppend: TimelineEntry | readonly TimelineEntry[]
    }
    originInstance: string
    receivingInstanceSlug: string
    precondition?: { ifBodyEquals: string | null }
  },
  deps?: { syncHook?: SyncHook },
) => Promise<{ path: string; changed: boolean; newLinks: unknown[]; conflict?: boolean }>
import {
  clusterNearDuplicates,
  DEFAULT_JACCARD_THRESHOLD,
  type DedupCandidate,
} from './jaccard.ts'
import { composeReservedPrompt, parseReservedExtraction } from './reserved-kinds.ts'

const log = createLogger('scribe')

/** Default cadence for the scheduled reflect loop — once per day. The batch is
 *  heavy (LLM per drifted page + one corpus extraction); a daily consolidation
 *  keeps memory tidy without churning tokens. */
export const DEFAULT_REFLECT_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Default watchdog per LLM dispatch inside the pass. */
export const DEFAULT_REFLECT_WATCHDOG_MS = 120_000

/** Default max pages re-synthesized per pass (hard cost cap on step 2). */
export const DEFAULT_MAX_RESYNTH_PAGES = 200

/** Default corpus-digest char budget fed to the reserved-kind extraction. */
export const DEFAULT_MAX_RESERVED_DIGEST_CHARS = 24_000

/** Only re-synthesize a page whose timeline has accreted at least this many rows
 *  — a page with a row or two has nothing to consolidate, so spending a token
 *  budget on it is waste. Deterministic gate (no per-page LLM probe). */
export const DEFAULT_RESYNTH_MIN_TIMELINE_ROWS = 3

export interface ReflectPassDeps {
  /** The instance's Zone-B data dir (the writer/enumerator append `/entities`). */
  ownerDataDir: string
  /** Own instance slug — the own-origin stamp for every `writeEntity` call. */
  ownSlug: string
  /** Entity-writer surface (defaults to the real `writeEntity` at the wiring layer). */
  writeEntity: ReflectWriteEntity
  /** Per-instance GBrain sync hook, fanned into every write. Optional (LLM-less/no-brain). */
  syncHook?: SyncHook
  /**
   * The batch LLM substrate. ABSENT → steps 2 (re-synthesis) and 3 (reserved-kind
   * extraction) are skipped and only deterministic dedup runs. This is the ONLY
   * LLM handle in the pass; nothing else dispatches.
   */
  substrate?: Substrate
  /** Model preference for the batch calls. Defaults to `[getBestModel()]`. */
  model_preference?: ReadonlyArray<string>
  /**
   * Best-effort backend page-delete for a merged-away loser (resolved from the
   * MemoryStore at the wiring layer). Absent → only the on-disk page is removed
   * and the brain mirror is left to its own reconciliation. Never throws into the pass.
   */
  deletePage?: (slug: string) => Promise<void>
  /** Similarity bar for dedup. Default `DEFAULT_JACCARD_THRESHOLD`. */
  jaccardThreshold?: number
  /** Hard cap on step-2 re-synthesis. Default `DEFAULT_MAX_RESYNTH_PAGES`. */
  maxResynthPages?: number
  /** Min timeline rows before a page is re-synthesized. Default `DEFAULT_RESYNTH_MIN_TIMELINE_ROWS`. */
  resynthMinTimelineRows?: number
  /** Corpus-digest char budget for step 3. Default `DEFAULT_MAX_RESERVED_DIGEST_CHARS`. */
  maxReservedDigestChars?: number
  /** Per-dispatch watchdog (ms). Default `DEFAULT_REFLECT_WATCHDOG_MS`. */
  watchdogMs?: number
  /**
   * Atomic dedup loser-deletion seam. Defaults to the real
   * `runtime/entity-writer.ts:deleteEntity`, which unlinks under the SAME per-key
   * lock as `writeEntity` with a body precondition — so a concurrent write to the
   * loser can't be silently deleted. Injected in tests to drive the conflict /
   * failure paths (a conflicted or failed deletion RETAINS the loser and is NOT
   * counted as merged).
   */
  deleteEntity?: ReflectDeleteEntity
  /** Clock injection for determinism. Defaults to `Date.now`. */
  now?: () => number
  /** Failure sink. Defaults to a structured warn. */
  logFailure?: (msg: string, err: unknown) => void
  /**
   * Test-only seam fired ONCE right after the corpus snapshot, before any
   * mutation. Lets a test inject a deterministic concurrent write to prove the
   * compare-and-swap guards back off instead of clobbering it. Unused in production.
   */
  onAfterSnapshot?: () => void | Promise<void>
}

export interface ReflectReport {
  /** Entity pages enumerated at the start of the pass. */
  scanned: number
  /** Near-duplicate pages merged AWAY (losers deleted). */
  merged: number
  /** Pages whose compiled-truth was re-synthesized (a real, accepted rewrite). */
  resynthesized: number
  /** Reserved-kind (meeting/project/original) pages written. */
  reservedWritten: number
  /** Total LLM dispatches — the cost-confinement proof (0 on a no-substrate pass). */
  llmCalls: number
}

/** One enumerated + read entity page. `raw` is the EXACT on-disk body at snapshot
 *  time — the compare-and-swap baseline that lets a mutating step (merge/unlink/
 *  re-synthesis) detect a concurrent user write and back off instead of clobbering. */
interface LoadedPage {
  kind: EntityKind
  slug: string
  title: string
  compiledTruth: string
  timeline: TimelineEntry[]
  frontmatter: Record<string, unknown>
  raw: string
}

/** Extract the set of `[[slug]]` (or `[[slug|alias]]`) wikilink targets in text —
 *  the graph-edge surface that re-synthesis must never shrink. */
function wikilinkTargets(text: string): Set<string> {
  const out = new Set<string>()
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const target = m[1]?.trim().toLowerCase()
    if (target !== undefined && target.length > 0) out.add(target)
  }
  return out
}

/** True iff `next` preserves every wikilink target present in `prev` (no edge
 *  loss). A re-synthesis that drops even one prior link is rejected. */
function preservesEdges(prev: string, next: string): boolean {
  const before = wikilinkTargets(prev)
  const after = wikilinkTargets(next)
  for (const t of before) if (!after.has(t)) return false
  return true
}

/**
 * Run one reflect batch pass over the owner's entity corpus. Best-effort by
 * construction — every step swallows + logs its own failures so a single bad
 * page never sinks the pass. Returns a report; never throws.
 */
export async function runReflectPass(deps: ReflectPassDeps): Promise<ReflectReport> {
  const now = deps.now ?? ((): number => Date.now())
  const logFailure =
    deps.logFailure ??
    ((msg: string, err: unknown): void => {
      log.warn(msg, { error: err instanceof Error ? err.message : String(err) })
    })
  const report: ReflectReport = {
    scanned: 0,
    merged: 0,
    resynthesized: 0,
    reservedWritten: 0,
    llmCalls: 0,
  }

  // ── Enumerate + read every page (all kinds), via the hardened backend-neutral
  //    scan (symlink-contained). A page that fails to read is skipped.
  let pages: LoadedPage[]
  try {
    pages = await loadAllPages(deps.ownerDataDir)
  } catch (err) {
    logFailure('reflect: enumerate failed', err)
    return report
  }
  report.scanned = pages.length

  // Test seam: a deterministic concurrent write can be injected here to exercise
  // the compare-and-swap guards below. No-op in production.
  if (deps.onAfterSnapshot !== undefined) {
    try {
      await deps.onAfterSnapshot()
    } catch (err) {
      logFailure('reflect: onAfterSnapshot hook threw', err)
    }
  }

  // ── Step 1 — DEDUP (deterministic, no LLM). Do it FIRST so re-synthesis + the
  //    reserved digest see the collapsed set.
  const survivors = await dedupPages(pages, deps, report, logFailure)

  // ── Step 2 — RE-SYNTHESIZE compiled-truth from timelines (LLM, edge-guarded).
  if (deps.substrate !== undefined) {
    await resynthesizePages(survivors, deps, report, now, logFailure)
  }

  // ── Step 3 — EXTRACT the reserved kinds (LLM, one batched corpus call).
  if (deps.substrate !== undefined) {
    await extractReservedKinds(survivors, deps, report, now, logFailure)
  }

  return report
}

/**
 * Enumerate + read every kind's pages. IDENTITY IS THE FILENAME, never the
 * frontmatter slug: the writer always names a page `<slug>.md`, but a
 * hand-planted / corrupt page can carry a frontmatter `slug` that DISAGREES with
 * its filename (or even aliases another page's slug). Keying identity — and every
 * later read/unlink path — off the ACTUAL basename keeps the path exact (so a
 * dedup delete can only ever remove the file it enumerated) and closes the
 * slug-alias delete-the-wrong-file boundary (Codex RB3). A page whose
 * frontmatter `slug` is present and disagrees with its filename is REJECTED
 * (corrupt/hostile), never silently reconciled.
 *
 * Full symlink containment, mirroring `runtime/memory-index.ts`: the entities
 * root + each kind dir must realpath UNDER the owner (a symlinked ancestor →
 * skipped), and each leaf is opened `O_NOFOLLOW` with stat/read through the held
 * fd (a symlinked leaf → skipped; the final-component check→read swap is closed).
 */
async function loadAllPages(ownerDataDir: string): Promise<LoadedPage[]> {
  const pages: LoadedPage[] = []
  for (const kind of ENTITY_KINDS) {
    const contained = await containedKindDir(ownerDataDir, kind)
    if (contained === null) continue // absent / symlinked ancestor → skip the kind
    const { dir, realRoot } = contained
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue
      const basename = name.slice(0, -'.md'.length)
      // Basename must be a clean entity slug (a readdir name can't contain `/`,
      // but this also rejects `.`-only / grammar-invalid names).
      if (!SLUG_REGEX.test(basename)) continue
      const read = await readContainedFile(join(dir, name), realRoot)
      if (read === null) continue // symlinked leaf / escapes root / unreadable
      const fm = parseFrontmatter(read.body)
      // Reject a frontmatter slug that disagrees with the filename (corrupt or a
      // hostile alias of another page) — identity stays the filename.
      const fmSlug = typeof fm['slug'] === 'string' ? (fm['slug'] as string).trim() : ''
      if (fmSlug.length > 0 && fmSlug !== basename) continue
      const title =
        typeof fm['name'] === 'string' && (fm['name'] as string).trim().length > 0
          ? (fm['name'] as string).trim()
          : basename
      pages.push({
        kind,
        slug: basename,
        title,
        compiledTruth: extractCompiledTruth(read.body),
        timeline: extractTimeline(read.body),
        frontmatter: fm,
        raw: read.body,
      })
    }
  }
  return pages
}

/**
 * Resolve `<ownerDataDir>/entities/<kind-dir>` ONLY when it currently canonicalises
 * UNDER the owner (entities root under owner AND kind dir under that root). Returns
 * `{ dir, realRoot }` or null. Called fresh at each use — enumeration, the pre-unlink
 * revalidation, and the reserved-page read — so an ancestor swapped to a symlink
 * pointing outside the owner (e.g. `entities/companies -> /outside`) between the
 * scan and a later mutation is caught right before that mutation (the memory-index
 * TOCTOU discipline). The irreducible sub-call residual (a swap between this final
 * check and the very next syscall) is not closable in portable Node
 * (needs Linux `openat2`/`RESOLVE_BENEATH`) and is accepted under the single-owner
 * local threat model — the same residual `runtime/memory-index.ts` documents.
 */
async function containedKindDir(
  ownerDataDir: string,
  kind: EntityKind,
): Promise<{ dir: string; realRoot: string } | null> {
  const realOwner = await safeRealpath(ownerDataDir)
  if (realOwner === null) return null
  const entitiesDir = join(ownerDataDir, 'entities')
  const realRoot = await safeRealpath(entitiesDir)
  if (realRoot === null || !isPathUnder(realOwner, realRoot)) return null
  const dir = join(entitiesDir, KIND_TO_DIR[kind])
  const realDir = await safeRealpath(dir)
  if (realDir === null || !isPathUnder(realRoot, realDir)) return null
  return { dir, realRoot }
}

/** `realpath` → null instead of throwing (missing path / broken link). */
async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/** True iff canonical `child` is `root` or nested under it. */
function isPathUnder(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Read a `.md` file with full symlink containment (mirrors
 * `runtime/memory-index.ts:readContainedFile`): the parent must canonicalise
 * under `realBoundary`, the leaf is opened `O_NOFOLLOW`, and stat/read go through
 * the held fd. Returns null on any rejection. Fail-closed.
 */
async function readContainedFile(
  filePath: string,
  realBoundary: string,
): Promise<{ body: string } | null> {
  const realParent = await safeRealpath(dirname(filePath))
  if (realParent === null || !isPathUnder(realBoundary, realParent)) return null
  let fh: Awaited<ReturnType<typeof fsOpen>> | null = null
  try {
    fh = await fsOpen(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = await fh.stat()
    if (!stat.isFile()) return null
    return { body: await fh.readFile('utf8') }
  } catch {
    return null
  } finally {
    if (fh !== null) await fh.close().catch(() => undefined)
  }
}

/**
 * DEDUP: within each kind, cluster near-duplicate pages by Jaccard and merge each
 * cluster (size > 1) into a survivor. Returns the surviving page set (losers
 * removed). History-preserving: the survivor absorbs the union of every member's
 * timeline plus the losers' compiled-truth (so their graph edges re-extract onto
 * the survivor); the loser page is then deleted from disk + (best-effort) the brain.
 */
async function dedupPages(
  pages: LoadedPage[],
  deps: ReflectPassDeps,
  report: ReflectReport,
  logFailure: (msg: string, err: unknown) => void,
): Promise<LoadedPage[]> {
  const threshold = deps.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD
  const byKind = new Map<EntityKind, LoadedPage[]>()
  for (const p of pages) {
    const arr = byKind.get(p.kind)
    if (arr === undefined) byKind.set(p.kind, [p])
    else arr.push(p)
  }
  const survivors: LoadedPage[] = []
  for (const [, kindPages] of byKind) {
    const bySlug = new Map(kindPages.map((p) => [p.slug, p]))
    const candidates: DedupCandidate[] = kindPages.map((p) => ({
      slug: p.slug,
      text: `${p.title}\n${p.compiledTruth}`,
    }))
    const clusters = clusterNearDuplicates(candidates, threshold)
    for (const cluster of clusters) {
      const members = cluster.map((c) => bySlug.get(c.slug)!).filter((p) => p !== undefined)
      if (members.length <= 1) {
        if (members[0] !== undefined) survivors.push(members[0])
        continue
      }
      try {
        const merged = await mergeCluster(members, deps)
        if (merged === null) {
          // A member changed on disk since the snapshot (a concurrent user write)
          // — abort this cluster's merge and keep every member as-is; a later pass
          // re-clusters the fresh content. No stale write, no wrong delete.
          for (const m of members) survivors.push(m)
          continue
        }
        survivors.push(merged.survivor)
        // A loser whose canonical (on-disk) deletion FAILED is retained as its own
        // survivor and NOT counted as merged — telemetry never claims a
        // consolidation that left both files on disk (a later pass retries it).
        for (const r of merged.retained) survivors.push(r)
        report.merged += merged.deleted
      } catch (err) {
        // Merge failed — keep every member as its own survivor (no data lost).
        logFailure('reflect: merge failed', err)
        for (const m of members) survivors.push(m)
      }
    }
  }
  return survivors
}

/**
 * Merge a near-duplicate cluster (>= 2 pages, same kind) into one survivor.
 * Survivor = the page with the most timeline history (tie: longest
 * compiled-truth, then lexicographically-smallest slug) — deterministic. The
 * survivor ABSORBS each loser's compiled-truth (content-idempotent fold, so unique
 * facts + graph edges survive) plus the union of every member's dated timeline
 * rows (history), then — and only after that write is durable — each loser is
 * atomically CAS-deleted. Because the survivor holds a loser's content BEFORE the
 * loser is removed, no history can be lost even if a delete or the process fails.
 */
async function mergeCluster(
  members: LoadedPage[],
  deps: ReflectPassDeps,
): Promise<{ survivor: LoadedPage; retained: LoadedPage[]; deleted: number } | null> {
  // EARLY ABORT (optimization): if any member changed on disk since the snapshot,
  // skip the whole cluster now — a later pass re-clusters the fresh content. Not
  // the safety mechanism (that is the atomic precondition on the survivor write +
  // the atomic CAS on each loser delete, below); it just avoids wasted work in the
  // common concurrent-write case.
  for (const m of members) {
    if ((await reloadRawBody(deps.ownerDataDir, m.kind, m.slug)) !== m.raw) return null
  }
  const ranked = [...members].sort((a, b) => {
    if (b.timeline.length !== a.timeline.length) return b.timeline.length - a.timeline.length
    if (b.compiledTruth.length !== a.compiledTruth.length) {
      return b.compiledTruth.length - a.compiledTruth.length
    }
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
  const survivor = ranked[0]!
  const losers = ranked.slice(1)

  // SURVIVOR-FIRST MERGE. Jaccard similarity does NOT imply semantic subsumption —
  // a near-duplicate loser can still hold a durable fact / graph edge the survivor
  // lacks (e.g. a unique `[[client]]`). So the survivor ABSORBS each loser's
  // compiled-truth (preserving its edges, which the writer re-extracts from the
  // combined truth) plus the union of every member's dated timeline rows.
  //
  // The fold is CONTENT-IDEMPOTENT: a loser body already substring-present in the
  // survivor is not re-added, so a repeated merge (e.g. a lingering loser whose
  // deletion keeps failing) never accretes duplicate sections.
  //
  // ORDER: write the survivor FIRST, then delete the losers. So the survivor
  // DURABLY holds a loser's content BEFORE that loser is removed — a loser is
  // deleted only if it still byte-matches the snapshot the survivor just absorbed
  // (atomic CAS on `l.raw`). A loser that changed concurrently fails that CAS and
  // is RETAINED (its fresh content is safe on disk; the survivor holds its prior
  // snapshot, and a later pass folds the new content + collapses). No delete ever
  // precedes a durable survivor write → NO history can be lost, and no compensation
  // is needed.
  const foldSections = losers
    .map((l) => l.compiledTruth.trim())
    .filter((body) => body.length > 0 && !survivor.compiledTruth.includes(body))
  const mergedCompiledTruth =
    foldSections.length > 0
      ? `${survivor.compiledTruth.trimEnd()}\n\n${foldSections.map((b) => `## Merged\n\n${b}`).join('\n\n')}\n`
      : survivor.compiledTruth

  const unionTimeline = members
    .flatMap((m) => m.timeline)
    .reduce<TimelineEntry[]>((acc, row) => mergeTimeline(acc, row), [])

  const frontmatter: Record<string, unknown> = {
    ...survivor.frontmatter,
    slug: survivor.slug,
    type: survivor.kind,
    name: survivor.title,
    source: `reflect:${deps.ownSlug}`,
  }

  // ONE atomic survivor write: the merged (loser-folded) compiled-truth + the union
  // timeline, guarded by `ifBodyEquals: survivor.raw`. A concurrent survivor write
  // flips this to a no-op conflict → abort the whole cluster (delete no loser).
  const out = await deps.writeEntity(
    {
      ownerDataDir: deps.ownerDataDir,
      kind: survivor.kind,
      slug: survivor.slug,
      body: { frontmatter, compiledTruth: mergedCompiledTruth, timelineAppend: unionTimeline },
      originInstance: deps.ownSlug,
      receivingInstanceSlug: deps.ownSlug,
      precondition: { ifBodyEquals: survivor.raw },
    },
    deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {},
  )
  if (out.conflict === true) return null // survivor changed concurrently → abort, delete nothing

  // Re-read the survivor's NEW on-disk bytes as the fresh CAS baseline, so a
  // SAME-PASS re-synthesis of this merged survivor uses the post-merge body as
  // `ifBodyEquals` (not the stale pre-merge snapshot, which would always conflict).
  const newSurvivorRaw = (await reloadRawBody(deps.ownerDataDir, survivor.kind, survivor.slug)) ?? survivor.raw

  // Now delete each loser ATOMICALLY, only if it STILL matches the snapshot the
  // survivor just absorbed (CAS on `l.raw`, under the writer's per-key lock — a
  // concurrent loser write can't interleave). A conflict/failure retains the loser
  // (its content is durably in the survivor, so no loss; a later pass reconciles).
  // Only a confirmed delete counts + fans the best-effort brain-mirror removal.
  const deleteEntityFn = deps.deleteEntity ?? realDeleteEntity
  const retained: LoadedPage[] = []
  let deleted = 0
  for (const l of losers) {
    let removed = false
    try {
      const del = await deleteEntityFn({
        ownerDataDir: deps.ownerDataDir,
        kind: l.kind,
        slug: l.slug,
        precondition: { ifBodyEquals: l.raw },
      })
      removed = del.deleted && del.conflict !== true
    } catch {
      removed = false
    }
    if (!removed) {
      retained.push(l)
      continue
    }
    deleted += 1
    if (deps.deletePage !== undefined) {
      try {
        await deps.deletePage(l.slug)
      } catch {
        // brain delete is best-effort — never fail the merge on a mirror hiccup
      }
    }
  }

  return {
    survivor: {
      ...survivor,
      compiledTruth: mergedCompiledTruth,
      timeline: unionTimeline,
      frontmatter,
      raw: newSurvivorRaw,
    },
    retained,
    deleted,
  }
}

/** Re-synthesis persona: tidy the compiled-truth from the timeline WITHOUT losing
 *  any fact or wikilink. */
const RESYNTH_PROMPT = `You are the reflect pass consolidating one knowledge-base entity page. You are given the page's CURRENT compiled-truth and its full dated TIMELINE. Rewrite the compiled-truth as the clean, de-duplicated CURRENT best understanding of the entity, folding in anything durable from the timeline.

Return ONLY the rewritten compiled-truth as markdown — no preamble, no JSON, no code fence, no timeline.

Hard rules:
- Preserve EVERY \`[[wikilink]]\` that appears in the current compiled-truth — dropping one silently deletes a knowledge-graph edge. Keep them all, in natural sentences.
- Never invent facts or enrich from outside knowledge. Only consolidate what is already on the page/timeline.
- Keep it concise and non-redundant. Do not add a timeline or headings that restate the timeline.
`

/**
 * RE-SYNTHESIZE compiled-truth for each drifted survivor. Gated deterministically
 * (>= `resynthMinTimelineRows` rows) and hard-capped (`maxResynthPages`). The
 * rewrite is REJECTED unless it preserves every prior wikilink (no edge loss),
 * so a lossy/garbage emit leaves the page byte-untouched. `writeEntity` is
 * idempotent, so an unchanged rewrite is a no-op that costs one LLM call but no write.
 */
async function resynthesizePages(
  survivors: LoadedPage[],
  deps: ReflectPassDeps,
  report: ReflectReport,
  now: () => number,
  logFailure: (msg: string, err: unknown) => void,
): Promise<void> {
  const minRows = deps.resynthMinTimelineRows ?? DEFAULT_RESYNTH_MIN_TIMELINE_ROWS
  const cap = deps.maxResynthPages ?? DEFAULT_MAX_RESYNTH_PAGES
  let done = 0
  for (const page of survivors) {
    if (done >= cap) break
    if (page.timeline.length < minRows) continue
    done += 1
    try {
      const digest = renderPageForResynth(page)
      const raw = await dispatch(deps, report, `${RESYNTH_PROMPT}\n${digest}\n`)
      const next = raw.trim()
      if (next.length === 0) continue
      if (!preservesEdges(page.compiledTruth, next)) continue // would drop an edge → reject
      // IDEMPOTENCE: if the LLM returned the already-consolidated truth (no real
      // change), do NOT write — appending a marker row would rewrite the page,
      // report a phantom consolidation, grow the timeline every pass, and keep the
      // page permanently above the row gate. Only a genuine change is written.
      if (next === page.compiledTruth.trim()) continue
      const frontmatter: Record<string, unknown> = {
        ...page.frontmatter,
        slug: page.slug,
        type: page.kind,
        name: page.title,
        source: `reflect:${deps.ownSlug}`,
      }
      // ATOMIC COMPARE-AND-SWAP: the full-replacement write commits ONLY if the
      // page is still byte-identical to the snapshot the LLM consolidated from
      // (`ifBodyEquals: page.raw`), checked inside the writer's per-key lock. The
      // LLM call took time; a concurrent scribe/user write that landed meanwhile
      // flips this to a no-op conflict, so the stale rewrite never clobbers it. A
      // later pass re-synthesizes the fresh content.
      const out = await deps.writeEntity(
        {
          ownerDataDir: deps.ownerDataDir,
          kind: page.kind,
          slug: page.slug,
          body: {
            frontmatter,
            compiledTruth: next,
            timelineAppend: {
              ts: new Date(now()).toISOString(),
              source: `reflect:resynth:${deps.ownSlug}`,
              body: 'Consolidated compiled-truth from timeline',
            },
          },
          originInstance: deps.ownSlug,
          receivingInstanceSlug: deps.ownSlug,
          precondition: { ifBodyEquals: page.raw },
        },
        deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {},
      )
      if (out.changed) {
        report.resynthesized += 1
        // Keep the in-memory page current so the SAME-pass reserved-kind
        // extraction (step 3) digests the freshly consolidated truth — a fact
        // lifted from timeline into compiled-truth can drive a reserved entity in
        // this pass, not only the next one.
        page.compiledTruth = next
      }
    } catch (err) {
      logFailure('reflect: resynth failed', err)
    }
  }
}

/** Render a page's compiled-truth + timeline as a digest for re-synthesis. */
function renderPageForResynth(page: LoadedPage): string {
  const rows = page.timeline
    .map((e) => `- ${e.ts} | ${e.source} | ${e.body}`)
    .join('\n')
  return `COMPILED-TRUTH:\n${page.compiledTruth.trim()}\n\nTIMELINE:\n${rows}`
}

/**
 * EXTRACT the reserved kinds (meeting/project/original) from a corpus digest in
 * ONE batched LLM call, then write each through the entity-writer → GBrain path.
 *
 * ADDITIVE-MERGE over an EXISTING reserved page (the Nova-scribe / write-to-gbrain
 * rule): `writeEntity` renders `body.compiledTruth` as a FULL REPLACEMENT and
 * retracts every graph edge present before but absent now, so composing a fresh
 * one-fact page over a richer existing meeting/project/note would erase its prior
 * facts AND edges. So for an existing page we KEEP its compiled-truth verbatim and
 * only APPEND a genuinely new fact sentence (never already present) — so a newly
 * discovered fact reaches BOTH the compiled-truth AND, via the writer's
 * compiled-truth-only edge extractor, the graph, while no prior fact/edge is
 * retracted (`removedLinks` stays empty). A fact already present (or an absent
 * fact) is a true no-op — no write, no timeline growth. A genuinely NEW entity
 * gets a freshly-composed page (Codex RB3).
 */
async function extractReservedKinds(
  survivors: LoadedPage[],
  deps: ReflectPassDeps,
  report: ReflectReport,
  now: () => number,
  logFailure: (msg: string, err: unknown) => void,
): Promise<void> {
  const budget = deps.maxReservedDigestChars ?? DEFAULT_MAX_RESERVED_DIGEST_CHARS
  const digest = buildCorpusDigest(survivors, budget)
  if (digest.trim().length === 0) return
  let entities: ReturnType<typeof parseReservedExtraction>
  try {
    const raw = await dispatch(deps, report, composeReservedPrompt(digest))
    entities = parseReservedExtraction(raw)
  } catch (err) {
    logFailure('reflect: reserved extract failed', err)
    return
  }
  const nowIso = new Date(now()).toISOString()
  for (const e of entities) {
    const slug = slugify(e.name)
    if (slug === null) continue
    try {
      // Read any existing page for (kind, slug). The slug came from `slugify` →
      // grammar-safe path.
      const existing = await readContainedPage(deps.ownerDataDir, e.kind, slug)
      const fact = e.fact !== undefined && e.fact.trim().length > 0 ? e.fact.trim() : undefined
      let compiledTruth: string
      if (existing === null) {
        // New entity — freshly compose the page.
        compiledTruth = `# ${e.name}\n\n${(fact ?? `Identified during reflect (${e.kind}).`).replace(/\.?$/, '.')}\n`
      } else {
        // Existing entity — additive merge: keep prior truth verbatim and APPEND a
        // genuinely new fact sentence (so it reaches compiled-truth + the graph)
        // without retracting any prior fact/edge. Nothing new → true no-op.
        const factSentence = fact !== undefined ? fact.replace(/\.?$/, '.') : undefined
        if (factSentence === undefined || existing.compiledTruth.includes(factSentence)) {
          continue // no new durable fact for this page → skip (no write, no growth)
        }
        compiledTruth = `${existing.compiledTruth.trimEnd()}\n\n${factSentence}\n`
      }
      const frontmatter: Record<string, unknown> = {
        ...(existing?.frontmatter ?? {}),
        slug,
        type: e.kind,
        name: existing !== null ? (existing.frontmatter['name'] ?? e.name) : e.name,
        source: `reflect:${deps.ownSlug}`,
      }
      // ATOMIC COMPARE-AND-SWAP: a NEW page commits only if none exists yet
      // (`ifBodyEquals: null`); an existing page commits only if it is still
      // byte-identical to the `existing` snapshot the append was computed from.
      // Either way a concurrent write between the read above and the writer's lock
      // flips this to a no-op conflict, never clobbering it.
      const out = await deps.writeEntity(
        {
          ownerDataDir: deps.ownerDataDir,
          kind: e.kind,
          slug,
          body: {
            frontmatter,
            compiledTruth,
            timelineAppend: {
              ts: nowIso,
              source: `reflect:reserved:${deps.ownSlug}`,
              body: `Extracted ${e.kind} during reflect${e.fact !== undefined ? ` — ${e.fact}` : ''}`,
            },
          },
          originInstance: deps.ownSlug,
          receivingInstanceSlug: deps.ownSlug,
          precondition: { ifBodyEquals: existing === null ? null : existing.raw },
        },
        deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {},
      )
      // Count any real write — a new page OR an existing page that gained a fact
      // (the skip above + a concurrent-write conflict both leave `changed` false).
      if (out.changed) report.reservedWritten += 1
    } catch (err) {
      logFailure('reflect: reserved write failed', err)
    }
  }
}

/** Read a page's CURRENT on-disk state (raw body + parsed compiled-truth +
 *  frontmatter), or null when absent. Symlink-contained via the SAME hardened
 *  reader the scan uses (revalidated kind dir + `O_NOFOLLOW` leaf), so a symlinked
 *  page / ancestor can't make this read escape the owner. `slug` is grammar-safe.
 *  Used both to read an existing reserved page (append-only merge) and as the
 *  compare-and-swap re-read for re-synthesis. */
async function readContainedPage(
  ownerDataDir: string,
  kind: EntityKind,
  slug: string,
): Promise<{ raw: string; compiledTruth: string; frontmatter: Record<string, unknown> } | null> {
  if (!SLUG_REGEX.test(slug)) return null
  const contained = await containedKindDir(ownerDataDir, kind)
  if (contained === null) return null
  const read = await readContainedFile(join(contained.dir, `${slug}.md`), contained.realRoot)
  if (read === null) return null
  return {
    raw: read.body,
    compiledTruth: extractCompiledTruth(read.body),
    frontmatter: parseFrontmatter(read.body),
  }
}

/** The raw on-disk body for the dedup compare-and-swap, or null when absent. */
async function reloadRawBody(
  ownerDataDir: string,
  kind: EntityKind,
  slug: string,
): Promise<string | null> {
  const page = await readContainedPage(ownerDataDir, kind, slug)
  return page === null ? null : page.raw
}

/** Concatenate page titles + compiled-truth (+ the two NEWEST timeline rows —
 *  `extractTimeline` returns rows newest-first) into a budget-capped digest for
 *  the reserved-kind extraction. */
function buildCorpusDigest(pages: LoadedPage[], budgetChars: number): string {
  const parts: string[] = []
  let used = 0
  for (const p of pages) {
    const recent = p.timeline
      .slice(0, 2) // newest-first ordering ⇒ the two most recent rows
      .map((e) => `  · ${e.body}`)
      .join('\n')
    const block = `### ${p.title} (${p.kind})\n${p.compiledTruth.trim()}${recent.length > 0 ? `\n${recent}` : ''}`
    if (used + block.length > budgetChars) break
    parts.push(block)
    used += block.length + 2
  }
  return parts.join('\n\n')
}

/**
 * Dispatch ONE LLM turn through the batch substrate and return the drained text.
 * Every dispatch bumps `report.llmCalls` (the cost-confinement counter). A
 * per-dispatch watchdog aborts a hung call. Throws on substrate error / abort so
 * the caller's try/catch can skip just that step.
 */
async function dispatch(deps: ReflectPassDeps, report: ReflectReport, prompt: string): Promise<string> {
  const substrate = deps.substrate
  if (substrate === undefined) return ''
  report.llmCalls += 1
  const controller = new AbortController()
  const watchdog = setTimeout(() => controller.abort(), deps.watchdogMs ?? DEFAULT_REFLECT_WATCHDOG_MS)
  try {
    const handle = substrate.start({
      prompt,
      tools: [],
      model_preference:
        deps.model_preference !== undefined && deps.model_preference.length > 0
          ? [...deps.model_preference]
          : [getBestModel()],
      max_tokens: 4096,
    })
    return await drainToText(handle, {
      signal: controller.signal,
      errorPrefix: 'reflect: substrate error: ',
      abortMessage: 'reflect: aborted (watchdog)',
      abortBeforeDispatchMessage: 'reflect: aborted before dispatch (watchdog)',
      keepAliveExempt: true,
    })
  } finally {
    clearTimeout(watchdog)
  }
}
