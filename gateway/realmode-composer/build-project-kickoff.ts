/**
 * @neutronai/gateway/realmode-composer — one-time agentic per-project KICKOFF.
 *
 * Ryan, 2026-07-01: "instead of just a one-liner 'want to X?', pick some more
 * detailed meaty work and start on it, and present a draft document, or ask if
 * you want to schedule reminders for upcoming tasks/deadlines... more agentic
 * wow things rather than just being like a chat interface."
 *
 * At onboarding completion, for EACH materialized project, `emitProjectOpenings`
 * (build-onboarding-finalize.ts) now first asks this module for an agentic
 * opening. When a project carries enough signal to do a good job, the kickoff
 * does REAL work and returns a richer opening; otherwise it returns `null` and
 * the caller falls back to the existing deterministic prompt-the-user opening.
 *
 * HARD RULES (from the brief):
 *   - ONE-TIME only. This runs inside finalize's single per-project opening pass
 *     and the caller emits the result under the SAME durable dedupe key
 *     (`onboarding_opening:<project_id>`) as the deterministic opening, so it
 *     fills the ONE opening slot and never re-fires. NO cadence / cooldown /
 *     on-enter refresh / settings — none of the recurring wow machinery.
 *   - HARD data-sufficiency gate. A meaty action fires ONLY when the project has
 *     real context to do it well; thin work projects get `null` (→ deterministic
 *     opening). "Better nothing than a bad job" (Ryan): any doc-composition
 *     failure also degrades to `null` (or, for a hobby, to engaging questions)
 *     rather than a half-baked artifact.
 *
 * Action catalogue (best-fit per project, mirroring the wow `WowActionModule`
 * trigger/run contract without dragging in the button-prompt/cron `ActionRunner`
 * that the one-time plain-emit finalize path has no channel adapter for):
 *   - `draft-doc`        (work, rich)         compose a starting plan via the
 *                                             kickoff composer, write it
 *                                             create-if-missing under docs/,
 *                                             present a tappable doc-link, index
 *                                             it to GBrain recall.
 *   - `deadline-offer`   (work, has deadline) name concrete upcoming deadline(s)
 *                                             from the import and OFFER to set
 *                                             reminders (never auto-create; the
 *                                             live agent's `reminders_create`
 *                                             handles an accept).
 *   - `interest-research`(hobby, rich)        compose light starting notes for
 *                                             the interest; write + link + index.
 *   - `interest-questions`(hobby, thin)       ask 2-3 genuinely engaging
 *                                             questions to draw the owner out
 *                                             (a hobby's meaty action, not a
 *                                             fallback).
 *   - `null`             (work, thin)         no meaty action → deterministic
 *                                             prompt-the-user opening.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import type {
  MaterializeOutcome,
  ProjectPageIndexFn,
} from '@neutronai/onboarding/wow-moment/project-materializer.ts'
import { namesRelate } from '@neutronai/onboarding/wow-moment/project-identity.ts'
import {
  parseStatusMd,
  firstProseParagraph,
  type ProjectOpeningDocs,
} from './build-onboarding-handoff.ts'
import type { ProjectKickoffComposer } from './build-project-kickoff-composer.ts'

/** Upcoming-deadline window (ms). A proposed task due within this window of now
 *  is a concrete "upcoming deadline" worth offering a reminder for. */
export const DEADLINE_WINDOW_MS = 60 * 24 * 60 * 60 * 1_000

/** Max deadlines named in a single offer (keep the bubble tight). */
const MAX_DEADLINES_IN_OFFER = 3

/** The import-signal match shape the caller already computes per project. */
export interface KickoffMatch {
  name: string
  rationale: string
  suggested_topics: readonly string[]
}

/** Everything the kickoff needs about one materialized project. */
export interface KickoffInput {
  /** Canonical bind id (topic + on-disk repo key). */
  project_id: string
  name: string
  /** True iff materialized from a hobby/interest answer. */
  is_interest: boolean
  /** The materialized on-disk docs the caller already read (README / summary / STATUS). */
  docs: ProjectOpeningDocs
  /** The import-signal match (direct or synthesized), or null. */
  matched: KickoffMatch | null
  /** The onboarding import result (for deadline signal), or null. */
  import_result: ImportResult | null
  /** The materializer's per-project outcome (slice/summary signal), or null. */
  outcome: MaterializeOutcome | null
}

/** Which action fired + the opening body it produced. */
export interface KickoffResult {
  body: string
  action: 'draft-doc' | 'deadline-offer' | 'interest-research' | 'interest-questions'
  /** Repo-(docs-root)-relative path of a doc written this kickoff, if any. */
  doc_relpath?: string
  /** True iff the written doc was indexed to GBrain recall. */
  indexed: boolean
}

export interface ProjectKickoffDeps {
  /** OWNER_ROOT — `<owner_home>/Projects/<id>/docs/` is where kickoff docs land. */
  owner_home: string
  /** Instance internal handle (indexer origin). */
  project_slug: string
  /** CC-substrate doc composer. Null → doc actions are unavailable (work projects
   *  then fall through to `null`; hobbies fall through to engaging questions). */
  composer: ProjectKickoffComposer | null
  /** GBrain page indexer — when present, a written doc is re-indexed so recall
   *  surfaces it. Omit on instances without GBrain wired. */
  indexer?: ProjectPageIndexFn | null
  now?: () => number
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface ProjectKickoff {
  /** Compose the agentic opening for one project, or `null` to fall back to the
   *  deterministic prompt-the-user opening. Never throws. */
  composeKickoff(input: KickoffInput): Promise<KickoffResult | null>
}

/** Distilled, redacted per-project signal the gate + actions read. */
interface KickoffSignal {
  status_one_liner: string
  status_summary: string
  open_threads: string[]
  readme_prose: string
  rationale: string
  suggested_topics: string[]
  slice_chunks: number
  summary_written: boolean
  /** Upcoming deadlines from the import related to this project (title + due_at). */
  deadlines: Array<{ title: string; due_at: number }>
}

export function buildProjectKickoff(deps: ProjectKickoffDeps): ProjectKickoff {
  const now = deps.now ?? ((): number => Date.now())
  const log =
    deps.log ??
    ((msg: string, meta?: Record<string, unknown>): void => {
      // eslint-disable-next-line no-console
      console.warn(
        `[project-kickoff] project=${deps.project_slug} ${msg}${
          meta !== undefined ? ` ${safeMeta(meta)}` : ''
        }`,
      )
    })

  return {
    async composeKickoff(input: KickoffInput): Promise<KickoffResult | null> {
      try {
        const signal = assessSignal(input, now())

        if (input.is_interest) {
          // HOBBY — rich enough → light research doc; else engaging questions
          // (a hobby's meaty action, never a "bad job" fallback).
          if (hasInterestSignal(signal) && deps.composer !== null) {
            const doc = await tryDraftDoc(deps, input, signal, 'interest_brief', {
              relpath: 'starting-notes.md',
              title: `${input.name} - starting notes`,
              label: 'Starting notes',
              lead: `I did a little digging on ${input.name} and jotted some starting notes to explore`,
            })
            if (doc !== null) return doc
            // Compose failed → fall through to engaging questions (not null):
            // a hobby always gets a meaty opening, never the bare deterministic one.
          }
          return { body: composeInterestQuestions(input.name, signal), action: 'interest-questions', indexed: false }
        }

        // WORK — a concrete upcoming deadline is the highest-value, lowest-risk
        // move (no LLM artifact that could be wrong); offer a reminder for it.
        if (signal.deadlines.length > 0) {
          return {
            body: composeDeadlineOffer(input.name, signal.deadlines),
            action: 'deadline-offer',
            indexed: false,
          }
        }
        // Rich work project → draft a real starting plan.
        if (hasWorkSignal(signal) && deps.composer !== null) {
          const doc = await tryDraftDoc(deps, input, signal, 'draft_doc', {
            relpath: 'starting-plan.md',
            title: `${input.name} - starting plan`,
            label: 'Starting plan',
            lead: `I took a first pass at ${input.name} and drafted a starting plan`,
          })
          if (doc !== null) return doc
        }
        // Thin work project (or compose failed) → deterministic opening.
        return null
      } catch (err) {
        // Never throw into the finalize opening loop — degrade to the
        // deterministic opening (or, for a hobby, questions were already
        // returned above). A thrown error here means "fall back".
        log('kickoff failed; falling back to deterministic opening', {
          project: input.name,
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Signal + gates
// ---------------------------------------------------------------------------

function assessSignal(input: KickoffInput, nowMs: number): KickoffSignal {
  const status = input.docs.status_md !== null ? parseStatusMd(input.docs.status_md) : null
  const readme_prose = input.docs.readme !== null ? firstProseParagraph(input.docs.readme) : ''
  const suggested_topics = (input.matched?.suggested_topics ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length > 0)
  return {
    status_one_liner: status?.one_liner ?? '',
    status_summary: status?.summary ?? '',
    open_threads: status?.open_threads ?? [],
    readme_prose,
    rationale: (input.matched?.rationale ?? '').trim(),
    suggested_topics,
    slice_chunks: input.outcome?.slice_chunk_count ?? 0,
    summary_written: input.outcome?.summary_written ?? false,
    deadlines: relatedDeadlines(input, nowMs),
  }
}

/**
 * HARD data-sufficiency gate for a WORK project. Enough to draft a genuinely
 * useful starting plan when there is real substance to ground on: STATUS open
 * threads, a real transcript summary / matched transcript slices (import-derived
 * history), OR an import rationale paired with at least one suggested topic. A
 * bare deterministic-template README (no import signal) does NOT qualify on its
 * own — that is the "better nothing than a bad job" line.
 */
function hasWorkSignal(s: KickoffSignal): boolean {
  if (s.open_threads.length > 0) return true
  if (s.summary_written || s.slice_chunks > 0) return true
  if (s.rationale.length > 0 && s.suggested_topics.length > 0) return true
  return false
}

/**
 * Data-sufficiency gate for a HOBBY project. Enough for light research when the
 * import surfaced a basis (rationale), matched transcript history, or concrete
 * angles (suggested topics). Otherwise the hobby gets engaging questions.
 */
function hasInterestSignal(s: KickoffSignal): boolean {
  if (s.summary_written || s.slice_chunks > 0) return true
  if (s.rationale.length > 0) return true
  if (s.suggested_topics.length > 0) return true
  return false
}

/** Upcoming import-proposed deadlines (due within the window) related to this
 *  project by name/topic. Sorted soonest-first, capped for a tight offer. */
function relatedDeadlines(
  input: KickoffInput,
  nowMs: number,
): Array<{ title: string; due_at: number }> {
  const tasks = input.import_result?.proposed_tasks
  if (!Array.isArray(tasks)) return []
  const terms = [input.name, ...(input.matched?.suggested_topics ?? [])]
  const out: Array<{ title: string; due_at: number }> = []
  for (const t of tasks) {
    if (t === null || typeof t !== 'object') continue
    const title = typeof t.title === 'string' ? t.title.trim() : ''
    const due_at = typeof t.due_at === 'number' ? t.due_at : NaN
    if (title.length === 0 || !Number.isFinite(due_at)) continue
    // Upcoming only: due in the future, within the window.
    if (due_at <= nowMs || due_at > nowMs + DEADLINE_WINDOW_MS) continue
    if (!terms.some((term) => namesRelate(title, term))) continue
    out.push({ title, due_at })
  }
  out.sort((a, b) => a.due_at - b.due_at)
  return out.slice(0, MAX_DEADLINES_IN_OFFER)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface DraftDocPlan {
  /** Path relative to the project's docs/ root. */
  relpath: string
  /** `# <title>` heading + doc-link label basis. */
  title: string
  /** Human label for the tappable link. */
  label: string
  /** Opening-bubble lead-in ("I drafted X ..."). */
  lead: string
}

/**
 * Compose a doc via the kickoff composer, write it create-if-missing under
 * `Projects/<id>/docs/<relpath>`, index it to GBrain, and return an opening
 * whose body carries a tappable `docs:/` marker. Returns `null` on any failure
 * (compose threw/empty, or the doc already existed and we won't clobber) so the
 * caller degrades gracefully.
 */
async function tryDraftDoc(
  deps: ProjectKickoffDeps,
  input: KickoffInput,
  signal: KickoffSignal,
  kind: 'draft_doc' | 'interest_brief',
  plan: DraftDocPlan,
): Promise<KickoffResult | null> {
  if (deps.composer === null) return null
  const docsDir = join(deps.owner_home, 'Projects', input.project_id, 'docs')
  const abs = join(docsDir, plan.relpath)
  // Create-if-missing only — never clobber a doc the user (or a prior run) wrote.
  // An existing doc means we've already kicked this project off; fall back.
  if (existsSync(abs)) return null

  let body: string
  try {
    body = (
      await deps.composer({
        kind,
        project_name: input.name,
        doc_title: plan.title,
        context_lines: contextLines(signal),
      })
    ).trim()
  } catch (err) {
    ;(deps.log ?? (() => {}))('kickoff doc compose failed', {
      project: input.name,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (body.length === 0) return null

  try {
    mkdirSync(docsDir, { recursive: true })
    // ATOMIC create-if-missing (Codex P2): the `existsSync` above is a cheap
    // early-out, but two finalize/recovery paths can both pass it before either
    // writes. `flag: 'wx'` makes the create atomic + exclusive, so the loser
    // throws `EEXIST` and we fall back (never clobbering the winner's doc, which
    // the winner's opening already describes) rather than truncate-overwriting it.
    writeFileSync(abs, `${body}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    ;(deps.log ?? (() => {}))(
      code === 'EEXIST' ? 'kickoff doc already exists (concurrent create); falling back' : 'kickoff doc write failed',
      { project: input.name, err: err instanceof Error ? err.message : String(err) },
    )
    return null
  }

  // Index to GBrain recall (best-effort). The doc gist is appended to the
  // project's canonical page body so `memoryStore.query` surfaces it.
  let indexed = false
  if (deps.indexer !== null && deps.indexer !== undefined) {
    try {
      await deps.indexer({
        project_slug: input.project_id,
        name: input.name,
        body: indexPageBody(input, plan, body),
        source_path: `Projects/${input.project_id}`,
      })
      indexed = true
    } catch (err) {
      ;(deps.log ?? (() => {}))('kickoff doc index failed', {
        project: input.name,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const gist = firstProseParagraph(body)
  const gistClause = gist.length > 0 ? `: ${stripTrailingPunctuation(gist)}` : ''
  const marker = `[${plan.label}](docs:/${input.project_id}/${plan.relpath})`
  const body_out =
    `${plan.lead}${gistClause}. Have a look and tell me what to change - ${marker}.`
  return { body: body_out, action: kind === 'draft_doc' ? 'draft-doc' : 'interest-research', doc_relpath: plan.relpath, indexed }
}

/** A concrete, offer-only reminder pitch naming the upcoming deadline(s). The
 *  live agent's `reminders_create` handles an accept; we NEVER auto-create. */
function composeDeadlineOffer(
  name: string,
  deadlines: ReadonlyArray<{ title: string; due_at: number }>,
): string {
  const named = deadlines
    .map((d) => `${stripTrailingPunctuation(d.title)} (${formatDeadline(d.due_at)})`)
    .join(', ')
  const noun = deadlines.length === 1 ? 'a deadline coming up' : 'some deadlines coming up'
  return (
    `Looking at ${name}, you have ${noun}: ${named}. ` +
    `Want me to set reminders so they don't slip? Say the word and I'll schedule them.`
  )
}

/** Engaging questions to draw the owner out on a thin hobby. Deterministic (no
 *  LLM) so it always lands, and grounded only in the interest name. */
function composeInterestQuestions(name: string, signal: KickoffSignal): string {
  const lead =
    signal.status_one_liner.length > 0
      ? `${stripTrailingPunctuation(signal.status_one_liner)}.`
      : `I added ${name} to your projects and I'd love to help you get more out of it.`
  return (
    `${lead} To do that well, tell me a bit more: what first drew you to ${name}, ` +
    `where are you with it right now, and what would make it more fun or rewarding for you? ` +
    `With that I can dig up ideas, plan things out, or just keep track as you go.`
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redacted context lines handed to the composer — never raw transcript. */
function contextLines(s: KickoffSignal): string[] {
  const lines: string[] = []
  if (s.status_one_liner.length > 0) lines.push(`Summary: ${s.status_one_liner}`)
  else if (s.status_summary.length > 0) lines.push(`Summary: ${s.status_summary}`)
  else if (s.readme_prose.length > 0) lines.push(`Overview: ${s.readme_prose}`)
  if (s.rationale.length > 0) lines.push(`Why it matters: ${s.rationale}`)
  for (const thread of s.open_threads) lines.push(`Open thread: ${thread}`)
  if (s.suggested_topics.length > 0) lines.push(`Topics: ${s.suggested_topics.join(', ')}`)
  return lines
}

/** Project-page body re-indexed to GBrain so the drafted doc surfaces in recall. */
function indexPageBody(input: KickoffInput, plan: DraftDocPlan, docBody: string): string {
  const overview =
    input.docs.readme !== null ? firstProseParagraph(input.docs.readme) : input.matched?.rationale ?? ''
  const lines: string[] = [`# ${input.name}`, '']
  if (overview.length > 0) lines.push(overview, '')
  lines.push(`## ${plan.title}`, '', docBody.trim(), '')
  lines.push(`Project folder: Projects/${input.project_id}/`)
  return `${lines.join('\n').trimEnd()}\n`
}

/** Format a unix-ms deadline as a short, human date (no time-of-day). */
function formatDeadline(due_at: number): string {
  const d = new Date(due_at)
  return d.toISOString().slice(0, 10)
}

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.?!,;:]+$/, '').trim()
}

function safeMeta(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta)
  } catch {
    return '[unserializable meta]'
  }
}
