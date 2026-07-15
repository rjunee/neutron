/**
 * @neutronai/onboarding/wow-moment — project identity + context synthesis.
 *
 * ISSUES #95. Two helpers shared across the wow-moment project-shell
 * action AND the gateway onboarding-handoff hook so the two surfaces
 * converge on ONE project identity:
 *
 *   - `slugifyProjectId(name)` — the canonical name → project_id
 *     slugifier. `gateway/wiring/build-onboarding-handoff.ts`
 *     re-exports this as `defaultProjectIdSlugifier`; both the sidebar's
 *     `projects` rows (written by `03-project-shells`) AND the
 *     per-project proactive-seed prompts (`web:<user_id>:<slug>`, written
 *     by the handoff hook) key off the SAME slug. Pre-#95 the shell
 *     action minted a fresh random UUID per run, so the named sidebar
 *     project and the seed-question topic were two disconnected things
 *     (and re-runs piled up orphans). Keying both off the slug unifies
 *     them and makes creation idempotent.
 *
 *   - `synthesizeProjectContext(...)` — a deterministic one-paragraph
 *     context string stored in `projects.description` so a freshly
 *     created project is never a nameless/contextless placeholder. The
 *     rich proactive opening question is owned by the handoff hook's
 *     `composeProjectSeed` path; this is the durable at-rest context.
 *
 * The slugifier matches the `sanitizeProjectId` contract in
 * `channels/adapters/app-ws/envelope.ts` (`[A-Za-z0-9_.-]`, capped) so a
 * project_id produced here round-trips through the app-ws + app-projects
 * surfaces.
 */

import type { ImportResult } from '../history-import/types.ts'
import type { CapturedProject } from './action-types.ts'

/**
 * Canonical project-id slugifier. Lowercase, replace any run of
 * non-`[a-z0-9._-]` chars with `-`, trim leading/trailing `-`, cap at 64
 * chars. Returns `'project'` when the input collapses to empty
 * (all-emoji / all-punctuation names).
 *
 * MUST stay identical to `defaultProjectIdSlugifier` in
 * `gateway/wiring/build-onboarding-handoff.ts` (which now
 * re-exports this function). A drift-guard test asserts equality.
 */
export function slugifyProjectId(name: string): string {
  const lowered = name.toLowerCase()
  const replaced = lowered.replace(/[^a-z0-9._-]+/g, '-')
  const trimmed = replaced.replace(/^-+|-+$/g, '')
  const capped = trimmed.slice(0, 64)
  return capped.length === 0 ? 'project' : capped
}

/** Hard cap on the synthesized at-rest context paragraph. */
export const PROJECT_CONTEXT_MAX_CHARS = 480

/**
 * Cross-project signal a project name relates to but that did NOT come
 * from a matched `proposed_projects` rationale. GAP2 (2026-06-09): a
 * freeform-added project ("Buddhism", "Biohacking") that has no
 * `proposed_projects` row by name is NOT signal-free — the import's
 * entities / topics / inferred_interests frequently carry threads that
 * relate to it by name. Surfacing those turns the bland "I don't have
 * history on it yet" stub into real, content-aware context.
 *
 * `entities` / `topics` are the deduped names; `interests` are the
 * `inferred_interests[].name` matches. All three are already filtered to
 * items whose name relates to the project name (case-insensitive
 * substring either direction) so the caller can weave them directly.
 */
export interface RelatedImportSignal {
  entities: string[]
  topics: string[]
  interests: string[]
}

/**
 * Scan a Pass-2 `import_result` for cross-project signal that relates to
 * `name` by a case-insensitive substring match (either direction, so
 * "Biohacking" matches an inferred interest "biohacking / cold plunge"
 * AND a topic "biohacking" matches the project "Biohacking & Sleep").
 *
 * This is the engine behind the content-aware path for UNMATCHED
 * projects: even when no `proposed_projects` row carries the project
 * name, the entities / topics / inferred_interests the import surfaced
 * across the whole history may name the same thing. Returns empty arrays
 * (never throws) when the import is null OR genuinely carries nothing
 * related — that's the only case the caller falls to the generic stub.
 *
 * Each list is deduped (case-insensitive, first-seen casing wins) and
 * capped at `RELATED_SIGNAL_CAP` so a runaway import can't blow up the
 * woven paragraph. Order preserves the import's own ranking (entities /
 * topics arrive recency/mention sorted from Pass-2).
 *
 * Exported for unit testing + reuse by the handoff composer.
 */
export const RELATED_SIGNAL_CAP = 4

export function findRelatedImportSignal(
  name: string,
  import_result: ImportResult | null,
): RelatedImportSignal {
  const empty: RelatedImportSignal = { entities: [], topics: [], interests: [] }
  if (import_result === null) return empty
  const target = name.trim().toLowerCase()
  if (target.length === 0) return empty
  const entities = collectRelated(
    Array.isArray(import_result.entities) ? import_result.entities : [],
    (e) => (e !== null && typeof e === 'object' && typeof e.name === 'string' ? e.name : ''),
    target,
  )
  const topics = collectRelated(
    Array.isArray(import_result.topics) ? import_result.topics : [],
    (t) => (t !== null && typeof t === 'object' && typeof t.name === 'string' ? t.name : ''),
    target,
  )
  const interests = collectRelated(
    Array.isArray(import_result.inferred_interests) ? import_result.inferred_interests : [],
    (i) => (i !== null && typeof i === 'object' && typeof i.name === 'string' ? i.name : ''),
    target,
  )
  return { entities, topics, interests }
}

/**
 * Public wrapper over `relatesByName` for callers outside this module
 * (Item 4's project materializer matches retained transcript chunks'
 * Pass-1 candidate names against a project's term set). Symmetric enough
 * for that use: exact (case-insensitive) phrase equality OR a shared
 * whole word-token of ≥ `MIN_RELATE_TOKEN_LEN` chars.
 */
export function namesRelate(a: string, b: string): boolean {
  return relatesByName(a.trim().toLowerCase(), b.trim().toLowerCase())
}

/** Minimum length of a shared word-token for two names to be considered
 *  related. Bare substring matching (the pre-Codex-review shape) let short
 *  signals like "AI" / "PR" / "HR" match unrelated names that merely
 *  contain those letters (e.g. topic "AI" matching project "Daily Review"
 *  via the "ai" inside "Daily"). Requiring a SHARED WHOLE TOKEN of ≥ this
 *  length kills those false positives while still matching the real cases. */
const MIN_RELATE_TOKEN_LEN = 4

/** True iff the project name and a signal name relate. Either an exact
 *  (case-insensitive) phrase match, OR they share a whole word-token of at
 *  least `MIN_RELATE_TOKEN_LEN` chars. Token (not substring) matching means
 *  a long signal ("Tibetan Buddhism daily practice") still matches a short
 *  project name ("Buddhism") via the shared "buddhism" token, AND a long
 *  project name ("Buddhism & meditation") still matches a short signal
 *  ("buddhism") — but "AI" no longer matches "Daily". A short project whose
 *  name carries no ≥4-char token (e.g. "AI", "n8n") simply falls through to
 *  the generic-but-named context, which is the safe outcome. */
function relatesByName(signalLower: string, target: string): boolean {
  if (signalLower.length === 0) return false
  if (signalLower === target) return true
  const signalTokens = new Set(tokenizeName(signalLower))
  for (const tok of tokenizeName(target)) {
    if (tok.length >= MIN_RELATE_TOKEN_LEN && signalTokens.has(tok)) return true
  }
  return false
}

/** Lowercase alphanumeric word-tokens of a name (split on any run of
 *  non-`[a-z0-9]`). Caller passes an already-lowercased string. */
function tokenizeName(lowered: string): string[] {
  return lowered.split(/[^a-z0-9]+/).filter((t) => t.length > 0)
}

/** Pull related names from a row list, dedup case-insensitively, cap. */
function collectRelated<T>(
  rows: ReadonlyArray<T>,
  getName: (row: T) => string,
  target: string,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const raw = getName(row).trim()
    if (raw.length === 0) continue
    const lower = raw.toLowerCase()
    if (!relatesByName(lower, target)) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(raw)
    if (out.length >= RELATED_SIGNAL_CAP) break
  }
  return out
}

/**
 * Build a deterministic, non-empty at-rest context paragraph for a
 * confirmed project. Priority:
 *   1. The user's own rationale captured at `projects_proposed`.
 *   2. The Pass-2 import synthesis rationale for the matching project.
 *   3. GAP2 (2026-06-09): cross-project import signal — entities / topics
 *      / inferred_interests whose name relates to the project name. This
 *      makes a freeform-added project ("Buddhism", "Biohacking") that
 *      never name-matched a `proposed_projects` row STILL open with real
 *      context drawn from what the import learned about it.
 *   4. A generic-but-named acknowledgement (never a bare placeholder) —
 *      reached only when the import is null OR carries zero related
 *      signal.
 *
 * This is the value persisted to `projects.description`. It is always
 * non-empty and always names the project, so the settings drawer + the
 * sidebar render real context even when no LLM polish ran.
 */
export function synthesizeProjectContext(
  project: CapturedProject,
  import_result: ImportResult | null,
): string {
  const name = project.name.trim()
  const ownRationale = (project.rationale ?? '').trim()
  if (ownRationale.length > 0) {
    return clampContext(ensureSentence(ownRationale))
  }
  const imported = findImportedRationale(name, import_result)
  if (imported.length > 0) {
    return clampContext(ensureSentence(imported))
  }
  // Priority 3 — no matched rationale, but the import may carry
  // cross-project signal that names this project. Weave it into a
  // content-aware paragraph instead of the bland stub.
  const related = findRelatedImportSignal(name, import_result)
  const woven = weaveRelatedSignal(name, related)
  if (woven.length > 0) {
    return clampContext(woven)
  }
  return clampContext(
    `${name} — added to your projects during onboarding. I don't have history on it yet; tell me the context and what you'd like me to track.`,
  )
}

/**
 * True iff there is REAL import/project-derived grounding for this project
 * beyond the generic "added during onboarding" stub. Mirrors the priority
 * ladder in `synthesizeProjectContext`: the project's OWN rationale (an import
 * proposed_projects rationale or an interest's basis), an import
 * proposed_projects rationale matched by name, or cross-project import signal
 * (related entities/topics/interests) that names it. When this returns false,
 * `synthesizeProjectContext` falls through to the generic no-history stub — i.e.
 * the project has NO context.
 *
 * NB: raw transcript slices (import_pass1_chunks matched to the project) are an
 * ADDITIONAL context source that requires a DB read; the materializer checks
 * those separately (`slices.chunks.length > 0`) and OR-s them with this. This
 * predicate covers only the import-result / project-derived signal, so it stays
 * pure + DB-free and is safe to call anywhere.
 *
 * Exported for the materializer's data-sufficiency gate (minimal no-context
 * STATUS.md + honest no-context opening) and for unit testing.
 */
export function hasRealProjectContext(
  project: CapturedProject,
  import_result: ImportResult | null,
): boolean {
  const name = project.name.trim()
  if ((project.rationale ?? '').trim().length > 0) return true
  if (findImportedRationale(name, import_result).length > 0) return true
  const related = findRelatedImportSignal(name, import_result)
  return weaveRelatedSignal(name, related).length > 0
}

/**
 * Turn the related cross-project signal into a 1-2 sentence context
 * paragraph that names concrete threads/entities. Returns '' when there
 * is genuinely nothing related (caller falls to the generic stub).
 *
 * Exported for unit testing.
 */
export function weaveRelatedSignal(name: string, related: RelatedImportSignal): string {
  const fragments: string[] = []
  if (related.topics.length > 0) {
    fragments.push(`threads on ${joinNames(related.topics)}`)
  }
  if (related.entities.length > 0) {
    fragments.push(`mentions of ${joinNames(related.entities)}`)
  }
  if (related.interests.length > 0) {
    fragments.push(`an interest in ${joinNames(related.interests)}`)
  }
  if (fragments.length === 0) return ''
  return `${name} — from your history I picked up ${joinFragments(fragments)}. Tell me what you'd like me to focus on here.`
}

/** Join up to N names into an English list ("A, B and C"). */
function joinNames(names: ReadonlyArray<string>): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Join clause fragments with semicolons (they already contain commas). */
function joinFragments(fragments: ReadonlyArray<string>): string {
  if (fragments.length === 1) return fragments[0]!
  if (fragments.length === 2) return `${fragments[0]} and ${fragments[1]}`
  return `${fragments.slice(0, -1).join('; ')}; and ${fragments[fragments.length - 1]}`
}

function findImportedRationale(
  name: string,
  import_result: ImportResult | null,
): string {
  if (import_result === null) return ''
  const proposed = import_result.proposed_projects
  if (!Array.isArray(proposed)) return ''
  const target = name.toLowerCase()
  for (const row of proposed) {
    if (row === null || typeof row !== 'object') continue
    const rowName = typeof row.name === 'string' ? row.name.trim().toLowerCase() : ''
    if (rowName !== target) continue
    return typeof row.rationale === 'string' ? row.rationale.trim() : ''
  }
  return ''
}

function ensureSentence(s: string): string {
  const t = s.trim()
  if (t.length === 0) return t
  return /[.!?]$/.test(t) ? t : `${t}.`
}

function clampContext(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= PROJECT_CONTEXT_MAX_CHARS) return trimmed
  const trunc = trimmed.slice(0, PROJECT_CONTEXT_MAX_CHARS - 1)
  const lastBoundary = Math.max(
    trunc.lastIndexOf('. '),
    trunc.lastIndexOf('! '),
    trunc.lastIndexOf('? '),
  )
  if (lastBoundary > Math.floor(PROJECT_CONTEXT_MAX_CHARS * 0.5)) {
    return `${trunc.slice(0, lastBoundary + 1).trim()}…`
  }
  return `${trunc.trim()}…`
}
