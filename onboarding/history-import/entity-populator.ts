/**
 * @neutronai/onboarding/history-import — entity-populator.
 *
 * 2026-05-25 (import-pipeline-resilience sprint, Bug D).
 *
 * After Pass-2 synthesis lands an `ImportResult` on `import_results`,
 * fan each extracted entity / inferred interest / voice-signal page
 * through `runtime/entity-writer.ts` so the per-project
 * `<ownerDataDir>/entities/<kind>/<slug>.md` filesystem (and the wired
 * GBrainSyncHook → GBrain KG) is populated from the user's very
 * first session. Without this fan-out the import pipeline produced
 * `import_results` JSON columns that no agent code ever read — the
 * "Neutron knows everything about you from first use" wow-moment was
 * undelivered.
 *
 * Idempotent. Each `writeEntity` call short-circuits on a byte-equal
 * rewrite, so re-running the populator (e.g. on a resumed-import
 * completion that surfaces the same entities again) writes no new
 * pages. The GBrainSyncHook's `onEntityWrite` is only fired when the
 * writer actually changed the on-disk page, so KG re-emits are also
 * suppressed on a no-op re-run.
 *
 * Best-effort. Individual `writeEntity` failures (e.g. invalid slug
 * after sanitisation, symlink-rejection) are logged and skipped — the
 * populator never throws so the calling job-runner's completed/partial
 * path continues regardless of fan-out trouble.
 */

import type { ImportResult, ImportSource, VoiceSignals } from './types.ts'
import type { EntityKind, SyncHook } from '../../runtime/entity-writer.ts'
import { entitySlugify } from '../../runtime/entity-slug.ts'
// Direct value import of writeEntity is deliberately avoided here so
// tests can inject a fake. Production passes `writeEntity` via deps.

/**
 * Minimum mention_count to write an entity page. Below this the LLM's
 * "saw it once" signal is too weak to materialise as a long-lived
 * compiled-truth page; the entity stays as a row on `import_results`
 * but doesn't pollute the entity tree.
 *
 * Matches the threshold the Pass-2 prompt uses when emitting
 * `candidate_entities` — keeps the populator's signal-density floor
 * consistent with the LLM's own.
 */
export const POPULATOR_MENTION_COUNT_MIN = 2

/**
 * Minimal `writeEntity` surface the populator depends on. Lets tests
 * pass a recorder without importing the file-touching real
 * implementation. Production wires the real `writeEntity` from
 * `runtime/entity-writer.ts`.
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
      // M2.6 Ph1 (#83) — own-origin attribution. Import content is the owner's
      // own history, so both equal the receiving owner's slug → passes the
      // quarantine guard.
      originInstance: string
      receivingInstanceSlug: string
    },
    deps?: { syncHook?: SyncHook },
  ): Promise<{ path: string; changed: boolean; newLinks: unknown[] }>
}

export interface EntityPopulatorInput {
  /** Absolute path to the project's Zone-B data dir. */
  ownerDataDir: string
  /** Owner slug for the timeline source citation. */
  project_slug: string
  /** Import job id for the timeline source citation. */
  job_id: string
  /** Which import surface produced the result (chatgpt-zip, claude-zip, etc.). */
  source: ImportSource
  /** Pass-2 synthesised result (or partial). */
  result: ImportResult
  /** Observation timestamp for the timeline entry. Caller injects so tests are deterministic. */
  now?: () => number
}

export interface EntityPopulatorDeps {
  writeEntity: WriteEntityFn
  /**
   * Optional GBrain sync hook. When provided, `writeEntity` invokes
   * `onEntityWrite` after each successful page change so the entity
   * lands in MemoryStore + the GBrain KG. When omitted the writer
   * still emits the on-disk markdown; KG population happens on the
   * next sync sweep / external repair pass.
   */
  syncHook?: SyncHook
  /** Optional failure sink. Defaults to console.warn. */
  logFailure?: (err: unknown, ctx: { kind: EntityKind; slug: string }) => void
}

export interface EntityPopulatorReport {
  pages_written: number
  pages_skipped: number
  /**
   * Best-effort count of memory KG edges that *may* have been emitted.
   * The sync hook is fire-and-forget so this is an upper bound (the
   * populator counts every `writeEntity` call whose `changed: true`
   * AND `syncHook !== undefined`; the hook's own per-triple kg_add
   * tally is opaque to us).
   */
  memory_edges: number
}

interface NormalisedCandidate {
  name: string
  slug: string
  mention_count: number
}

/**
 * Fan out a Pass-2 `ImportResult` into the project's entity filesystem.
 *
 * Per the 2026-05-25 sprint brief Part D, the fan-out rules are:
 *
 *   1. People — `facts.key_people[]` ∪ entities.kind='person'. Slug
 *      from the canonical name; compiled-truth body cites the import
 *      source + mention count. Timeline entry cites job_id + source.
 *   2. Companies — `facts.companies[]` ∪ entities.kind='company'.
 *   3. Concepts — entities.kind='concept'. Compiled-truth carries the
 *      1-line mention summary the LLM extracted.
 *   4. Interests — `inferred_interests[]`. Fan out as kind=concept
 *      (no `interest` kind in the entity-writer allowlist; the
 *      compiled-truth body distinguishes via the "Inferred non-work
 *      interest" prefix). `basis` + `cadence_hint` are surfaced when
 *      present.
 *   5. Voice signals — single page at `entities/concepts/voice-signals.md`
 *      with tone / verbosity / structure_pref / signature_phrases
 *      rendered as a structured compiled-truth body.
 *
 * Entities with `mention_count < POPULATOR_MENTION_COUNT_MIN` are
 * skipped (counted as `pages_skipped`). Voice signals are written
 * unconditionally when at least one field is populated.
 */
export async function populateEntitiesFromImport(
  input: EntityPopulatorInput,
  deps: EntityPopulatorDeps,
): Promise<EntityPopulatorReport> {
  const { ownerDataDir, source, result, job_id } = input
  const nowFn = input.now ?? (() => Date.now())
  const ts = new Date(nowFn()).toISOString()
  const sourceCitation = `import:${source}`
  const friendlySource = humanizeSource(source)

  const report: EntityPopulatorReport = {
    pages_written: 0,
    pages_skipped: 0,
    memory_edges: 0,
  }

  // 1) People — union(facts.key_people, entities[kind=person]).
  const peopleByName = new Map<string, NormalisedCandidate>()
  for (const name of result.facts.key_people ?? []) {
    addCandidate(peopleByName, name, /*mention_count*/ 1)
  }
  for (const e of result.entities) {
    if (e.kind === 'person') {
      addCandidate(peopleByName, e.name, e.mention_count)
    }
  }
  for (const c of peopleByName.values()) {
    if (c.mention_count < POPULATOR_MENTION_COUNT_MIN) {
      report.pages_skipped += 1
      continue
    }
    await writePage(report, deps, input.project_slug, {
      ownerDataDir,
      kind: 'person',
      slug: c.slug,
      frontmatter: {
        slug: c.slug,
        type: 'person',
        name: c.name,
        source: sourceCitation,
        mention_count: c.mention_count,
      },
      compiledTruth: composePersonOrCompanyBody({
        displayName: c.name,
        kindLabel: 'person',
        friendlySource,
        mention_count: c.mention_count,
      }),
      timeline: {
        ts,
        source: sourceCitation,
        body: `First seen during onboarding import (job=${job_id})`,
      },
    })
  }

  // 2) Companies — union(facts.companies, entities[kind=company]).
  const companiesByName = new Map<string, NormalisedCandidate>()
  for (const name of result.facts.companies ?? []) {
    addCandidate(companiesByName, name, /*mention_count*/ 1)
  }
  for (const e of result.entities) {
    if (e.kind === 'company') {
      addCandidate(companiesByName, e.name, e.mention_count)
    }
  }
  for (const c of companiesByName.values()) {
    if (c.mention_count < POPULATOR_MENTION_COUNT_MIN) {
      report.pages_skipped += 1
      continue
    }
    await writePage(report, deps, input.project_slug, {
      ownerDataDir,
      kind: 'company',
      slug: c.slug,
      frontmatter: {
        slug: c.slug,
        type: 'company',
        name: c.name,
        source: sourceCitation,
        mention_count: c.mention_count,
      },
      compiledTruth: composePersonOrCompanyBody({
        displayName: c.name,
        kindLabel: 'company',
        friendlySource,
        mention_count: c.mention_count,
      }),
      timeline: {
        ts,
        source: sourceCitation,
        body: `First seen during onboarding import (job=${job_id})`,
      },
    })
  }

  // 3) Concepts — entities[kind=concept]. The candidate-entity shape
  //    has no summary field so the body is just a mention citation;
  //    follow-up sessions enrich the compiled-truth via writeEntity.
  const conceptsByName = new Map<string, NormalisedCandidate>()
  for (const e of result.entities) {
    if (e.kind === 'concept') {
      addCandidate(conceptsByName, e.name, e.mention_count)
    }
  }
  for (const c of conceptsByName.values()) {
    if (c.mention_count < POPULATOR_MENTION_COUNT_MIN) {
      report.pages_skipped += 1
      continue
    }
    await writePage(report, deps, input.project_slug, {
      ownerDataDir,
      kind: 'concept',
      slug: c.slug,
      frontmatter: {
        slug: c.slug,
        type: 'concept',
        name: c.name,
        source: sourceCitation,
        mention_count: c.mention_count,
      },
      compiledTruth:
        `# ${c.name}\n\n` +
        `Mentioned ${c.mention_count} time${c.mention_count === 1 ? '' : 's'} ` +
        `in your ${friendlySource} import history.\n`,
      timeline: {
        ts,
        source: sourceCitation,
        body: `First seen during onboarding import (job=${job_id})`,
      },
    })
  }

  // 4) Interests — inferred_interests. Fan out as kind=concept (the
  //    entity-writer allowlist has no `interest` kind). The body
  //    leads with "Inferred non-work interest" so the page is
  //    distinguishable from a real concept later.
  for (const i of result.inferred_interests ?? []) {
    const slug = slugify(i.name)
    if (slug === null) {
      report.pages_skipped += 1
      continue
    }
    const basis = (i.basis ?? '').trim()
    const cadence = i.cadence_hint
    const lines: string[] = [`# ${i.name}`, '']
    lines.push(`Inferred non-work interest from your ${friendlySource} import.`)
    if (basis.length > 0) {
      lines.push('')
      lines.push(`Basis: ${basis}`)
    }
    if (cadence !== undefined) {
      lines.push('')
      lines.push(`Cadence hint: ${cadence}`)
    }
    await writePage(report, deps, input.project_slug, {
      ownerDataDir,
      kind: 'concept',
      slug,
      frontmatter: {
        slug,
        type: 'concept',
        name: i.name,
        source: sourceCitation,
        category: 'inferred_interest',
        ...(basis.length > 0 ? { basis } : {}),
        ...(cadence !== undefined ? { cadence_hint: cadence } : {}),
      },
      compiledTruth: lines.join('\n') + '\n',
      timeline: {
        ts,
        source: sourceCitation,
        body:
          basis.length > 0
            ? `Inferred from conversation patterns (basis: ${basis})`
            : `Inferred from conversation patterns`,
      },
    })
  }

  // 5) Voice signals — single page. Skip the write only when every
  //    field is empty (defensive against an empty VoiceSignals object).
  if (hasAnyVoiceSignal(result.voice_signals)) {
    await writePage(report, deps, input.project_slug, {
      ownerDataDir,
      kind: 'concept',
      slug: 'voice-signals',
      frontmatter: {
        slug: 'voice-signals',
        type: 'concept',
        name: 'Voice signals',
        source: sourceCitation,
        category: 'voice_signals',
      },
      compiledTruth: composeVoiceSignalsBody(result.voice_signals, friendlySource),
      timeline: {
        ts,
        source: sourceCitation,
        body: 'Voice signals extracted',
      },
    })
  }

  return report
}

interface WritePageJob {
  ownerDataDir: string
  kind: EntityKind
  slug: string
  frontmatter: Record<string, unknown>
  compiledTruth: string
  timeline: { ts: string; source: string; body: string }
}

async function writePage(
  report: EntityPopulatorReport,
  deps: EntityPopulatorDeps,
  ownSlug: string,
  job: WritePageJob,
): Promise<void> {
  const writeDeps: { syncHook?: SyncHook } =
    deps.syncHook !== undefined ? { syncHook: deps.syncHook } : {}
  try {
    const out = await deps.writeEntity(
      {
        ownerDataDir: job.ownerDataDir,
        kind: job.kind,
        slug: job.slug,
        body: {
          frontmatter: job.frontmatter,
          compiledTruth: job.compiledTruth,
          timelineAppend: job.timeline,
        },
        // M2.6 Ph1 (#83) — own-origin stamp. Import content is the owner's own
        // history, so origin === receiving → quarantine guard passes.
        originInstance: ownSlug,
        receivingInstanceSlug: ownSlug,
      },
      writeDeps,
    )
    if (out.changed) {
      report.pages_written += 1
      if (deps.syncHook !== undefined) {
        // Upper-bound estimate: 1 edge per changed page. The hook may
        // emit multiple kg_add calls (one per Triple) but we have no
        // visibility into that without the hook surfacing a count.
        report.memory_edges += 1
      }
    } else {
      report.pages_skipped += 1
    }
  } catch (err) {
    report.pages_skipped += 1
    const sink =
      deps.logFailure ??
      ((e: unknown, ctx: { kind: EntityKind; slug: string }): void => {
        // eslint-disable-next-line no-console
        console.warn(
          `[entity-populator] writeEntity failed kind=${ctx.kind} slug=${ctx.slug}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      })
    sink(err, { kind: job.kind, slug: job.slug })
  }
}

function addCandidate(
  bucket: Map<string, NormalisedCandidate>,
  rawName: string,
  mention_count: number,
): void {
  if (typeof rawName !== 'string') return
  const trimmed = rawName.trim()
  if (trimmed.length === 0) return
  const slug = slugify(trimmed)
  if (slug === null) return
  const existing = bucket.get(slug)
  if (existing === undefined) {
    bucket.set(slug, { name: trimmed, slug, mention_count })
  } else {
    existing.mention_count += mention_count
  }
}

/**
 * Entity-slug grammar. Re-exported under the historical `slugify` name from
 * the shared `runtime/entity-slug` leaf (Open refactor P2-8) so the producer
 * and the entity-writer validator can never drift. See {@link entitySlugify}.
 */
export const slugify = entitySlugify

function composePersonOrCompanyBody(args: {
  displayName: string
  kindLabel: 'person' | 'company'
  friendlySource: string
  mention_count: number
}): string {
  const { displayName, kindLabel, friendlySource, mention_count } = args
  return (
    `# ${displayName}\n\n` +
    `First mentioned in your ${friendlySource} import. ` +
    `Mentioned ${mention_count} time${mention_count === 1 ? '' : 's'} ` +
    `across the analyzed conversations (kind: ${kindLabel}).\n`
  )
}

function composeVoiceSignalsBody(vs: VoiceSignals, friendlySource: string): string {
  const lines: string[] = ['# Voice signals', '']
  lines.push(`Extracted from your ${friendlySource} import.`)
  lines.push('')
  if (vs.tone !== undefined) {
    lines.push(`- Tone: ${vs.tone}`)
  }
  if (vs.verbosity !== undefined) {
    lines.push(`- Verbosity: ${vs.verbosity}`)
  }
  if (vs.structure_pref !== undefined) {
    lines.push(`- Structure preference: ${vs.structure_pref}`)
  }
  const phrases = (vs.signature_phrases ?? []).filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  )
  if (phrases.length > 0) {
    lines.push('')
    lines.push('Signature phrases:')
    for (const p of phrases) {
      lines.push(`- ${p}`)
    }
  }
  return lines.join('\n') + '\n'
}

function hasAnyVoiceSignal(vs: VoiceSignals): boolean {
  if (vs.tone !== undefined) return true
  if (vs.verbosity !== undefined) return true
  if (vs.structure_pref !== undefined) return true
  if ((vs.signature_phrases ?? []).some((p) => typeof p === 'string' && p.trim().length > 0)) {
    return true
  }
  return false
}

function humanizeSource(source: ImportSource): string {
  switch (source) {
    case 'chatgpt-zip':
      return 'ChatGPT'
    case 'claude-zip':
      return 'Claude.ai'
    case 'gmail-oauth':
      return 'Gmail'
    case 'calendar-oauth':
      return 'Calendar'
    case 'drive-oauth':
      return 'Drive'
    case 'notion-oauth':
      return 'Notion'
    case 'slack-oauth':
      return 'Slack'
    default:
      return source
  }
}
