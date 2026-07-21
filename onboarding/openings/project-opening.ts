/**
 * @neutronai/gateway/wiring — onboarding handoff hook factory.
 *
 * Per the 2026-05-28 sidebar + per-project chat topology sprint, extended
 * 2026-05-29 with content-aware seeds, REDESIGNED 2026-06-11 for Item 5
 * of the post-onboarding experience (ISSUES #208,
 * docs/plans/project-opening-message-redesign-2026-06-10.md +
 * docs/plans/post-onboarding-experience-spec-2026-06-10.md § ITEM 5).
 *
 * The engine fires `onboardingHandoff.emitProjectSeeds(...)` on the
 * `wow_fired` → `completed` transition with the captured-project list
 * pulled from `phase_state.primary_projects_confirmed` AND the Pass-2
 * `import_result` (when present). The production implementation in this
 * file walks that list and emits one `button_prompts` row per project
 * under `web:<user_id>:<project_id>` via the per-instance `ButtonStore`.
 * The sidebar's `/api/v1/chat/topics` endpoint then surfaces the row as
 * a per-project topic with an unread badge, so the user sees "General"
 * + one row per project the first time they open `/chat` post-
 * onboarding.
 *
 * Opening-message shape (Item 5, 2026-06-11 — replaces the templated
 * rationale + Summarise-X button wall):
 *
 *   <free-form PARAGRAPH — what the project actually IS, LLM-synthesized
 *    from the project's MATERIALIZED docs (Item 4: Projects/<slug>/README.md
 *    + docs/transcript-summary.md) with the import_result as fallback signal>
 *
 *   <exactly ONE next move — a suggested action, OR an offer to set a
 *    reminder (offer only, never auto-created), OR "What would you like
 *    to do next?">
 *
 *   options: []  +  allow_freeform: true   — NO buttons; the user types.
 *
 * Fallback (import skipped / genuinely no signal / no materialized docs),
 * per the narrow spec § 4.4:
 *
 *   You added <Name> to your projects. I don't have history on it yet -
 *   tell me what it is and what you want me to track, and I'll take it
 *   from there.
 *
 * Bodies are bounded at `OPENING_MESSAGE_MAX_CHARS` (700 chars — Sam-
 * approved, richer than the previous 480 because paragraph + next-move
 * is the whole point) and em dashes are normalized to hyphens (hard
 * rule) before emit.
 *
 * LLM composition: the factory accepts a `composeProjectOpening`
 * callable (production: `buildProjectOpeningMessageComposer` in
 * `build-project-opening-message.ts`, CC-substrate-backed via the
 * gateway `anthropicClient` shim — NO direct api.anthropic.com, hard
 * rule). Per-project failures fall back to the deterministic prose so
 * one bad LLM round-trip doesn't strand the whole batch. When unwired
 * (tests, Open self-hosters without an Anthropic client) the
 * deterministic path always produces a usable body.
 *
 * Generation is EAGER at the wow→completed transition (same site as the
 * old seeds — Sam-approved: no first-open spinner; Item 4's
 * materialization runs earlier in the SAME transition via the wow
 * dispatcher's action 03, so the docs are on disk by the time this hook
 * fires; when materialization failed/raced the doc reads return null
 * and the composer degrades to import-signal-only input).
 *
 * Idempotency: each opening uses an `idempotency_key` derived from
 * `(owner_slug, topic_id, 'onboarding_handoff_seed')` so a re-fire on
 * engine retry collapses onto the same row (the engine's existing
 * wow_fired re-entry guard prevents this for completed flows, but the
 * key is belt-and-braces against a future regression).
 *
 * Best-effort: failures inside `emitProjectSeeds` are caught by the
 * engine (see `dispatchWowAndAdvance`); the user still advances to
 * `completed`. Per-row emit failures are caught locally so a bad
 * project name doesn't take down the whole batch.
 *
 * LEGACY NOTE — the pre-Item-5 button values (`show-context`,
 * `starter-N`, `tell-me-what-you-know`, `not-now`,
 * `ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE`) still exist on already-
 * emitted rows in live project DBs. The inbound router
 * (`gateway/http/chat-bridge.ts`) keeps handling them (left inert /
 * routed to the live agent per ISSUES #204); only NEW emits are
 * button-less.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OnboardingHandoffHook } from '@neutronai/onboarding/interview/engine.ts'
import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import {
  slugifyProjectId,
  findRelatedImportSignal,
  type RelatedImportSignal,
} from '@neutronai/onboarding/wow-moment/project-identity.ts'

/**
 * Hard cap on the opening-message body. ~700 chars fits a 2-4 sentence
 * paragraph + a one-sentence next-move comfortably (Sam-approved over
 * the previous 480-char seed cap — richer prose is the point of Item 5)
 * while staying one ergonomic chat bubble on mobile. Longer bodies tend
 * to indicate the LLM ran away — better to truncate cleanly at a
 * sentence boundary.
 */
export const OPENING_MESSAGE_MAX_CHARS = 700

/**
 * Per-doc cap on the materialized-doc content fed to the LLM composer.
 * README + transcript-summary are each 1-2 screens by Item 4's own
 * output budget; this bound is defense against a user-edited 5 MB
 * README blowing up the prompt.
 */
export const PROJECT_DOC_MAX_CHARS = 12_000

/**
 * ISSUES #69 Argus r1 MINOR 2 (2026-05-30) — LEGACY: the `[B] Skip for
 * now` button's `value` on the pre-Item-5 no-match fallback seed.
 *
 * Item 5 (2026-06-11) removed ALL buttons from newly-emitted openings,
 * but rows emitted before the cutover still carry this value in live
 * project DBs, and `handleProjectTopicInbound`
 * (`gateway/http/chat-bridge.ts`) still special-cases it to keep the
 * silent-skip contract for those rows. Keep the shared const until the
 * last pre-Item-5 row ages out.
 */
export const ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE = 'skip-for-now'

/**
 * Materialized per-project docs (Item 4) handed to the opening-message
 * composer as its PRIMARY source. Null fields mean the doc does not
 * exist on disk (import skipped, materialization failed/raced, or the
 * project genuinely has no transcript-summary) — the composer then
 * leans on the import signal instead.
 */
export interface ProjectOpeningDocs {
  /** `Projects/<slug>/README.md` content (capped), or null. */
  readme: string | null
  /** `Projects/<slug>/docs/transcript-summary.md` content (capped), or null. */
  transcript_summary: string | null
  /**
   * BUG #308 fix (2026-06-19) — `Projects/<slug>/STATUS.md` content
   * (capped), or null. The materializer writes this as the completion
   * marker for every project (`project-materializer.ts` renderStatusMd),
   * so it is the highest-signal source for the opening: it carries the
   * project's one-liner, status, priority, and (once worked) its open
   * threads. The opening SUMMARIZES it rather than emitting a generic
   * "want me to dig into X?".
   */
  status_md: string | null
}

/**
 * Composed opening-message body. Just prose — Item 5 has NO buttons, so
 * unlike the retired `ProjectSeedComposition` there are no action
 * labels. The body is finalized (em-dash normalization + 700-char
 * clamp) at the emit site, so composers may return raw prose.
 */
export interface ProjectOpeningComposition {
  body: string
}

/**
 * Input the LLM opening composer receives. Mirrors the shape the
 * deterministic helper reads from so swapping in the LLM path is a
 * 1-to-1 substitution at the call site.
 */
export interface ComposeProjectOpeningInput {
  /** Human-readable project name as the user supplied it. */
  name: string
  /**
   * Matching Pass-2 synthesis row when present — the literal
   * `proposed_projects` row, or the GAP2 cross-project-signal stand-in
   * synthesized from related entities/topics/interests. Null only when
   * there is genuinely no import signal for this project.
   */
  imported_project: { name: string; rationale: string; suggested_topics: readonly string[] } | null
  /**
   * The full Pass-2 result so the composer can pull cross-project
   * signal (facts, voice register) when the per-project row is light
   * on detail. Null when the user skipped the import entirely.
   */
  import_result: ImportResult | null
  /**
   * Item 4 materialized docs — the PRIMARY synthesis source. Higher
   * signal than the one-line rationale because they are already
   * project-scoped syntheses over the retained transcript slices.
   */
  project_docs: ProjectOpeningDocs
  owner_slug: string
  user_id: string
  /**
   * The materialized project's id. When present, the LLM opening-message
   * composer threads it onto the substrate dispatch as
   * `metering_context.project_id` (ISSUES #378) so the opening composes in THIS
   * project's OWN per-project `cc-agent-*` warm session — isolated from every
   * other project's transcript by construction. Optional so the deterministic
   * path + older callers/tests remain unchanged.
   */
  project_id?: string
}

export type ComposeProjectOpeningFn = (
  input: ComposeProjectOpeningInput,
) => Promise<ProjectOpeningComposition>

/**
 * Doc-read seam. Production default reads
 * `<owner_home>/Projects/<owner_slug>/<relpath>` (built via
 * `buildProjectDocReader`); tests inject a stub. Returns null when the
 * file does not exist or cannot be read — never throws.
 */
export type ReadProjectDocFn = (owner_slug: string, relpath: string) => string | null

export interface BuildOnboardingHandoffOptions {
  /** Per-instance button-prompt store. The opening rows persist here so the
   *  sidebar's /api/v1/chat/topics + /api/v1/chat/history endpoints
   *  surface them on the user's next chat surface load. */
  buttonStore: ButtonStore
  /** Sanitiser to derive a project_id from the human-readable name.
   *  Default: lowercase, replace runs of non-[A-Za-z0-9.-_] with `-`,
   *  trim leading/trailing `-`, fall back to `project` when empty. */
  toProjectId?: (name: string) => string
  /**
   * Item 5 (2026-06-11) — optional LLM opening-message composer. When
   * wired (production: `buildProjectOpeningMessageComposer`, Opus over
   * the CC substrate), called once per project with the materialized
   * docs + structured import data; the returned body is the opening
   * bubble. When omitted (tests + Open self-hosters without an
   * Anthropic client), the deterministic prose path takes over — same
   * shape, blander paragraph.
   *
   * Per-project failures (LLM throws, timeout, malformed body) are
   * caught here: the project gets the deterministic fallback while
   * OTHER projects still get their LLM-composed openings.
   */
  composeProjectOpening?: ComposeProjectOpeningFn
  /**
   * Item 5 — OWNER_ROOT for the default materialized-doc reader (the
   * same `owner_home` the wow dispatcher hands the Item 4 materializer,
   * so reads land on the exact tree `materialize()` wrote). When BOTH
   * this and `readProjectDoc` are omitted, doc reads return null and
   * the composer runs on import signal alone (pre-Item-4 degradation).
   */
  owner_home?: string
  /** Item 5 — test seam overriding the default doc reader. */
  readProjectDoc?: ReadProjectDocFn
  /**
   * 2026-05-29 r2 — max number of `composeProjectOpening` calls in
   * flight at once. Defaults to `DEFAULT_COMPOSER_CONCURRENCY` (4).
   * Clamped to `[1, 16]`. Smaller values trade latency for spend /
   * rate-limit headroom; larger values are bounded so a 100-project
   * edge case cannot DoS the Anthropic client. Pass 1 in tests that
   * want strict ordering observability.
   */
  composerConcurrency?: number
}

/**
 * Default materialized-doc reader. Reads
 * `<owner_home>/Projects/<slug>/<relpath>` — the exact tree the Item 4
 * materializer (`onboarding/wow-moment/project-materializer.ts`) wrote
 * during the wow dispatch earlier in the same transition. Caps content
 * at `PROJECT_DOC_MAX_CHARS`; returns null on missing file or any read
 * error (never throws — a doc-read hiccup must not strand the batch).
 *
 * Exported for unit testing + the landing-stack wiring.
 */
export function buildProjectDocReader(opts: { owner_home: string }): ReadProjectDocFn {
  return (owner_slug: string, relpath: string): string | null => {
    try {
      const abs = join(opts.owner_home, 'Projects', owner_slug, relpath)
      if (!existsSync(abs)) return null
      const content = readFileSync(abs, 'utf8')
      if (content.trim().length === 0) return null
      return content.length > PROJECT_DOC_MAX_CHARS
        ? content.slice(0, PROJECT_DOC_MAX_CHARS)
        : content
    } catch {
      return null
    }
  }
}

/**
 * GAP2 (2026-06-09) — cap on the suggested topics carried by the
 * cross-project synthesized stand-in (they feed the composer prompt +
 * the deterministic next-move pick).
 */
export const SYNTHESIZED_SUGGESTED_TOPICS_CAP = 3

/**
 * GAP2 — synthesize a `matched`-shaped object from cross-project import
 * signal for a project that did NOT name-match a `proposed_projects`
 * row. The synthesized `rationale` is the woven context paragraph; the
 * synthesized `suggested_topics` are the related topics + interests so
 * the downstream deterministic / composer path has concrete material.
 * Returns null when there is genuinely no related signal — the caller
 * keeps the § 4.4 no-history fallback in that case.
 *
 * Reuses `findRelatedImportSignal` (already run by the caller and passed
 * in) so the scan happens once per project.
 *
 * Exported for unit testing.
 */
export function synthesizeMatchFromSignal(
  name: string,
  related: RelatedImportSignal,
): { name: string; rationale: string; suggested_topics: readonly string[] } | null {
  const hasSignal =
    related.entities.length > 0 || related.topics.length > 0 || related.interests.length > 0
  if (!hasSignal) return null
  // Rationale = a short content-aware sentence naming the concrete
  // threads/entities/interests. Mirrors the at-rest paragraph shape from
  // `synthesizeProjectContext` but kept terse for the opening body.
  const parts: string[] = []
  if (related.topics.length > 0) parts.push(related.topics.join(', '))
  if (related.entities.length > 0) parts.push(related.entities.join(', '))
  if (related.interests.length > 0) parts.push(related.interests.join(', '))
  const rationale = `From your history I picked up ${parts.join('; ')} relating to ${name}.`
  // Suggested topics = the related topics first (most action-shaped),
  // then interests, then entities — deduped, capped. These feed the
  // deterministic next-move pick + the composer prompt.
  const suggested_topics: string[] = []
  const seen = new Set<string>()
  for (const list of [related.topics, related.interests, related.entities]) {
    for (const t of list) {
      const lower = t.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      suggested_topics.push(t)
      if (suggested_topics.length >= SYNTHESIZED_SUGGESTED_TOPICS_CAP) break
    }
    if (suggested_topics.length >= SYNTHESIZED_SUGGESTED_TOPICS_CAP) break
  }
  return { name, rationale, suggested_topics }
}

/**
 * Default concurrency for `composeProjectOpening` round-trips. Picked at
 * 4 per the r2 brief: large enough to parallelise the common 3-8
 * project case meaningfully, small enough to stay well inside the
 * per-instance Anthropic client's typical concurrent-request budget.
 */
export const DEFAULT_COMPOSER_CONCURRENCY = 4

/**
 * Map an array through an async fn with a fixed concurrency budget.
 * Order-preserving — output[i] always corresponds to input[i] — so
 * the downstream serial-emit loop can pair compositions with their
 * `items[]` slot by index.
 *
 * The internal scheduler pulls the next index off a shared counter
 * (no per-task await chain that would serialise on the slowest job).
 * Workers run in parallel up to `concurrency`; when one resolves,
 * its slot picks the next pending index. Empty input is a no-op.
 *
 * Exported for unit testing.
 */
export async function mapWithBoundedConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R>> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }
  const workers: Array<Promise<void>> = []
  for (let w = 0; w < workerCount; w += 1) workers.push(worker())
  await Promise.all(workers)
  return results
}

/**
 * Lower-cased name → matching `import_result.proposed_projects` row
 * lookup. The user's freeform `primary_projects_confirmed` casing can
 * drift from the Pass-2 LLM's casing (the LLM tends to title-case
 * brand-shape names like "topline hospitality" → "Topline Hospitality"), so
 * the lookup is case-insensitive. Returns an empty Map when the import
 * is null OR has no proposed_projects.
 *
 * Exported for unit testing.
 */
export function indexProposedProjects(
  import_result: ImportResult | null,
): Map<string, { name: string; rationale: string; suggested_topics: readonly string[] }> {
  const out = new Map<string, { name: string; rationale: string; suggested_topics: readonly string[] }>()
  if (import_result === null) return out
  const proposed = import_result.proposed_projects
  if (!Array.isArray(proposed)) return out
  for (const row of proposed) {
    if (row === null || typeof row !== 'object') continue
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (name.length === 0) continue
    const rationale = typeof row.rationale === 'string' ? row.rationale : ''
    const suggested_topics: readonly string[] = Array.isArray(row.suggested_topics)
      ? row.suggested_topics.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : []
    out.set(name.toLowerCase(), { name, rationale, suggested_topics })
  }
  return out
}

/**
 * Deterministic opening composition — the no-LLM / LLM-failure path.
 * Paragraph source priority (Item 5 read order):
 *
 *   1. The materialized README's first prose paragraph (Item 4 — already
 *      an LLM-grade project-scoped synthesis when the doc composer ran
 *      at materialization time).
 *   2. The matched/synthesized import rationale.
 *   3. § 4.4 no-history fallback ("tell me what it is and what you want
 *      me to track").
 *
 * Next-move: the first suggested topic when present ("Want me to dig
 * into <topic>?"), else the open question "What would you like to do
 * next?". Always returns a non-empty body; the caller finalizes
 * (em-dash normalization + clamp).
 *
 * Exported for unit testing.
 */
/**
 * HONEST no-context opening (2026-07-01 SEV1 — "STOP M2" b). For a project the
 * materializer flagged as having NO real grounding (`MaterializeOutcome
 * .has_context === false`): a thin chat answer with no import match, no matched
 * transcript slices, no related import signal. Rather than fabricate a "here's
 * where X stands" summary (the exact bug Ryan hit — a made-up status + "active,
 * P2" for a project with zero data), we ask the owner for the context directly.
 * "Better nothing than a bad job." Em-dash-free (Sam hard rule).
 *
 * The caller (`emitProjectOpenings`) routes here ONLY for a WORK project with no
 * context; a no-context HOBBY gets the kickoff's engaging questions (its own
 * meaty opening), and any project WITH context keeps the real summary opening.
 *
 * Exported for unit testing.
 */
export function buildNoContextProjectOpening(name: string): ProjectOpeningComposition {
  return {
    body: `I don't have any context on ${name} yet - tell me a bit about it, and what do you want to work on first?`,
  }
}

export function buildDeterministicProjectOpening(
  name: string,
  matched: { name: string; rationale: string; suggested_topics: readonly string[] } | null,
  docs: ProjectOpeningDocs,
): ProjectOpeningComposition {
  // BUG #308 fix (2026-06-19, owner live-dogfood) — STATUS.md is the
  // highest-signal opening source (the materializer writes it as the
  // project's completion marker with a one-liner, status, priority, and
  // once worked its open threads). When present + parseable, lead with a
  // real status summary, then an ask-for-corrections line, then a custom
  // per-project next-action hook. This replaces the old behaviour where
  // STATUS.md was never read and the opening was a hardcoded
  // "Want me to dig into <topic>?" sourced only from the README /
  // import rationale.
  if (docs.status_md !== null) {
    const status = parseStatusMd(docs.status_md)
    const summaryText = status.one_liner.length > 0 ? status.one_liner : status.summary
    if (summaryText.length > 0) {
      const summarySentence = /[.!?]$/.test(summaryText) ? summaryText : `${summaryText}.`
      const stateBits: string[] = []
      if (status.status.length > 0) stateBits.push(status.status)
      if (status.priority.length > 0) stateBits.push(status.priority)
      const stateLine =
        stateBits.length > 0
          ? `Here's where ${name} stands: ${summarySentence} I have it marked ${stateBits.join(', ')}.`
          : `Here's where ${name} stands: ${summarySentence}`
      const corrections = "If any of that is stale or off, tell me what's changed and I'll update it."
      // Next-action hook (per-project): prefer an open thread pulled from
      // STATUS.md, then a suggested topic from the import signal, else a
      // plain open question. Reads naturally as something to answer in text.
      const firstThread = status.open_threads[0]
      const firstTopic = (matched?.suggested_topics ?? [])
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length > 0)[0]
      const nextMove =
        firstThread !== undefined && firstThread.length > 0
          ? `Want to pick up ${stripTrailingPunctuation(firstThread)}?`
          : firstTopic !== undefined && firstTopic.length > 0
            ? `Want me to dig into ${firstTopic}?`
            : 'What do you want to push on first?'
      return { body: `${stateLine}\n\n${corrections}\n\n${nextMove}` }
    }
  }
  const readmeParagraph = docs.readme !== null ? firstProseParagraph(docs.readme) : ''
  const rationale = (matched?.rationale ?? '').trim()
  const paragraph = readmeParagraph.length > 0 ? readmeParagraph : rationale
  if (paragraph.length === 0) {
    // § 4.4 — import skipped or genuinely no signal. Plain prose, no
    // buttons, free-form reply. (Replaces the pre-Item-5 2-button
    // [A]/[B] fallback.)
    return {
      body: `You added ${name} to your projects. I don't have history on it yet - tell me what it is and what you want me to track, and I'll take it from there.`,
    }
  }
  const summarySentence = /[.!?]$/.test(paragraph) ? paragraph : `${paragraph}.`
  const firstTopic = (matched?.suggested_topics ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length > 0)[0]
  const nextMove =
    firstTopic !== undefined && firstTopic.length > 0
      ? `Want me to dig into ${firstTopic}?`
      : 'What would you like to do next?'
  return { body: `${summarySentence}\n\n${nextMove}` }
}

/**
 * First non-heading, non-empty paragraph of a markdown doc, flattened
 * to a single line. Used by the deterministic opening to lift the
 * README's overview sentence(s) without dragging headings or the whole
 * doc into the bubble.
 *
 * Exported for unit testing.
 */
export function firstProseParagraph(markdown: string): string {
  const blocks = markdown.split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
    if (lines.length === 0) continue
    const flat = lines.join(' ').replace(/\s+/g, ' ').trim()
    if (flat.length > 0) return flat
  }
  return ''
}

/**
 * BUG #308 fix (2026-06-19) — parsed STATUS.md projection used by the
 * opening composer (deterministic + LLM paths).
 */
export interface ParsedStatus {
  /** Frontmatter `one_liner` (JSON-unquoted), or '' when absent. */
  one_liner: string
  /** Frontmatter `status` (e.g. "active"), or ''. */
  status: string
  /** Frontmatter `priority` (e.g. "P2"), or ''. */
  priority: string
  /** First prose paragraph of the body (fallback when one_liner is '' ). */
  summary: string
  /** Bulleted items under an "Open threads"/"Next steps"/"TODO" section. */
  open_threads: string[]
}

/**
 * Minimal STATUS.md parser. Reads the YAML-ish frontmatter the
 * materializer writes (`renderStatusMd`) plus the body's summary paragraph
 * and any open-threads list. Defensive by construction: a malformed or
 * frontmatter-less doc yields empty fields (the caller then degrades to the
 * README / import-signal path) and this never throws.
 *
 * Exported for unit testing.
 */
export function parseStatusMd(md: string): ParsedStatus {
  const empty: ParsedStatus = {
    one_liner: '',
    status: '',
    priority: '',
    summary: '',
    open_threads: [],
  }
  if (typeof md !== 'string' || md.trim().length === 0) return empty
  const normalized = md.replace(/\r\n/g, '\n')
  let frontmatter = ''
  let body = normalized
  // Frontmatter = the block between a leading `---` line and the next `---`.
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---', 4)
    if (end !== -1) {
      frontmatter = normalized.slice(4, end)
      // Skip past the closing fence to the body (drop the `\n---` + its line).
      const afterFence = normalized.indexOf('\n', end + 1)
      body = afterFence !== -1 ? normalized.slice(afterFence + 1) : ''
    }
  }
  const fm = parseFrontmatterFields(frontmatter)
  return {
    one_liner: unquoteFrontmatterValue(fm.get('one_liner') ?? ''),
    status: unquoteFrontmatterValue(fm.get('status') ?? ''),
    priority: unquoteFrontmatterValue(fm.get('priority') ?? ''),
    summary: firstProseParagraph(body),
    open_threads: extractOpenThreads(body),
  }
}

/** Parse simple `key: value` frontmatter lines into a map (first wins). */
function parseFrontmatterFields(frontmatter: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of frontmatter.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const val = line.slice(idx + 1).trim()
    if (key.length > 0 && !map.has(key)) map.set(key, val)
  }
  return map
}

/** Strip surrounding quotes from a frontmatter value. `one_liner` is
 *  JSON.stringify'd by the materializer, so JSON.parse it back; other
 *  fields are bare. Never throws. */
function unquoteFrontmatterValue(s: string): string {
  const t = s.trim()
  if (t.length === 0) return ''
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      const parsed = JSON.parse(t) as unknown
      if (typeof parsed === 'string') return parsed.trim()
    } catch {
      /* fall through to a manual strip */
    }
    return t.slice(1, -1).trim()
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** Collect bullet items under the first "open threads"/"next steps"/
 *  "TODO"/"open questions" heading or label. Capped at 5 for the hook. */
function extractOpenThreads(body: string): string[] {
  const SECTION = /(open thread|open question|open work|next step|to[\s-]?do)/
  const threads: string[] = []
  let collecting = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!collecting) {
      const isHeadingLike = /^#{1,6}\s+/.test(line) || /:$/.test(line)
      if (!isHeadingLike) continue
      const label = line.replace(/^#{1,6}\s+/, '').replace(/:$/, '').trim().toLowerCase()
      if (SECTION.test(label)) collecting = true
      continue
    }
    if (line.length === 0) continue
    const bullet = line.match(/^[-*+]\s+(.*)$/)
    if (bullet !== null && typeof bullet[1] === 'string') {
      const t = bullet[1].trim()
      if (t.length > 0) threads.push(t)
      if (threads.length >= 5) break
      continue
    }
    // A new heading or any non-bullet prose ends the section.
    break
  }
  return threads
}

/** Trim trailing sentence punctuation so a thread reads cleanly when
 *  embedded inside a "Want to pick up <thread>?" question. */
function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.?!,;:]+$/, '').trim()
}

/**
 * Finalize an opening body for emit:
 *   - normalize em dashes to hyphens (Sam hard rule — em dashes are an
 *     AI tell; applies to LLM output AND any rationale text that flowed
 *     through the deterministic path),
 *   - tidy whitespace,
 *   - clamp to `OPENING_MESSAGE_MAX_CHARS` at a sentence boundary when
 *     possible,
 *   - never return empty (pathological composer output gets a
 *     recognisable stand-in so an operator can spot the regression in
 *     logs without breaking the user's chat surface).
 *
 * Exported for unit testing.
 */
export function finalizeOpeningBody(body: string): string {
  const normalized = (typeof body === 'string' ? body : '')
    .replace(/\s*—\s*/g, ' - ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (normalized.length === 0) {
    return 'I have this project on file. What would you like to do next?'
  }
  if (normalized.length <= OPENING_MESSAGE_MAX_CHARS) return normalized
  // Try to cut at the last sentence boundary that fits.
  const trunc = normalized.slice(0, OPENING_MESSAGE_MAX_CHARS - 1)
  const lastBoundary = Math.max(
    trunc.lastIndexOf('. '),
    trunc.lastIndexOf('! '),
    trunc.lastIndexOf('? '),
    trunc.lastIndexOf('\n'),
  )
  if (lastBoundary > Math.floor(OPENING_MESSAGE_MAX_CHARS * 0.5)) {
    return `${trunc.slice(0, lastBoundary + 1).trim()}…`
  }
  return `${trunc.trim()}…`
}

/**
 * Default project-id slugifier. ISSUES #95: delegates to the canonical
 * `slugifyProjectId` in `onboarding/wow-moment/project-identity.ts` so
 * the per-project opening message (`web:<user_id>:<slug>`, written here)
 * and the sidebar `projects` row (keyed on the same slug by
 * `03-project-shells`) CANNOT drift — and, since Item 4/5, so the doc
 * reader resolves the SAME `Projects/<slug>/` folder the materializer
 * wrote. Re-exported under this name for back-compat with existing
 * callers + tests.
 *
 * Matches the `sanitizeProjectId` contract in
 * `channels/adapters/app-ws/envelope.ts:sanitizeProjectId`
 * (`[A-Za-z0-9_.-]`, 1-128 chars) so a project_id this helper produces
 * is round-trippable through the app-ws + app-projects surfaces.
 */
export function defaultProjectIdSlugifier(name: string): string {
  return slugifyProjectId(name)
}
