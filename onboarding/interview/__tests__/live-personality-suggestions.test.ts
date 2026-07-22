/**
 * @neutronai/onboarding/interview — LIVE-path personality-suggestion coordinator tests.
 *
 * 2026-07-21 — the live CC-session onboarding path renders the STATIC five
 * personality names for every owner because the Opus-backed suggester was only
 * consumed by the retired phase machine. `buildLivePersonalitySuggestionCoordinator`
 * feeds that suggester into the live per-turn step guard WITHOUT ever blocking a
 * turn: background, deduped, fingerprint-gated generation; memoized `'llm'`-only
 * picks; static default until they land / on failure. These tests pin that
 * contract (never-block, dedup, regenerate-on-signal-change, freeze-on-llm,
 * re-read-before-write, swallow-failures) and the anchor-name union.
 */

import { describe, expect, it } from 'bun:test'

import {
  buildLivePersonalitySuggestionCoordinator,
  candidatePersonalityAnchorNames,
  computeSuggesterSignals,
  hasAnySignal,
  signalsFingerprint,
  PERSONALITY_SUGGESTIONS_KEY,
  PERSONALITY_SUGGESTIONS_SOURCE_KEY,
  PERSONALITY_SUGGESTIONS_FINGERPRINT_KEY,
  type LivePersonalityStateStore,
} from '../live-personality-suggestions.ts'
import type {
  CharacterSuggesterResult,
  PersonalityCharacterSuggester,
  PersonalityCharacterSuggesterInput,
} from '../personality-character-suggester.ts'
import { DEFINED_PERSONALITY_CHARACTER_NAMES } from '../onboarding-preamble.ts'
import { FALLBACK_CHARACTER_NAMES } from '../personality-character-suggester.ts'
import type { PersonalityCharacterSuggestions } from '../personality-characters.ts'

const LLM_SUGGESTIONS: PersonalityCharacterSuggestions = {
  personalized: [
    { name: 'Naval Ravikant', why: 'Calm, first-principles.' },
    { name: 'Hermione Granger', why: 'Rigorous and prepared.' },
    { name: 'Don Draper', why: 'Persuasive and decisive.' },
  ],
  wild: [
    { name: 'Moana', why: 'Bold and curious.' },
    { name: 'Bilbo Baggins', why: 'Rises when it counts.' },
  ],
}

/** A fake suggester whose result + call log are test-controlled. */
function fakeSuggester(
  result: CharacterSuggesterResult | (() => Promise<CharacterSuggesterResult>),
): { suggester: PersonalityCharacterSuggester; calls: PersonalityCharacterSuggesterInput[] } {
  const calls: PersonalityCharacterSuggesterInput[] = []
  const suggester: PersonalityCharacterSuggester = {
    async generate(input) {
      calls.push(input)
      if (typeof result === 'function') return result()
      return result
    },
  }
  return { suggester, calls }
}

interface Row {
  phase: string
  phase_state: Record<string, unknown>
  last_advanced_at: number
}

/** In-memory single-row state-store stub recording upsert inputs. */
function fakeStore(initial: Row | null): {
  store: LivePersonalityStateStore
  upserts: Array<Record<string, unknown>>
  current(): Row | null
  setOnGet(row: Row | null): void
} {
  let row: Row | null = initial
  let onGet: Row | null | undefined
  const upserts: Array<Record<string, unknown>> = []
  const store = {
    async get(_owner: string, _user: string) {
      const r = onGet !== undefined ? onGet : row
      return r === null ? null : ({ ...r, phase_state: { ...r.phase_state } } as never)
    },
    async upsert(input: Record<string, unknown>) {
      upserts.push(input)
      const patch = (input['phase_state_patch'] as Record<string, unknown>) ?? {}
      const base = row ?? { phase: input['phase'] as string, phase_state: {}, last_advanced_at: 0 }
      row = {
        phase: input['phase'] as string,
        phase_state: { ...base.phase_state, ...patch },
        last_advanced_at:
          typeof input['advanced_at'] === 'number' ? (input['advanced_at'] as number) : Date.now(),
      }
      return { ...row } as never
    },
  } as unknown as LivePersonalityStateStore
  return {
    store,
    upserts,
    current: () => row,
    setOnGet: (r) => {
      onGet = r
    },
  }
}

/** Capture background promises so a test can deterministically await them. */
function capturingFire(): { fire: (l: string, p: Promise<unknown>) => void; settle(): Promise<void> } {
  const captured: Array<Promise<unknown>> = []
  return {
    fire: (_l, p) => {
      captured.push(p.catch(() => undefined))
    },
    settle: async () => {
      await Promise.all(captured)
    },
  }
}

const SIGNAL_STATE = { user_first_name: 'Sam', primary_projects: ['A', 'B', 'C'] }

describe('maybeKickoff — gating + dedup', () => {
  it('zero signals → generate NOT called', () => {
    const { suggester, calls } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    const { store } = fakeStore(null)
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: {} })
    expect(calls.length).toBe(0)
  })

  it('≥1 signal + no memo → generate once; a concurrent second call dedups', () => {
    const { suggester, calls } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    const { store } = fakeStore({ phase: 'work_interview', phase_state: SIGNAL_STATE, last_advanced_at: 10 })
    const { fire } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    const st = { phase: 'work_interview' as never, phase_state: SIGNAL_STATE }
    coord.maybeKickoff('u1', st)
    coord.maybeKickoff('u1', st) // concurrent, still pending
    expect(calls.length).toBe(1)
  })
})

describe('maybeKickoff — llm result persistence', () => {
  it('persists the three keys, phase from the re-read row, and preserves last_advanced_at', async () => {
    const { suggester } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    const { store, upserts } = fakeStore({
      phase: 'work_interview',
      phase_state: { ...SIGNAL_STATE },
      last_advanced_at: 987654,
    })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...SIGNAL_STATE } })
    await settle()

    expect(upserts.length).toBe(1)
    const up = upserts[0]!
    expect(up['phase']).toBe('work_interview')
    expect(up['advanced_at']).toBe(987654) // resume-window timer preserved
    const patch = up['phase_state_patch'] as Record<string, unknown>
    expect(patch[PERSONALITY_SUGGESTIONS_KEY]).toEqual(LLM_SUGGESTIONS)
    expect(patch[PERSONALITY_SUGGESTIONS_SOURCE_KEY]).toBe('llm')
    expect(patch[PERSONALITY_SUGGESTIONS_FINGERPRINT_KEY]).toBe(
      signalsFingerprint(computeSuggesterSignals(SIGNAL_STATE)),
    )

    // guardCharacters over the persisted memo returns the 5 picks in order.
    const persisted = { [PERSONALITY_SUGGESTIONS_KEY]: LLM_SUGGESTIONS }
    const guard = coord.guardCharacters(persisted)
    expect(guard).not.toBeNull()
    expect((guard as ReadonlyArray<{ name: string }>).map((c) => c.name)).toEqual([
      'Naval Ravikant',
      'Hermione Granger',
      'Don Draper',
      'Moana',
      'Bilbo Baggins',
    ])
  })

  it('fallback result → NO upsert; a later kickoff retries', async () => {
    const { suggester, calls } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'fallback' })
    const { store, upserts } = fakeStore({
      phase: 'work_interview',
      phase_state: { ...SIGNAL_STATE },
      last_advanced_at: 5,
    })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...SIGNAL_STATE } })
    await settle()
    expect(upserts.length).toBe(0) // fallback never persists
    // Pending cleared → a fresh kickoff retries (generation runs again).
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...SIGNAL_STATE } })
    expect(calls.length).toBe(2)
  })
})

describe('maybeKickoff — fingerprint gating', () => {
  it('llm memo with UNCHANGED fingerprint → no regenerate; CHANGED fingerprint → regenerate', async () => {
    const { suggester, calls } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    const fp = signalsFingerprint(computeSuggesterSignals(SIGNAL_STATE))
    const frozenState = {
      ...SIGNAL_STATE,
      [PERSONALITY_SUGGESTIONS_KEY]: LLM_SUGGESTIONS,
      [PERSONALITY_SUGGESTIONS_SOURCE_KEY]: 'llm',
      [PERSONALITY_SUGGESTIONS_FINGERPRINT_KEY]: fp,
    }
    const { store } = fakeStore({ phase: 'work_interview', phase_state: frozenState, last_advanced_at: 1 })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: frozenState })
    await settle()
    expect(calls.length).toBe(0) // frozen — matching llm fingerprint

    // Signals change (an interest arrives) → fingerprint mismatch → regenerate.
    const changedState = { ...frozenState, non_work_interests: ['surfing'] }
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: changedState })
    await settle()
    expect(calls.length).toBe(1)
  })
})

describe('maybeKickoff — settled personality + re-read guard', () => {
  it('agent_personality already settled → never kicks off', () => {
    const { suggester, calls } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    const { store } = fakeStore({ phase: 'work_interview', phase_state: SIGNAL_STATE, last_advanced_at: 1 })
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
    })
    coord.maybeKickoff('u1', {
      phase: 'work_interview' as never,
      phase_state: { ...SIGNAL_STATE, agent_personality: 'Yoda' },
    })
    expect(calls.length).toBe(0)
  })

  it('personality settled DURING the in-flight call → write skipped (re-read wins)', async () => {
    const { suggester } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    const back = fakeStore({ phase: 'work_interview', phase_state: { ...SIGNAL_STATE }, last_advanced_at: 1 })
    // The re-read inside the background task sees personality settled meanwhile.
    back.setOnGet({
      phase: 'work_interview',
      phase_state: { ...SIGNAL_STATE, agent_personality: 'Sherlock Holmes' },
      last_advanced_at: 1,
    })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: back.store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...SIGNAL_STATE } })
    await settle()
    expect(back.upserts.length).toBe(0)
  })

  it('signals change DURING the in-flight call → stale picks discarded, NOT persisted under the old fingerprint (Argus r2 veto)', async () => {
    const { suggester } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    // Kickoff conditions on SIGNAL_STATE. While the (slow) generate is in flight the
    // owner adds a new interest, so the re-read row has DIFFERENT signals → a mismatched
    // fingerprint. Personality is still unsettled, so ONLY the drift guard can stop the write.
    const back = fakeStore({ phase: 'work_interview', phase_state: { ...SIGNAL_STATE }, last_advanced_at: 1 })
    back.setOnGet({
      phase: 'work_interview',
      phase_state: { ...SIGNAL_STATE, non_work_interests: ['sailing'] },
      last_advanced_at: 1,
    })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: back.store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...SIGNAL_STATE } })
    await settle()
    // Discarded: no upsert means guardCharacters never serves picks under the stale fp,
    // and the next turn regenerates against the current signals.
    expect(back.upserts.length).toBe(0)
  })

  it('signals UNCHANGED during the in-flight call → picks ARE persisted (drift guard does not over-reject)', async () => {
    const { suggester } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    // Re-read returns the SAME signals (fingerprint matches) → the drift guard must NOT
    // block a legitimate write.
    const back = fakeStore({ phase: 'work_interview', phase_state: { ...SIGNAL_STATE }, last_advanced_at: 1 })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: back.store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...SIGNAL_STATE } })
    await settle()
    expect(back.upserts.length).toBe(1)
  })
})

describe('maybeKickoff — never throws', () => {
  it('suggester rejection is swallowed, nothing persisted', async () => {
    const { suggester } = fakeSuggester(() => Promise.reject(new Error('boom')))
    const { store, upserts } = fakeStore({ phase: 'work_interview', phase_state: SIGNAL_STATE, last_advanced_at: 1 })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    expect(() =>
      coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: SIGNAL_STATE }),
    ).not.toThrow()
    await settle()
    expect(upserts.length).toBe(0)
  })
})

describe('candidatePersonalityAnchorNames', () => {
  it('unions the static 5, all 16 fallback-pool names, and memoized custom names', () => {
    const memoState = { [PERSONALITY_SUGGESTIONS_KEY]: LLM_SUGGESTIONS }
    const names = candidatePersonalityAnchorNames(memoState)
    // Static defaults present.
    for (const n of DEFINED_PERSONALITY_CHARACTER_NAMES) expect(names).toContain(n)
    // Every fallback-pool name present.
    for (const n of FALLBACK_CHARACTER_NAMES) expect(names).toContain(n)
    // Memoized custom names present.
    expect(names).toContain('Naval Ravikant')
    expect(names).toContain('Don Draper')
    // De-duplicated (Sherlock Holmes / Yoda etc. appear in BOTH static and pool).
    const lc = names.map((n) => n.toLowerCase())
    expect(new Set(lc).size).toBe(lc.length)
  })

  it('with no memo → just static ∪ pool (no throw)', () => {
    const names = candidatePersonalityAnchorNames({})
    expect(names).toContain('Sherlock Holmes')
    expect(names).toContain('Ada Lovelace') // pool-only
  })
})

describe('signal helpers', () => {
  it('computeSuggesterSignals defensively parses phase_state', () => {
    const s = computeSuggesterSignals({
      user_first_name: '  Sam  ',
      primary_projects: ['A', '', '  B ', 42],
      non_work_interests: 'not-an-array',
    })
    expect(s.user_first_name).toBe('Sam')
    expect(s.primary_projects).toEqual(['A', 'B'])
    expect(s.non_work_interests).toEqual([])
    expect(s.user_supplied_corrections).toEqual([])
  })

  it('hasAnySignal true iff any signal present', () => {
    expect(hasAnySignal(computeSuggesterSignals({}))).toBe(false)
    expect(hasAnySignal(computeSuggesterSignals({ user_first_name: 'Sam' }))).toBe(true)
    expect(hasAnySignal(computeSuggesterSignals({ primary_projects: ['x'] }))).toBe(true)
  })
})
