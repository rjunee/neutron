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

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
import { collectMemoryIndexEntries } from '@neutronai/runtime/memory-index.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import { drainToText } from '@neutronai/runtime/substrate-text.ts'
import { createLogger } from '@neutronai/logger'
import { type WriteEntityFn, slugify } from '../write-to-gbrain.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'
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
  writeEntity: WriteEntityFn
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
  /** Clock injection for determinism. Defaults to `Date.now`. */
  now?: () => number
  /** Failure sink. Defaults to a structured warn. */
  logFailure?: (msg: string, err: unknown) => void
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

/** One enumerated + read entity page. */
interface LoadedPage {
  kind: EntityKind
  slug: string
  title: string
  compiledTruth: string
  timeline: TimelineEntry[]
  frontmatter: Record<string, unknown>
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

  // ── Step 1 — DEDUP (deterministic, no LLM). Do it FIRST so re-synthesis + the
  //    reserved digest see the collapsed set.
  const survivors = await dedupPages(pages, deps, report, now, logFailure)

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

/** Enumerate every kind's pages and read each full body from disk. */
async function loadAllPages(ownerDataDir: string): Promise<LoadedPage[]> {
  const entries = await collectMemoryIndexEntries(ownerDataDir, { kinds: ENTITY_KINDS })
  const pages: LoadedPage[] = []
  for (const e of entries) {
    const path = join(ownerDataDir, 'entities', KIND_TO_DIR[e.kind], `${e.slug}.md`)
    let body: string
    try {
      body = await readFile(path, 'utf8')
    } catch {
      continue // vanished / unreadable between scan and read — skip
    }
    pages.push({
      kind: e.kind,
      slug: e.slug,
      title: e.title,
      compiledTruth: extractCompiledTruth(body),
      timeline: extractTimeline(body),
      frontmatter: parseFrontmatter(body),
    })
  }
  return pages
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
  now: () => number,
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
        const survivor = await mergeCluster(members, deps, now)
        survivors.push(survivor)
        report.merged += members.length - 1
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
 * survivor's compiled-truth is its own body plus a "Merged from" section carrying
 * the losers' compiled-truth verbatim (their `[[wikilinks]]` re-extract onto the
 * survivor); its timeline absorbs the union of every member's rows. Each loser is
 * removed from disk and best-effort from the brain.
 */
async function mergeCluster(
  members: LoadedPage[],
  deps: ReflectPassDeps,
  now: () => number,
): Promise<LoadedPage> {
  const ranked = [...members].sort((a, b) => {
    if (b.timeline.length !== a.timeline.length) return b.timeline.length - a.timeline.length
    if (b.compiledTruth.length !== a.compiledTruth.length) {
      return b.compiledTruth.length - a.compiledTruth.length
    }
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
  const survivor = ranked[0]!
  const losers = ranked.slice(1)

  // Fold the losers' compiled-truth into the survivor so their graph edges carry
  // over. Keep it verbatim under a labelled section; the writer's edge extractor
  // re-derives the union of triples from the combined compiled-truth.
  const foldSections = losers
    .map((l) => {
      const body = l.compiledTruth.trim()
      return body.length > 0 ? `## Merged from ${l.slug}\n\n${body}` : ''
    })
    .filter((s) => s.length > 0)
  const mergedCompiledTruth =
    foldSections.length > 0
      ? `${survivor.compiledTruth.trimEnd()}\n\n${foldSections.join('\n\n')}\n`
      : survivor.compiledTruth

  // The union timeline: every member's rows plus a dated merge marker.
  const nowIso = new Date(now()).toISOString()
  const marker: TimelineEntry = {
    ts: nowIso,
    source: `reflect:dedup:${deps.ownSlug}`,
    body: `Merged near-duplicate ${survivor.kind} page(s): ${losers.map((l) => l.slug).join(', ')}`,
  }
  const unionTimeline = mergeTimeline(
    members.flatMap((m) => m.timeline),
    marker,
  )

  const frontmatter: Record<string, unknown> = {
    ...survivor.frontmatter,
    slug: survivor.slug,
    type: survivor.kind,
    name: survivor.title,
    source: `reflect:${deps.ownSlug}`,
  }

  // Write the survivor's merged compiled-truth ONCE (this establishes the edge
  // set), then fold in every union-timeline row via the writer's single-append
  // seam — each `writeEntity` merges one row into the on-disk timeline (dedup on
  // ts/source/body), so the survivor ends up with the whole union while the
  // compiled-truth (hence the edges) is written exactly once.
  const writeOne = (append: TimelineEntry): Promise<unknown> =>
    deps.writeEntity(
      {
        ownerDataDir: deps.ownerDataDir,
        kind: survivor.kind,
        slug: survivor.slug,
        body: { frontmatter, compiledTruth: mergedCompiledTruth, timelineAppend: append },
        originInstance: deps.ownSlug,
        receivingInstanceSlug: deps.ownSlug,
      },
      deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {},
    )
  // First append seeds the merged compiled-truth; the rest only grow the timeline.
  await writeOne(unionTimeline[0] ?? marker)
  for (const row of unionTimeline.slice(1)) await writeOne(row)

  // Remove each loser: disk first (canonical), then best-effort brain mirror.
  for (const l of losers) {
    const path = join(deps.ownerDataDir, 'entities', KIND_TO_DIR[l.kind], `${l.slug}.md`)
    try {
      await unlink(path)
    } catch {
      // already gone / unreadable — the survivor still carries the merged content
    }
    if (deps.deletePage !== undefined) {
      try {
        await deps.deletePage(l.slug)
      } catch {
        // brain delete is best-effort — never fail the merge on a mirror hiccup
      }
    }
  }

  return {
    ...survivor,
    compiledTruth: mergedCompiledTruth,
    timeline: unionTimeline,
    frontmatter,
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
      const frontmatter: Record<string, unknown> = {
        ...page.frontmatter,
        slug: page.slug,
        type: page.kind,
        name: page.title,
        source: `reflect:${deps.ownSlug}`,
      }
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
        },
        deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {},
      )
      if (out.changed) report.resynthesized += 1
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
 * A conservative single-pass writer: fresh compiled-truth per entity, one
 * timeline row; `writeEntity` dedups on re-run.
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
    const fact = e.fact !== undefined && e.fact.length > 0 ? e.fact : `Identified during reflect (${e.kind}).`
    const compiledTruth = `# ${e.name}\n\n${fact.endsWith('.') ? fact : `${fact}.`}\n`
    try {
      const out = await deps.writeEntity(
        {
          ownerDataDir: deps.ownerDataDir,
          kind: e.kind,
          slug,
          body: {
            frontmatter: {
              slug,
              type: e.kind,
              name: e.name,
              source: `reflect:${deps.ownSlug}`,
            },
            compiledTruth,
            timelineAppend: {
              ts: nowIso,
              source: `reflect:reserved:${deps.ownSlug}`,
              body: `Extracted ${e.kind} during reflect${e.fact !== undefined ? ` — ${e.fact}` : ''}`,
            },
          },
          originInstance: deps.ownSlug,
          receivingInstanceSlug: deps.ownSlug,
        },
        deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {},
      )
      if (out.changed) report.reservedWritten += 1
    } catch (err) {
      logFailure('reflect: reserved write failed', err)
    }
  }
}

/** Concatenate page titles + compiled-truth (+ a couple of recent timeline rows)
 *  into a budget-capped digest for the reserved-kind extraction. */
function buildCorpusDigest(pages: LoadedPage[], budgetChars: number): string {
  const parts: string[] = []
  let used = 0
  for (const p of pages) {
    const recent = p.timeline
      .slice(0, 2)
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
