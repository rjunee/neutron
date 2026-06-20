/**
 * @neutronai/onboarding/interview — shared LLM timeout budgets (2026-06-04).
 *
 * Background (the bug this fixes): every in-onboarding LLM call — the two
 * suggesters AND the `work_interview_gap_fill` question driver — runs on the
 * Claude Code subprocess substrate (`claude -p`), NOT a direct
 * api.anthropic.com call. A cold spawn (bun + MCP config + system-prompt
 * load + first token) routinely exceeds the legacy 4 s / 6 s budgets,
 * so those budgets timed out ~100 % of the time and the driver fell back to
 * the generic static spec (vague "tell me more" question / 5 male sages /
 * same 3 names) on EVERY onboarding.
 *
 * 2026-06-04 (LLM-model swap) — the suggesters now run on `BEST_MODEL`
 * (Opus 4.7) rather than `FAST_MODEL` (Haiku 4.5): the suggesters moved to
 * BACKGROUND pre-compute this sprint, so there is no user-facing latency
 * to protect and Opus gives far better personalization + variety (the whole
 * point of the sprint). Opus is slower than Haiku — a genuinely COLD Opus
 * CC-subprocess spawn (bun + MCP + system-prompt load + Opus generation)
 * can run 20-40 s. The suggester budget is therefore raised to 45 s so a
 * cold spawn lands the real, signal-conditioned picks during pre-compute
 * instead of timing out into the (re-rolled, never-frozen) diverse
 * fallback. The pre-compute fires several human-time turns before
 * `personality_offered` / `agent_name_chosen` render, so the longer upper
 * bound is hidden in the common case; the rare not-ready render does a
 * bounded await up to this budget with a typing indicator, then the
 * diverse fallback covers it.
 *
 * The `work_interview_gap_fill` question driver is genuinely INLINE (the
 * user waits for the next question with a typing indicator shown), so its
 * budget stays at 30 s — long enough for a warm Opus spawn to land a real
 * question while the static fallback question covers a cold-spawn timeout
 * without making the user wait the full 45 s.
 *
 * Both knobs are env-overridable so prod can tune without a redeploy.
 */

/** Parse a positive-integer millisecond env var; fall back otherwise. */
export function readEnvTimeoutMs(envKey: string, fallback: number): number {
  const raw = process.env[envKey]
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Suggester (character + agent-name) LLM budget. Was 6000ms → 30000ms →
 * 45000ms. Raised to 45 s when the suggesters moved to `BEST_MODEL`
 * (Opus 4.7): a cold Opus CC-subprocess spawn can run 20-40 s, and these
 * calls are background pre-computed (no user-facing latency in the common
 * case) so the longer upper bound costs nothing while letting the real
 * Opus picks land instead of timing out into the diverse fallback.
 */
export const SUGGESTER_TIMEOUT_MS_DEFAULT = readEnvTimeoutMs(
  'NEUTRON_SUGGESTER_TIMEOUT_MS',
  45000,
)

/**
 * CONVERSATIONAL (SHORT-tier) LLM budget — the `work_interview_gap_fill`
 * question-driver + the phase-spec-resolver prompt rephrasing.
 * History: 4000ms → 30000ms → 90000ms → 3000ms (2026-06-17) → 12000ms
 * (2026-06-18, warm-session hang fix) → 45000ms (2026-06-18, warm-turn
 * static-fallback fix).
 *
 * This constant is the default budget BOTH conversational consumers use
 * (`phase-spec-resolver.ts` + `llm-prompt-driver.ts`,
 * `deps.timeout_ms ?? CONVERSATIONAL_TIMEOUT_MS_DEFAULT`).
 *
 * WHY 45 s (the 12 s was STILL too tight for the rich phases): even with the
 * pre-warm `awaitReady` gate + the one-time elevated first-call budget, the live
 * owner-signup kept logging `[phase-spec-resolver] llm call failed; falling back
 * to static spec ... timed out after 12000ms` for `personality_offered`,
 * `agent_name_chosen`, `ai_substrate_offered`, and `signup`. Root cause: once the
 * pre-warm's trivial 16-token warm-up turn settles, `isWarmReady()` reports
 * "warm" and every subsequent dispatch drops to this snappy tier — but a REAL
 * phase-spec turn is NOT trivial. It runs BEST_MODEL (Opus) generating ~400
 * tokens of rich, personalised content (character archetypes, tailored name
 * ideas, buttons) on a session whose context ACCUMULATES across the whole
 * onboarding (by `personality_offered`/`agent_name_chosen` the transcript +
 * synthesis are already in-context), so a warm turn legitimately runs well past
 * 12 s. The resolver's `withTimeout` does NOT cancel the underlying turn, so any
 * budget below the real warm-turn latency discards EVERY real answer → 100 %
 * static fallback for those phases (generic archetypes, hardcoded placeholder
 * names — exactly the regression the owner hit).
 *
 * 45 s comfortably covers a warm Opus rephrase of even the heaviest phase (and a
 * cold ~11-30 s CC spawn on the rare path the elevated first-call budget misses),
 * matching the suggester tier's "cold Opus CC-spawn" budget — same model, same
 * substrate, same latency envelope. A typing indicator is shown throughout
 * (`onLlmStart`/`onLlmEnd`), so the user sees the agent thinking rather than a
 * snap to static. A genuine stall still falls back (and the abandoned turn marks
 * its warm session for a clean respawn — ReplSession.poisoned — so it can't
 * cascade); 45 s just stops a SLOW-but-healthy warm turn from being mistaken for
 * a stall. Per the synthesis-liveness philosophy: don't let a too-tight timeout
 * degrade to static while the session is merely slow.
 *
 * Env-overridable (`NEUTRON_GAP_FILL_TIMEOUT_MS`, name kept for back-compat with
 * existing prod overlays) for tuning without a redeploy.
 */
export const CONVERSATIONAL_TIMEOUT_MS_DEFAULT = readEnvTimeoutMs(
  'NEUTRON_GAP_FILL_TIMEOUT_MS',
  45000,
)

/**
 * SYNTHESIS / IMPORT (LONG-tier) LLM budget — the heavy history-read +
 * per-project synthesis path (Step 2). This is the path that genuinely needs a
 * long budget: it reads + digests a large export through a warm synthesis
 * session, and a single heavy read pass can legitimately run minutes. It is
 * NEVER on a user-facing conversational turn (it runs behind the loading screen
 * / in the background), so a long upper bound costs no interactive latency.
 *
 * Kept DISTINCT from the conversational tier so raising/lowering the heavy
 * budget can never re-introduce a multi-second stall on the chat path (the
 * 2026-06-17 regression: one global 90 s constant conflated the two and every
 * conversational turn inherited the heavy budget).
 *
 * Env-overridable (`NEUTRON_SYNTHESIS_TIMEOUT_MS`).
 */
export const SYNTHESIS_TIMEOUT_MS_DEFAULT = readEnvTimeoutMs(
  'NEUTRON_SYNTHESIS_TIMEOUT_MS',
  90000,
)

/**
 * SYNTHESIS IDLE-HEARTBEAT window (2026-06-18, owner-requested wedge-detector) —
 * the primary wedge detector for the heavy synthesis/import read path.
 *
 * WHY a heartbeat, not a fixed total cap: a FIXED per-turn cap
 * (`SYNTHESIS_TIMEOUT_MS_DEFAULT`) conflates "the REPL is wedged (emitting
 * nothing)" with "the read pass is legitimately long (still streaming
 * tokens/tool-calls/thinking)". The owner asked to "detect a wedge vs actual
 * work in a smarter way than a random timeout number." The synthesis dispatch
 * therefore watches the substrate's Event stream and resets an idle timer on
 * EVERY event (token / thinking / status / tool_* / completion) AND on a
 * substrate LIVENESS keepalive — a periodic `status` heartbeat the persistent
 * REPL emits while its `claude` child is ALIVE (see `REPL_LIVENESS_KEEPALIVE_MS`
 * in `persistent-repl-substrate.ts`). A turn that keeps streaming OR is silently
 * reading-but-alive stays alive no matter how long it runs; a turn that goes
 * SILENT *and* whose child is gone (zero events, no keepalive) trips this window.
 *
 * WHY 120 s (was 30 s — the 2026-06-18 owner-dogfood false-wedge): a synthesis
 * read pass spends its first stretch SILENTLY reading + thinking BEFORE emitting
 * its first token. On a loaded box that silent time-to-first-token routinely
 * exceeded the old 30 s window, so the detector fired a FALSE wedge on EVERY pass
 * (the live failure: 15 wedge events = 100 % of passes, whole import failed
 * `pass1_all_failed`). 30 s was wrong for time-to-first-token on the synthesis
 * read path even though it is well past any *inter-token* gap. 120 s comfortably
 * covers a cold silent read; the child-liveness keepalive is the real detector
 * (a silently-reading-but-alive turn keepalives, so it is never falsely wedged),
 * and this window only fires when the child is genuinely gone with no keepalive.
 * Env-overridable (`NEUTRON_SYNTHESIS_IDLE_MS`).
 */
export const SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT = readEnvTimeoutMs(
  'NEUTRON_SYNTHESIS_IDLE_MS',
  120000,
)

/**
 * SYNTHESIS ABSOLUTE CEILING (2026-06-18) — the final backstop for the heavy
 * synthesis/import read path, behind the idle-heartbeat above.
 *
 * The idle-heartbeat is the PRIMARY detector; this ceiling exists only so a
 * pathological turn that DOES keep emitting just enough activity (or keepalives
 * off a live-but-livelocked child) to dodge the idle window forever is still
 * bounded. It is deliberately GENEROUS (10 min — raised 2026-06-18 from 5 min so
 * the widened 120 s idle window has comfortable headroom under it) so a genuinely
 * long-but-healthy streaming read pass is never killed by it — that is the
 * heartbeat's job. Env-overridable (`NEUTRON_SYNTHESIS_CEILING_MS`).
 */
export const SYNTHESIS_CEILING_MS_DEFAULT = readEnvTimeoutMs(
  'NEUTRON_SYNTHESIS_CEILING_MS',
  600000,
)

/**
 * PRE-WARM AWAIT CAP (2026-06-18 synthesis-completes fix) — the bound the FIRST
 * conversational phase-spec dispatch waits for the pre-warmed `claude` REPL to
 * finish its cold spawn BEFORE starting its own (short) conversational budget.
 *
 * WHY: `open/composer.ts` pre-warms the conversational substrate fire-and-forget
 * at onboarding start (behind the loading indicator). A genuinely cold CC spawn
 * (bun + MCP + dev-channel + system-prompt load + first token) runs ~11-30 s. If
 * the owner answers the first question BEFORE the pre-warm settles, the first
 * real dispatch races that cold spawn — and the SHORT conversational tier
 * (`CONVERSATIONAL_TIMEOUT_MS_DEFAULT`, 12 s) is far too tight to cover it, so
 * the call times out and falls back to the static phase prompt purely from
 * cold-spawn latency (the live-signup symptom: `[phase-spec-resolver] llm call
 * failed; falling back to static spec ... timed out after 12000ms`).
 *
 * The fix AWAITS the pre-warm's readiness (bounded by this cap) OUTSIDE the
 * conversational timeout, so only the COLD FIRST turn waits and every warm turn
 * stays snappy at the 12 s tier. The cap comfortably exceeds the documented cold
 * spawn so the wait resolves on real readiness, not the bound; if the pre-warm
 * genuinely hangs past it, the dispatch proceeds anyway (degrading to exactly
 * the pre-fix race). Env-overridable.
 */
export const PREWARM_AWAIT_CAP_MS_DEFAULT = readEnvTimeoutMs(
  'NEUTRON_PREWARM_AWAIT_CAP_MS',
  35000,
)

/**
 * FIRST conversational-turn budget (2026-06-18, conversational cold-start fix) —
 * the ONE-TIME elevated timeout the phase-spec resolver applies to its FIRST LLM
 * dispatch only; every subsequent (warm) dispatch uses the snappy
 * `CONVERSATIONAL_TIMEOUT_MS_DEFAULT` (12 s) tier.
 *
 * WHY (the lingering 12 s timeout): even with the pre-warm `awaitReady` gate
 * (#95), the first one or two conversational phase-spec calls STILL fell back to
 * static with `... timed out after 12000ms` on a fresh load. Two ways the gate
 * leaks the cold spawn onto the first real turn: (a) `awaitReady` resolves at its
 * cap (`PREWARM_AWAIT_CAP_MS_DEFAULT`) while the warm session is STILL spawning,
 * or (b) the pre-warm's warm-up turn errored/was swallowed, so the first real
 * dispatch cold-spawns afresh. In both cases the 12 s tier is far too tight for a
 * ~11-30 s cold CC spawn, so the first turn degrades to static purely from
 * spawn latency.
 *
 * The robust fix is belt-and-suspenders with `awaitReady`: the FIRST conversational
 * call gets a budget that comfortably EXCEEDS a cold spawn (the pre-warm cap PLUS
 * one warm-turn tier), so it does NOT degrade to static merely because the warm
 * session is still spawning. Exactly one call pays this elevated budget; warm
 * turns stay snappy at 12 s. Env-overridable
 * (`NEUTRON_FIRST_CONVERSATIONAL_TIMEOUT_MS`); the default is derived so a tune of
 * either tier flows through.
 */
export const FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT = readEnvTimeoutMs(
  'NEUTRON_FIRST_CONVERSATIONAL_TIMEOUT_MS',
  PREWARM_AWAIT_CAP_MS_DEFAULT + CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
)
