/**
 * @neutronai/onboarding/interview — LIVE-path personality-suggestion coordinator.
 *
 * Path 1 (onboarding-as-CC-session) conducts the interview inside the live Claude
 * Code chat session, NOT the old phase machine. Its per-turn required-step guard
 * (`onboarding-preamble.ts` `buildOnboardingStepGuardFragment`) rendered the
 * STATIC `DEFINED_PERSONALITY_CHARACTERS` (same five names for every owner) at the
 * personality step, because there was no wiring to feed the LIVE, Opus-backed
 * `PersonalityCharacterSuggester` into that path — the suggester was only consumed
 * by the retired phase machine (`engine-spec-resolution.ts`).
 *
 * This coordinator closes that gap WITHOUT ever blocking a turn on the 45 s
 * suggester:
 *
 *   - `guardCharacters(phase_state)` renders the MEMOIZED Opus picks when present,
 *     else returns null so the caller keeps the byte-identical static default.
 *   - `maybeKickoff(user_id, st)` fires a background, deduped, fingerprint-gated
 *     generation whenever the owner's real signals (name / projects / interests)
 *     are available and personality is still open. Only `source === 'llm'` results
 *     are persisted (a fallback persists nothing → next turn retries, mirroring the
 *     old engine's "fallback stored-but-never-frozen" rule). The picks REGENERATE
 *     when the signals change (fingerprint mismatch) and FREEZE once an `'llm'`
 *     memo matches the current fingerprint.
 *   - `candidatePersonalityAnchorNames(phase_state)` unions every renderable name
 *     (static ∪ fallback-pool ∪ memoized) so the deterministic capture in
 *     `button-backed-answer.ts` settles a tap/typed answer against ANY list that
 *     could have been shown.
 *
 * It memoizes into the SAME `phase_state` keys the old engine path uses
 * (`personality_character_suggestions` + `..._source`), so the two paths never
 * disagree about the memo, PLUS a new `..._fingerprint` key that gates
 * regeneration against the owner's evolving Path-1 signals (name/projects/
 * interests arrive incrementally; personality is asked LAST, so the LLM picks
 * land in time).
 *
 * NO cycle: this module imports `onboarding-preamble.ts` (for the static names)
 * and `personality-character-suggester.ts` (for the memo reader + fallback names);
 * neither imports back. `button-backed-answer.ts` imports THIS module.
 */

import type { OnboardingStateStore } from './state-store.ts'
import type { OnboardingPhase } from './phase.ts'
import { DEFINED_PERSONALITY_CHARACTER_NAMES } from './onboarding-preamble.ts'
import type {
  CharacterSuggestion,
  PersonalityCharacterSuggestions,
} from './personality-characters.ts'
import {
  FALLBACK_CHARACTER_NAMES,
  readMemoizedCharacterSuggestions,
  type PersonalityCharacterSuggester,
} from './personality-character-suggester.ts'

/**
 * The memo keys. These MUST equal the literals the retired engine resolver writes
 * (`engine-spec-resolution.ts`) so the live path and any residual engine write
 * share ONE memo, never two competing copies.
 */
export const PERSONALITY_SUGGESTIONS_KEY = 'personality_character_suggestions'
export const PERSONALITY_SUGGESTIONS_SOURCE_KEY =
  'personality_character_suggestions_source'
/**
 * NEW (2026-07-21) — the signal fingerprint the picks were generated against.
 * Absent on any engine-written memo (the engine never sets it); a null/mismatched
 * fingerprint is treated as "regenerate", so an old-path memo is refreshed against
 * the owner's real Path-1 signals on the next turn.
 */
export const PERSONALITY_SUGGESTIONS_FINGERPRINT_KEY =
  'personality_character_suggestions_fingerprint'
/**
 * NEW (2026-07-22, Argus r2 minor) — the accumulating set of every character NAME
 * ever persisted as an `'llm'` memo for this owner. `candidatePersonalityAnchorNames`
 * unions it so a pick that was RENDERED on turn N still settles `agent_personality`
 * when tapped on turn N+1, even if a mid-turn signal change regenerated the memo to a
 * different personalized set in between (the current memo alone would no longer
 * contain the tapped name). Append-only; never shrinks.
 */
export const PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY =
  'personality_character_anchor_history'

/** The subset of signals the suggester conditions on. */
export interface LivePersonalitySignals {
  user_first_name: string | null
  primary_projects: string[]
  non_work_interests: string[]
  /** Always empty on the live path — the live interview has no persona-discovery
   *  correction channel. Kept for suggester-input shape parity. */
  user_supplied_corrections: string[]
}

/** Trim + require a non-empty string, else null. */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

/** Filter an unknown array-ish value to trimmed, non-empty strings. Mirrors the
 *  defensive parse composer.ts uses on `primary_projects`. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const t = item.trim()
    if (t.length > 0) out.push(t)
  }
  return out
}

/** Defensive parse of the owner's collected signals from durable phase_state. */
export function computeSuggesterSignals(
  phase_state: Readonly<Record<string, unknown>>,
): LivePersonalitySignals {
  return {
    user_first_name: trimmedOrNull(phase_state['user_first_name']),
    primary_projects: stringArray(phase_state['primary_projects']),
    non_work_interests: stringArray(phase_state['non_work_interests']),
    user_supplied_corrections: [],
  }
}

/**
 * Stable fingerprint of the signals that condition the picks. A change here means
 * the owner told us something new (their name, another project, an interest), so
 * the memoized picks are stale and must regenerate. `user_supplied_corrections`
 * is intentionally excluded (always empty on the live path).
 *
 * The arrays are SORTED before stringify: the fingerprint tracks WHICH projects/
 * interests are known, not the order they happen to be stored in. A bare order flip
 * (`['a','b']` vs `['b','a']`) is not new information and must not invalidate a
 * frozen `'llm'` memo — that would force an avoidable ~45s Opus regeneration (Argus
 * r2 nit). Copies are sorted so the caller's arrays are untouched.
 */
export function signalsFingerprint(signals: LivePersonalitySignals): string {
  return JSON.stringify([
    signals.user_first_name,
    [...signals.primary_projects].sort(),
    [...signals.non_work_interests].sort(),
  ])
}

/** True iff at least one real signal is present (name known OR any project/interest). */
export function hasAnySignal(signals: LivePersonalitySignals): boolean {
  return (
    signals.user_first_name !== null ||
    signals.primary_projects.length > 0 ||
    signals.non_work_interests.length > 0
  )
}

export interface LiveCharacterMemo {
  suggestions: PersonalityCharacterSuggestions
  source: string | null
  fingerprint: string | null
}

/**
 * Read the memoized picks (+ source + fingerprint) off phase_state via the strict
 * parser. Returns null when there is no valid memo (so the caller renders the
 * static default / kicks off generation).
 */
export function readLiveCharacterMemo(
  phase_state: Readonly<Record<string, unknown>>,
): LiveCharacterMemo | null {
  const suggestions = readMemoizedCharacterSuggestions(
    phase_state[PERSONALITY_SUGGESTIONS_KEY],
  )
  if (suggestions === null) return null
  const sourceRaw = phase_state[PERSONALITY_SUGGESTIONS_SOURCE_KEY]
  const fpRaw = phase_state[PERSONALITY_SUGGESTIONS_FINGERPRINT_KEY]
  return {
    suggestions,
    source: typeof sourceRaw === 'string' ? sourceRaw : null,
    fingerprint: typeof fpRaw === 'string' ? fpRaw : null,
  }
}

/**
 * Every character NAME the personality step could render this owner — static
 * defaults ∪ diverse-fallback pool ∪ the current memoized picks ∪ the anchor history
 * (every name EVER persisted as an `'llm'` memo). The capture anchor
 * (`button-backed-answer.ts`) matches a tap/typed answer against this set
 * (lowercased by the consumer), so a pick from ANY previously-rendered list settles
 * `agent_personality` — even after a mid-turn signal change regenerated the current
 * memo to a different personalized set (Argus r2 minor). Case-preserving, de-duplicated.
 */
export function candidatePersonalityAnchorNames(
  phase_state: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (name: string): void => {
    const key = name.toLowerCase()
    if (name.length === 0 || seen.has(key)) return
    seen.add(key)
    out.push(name)
  }
  for (const n of DEFINED_PERSONALITY_CHARACTER_NAMES) push(n)
  for (const n of FALLBACK_CHARACTER_NAMES) push(n)
  const memo = readLiveCharacterMemo(phase_state)
  if (memo !== null) {
    for (const c of memo.suggestions.personalized) push(c.name)
    for (const c of memo.suggestions.wild) push(c.name)
  }
  for (const n of readAnchorHistory(phase_state)) push(n)
  return out
}

/** Defensive read of the append-only anchor-history array off phase_state. */
export function readAnchorHistory(
  phase_state: Readonly<Record<string, unknown>>,
): string[] {
  const raw = phase_state[PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY]
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** Structural subset of `OnboardingStateStore` the coordinator needs. */
export type LivePersonalityStateStore = Pick<OnboardingStateStore, 'get' | 'upsert'>

/** The minimal per-turn state the coordinator reads at kickoff time. */
export interface LivePersonalityTurnState {
  phase: OnboardingPhase
  phase_state: Readonly<Record<string, unknown>>
}

export interface BuildLivePersonalityCoordinatorDeps {
  suggester: PersonalityCharacterSuggester
  stateStore: LivePersonalityStateStore
  owner_slug: string
  /** Stable per-instance seed for the deterministic fallback (never sent to the LLM). */
  seed: string | null
  /** Route the background promise through the repo's guarded fire-and-forget sink. */
  fireAndForget?: (label: string, promise: Promise<unknown>) => void
  log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ) => void
}

export interface LivePersonalitySuggestionCoordinator {
  /**
   * The characters to render in the personality step guard THIS turn: the
   * memoized picks (personalized then wild) when a memo is present, else null so
   * the caller keeps the static default. Never blocks.
   */
  guardCharacters(
    phase_state: Readonly<Record<string, unknown>>,
  ): ReadonlyArray<CharacterSuggestion> | null
  /**
   * Fire a background generation iff it is warranted (personality open, ≥1 signal,
   * memo missing/stale/non-llm, no pending run for this user). Never throws, never
   * awaits the suggester on the turn path.
   */
  maybeKickoff(user_id: string, st: LivePersonalityTurnState): void
}

function isSettledString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function buildLivePersonalitySuggestionCoordinator(
  deps: BuildLivePersonalityCoordinatorDeps,
): LivePersonalitySuggestionCoordinator {
  const { suggester, stateStore, owner_slug, seed } = deps
  const fire =
    deps.fireAndForget ??
    ((_label: string, promise: Promise<unknown>): void => {
      void promise.catch(() => undefined)
    })
  const log = deps.log ?? ((): void => {})
  // Per-user dedup: at most one in-flight generation per owner user_id.
  const pending = new Map<string, Promise<unknown>>()

  const guardCharacters = (
    phase_state: Readonly<Record<string, unknown>>,
  ): ReadonlyArray<CharacterSuggestion> | null => {
    const memo = readLiveCharacterMemo(phase_state)
    if (memo === null) return null
    return [...memo.suggestions.personalized, ...memo.suggestions.wild]
  }

  const maybeKickoff = (user_id: string, st: LivePersonalityTurnState): void => {
    try {
      // Personality already chosen → nothing to suggest.
      if (isSettledString(st.phase_state['agent_personality'])) return
      const signals = computeSuggesterSignals(st.phase_state)
      // No real signal yet → generating now would just produce a generic list;
      // wait until we know something about the owner (name lands first in Path 1).
      if (!hasAnySignal(signals)) return
      const fp = signalsFingerprint(signals)
      const memo = readLiveCharacterMemo(st.phase_state)
      // Frozen: a real LLM memo whose fingerprint still matches the current
      // signals. Anything else (no memo, a stored fallback, or a stale
      // fingerprint) is regenerated.
      if (memo !== null && memo.source === 'llm' && memo.fingerprint === fp) return
      // Dedup: one generation per user at a time.
      if (pending.has(user_id)) return

      const task = (async (): Promise<void> => {
        const result = await suggester.generate({ ...signals, seed })
        if (result.source !== 'llm') {
          // A fallback is NOT persisted (mirrors the old engine's stored-but-never-
          // frozen rule): next turn retries until the real picks land.
          log('info', 'live-personality: fallback result, not persisting', {
            owner_slug,
            user_id,
          })
          return
        }
        // RE-READ before writing (Codex-P1 lesson): the phase may have advanced or
        // the owner may have settled personality while the 45 s call was in flight.
        const fresh = await stateStore.get(owner_slug, user_id)
        if (fresh === null) return
        if (isSettledString(fresh.phase_state['agent_personality'])) return
        // FINGERPRINT-DRIFT guard (Argus r2 veto): the owner may have supplied a new
        // project/interest (or their name) while the up-to-45 s call was in flight, so
        // these picks were conditioned on now-stale signals. Persisting them under the
        // OLD `fp` would freeze a stale list AND `guardCharacters` would serve it until
        // the next turn's regen. Recompute the fingerprint from the FRESH state and
        // discard on mismatch — the `.finally` clears `pending`, so the next turn
        // regenerates against the current signals.
        const freshFp = signalsFingerprint(computeSuggesterSignals(fresh.phase_state))
        if (freshFp !== fp) {
          log('info', 'live-personality: signals changed mid-generation, discarding stale picks', {
            owner_slug,
            user_id,
          })
          return
        }
        // Accumulate every persisted name into the append-only anchor history so a
        // pick rendered from THIS memo still settles `agent_personality` if it is
        // tapped after a later regeneration replaced the memo (Argus r2 minor).
        const priorHistory = readAnchorHistory(fresh.phase_state)
        const historySeen = new Set(priorHistory.map((n) => n.toLowerCase()))
        const anchorHistory = [...priorHistory]
        for (const c of [...result.suggestions.personalized, ...result.suggestions.wild]) {
          const key = c.name.toLowerCase()
          if (c.name.length > 0 && !historySeen.has(key)) {
            historySeen.add(key)
            anchorHistory.push(c.name)
          }
        }
        await stateStore.upsert({
          owner_slug,
          user_id,
          phase: fresh.phase,
          phase_state_patch: {
            [PERSONALITY_SUGGESTIONS_KEY]: result.suggestions,
            [PERSONALITY_SUGGESTIONS_SOURCE_KEY]: 'llm',
            [PERSONALITY_SUGGESTIONS_FINGERPRINT_KEY]: fp,
            [PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY]: anchorHistory,
          },
          // Preserve the resume-window timer — a background memo write must not
          // reset `last_advanced_at` (mirrors engine-spec-resolution.ts).
          advanced_at: fresh.last_advanced_at,
        })
      })().finally(() => {
        pending.delete(user_id)
      })

      pending.set(user_id, task)
      fire('onboarding.live-personality-suggester', task)
    } catch (err) {
      // Never throw on the turn path.
      log('warn', 'live-personality: maybeKickoff failed', {
        owner_slug,
        user_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { guardCharacters, maybeKickoff }
}
