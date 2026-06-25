/**
 * @neutronai/onboarding — shared LLM field-extraction primitives.
 *
 * 2026-06-21 (onboarding-engine-consolidation) — relocated out of the
 * deleted `llm-prompt-driver.ts`. The `promptDriver` seam was never wired
 * in production (`open/composer.ts` wires `phaseSpecResolver` + `llmRouter`
 * only) and was removed when the onboarding engine collapsed onto the
 * single `llmRouter` extraction path. The `ExtractedFields` shape and the
 * `sanitizeUserFirstName` validator, however, are consumed by the SURVIVING
 * router-best-effort extraction in `engine.ts`
 * (`extractGapFillFieldsViaRouterBestEffort`, `mergeGapFillExtractedFields`)
 * and the signup name-capture path, so they live here as a leaf module with
 * no engine/driver dependencies.
 */

/**
 * Structured fields the onboarding LLM may extract from a freeform reply.
 *
 * All fields are optional. The LLM only includes a field when it has high
 * confidence the user supplied a value.
 */
export interface ExtractedFields {
  /**
   * Agent's name as chosen by the user. v1 also reused this field for the
   * USER's first name at signup (the v1 signup prompt was ambiguous —
   * "What should I call you?" could be parsed either way). v2 introduces
   * the dedicated `user_first_name` field below and shifts agent-naming
   * to `agent_name_chosen` per § 3.10. Both shapes are still accepted by
   * the engine's signup advance gate so the v2 LLM rephrase doesn't
   * regress v1-pattern responses.
   */
  agent_name?: string
  /** Slug the user wants for their personal URL. Raw — engine sanitizes. */
  slug?: string
  /** Character/persona archetype names the user named. */
  archetypes?: ReadonlyArray<string>
  /** One-line description of the user's primary goal/use-case. */
  goal_one_liner?: string
  /**
   * P2 v2 § 3.1 (S3, 2026-05-16) — the user's first name, captured at
   * `signup`. Engine writes this to `phase_state.user_first_name` AND
   * mirrors to the owner record via the `personaSync.recordUserFirstName`
   * hook. The dual-store write is intentional: `phase_state` is the
   * working state during onboarding; the owner table is the indexed lookup
   * downstream services (slug suggestion seed, USER.md generator,
   * persona-gen) read from.
   *
   * Extraction rules (from the system prompt at signup): if the user
   * gave a full name, take the first whitespace-separated token. Reject
   * stop-words ("yes", "ok", "what", "idk"); reject anything that
   * doesn't match `/^\p{L}[\p{L}' -]{0,31}$/u` after first-token slice.
   * Validation happens in the engine — the LLM is encouraged to emit
   * what it heard; the engine has the final say.
   */
  user_first_name?: string
  /**
   * P2 v2 § 3.8 / § 9.3 (S6, 2026-05-16) — gap-fill extraction surface.
   *
   * The `work_interview_gap_fill` phase asks one conversational question
   * per turn. The user's reply may legitimately carry MULTIPLE fields
   * ("Building Topline and Acme, also writing a book; outside work I
   * climb"). The router pulls each one out into the corresponding key
   * below and the engine merges (NOT overwrites) into `phase_state`.
   *
   * Extraction rules:
   *   - Names land VERBATIM (the spec's "they're signals from the user's
   *     own data, don't rephrase" rule). Only trim + drop empty entries.
   *   - For optional fields the LLM is conservative: only include when
   *     the user clearly volunteered the value; omit otherwise.
   *   - Plain-string arrays cap at 8 entries; objects (non_work_interests)
   *     cap at 6. The engine's audit only needs ≥3 / ≥1 — the cap is
   *     defense-in-depth against a runaway extraction.
   */
  primary_projects?: ReadonlyArray<string>
  /**
   * GAP1 (onboarding-wow-handoff-fix, 2026-06-09) — explicit project
   * removals. The `projects_proposed` / `import_analysis_presented`
   * confirm-merge is ADDITIVE: `primary_projects` is unioned with the
   * already-seeded list so a confirm reply can never silently SHRINK the
   * list (Sam's 7→3 regression). Omitting a project from
   * `primary_projects` therefore does NOT remove it. When the user
   * EXPLICITLY asks to drop / skip / remove a project ("drop the personal
   * one", "skip Biohacking"), the LLM names it here; the engine subtracts
   * `removed_projects` from the union (case-insensitive). This is the
   * brief's "union(presented, extracted) minus explicit removals" — and
   * resolves the self-contradiction Argus r1 flagged (the extraction
   * contract used to tell the LLM to OMIT removed projects, which the
   * additive union then re-added). Conservative: only populate on a clear
   * removal request.
   */
  removed_projects?: ReadonlyArray<string>
  non_work_interests?: ReadonlyArray<{
    name: string
    cadence_hint?: 'weekly' | 'monthly' | 'occasional'
  }>
  agent_personality?: string
  time_style?: string
  work_pattern?: string
  rituals?: ReadonlyArray<string>
  inner_circle?: ReadonlyArray<string>
  companies?: ReadonlyArray<string>
  user_supplied_corrections?: ReadonlyArray<string>
}

/**
 * Stop-list of replies the LLM might mistakenly echo back as a name when
 * the user types a non-name response. The engine's signup re-prompt
 * branch fires when the audit shows `user_first_name` still missing, so
 * these must NOT pass the sanitizer.
 */
const USER_FIRST_NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  'yes',
  'no',
  'what',
  'sure',
  'ok',
  'okay',
  'hi',
  'hello',
  'hey',
  'idk',
  'maybe',
  'nope',
  'yeah',
  'yep',
  'nah',
])

const NAME_TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])

/** Linear-time equivalent of `.replace(/[.,;:!?]+$/u, '')`. */
function stripTrailingNamePunctuation(s: string): string {
  let end = s.length
  while (end > 0 && NAME_TRAILING_PUNCTUATION.has(s[end - 1]!)) end--
  return s.slice(0, end)
}

/**
 * Normalize a candidate user first name: first whitespace-separated token,
 * trailing punctuation stripped, stop-words + over-long + non-letter inputs
 * rejected. Returns `null` when the input can't be a plausible first name.
 */
export function sanitizeUserFirstName(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  // Strip trailing punctuation: "Sam." → "Sam", "Sam," → "Sam". A backward
  // scan instead of `/[.,;:!?]+$/` — the unanchored `+` restarts at every
  // offset when `$` fails (e.g. "!!!!a"), which is quadratic (CodeQL
  // js/polynomial-redos). One linear pass strips the same trailing run.
  const stripped = stripTrailingNamePunctuation(firstToken)
  if (stripped.length === 0) return null
  if (stripped.length > 32) return null
  if (USER_FIRST_NAME_STOP_WORDS.has(stripped.toLowerCase())) return null
  // Unicode-aware letter + optional hyphen / apostrophe / space.
  if (!/^\p{L}[\p{L}' -]{0,31}$/u.test(stripped)) return null
  return stripped
}
