/**
 * @neutronai/scribe — fan a `ScribeExtraction` through the entity-writer → GBrain.
 *
 * Mirrors the history-import populator (`onboarding/history-import/
 * entity-populator.ts`) — the EXISTING production `writeEntity` caller — but
 * for the chat-time path. Each extracted entity becomes a compiled-truth +
 * timeline page written via `runtime/entity-writer.ts:writeEntity`; the
 * writer's `syncHook` (the per-instance `GBrainSyncHook`) fans the page body to
 * GBrain (`put_page`) and the auto-extracted typed triples to the GBrain graph
 * (`add_link`). This is the SAME path admin Memory + onboarding use — scribe
 * does not invent a second write boundary.
 *
 * Typed edges come "for free": relations are rendered into the subject page's
 * compiled-truth as natural-language sentences containing `[[object-slug]]`
 * wikilinks (e.g. `Works at [[acme]].`), which the writer's `extractTypedLinks`
 * resolves into the correct predicate (`auto-link.ts` verb patterns). The
 * compiled-truth stays the single source of truth for the graph.
 *
 * **Append-only over existing pages (Nova scribe rule + data-integrity).**
 * `writeEntity` treats `compiledTruth` as a FULL replacement and retracts every
 * triple present in the previous compiled-truth but absent from the new one
 * (`removedLinks`). A sparse chat turn must therefore NEVER overwrite a richer
 * existing page (e.g. an onboarding-populated entity) — that would erase prior
 * facts AND retract their GBrain edges. So for an EXISTING page scribe reads the
 * current compiled-truth, PRESERVES it verbatim, and only APPENDS a new
 * relationship wikilink when its (predicate, object) sentence isn't already
 * asserted (`removedLinks` stays empty — every prior edge is preserved). The new
 * fact goes to the append-only timeline, not the compiled-truth prose. Fresh
 * entities get a freshly-composed page. This mirrors Nova's scribe ("NO rewrites
 * above the horizontal rule").
 *
 * The SAME invariant applies to FRONTMATTER. `writeEntity` renders the page's
 * frontmatter wholesale from `body.frontmatter` (`runtime/entity-writer.ts`) —
 * it does NOT merge — so passing only scribe's minimal `{slug,type,name,source}`
 * over an import-seeded page would silently drop the populator's `mention_count`,
 * the original `source` citation, and `category:'inferred_interest'` (losing
 * `category` reclassifies an inferred interest as a plain concept = data loss).
 * So for an EXISTING page scribe reads the on-disk frontmatter and MERGES:
 * unknown/existing keys are preserved; only the keys scribe authoritatively
 * knows (`name`, `source`, plus the structural `slug`/`type`) are set.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  KIND_TO_DIR,
  extractCompiledTruth,
  parseFrontmatter,
} from '@neutronai/runtime/entity-format.ts'
import { extractTypedLinks } from '@neutronai/runtime/auto-link.ts'
import type { EntityKind, SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { entitySlugify } from '@neutronai/runtime/entity-slug.ts'
import { createLogger } from '@neutronai/logger'

const writeGbrainLog = createLogger('scribe')
import type { ExtractedEntity, ExtractedRelation, ScribeExtraction } from './extract.ts'

/**
 * Minimal `writeEntity` surface — lets tests inject a recorder without pulling
 * in the file-touching real implementation. Production wires the real
 * `writeEntity` from `runtime/entity-writer.ts`.
 */
export interface WriteEntityFn {
  (
    input: {
      ownerDataDir: string
      kind: EntityKind
      slug: string
      body: {
        frontmatter: Record<string, unknown>
        compiledTruth: string
        timelineAppend: { ts: string; source: string; body: string }
      }
      // M2.6 Ph1 (#83) — own-origin attribution. Chat-time content is the
      // owner's own, so both equal the receiving instance's slug → passes the
      // quarantine guard. M2.6 Ph4 — the syndication path passes a FOREIGN
      // `originInstance` (the member local_slug) + the owner `receivingInstanceSlug`
      // + the owner-approval-derived `allowPersistOrigins` whitelist so the
      // boundary guard ACCEPTS an approved member while still refusing everyone
      // else.
      originInstance: string
      receivingInstanceSlug: string
      allowPersistOrigins?: ReadonlyArray<string>
    },
    deps?: { syncHook?: SyncHook },
  ): Promise<{ path: string; changed: boolean; newLinks: unknown[] }>
}

export interface WriteExtractionInput {
  extraction: ScribeExtraction
  /** Absolute path to the instance's Zone-B data dir (the writer appends `/entities`). */
  ownerDataDir: string
  /** Provenance source pointer for the timeline entry (e.g. `chat:<instance>`). */
  source: string
  /** ISO timestamp for the timeline entry + frontmatter. */
  ts: string
  /**
   * M2.6 Ph1 (#83) — the receiving instance's own slug. Chat content is
   * own-origin, so this stamps BOTH `originInstance` and `receivingInstanceSlug`
   * on every `writeEntity` call → the quarantine guard passes it. Threaded
   * from `createScribe`'s `project_slug`.
   */
  ownSlug: string
  /**
   * M2.6 Ph4 — foreign-origin attribution for the syndication persist path. The
   * member `local_slug` that authored this content. Defaults to `ownSlug`
   * (own-origin: chat / Cores). When set DISTINCT from `ownSlug`, every
   * `writeEntity` call stamps `originInstance = originSlug` (foreign) +
   * `receivingInstanceSlug = ownSlug` (owner) and carries `allowPersistOrigins` so
   * the boundary guard accepts the approved member.
   */
  originSlug?: string
  /**
   * M2.6 Ph4 — owner-approval-derived whitelist passed THROUGH to the
   * `writeEntity` boundary so an approved foreign `originSlug` passes the
   * quarantine guard. Empty / undefined for the own-origin chat + Cores paths
   * (their behaviour is unchanged).
   */
  allowPersistOrigins?: ReadonlyArray<string>
  /**
   * Multi-author attribution (connect-spec §4.3 layer 2). The uniform author of
   * the turn this extraction came from — owner = author #0, each collaborator a
   * stable id + display. When present, the author id is folded into the per-page
   * timeline provenance so the host's one memory records WHICH author the
   * commitment/decision/fact came from. Absent for unattributed/legacy callers
   * (provenance unchanged).
   */
  author?: { id: string; display: string }
}

export interface WriteExtractionDeps {
  writeEntity: WriteEntityFn
  /** Per-instance GBrain sync hook (page store + typed-edge graph). */
  syncHook?: SyncHook
  /** Failure sink. Defaults to console.warn. */
  logFailure?: (err: unknown, ctx: { kind: EntityKind; slug: string }) => void
  /**
   * RB4 temporal invalidation — the shared `NEUTRON_PERFECT_RECALL` gate,
   * resolved at the wiring layer (`open/wiring/memory.ts`). When true, a relation
   * carrying a `supersedes` marker DROPS the superseded object's sentence(s) from
   * the subject's compiled-truth (so the writer's existing
   * `removedLinks`→`remove_link` machinery invalidates the stale gbrain edge and
   * `add_link` asserts the current one), and the superseding write records the
   * transition in the append-only timeline (dated history preserved). When false
   * (the default), `supersedes` is ignored entirely → pure accretion, byte-for-
   * byte today's behaviour.
   */
  supersede?: boolean
}

export interface WriteExtractionReport {
  pages_written: number
  pages_skipped: number
  /** Sum of typed triples the writer extracted across all changed pages. */
  edges_emitted: number
}

const KIND_MAP: Readonly<Record<ExtractedEntity['kind'], EntityKind>> = Object.freeze({
  person: 'person',
  company: 'company',
  concept: 'concept',
})

/** Predicate → compiled-truth sentence template. The `[[slug]]` resolves to the
 *  intended typed edge via `auto-link.ts` (`normaliseSentence` strips the
 *  brackets, then the verb pattern matches). `mentions` is the catch-all. */
const RELATION_SENTENCE: Readonly<Record<string, (objSlug: string) => string>> = Object.freeze({
  founded: (o) => `Founded [[${o}]].`,
  invested_in: (o) => `Invested in [[${o}]].`,
  advises: (o) => `Advises [[${o}]].`,
  works_at: (o) => `Works at [[${o}]].`,
  attended: (o) => `Attended [[${o}]].`,
  met: (o) => `Met with [[${o}]].`,
  mentions: (o) => `Mentions [[${o}]].`,
})

interface PlannedPage {
  kind: EntityKind
  slug: string
  name: string
  fact: string | undefined
  relations: ExtractedRelation[]
}

/**
 * Write every extracted entity as a compiled-truth page and fan its typed edges
 * to GBrain via the sync hook. Idempotent (the writer short-circuits byte-equal
 * rewrites) and best-effort (per-entity failures are logged + skipped; never
 * throws).
 */
export async function writeExtractionToGBrain(
  input: WriteExtractionInput,
  deps: WriteExtractionDeps,
): Promise<WriteExtractionReport> {
  const report: WriteExtractionReport = { pages_written: 0, pages_skipped: 0, edges_emitted: 0 }
  // RB4 — the perfect-recall supersede gate. OFF (default) → the merge stays
  // strictly append-only and the `supersedes` markers are inert (pure accretion).
  const supersede = deps.supersede === true

  // 1. Plan a page per entity, keyed + deduped by slug.
  const bySlug = new Map<string, PlannedPage>()
  for (const e of input.extraction.entities) {
    const slug = slugify(e.name)
    if (slug === null) {
      report.pages_skipped += 1
      continue
    }
    const kind = KIND_MAP[e.kind]
    const existing = bySlug.get(slug)
    if (existing === undefined) {
      bySlug.set(slug, { kind, slug, name: e.name.trim(), fact: e.fact, relations: [] })
    } else if (existing.fact === undefined && e.fact !== undefined) {
      existing.fact = e.fact
    }
  }

  // 2. Attach relations to their subject page. Keep ONLY relations whose
  //    subject AND object are both planned entity pages — GBrain's `add_link`
  //    requires both endpoint pages to exist, so an edge to an unextracted
  //    entity would just fail soft. Requiring both endpoints keeps every edge
  //    valid and the KG clean (over-creation is worse — Nova scribe rule).
  for (const r of input.extraction.relations) {
    const subjectSlug = slugify(r.subject)
    const objectSlug = slugify(r.object)
    if (subjectSlug === null || objectSlug === null) continue
    if (subjectSlug === objectSlug) continue // no self-edges
    const page = bySlug.get(subjectSlug)
    if (page === undefined) continue // subject has no page — drop the relation
    if (!bySlug.has(objectSlug)) continue // object has no page — drop the relation
    page.relations.push(r)
  }

  // 3. Write each page through the entity-writer → GBrain sync hook, in
  //    dependency order: a page's relation OBJECTS are written BEFORE the page
  //    itself so the object pages exist when the subject's `add_link` fires
  //    (GBrain requires both endpoints). Post-order DFS; cycles are broken
  //    arbitrarily (one direction's edge then fails soft — acceptable + rare).
  const writeDeps: { syncHook?: SyncHook } =
    deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {}

  // Author-attributed provenance (connect-spec §4.3 layer 2): fold the author id
  // into the timeline source so a memory entry records WHO contributed it. Two
  // distinct authors' identical claims stay distinct provenance entries (the
  // timeline dedup keys on source). Unattributed callers keep the bare source.
  const timelineSource =
    input.author !== undefined ? `${input.source}#author:${input.author.id}` : input.source

  for (const page of orderPagesObjectsFirst(bySlug)) {
    try {
      // Preserve an existing page's compiled-truth + frontmatter (append-only /
      // merge); compose fresh for a new entity. See the module header for the
      // data-loss rationale.
      const existing = await readExistingPage(input.ownerDataDir, page.kind, page.slug)
      const compiledTruth =
        existing !== null
          ? mergeExistingCompiledTruth(existing.compiledTruth, page, supersede)
          : composeNewCompiledTruth(page)
      // Merge frontmatter: preserve every existing key (mention_count, category,
      // basis, cadence_hint, …) and only set the keys scribe authoritatively
      // owns. `writeEntity` does NOT merge frontmatter, so without this the
      // populator's fields would be clobbered on the first chat touch.
      const frontmatter: Record<string, unknown> = {
        ...(existing?.frontmatter ?? {}),
        slug: page.slug,
        type: page.kind,
        name: page.name,
        source: input.source,
      }
      const out = await deps.writeEntity(
        {
          ownerDataDir: input.ownerDataDir,
          kind: page.kind,
          slug: page.slug,
          body: {
            frontmatter,
            compiledTruth,
            // Append-only provenance. Deterministic body (same for new + existing
            // pages on identical input) so the writer's (ts,source,body) timeline
            // dedup makes a repeated identical turn a true no-op.
            timelineAppend: {
              ts: input.ts,
              source: timelineSource,
              body: timelineBody(page, supersede),
            },
          },
          // M2.6 Ph1 (#83) — own-origin stamp by default (chat / Cores: origin
          // === receiving → guard passes). M2.6 Ph4 — the syndication path sets
          // `originSlug` to the member local_slug (foreign) + carries the owner-
          // approval-derived whitelist so the boundary guard accepts it.
          originInstance: input.originSlug ?? input.ownSlug,
          receivingInstanceSlug: input.ownSlug,
          ...(input.allowPersistOrigins !== undefined
            ? { allowPersistOrigins: input.allowPersistOrigins }
            : {}),
        },
        writeDeps,
      )
      if (out.changed) {
        report.pages_written += 1
        report.edges_emitted += Array.isArray(out.newLinks) ? out.newLinks.length : 0
      } else {
        report.pages_skipped += 1
      }
    } catch (err) {
      report.pages_skipped += 1
      const sink =
        deps.logFailure ??
        ((e: unknown, ctx: { kind: EntityKind; slug: string }): void => {
          writeGbrainLog.warn('write_entity_failed', {
            kind: ctx.kind,
            slug: ctx.slug,
            error: e instanceof Error ? e.message : String(e),
          })
        })
      sink(err, { kind: page.kind, slug: page.slug })
    }
  }

  return report
}

/**
 * Order pages so each page's relation objects come BEFORE it (post-order DFS).
 * Guarantees an edge's target page already exists in GBrain when the subject's
 * `add_link` fires. Cycles are tolerated (an in-progress node is skipped),
 * breaking the back-edge — that single edge then fails soft on `add_link`.
 */
function orderPagesObjectsFirst(bySlug: Map<string, PlannedPage>): PlannedPage[] {
  const emitted: PlannedPage[] = []
  const visited = new Set<string>()
  const inProgress = new Set<string>()
  const visit = (slug: string): void => {
    if (visited.has(slug) || inProgress.has(slug)) return
    inProgress.add(slug)
    const page = bySlug.get(slug)
    if (page !== undefined) {
      for (const r of page.relations) {
        const objSlug = slugify(r.object)
        if (objSlug !== null && objSlug !== slug && bySlug.has(objSlug)) visit(objSlug)
      }
      inProgress.delete(slug)
      visited.add(slug)
      emitted.push(page)
    } else {
      inProgress.delete(slug)
      visited.add(slug)
    }
  }
  for (const slug of bySlug.keys()) visit(slug)
  return emitted
}

/** Deterministic timeline-entry body for a page — identical across the new-page
 *  and existing-page paths for the same input so the writer's (ts,source,body)
 *  dedup makes a repeated identical turn a no-op.
 *
 *  RB4 — when `supersede` is on and this page carries a superseding relation, the
 *  transition is recorded in the (append-only, dated) timeline body so the prior
 *  belief is preserved in history even after it leaves compiled-truth. The
 *  superseded object is referenced in a deliberately non-triggering form (an
 *  arrow, no `works at <slug>` verb pattern) so it can never re-derive an edge —
 *  the graph half is driven purely off compiled-truth. */
function timelineBody(page: PlannedPage, supersede: boolean): string {
  const fact = page.fact?.trim()
  const base = fact !== undefined && fact.length > 0 ? `Chat mention — ${fact}` : 'Mentioned in chat'
  if (!supersede) return base
  const notes = supersedeNotes(page)
  return notes.length > 0 ? `${base} · ${notes.join('; ')}` : base
}

/**
 * RB4 — one-line supersession notes for the timeline body. For each relation
 * carrying a valid `supersedes` marker, `prior-slug → new-slug (predicate)`.
 * Slugs are bare (no `[[wikilink]]`, no verb phrasing) so nothing re-extracts a
 * triple from the timeline text.
 */
function supersedeNotes(page: PlannedPage): string[] {
  const notes: string[] = []
  const seen = new Set<string>()
  for (const r of page.relations) {
    if (r.supersedes === undefined) continue
    const priorSlug = slugify(r.supersedes)
    const objSlug = slugify(r.object)
    if (priorSlug === null || objSlug === null || priorSlug === objSlug) continue
    const key = `${r.predicate}\x1f${priorSlug}\x1f${objSlug}`
    if (seen.has(key)) continue
    seen.add(key)
    notes.push(`superseded ${r.predicate}: ${priorSlug} → ${objSlug}`)
  }
  return notes
}

/** Render the relationship bullet lines for a page, deduped by (predicate,
 *  object) and skipping self-edges. */
function renderRelationLines(page: PlannedPage): string[] {
  const seen = new Set<string>()
  const relLines: string[] = []
  for (const r of page.relations) {
    const objSlug = slugify(r.object)
    if (objSlug === null) continue
    if (objSlug === page.slug) continue // no self-edges
    const key = `${r.predicate}\x1f${objSlug}`
    if (seen.has(key)) continue
    seen.add(key)
    const tmpl = RELATION_SENTENCE[r.predicate] ?? RELATION_SENTENCE['mentions']!
    relLines.push(`- ${tmpl(objSlug)}`)
  }
  return relLines
}

/** Fresh compiled-truth for a brand-new entity page. */
function composeNewCompiledTruth(page: PlannedPage): string {
  const lines: string[] = [`# ${page.name}`, '']
  if (page.fact !== undefined && page.fact.length > 0) {
    lines.push(page.fact.endsWith('.') ? page.fact : `${page.fact}.`)
  } else {
    lines.push(`Mentioned in chat (kind: ${page.kind}).`)
  }
  const relLines = renderRelationLines(page)
  if (relLines.length > 0) {
    lines.push('', '## Relationships', '', ...relLines)
  }
  return lines.join('\n') + '\n'
}

/**
 * Append-only merge: keep the existing compiled-truth VERBATIM and append ONLY
 * relationship lines whose specific (predicate, object) SENTENCE isn't already
 * asserted in it. Deduping on the full sentence — not merely on whether
 * `[[objSlug]]` appears anywhere — means a genuinely NEW predicate to an
 * already-referenced target (e.g. `works_at [[acme]]` after an earlier
 * `Mentions [[acme]]`) still appends, so the predicate upgrade reaches the graph
 * via auto-link.
 *
 * `removedLinks` is empty in the common case (every prior line is preserved, so
 * no prose or fact is ever retracted) — WITH ONE intended exception: a predicate
 * UPGRADE to an already-referenced target. Both sentences then live in the
 * compiled-truth, but `auto-link.ts` collapses to one triple per (subject,
 * object), keeping the strongest predicate (`bestByObject`, lowest `PREDICATES`
 * index; `works_at` outranks `mentions` — see `runtime/auto-link.ts:231-249`).
 * So `newLinks = [works_at acme]`, `previousLinks = [mentions acme]`, and
 * `diffTriples` (`entity-writer.ts`) yields `removedLinks = [mentions acme]`:
 * the weaker EDGE is superseded. The GBrain sync hook runs `remove_link`
 * (predicate-blind — deletes all link_types between the pair) before `add_link`
 * (`gbrain-memory/GBrainSyncHook.ts:133-146`), so the net graph state is
 * `works_at` present, `mentions` gone. NO fact is lost — the compiled-truth prose
 * (both sentences) is preserved verbatim; only the redundant weaker graph edge
 * collapses. The new *fact* is NOT written into compiled-truth (it lands in the
 * append-only timeline instead), so the entity's prose is never rewritten.
 */
function mergeExistingCompiledTruth(
  existing: string,
  page: PlannedPage,
  supersede: boolean,
): string {
  // RB4 — when perfect-recall is on, DROP the superseded object's sentence(s)
  // from the existing compiled-truth BEFORE the append pass. That single edit is
  // what turns accretion into belief-evolution: the writer's diff then sees the
  // stale triple in the OLD compiled-truth but not the NEW one, so `removedLinks`
  // carries it and the sync hook `remove_link`s the stale gbrain edge — while the
  // append below asserts the CURRENT fact and the append-only timeline keeps the
  // dated history. A no-op when no relation carries `supersedes`.
  const stripped = supersede ? stripSupersededSentences(existing, page) : existing
  const base = stripped.replace(/\s+$/, '') // trim trailing whitespace; we re-add \n
  const newLines: string[] = []
  for (const line of renderRelationLines(page)) {
    // `line` is `- <verb> [[objSlug]].`. Each (predicate, object) maps to a
    // unique sentence, so we dedup on the sentence body (sans the `- ` bullet,
    // since existing prose may not be bulleted). A new predicate to an existing
    // target produces a sentence the base lacks → it appends.
    const sentence = line.replace(/^-\s+/, '')
    if (base.includes(sentence)) continue
    newLines.push(line)
  }
  if (newLines.length === 0) {
    // Nothing new to add to the graph — preserve the page exactly. The new
    // timeline entry (added by writeEntity) is the only change.
    return base + '\n'
  }
  const hasRelHeader = /^##\s+Relationships\s*$/im.test(base)
  const parts = [base, '']
  if (!hasRelHeader) parts.push('## Relationships', '')
  parts.push(...newLines)
  return parts.join('\n') + '\n'
}

/**
 * RB4 temporal invalidation — drop every existing compiled-truth LINE that
 * asserts a superseded `(predicate, prior-object)` triple, one target per
 * superseding relation on this page.
 *
 * PREDICATE-SCOPED, not object-blind: the marker `works_at NewCo, supersedes
 * OldCo` retires ONLY the prior `works_at [[oldco]]` assertion — a separate,
 * still-current `Advises [[oldco]].` line survives (Codex RB4 r1 blocker 1). A
 * line qualifies purely by what it would contribute to the graph, computed with
 * the SAME `extractTypedLinks` the writer uses — so ALIASED wikilinks
 * (`[[oldco|OldCo]]`) and every verb-phrasing variant are matched exactly as the
 * edge extractor sees them (Codex RB4 r1 blocker 2), never a brittle literal
 * `[[oldco]]` substring.
 *
 * Dropping the line removes the triple from the NEW compiled-truth, so the
 * writer's `removedLinks` diff surfaces `works_at oldco` → the sync hook's
 * (predicate-blind) `remove_link` clears the pair and its add-pass re-asserts any
 * survivor edge (e.g. `advises oldco`, still present in the new truth). The prior
 * belief lives on in the append-only, dated timeline. Guards skip a `supersedes`
 * that resolves to the same slug as the new object (a no-op / mis-emit).
 */
function stripSupersededSentences(existing: string, page: PlannedPage): string {
  // Targets: `${predicate}\x1f${priorSlug}` triples to retire from compiled-truth.
  const targets = new Set<string>()
  for (const r of page.relations) {
    if (r.supersedes === undefined) continue
    const priorSlug = slugify(r.supersedes)
    const objSlug = slugify(r.object)
    if (priorSlug === null || objSlug === null) continue
    if (priorSlug === objSlug) continue // not a real supersession
    targets.add(`${r.predicate}\x1f${priorSlug}`)
  }
  if (targets.size === 0) return existing
  const kept = existing.split('\n').filter((line) => {
    if (!line.includes('[[')) return true // fast path: no wikilink → keeps
    // Extract what THIS line would contribute to the graph (subject = this
    // page), then drop the line iff it asserts a superseded (predicate, object).
    const triples = extractTypedLinks(`${line}\n`, page.slug, {
      sourceKind: page.kind,
      source: 'rb4-supersede-scan',
    })
    return !triples.some((t) => targets.has(`${t.predicate}\x1f${t.object}`))
  })
  return kept.join('\n')
}

/** What scribe needs to preserve from an existing on-disk page: its compiled-
 *  truth slice (for append-only merge) and its parsed frontmatter (so the
 *  populator's `mention_count`/`category`/… survive the rewrite). */
interface ExistingPage {
  compiledTruth: string
  frontmatter: Record<string, unknown>
}

/**
 * Read the on-disk page for `(kind, slug)`, or null when it doesn't exist yet
 * (or can't be read). Parses via the shared entity-format codec
 * (`@neutronai/runtime/entity-format.ts` — refactor P8 deleted the hand
 * mirrors that used to live here) so the merge preserves exactly what the
 * writer would re-emit.
 */
async function readExistingPage(
  ownerDataDir: string,
  kind: EntityKind,
  slug: string,
): Promise<ExistingPage | null> {
  const path = resolve(ownerDataDir, 'entities', KIND_TO_DIR[kind], `${slug}.md`)
  let body: string
  try {
    body = await readFile(path, 'utf8')
  } catch {
    return null // ENOENT (new page) or unreadable — treat as fresh
  }
  return { compiledTruth: extractCompiledTruth(body), frontmatter: parseFrontmatter(body) }
}

/**
 * Entity-slug grammar. Re-exported under the historical `slugify` name from
 * the shared `runtime/entity-slug` leaf (Open refactor P2-8) — the scribe and
 * import-populator copies were near-verbatim and must agree, so they now share
 * one implementation. See {@link entitySlugify}.
 */
export const slugify = entitySlugify
