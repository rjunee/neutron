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
  PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY,
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

/** In-memory single-row state-store stub recording patchPhaseState calls. */
function fakeStore(initial: Row | null): {
  store: LivePersonalityStateStore
  patches: Array<Record<string, unknown>>
  current(): Row | null
  setOnGet(row: Row | null): void
  deleteRow(): void
} {
  let row: Row | null = initial
  let onGet: Row | null | undefined
  const patches: Array<Record<string, unknown>> = []
  const store = {
    async get(_owner: string, _user: string) {
      const r = onGet !== undefined ? onGet : row
      return r === null ? null : ({ ...r, phase_state: { ...r.phase_state } } as never)
    },
    async patchPhaseState(_owner: string, _user: string, patch: Record<string, unknown>) {
      patches.push(patch)
      // patchPhaseState is update-if-present: if the row was deleted (simulated via
      // deleteRow()), return null without writing (Argus r2 blocker fix).
      if (row === null) return null
      row = {
        phase: row.phase,
        phase_state: { ...row.phase_state, ...patch },
        last_advanced_at: row.last_advanced_at, // phase + timer always preserved
      }
      return { ...row } as never
    },
  } as unknown as LivePersonalityStateStore
  return {
    store,
    patches,
    current: () => row,
    setOnGet: (r) => {
      onGet = r
    },
    deleteRow: () => {
      row = null
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
  it('persists the four keys and preserves phase + last_advanced_at via patchPhaseState', async () => {
    const { suggester } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    const { store, patches, current } = fakeStore({
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

    expect(patches.length).toBe(1)
    const patch = patches[0]!
    expect(patch[PERSONALITY_SUGGESTIONS_KEY]).toEqual(LLM_SUGGESTIONS)
    expect(patch[PERSONALITY_SUGGESTIONS_SOURCE_KEY]).toBe('llm')
    expect(patch[PERSONALITY_SUGGESTIONS_FINGERPRINT_KEY]).toBe(
      signalsFingerprint(computeSuggesterSignals(SIGNAL_STATE)),
    )
    // patchPhaseState preserves phase + timer — the row's last_advanced_at must be untouched.
    expect(current()!.phase).toBe('work_interview')
    expect(current()!.last_advanced_at).toBe(987654)

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

  it('writes the anchor history and ACCUMULATES it across a regeneration', async () => {
    const first: PersonalityCharacterSuggestions = {
      personalized: [{ name: 'Old One', why: 'a' }],
      wild: [{ name: 'Old Wild', why: 'b' }],
    }
    const second: PersonalityCharacterSuggestions = {
      personalized: [{ name: 'New One', why: 'c' }],
      wild: [{ name: 'Old Wild', why: 'b' }], // repeat — must not duplicate in history
    }
    let which: PersonalityCharacterSuggestions = first
    const { suggester } = fakeSuggester(async () => ({ suggestions: which, source: 'llm' }))
    const { store, current, setOnGet } = fakeStore({
      phase: 'work_interview',
      phase_state: { ...SIGNAL_STATE },
      last_advanced_at: 1,
    })
    const { fire, settle } = capturingFire()
    const coord = buildLivePersonalitySuggestionCoordinator({
      suggester,
      stateStore: store,
      owner_slug: 'acme',
      seed: 'acme',
      fireAndForget: fire,
    })
    // First generation (turn state == stored signals → re-read fingerprint matches).
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...SIGNAL_STATE } })
    await settle()
    let hist = current()!.phase_state[PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY]
    expect(hist).toEqual(['Old One', 'Old Wild'])

    // A signal change forces a regeneration to a different personalized set. The
    // re-read row must carry the drifted signals (so the fingerprint matches and the
    // picks are NOT discarded) AND the accumulated history from the first pass.
    which = second
    const drifted = { ...SIGNAL_STATE, primary_projects: ['brand new project'] }
    setOnGet({
      phase: 'work_interview',
      phase_state: { ...current()!.phase_state, primary_projects: ['brand new project'] },
      last_advanced_at: 1,
    })
    coord.maybeKickoff('u1', { phase: 'work_interview' as never, phase_state: { ...drifted } })
    await settle()
    hist = current()!.phase_state[PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY]
    // History accumulates the new name, keeps the old ones, and de-dupes 'Old Wild'.
    expect(hist).toEqual(['Old One', 'Old Wild', 'New One'])
  })

  it('fallback result → NO patch; a later kickoff retries', async () => {
    const { suggester, calls } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'fallback' })
    const { store, patches } = fakeStore({
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
    expect(patches.length).toBe(0) // fallback never persists
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
    expect(back.patches.length).toBe(0)
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
    // Discarded: no patch means guardCharacters never serves picks under the stale fp,
    // and the next turn regenerates against the current signals.
    expect(back.patches.length).toBe(0)
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
    expect(back.patches.length).toBe(1)
  })
})

describe('maybeKickoff — never throws', () => {
  it('suggester rejection is swallowed, nothing persisted', async () => {
    const { suggester } = fakeSuggester(() => Promise.reject(new Error('boom')))
    const { store, patches } = fakeStore({ phase: 'work_interview', phase_state: SIGNAL_STATE, last_advanced_at: 1 })
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
    expect(patches.length).toBe(0)
  })

  // Argus r2 blocker: if the row is admin-reset (deleted) in the race window between
  // the in-flight re-read and the background write, patchPhaseState must return null
  // and NOT resurrect the deleted onboarding row. Previously upsert() fell into the
  // INSERT branch and recreated the row with stale phase/state.
  it('row deleted (admin reset) between re-read and write → no insert, no throw (CAS skip)', async () => {
    const { suggester } = fakeSuggester({ suggestions: LLM_SUGGESTIONS, source: 'llm' })
    // Start with a null row (row = null, so patchPhaseState will return null).
    // Use setOnGet to make get() return a non-null row — simulating the background
    // task's re-read seeing the row as it existed BEFORE the admin reset, while
    // patchPhaseState (which uses `row`) sees the post-reset absent state.
    const back = fakeStore(null) // row is already deleted
    back.setOnGet({
      phase: 'work_interview',
      phase_state: { ...SIGNAL_STATE },
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
    // patchPhaseState was called (re-read returned the row, fingerprint matched,
    // personality unsettled — all guards passed) but the write was skipped
    // because the store's row was absent (admin reset).
    expect(back.patches.length).toBe(1) // patchPhaseState was called
    expect(back.current()).toBeNull() // row NOT resurrected
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

  // Argus r2 minor: a pick RENDERED on turn N must still settle personality when
  // tapped on turn N+1, even after a mid-turn signal change regenerated the memo to a
  // different personalized set. The anchor history preserves every previously-shown
  // custom name.
  it('unions the anchor history — a previously-rendered name no longer in the current memo still anchors', () => {
    const state = {
      // Current memo has DIFFERENT personalized names (regenerated); valid shape
      // (the parser requires 3 personalized + 2 wild).
      [PERSONALITY_SUGGESTIONS_KEY]: {
        personalized: [
          { name: 'Fresh Persona', why: 'new' },
          { name: 'Fresh Two', why: 'new' },
          { name: 'Fresh Three', why: 'new' },
        ],
        wild: [
          { name: 'Fresh Wild', why: 'new' },
          { name: 'Fresh Wild Two', why: 'new' },
        ],
      } satisfies PersonalityCharacterSuggestions,
      // History carries an earlier custom pick that is NOT in the current memo.
      [PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY]: ['Stale Persona'],
    }
    const names = candidatePersonalityAnchorNames(state)
    expect(names).toContain('Fresh Persona') // current memo
    expect(names).toContain('Stale Persona') // history-only, still anchors
  })

  it('ignores a malformed anchor-history value (non-array / non-string entries)', () => {
    const a = candidatePersonalityAnchorNames({ [PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY]: 'nope' })
    expect(a).toContain('Sherlock Holmes')
    const b = candidatePersonalityAnchorNames({ [PERSONALITY_SUGGESTIONS_ANCHOR_HISTORY_KEY]: [42, '', 'Kept Name'] })
    expect(b).toContain('Kept Name')
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

  // Argus r2 nit: the fingerprint tracks WHICH projects/interests are known, not the
  // order they are stored in — a bare order flip must not force a ~45s regeneration.
  it('signalsFingerprint is invariant to project/interest array order', () => {
    const a = signalsFingerprint(
      computeSuggesterSignals({ user_first_name: 'Sam', primary_projects: ['a', 'b'], non_work_interests: ['x', 'y'] }),
    )
    const b = signalsFingerprint(
      computeSuggesterSignals({ user_first_name: 'Sam', primary_projects: ['b', 'a'], non_work_interests: ['y', 'x'] }),
    )
    expect(b).toBe(a)
    // A genuinely new project still changes the fingerprint.
    const c = signalsFingerprint(
      computeSuggesterSignals({ user_first_name: 'Sam', primary_projects: ['a', 'b', 'c'], non_work_interests: ['x', 'y'] }),
    )
    expect(c).not.toBe(a)
  })
})
