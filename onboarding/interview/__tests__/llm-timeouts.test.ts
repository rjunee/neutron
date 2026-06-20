/**
 * 2026-06-17 (onboarding single-session warm-conversational rework, Step 1) —
 * pins the TIERED LLM timeout budgets.
 *
 * History: the single `GAP_FILL_TIMEOUT_MS_DEFAULT` was raised to 90s to give a
 * cold per-turn `claude` CC-subprocess spawn room to land on the conversational
 * critical path. But the per-turn cold spawn was the bug; with one global
 * constant, EVERY conversational turn inherited the 90s heavy budget and
 * blocked the full 90s before falling back to static. The rework splits the
 * budget into two tiers:
 *   - CONVERSATIONAL (SHORT, 12s as of 2026-06-18) — phase-spec-resolver +
 *     gap-fill driver on a REUSED warm session. 3s (the 2026-06-17 value) was
 *     too tight: the resolver's withTimeout does not cancel the turn, so a
 *     budget below the warm-turn latency discarded every real answer; 12s lands
 *     a warm turn while still falling back fast on a stall.
 *   - SYNTHESIS (LONG, 90s) — the heavy background history-read / synthesis
 *     path (Step 2), never on a user-facing turn.
 */

import { describe, expect, test } from 'bun:test'
import {
  CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
  SYNTHESIS_TIMEOUT_MS_DEFAULT,
  SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT,
  SYNTHESIS_CEILING_MS_DEFAULT,
  SUGGESTER_TIMEOUT_MS_DEFAULT,
  PREWARM_AWAIT_CAP_MS_DEFAULT,
  FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
  readEnvTimeoutMs,
} from '../llm-timeouts.ts'

describe('LLM timeout budgets', () => {
  test('suggester default is 45s — room for a cold Opus CC-spawn (was 6s → 30s)', () => {
    // Raised 30s → 45s when the suggesters moved to BEST_MODEL (Opus 4.7):
    // a cold Opus CC-subprocess spawn can run 20-40s, and these calls are
    // background pre-computed so the longer upper bound is hidden. See
    // llm-timeouts.ts for the full rationale.
    expect(SUGGESTER_TIMEOUT_MS_DEFAULT).toBe(45000)
    // The whole bug was a budget below cold-spawn latency. Guard it never
    // regresses back under the old 6s ceiling.
    expect(SUGGESTER_TIMEOUT_MS_DEFAULT).toBeGreaterThan(6000)
  })

  test('conversational tier covers a warm Opus turn (45s) — rich phases land instead of falling back to static', () => {
    // 2026-06-18 (warm-turn static-fallback fix): 12s was STILL too tight for the
    // rich phases. Once the pre-warm's trivial 16-token warm-up settles,
    // `isWarmReady()` flips true and every dispatch drops to this tier — but a
    // REAL phase-spec turn runs Opus generating ~400 tokens of personalised
    // content on an ACCUMULATING session, which legitimately runs past 12s. The
    // resolver's `withTimeout` does not cancel the turn, so a budget below the
    // real warm-turn latency discarded EVERY answer → 100% static fallback for
    // personality_offered / agent_name_chosen / ai_substrate_offered / signup
    // (the owner's generic-archetypes + hardcoded-names regression). 45s covers a
    // warm Opus rephrase (matching the suggester's cold-Opus-CC-spawn budget); a
    // typing indicator is shown throughout. See llm-timeouts.ts for the rationale.
    expect(CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBe(45000)
    // Must comfortably exceed the warm-turn latency that caused the
    // 100%-static-fallback bug (the whole point of this fix), AND stay under the
    // heavy synthesis budget so the two tiers never collapse into one value.
    expect(CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBeGreaterThanOrEqual(30000)
    expect(CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBeLessThan(SYNTHESIS_TIMEOUT_MS_DEFAULT)
  })

  test('synthesis tier is LONG (90s) — heavy background read, never on a turn', () => {
    // The synthesis/import path genuinely needs a long budget (a heavy history
    // read can run minutes) but runs behind the loading screen, not on a turn.
    expect(SYNTHESIS_TIMEOUT_MS_DEFAULT).toBe(90000)
    expect(SYNTHESIS_TIMEOUT_MS_DEFAULT).toBeGreaterThanOrEqual(60000)
  })

  test('the two tiers are DISTINCT — conversational must be far shorter than synthesis', () => {
    // Regression guard for the 2026-06-17 conflation: one global constant made
    // every conversational turn inherit the heavy budget. The tiers must never
    // collapse back into one value.
    expect(CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBeLessThan(SYNTHESIS_TIMEOUT_MS_DEFAULT)
    // The conversational tier must stay shorter than the heavy synthesis budget
    // (45s vs 90s = 2x). The ratio loosened from 4x when the conversational floor
    // rose to 45s (warm-turn static-fallback fix — a warm Opus rephrase needs that
    // room); the guard's job is "never collapse back into one identical value",
    // which 2x still preserves.
    expect(SYNTHESIS_TIMEOUT_MS_DEFAULT / CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBeGreaterThanOrEqual(2)
  })

  test('synthesis idle-heartbeat window is the PRIMARY wedge detector (120s — covers a cold silent read)', () => {
    // 2026-06-18 owner-dogfood false-wedge fix: 30s was too tight for the SILENT
    // time-to-first-token on the synthesis read path (read + think before the first
    // token), so the detector false-wedged 100% of passes on a loaded box. Widened
    // to 120s; the child-liveness keepalive is the real detector (a silently-
    // reading-but-alive turn keepalives, so it never false-wedges), and this window
    // only fires when the child is genuinely gone. Must stay short of the ceiling.
    expect(SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT).toBe(120000)
    expect(SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT).toBeLessThan(SYNTHESIS_CEILING_MS_DEFAULT)
    // Never regress back under the old 30s false-wedge threshold.
    expect(SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT).toBeGreaterThan(30000)
  })

  test('synthesis absolute ceiling is GENEROUS (10 min) — the backstop, not the detector', () => {
    // The ceiling exists only to bound a livelock that dodges the idle window; it
    // must be generous so a legitimately long but healthy streaming read pass is
    // never killed by it (that is the idle-heartbeat's job). Raised 5min → 10min
    // so the widened 120s idle window has comfortable headroom under it.
    expect(SYNTHESIS_CEILING_MS_DEFAULT).toBe(600000)
    expect(SYNTHESIS_CEILING_MS_DEFAULT).toBeGreaterThanOrEqual(SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT * 2)
  })

  test('first-conversational budget covers a cold spawn (pre-warm cap + one warm tier)', () => {
    // 2026-06-18 cold-start fix: the FIRST conversational turn gets a one-time
    // elevated budget so it can't degrade to static merely because the warm
    // session is still cold-spawning. It must exceed both the snappy tier AND the
    // pre-warm await cap (a cold spawn can land right at the cap).
    expect(FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBe(
      PREWARM_AWAIT_CAP_MS_DEFAULT + CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
    )
    expect(FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBeGreaterThan(CONVERSATIONAL_TIMEOUT_MS_DEFAULT)
    expect(FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT).toBeGreaterThanOrEqual(PREWARM_AWAIT_CAP_MS_DEFAULT)
  })

  test('readEnvTimeoutMs parses a positive integer override', () => {
    expect(readEnvTimeoutMs('__NEUTRON_TEST_MISSING__', 12345)).toBe(12345)
  })

  test('readEnvTimeoutMs rejects non-numeric / non-positive overrides', () => {
    process.env['__NEUTRON_TEST_TIMEOUT__'] = 'not-a-number'
    expect(readEnvTimeoutMs('__NEUTRON_TEST_TIMEOUT__', 9000)).toBe(9000)
    process.env['__NEUTRON_TEST_TIMEOUT__'] = '0'
    expect(readEnvTimeoutMs('__NEUTRON_TEST_TIMEOUT__', 9000)).toBe(9000)
    process.env['__NEUTRON_TEST_TIMEOUT__'] = '-5'
    expect(readEnvTimeoutMs('__NEUTRON_TEST_TIMEOUT__', 9000)).toBe(9000)
    process.env['__NEUTRON_TEST_TIMEOUT__'] = '15000'
    expect(readEnvTimeoutMs('__NEUTRON_TEST_TIMEOUT__', 9000)).toBe(15000)
    delete process.env['__NEUTRON_TEST_TIMEOUT__']
  })
})
