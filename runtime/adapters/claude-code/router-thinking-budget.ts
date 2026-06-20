/**
 * @neutronai/runtime — router classifier thinking-budget control.
 *
 * ROOT CAUSE (2026-06-05, `docs/plans/router-call-hangs-rootcause-brief.md`):
 * the onboarding router's per-turn `claude -p` spawn ran with Claude Code's
 * DEFAULT extended-thinking budget enabled. The router is a trivial classifier
 * that emits ONE JSON line — but on a real (slightly ambiguous) onboarding
 * prompt the model generated a multi-thousand-token THINKING block before the
 * answer, taking 20-40s to complete. That is the "hang": the call never
 * returned within ANY budget (6s, 12s, …) because the abort fired mid-thinking.
 *
 * Measured on prod (Haiku 4.5, the REAL 5 KB router prompt):
 *   - thinking ON  → cold 39810ms (out_tokens=4879) / warm 20097-36267ms
 *   - thinking OFF → cold 3080-3224ms (out_tokens=173-201) / warm 2982-3708ms
 *
 * Four prior fixes (budget 3000→6000→12000ms, warm reuse #370, prewarm #371)
 * all treated this as cold-spawn LATENCY. It was never latency or prompt size
 * (the prompt is ~1300 tokens); it was thinking generation time. The fix is to
 * set `MAX_THINKING_TOKENS=0` in the router spawn env so the model emits the
 * JSON envelope directly (~3s, matching the ~2.4s bare-call baseline) instead
 * of thinking for 20-40s. Classification quality is unchanged — the disabled-
 * thinking output produced the same correct `advance`/confidence/freeform
 * decisions in every prod trial.
 *
 * Applied to the router substrate: the router-dedicated `buildLlmCallSubstrate`
 * threads this as `extra_env` (`gateway/index.ts`), so the persistent router REPL
 * (`cc-llm-router-{instance}`) spawns with `MAX_THINKING_TOKENS=0`. (The legacy
 * `claude -p` warm-router process was deleted in the S3 rip-replace.)
 *
 * Scope: router-only. The shared `llmCallSubstrate` (suggesters, persona
 * summarizer, seed composer, wow picker, watcher, nudge, research) is left
 * untouched here — the same thinking-latency likely affects those structured
 * composer calls too, but that is a separate, broader change (see the sprint
 * PR's "follow-up" note). This module keeps the router's escape hatch isolated.
 */

/** Env override for the router classifier's thinking-token budget. Default
 *  `'0'` (thinking disabled). Set to a positive integer to re-enable a bounded
 *  thinking budget, or leave unset for the safe (disabled) default. */
export const ROUTER_MAX_THINKING_TOKENS_ENV = 'NEUTRON_ROUTER_MAX_THINKING_TOKENS'

/** Default: thinking fully disabled for the router classifier spawn. */
export const ROUTER_MAX_THINKING_TOKENS_DEFAULT = '0'

/**
 * Resolve the `MAX_THINKING_TOKENS` value to inject into the router spawn env.
 * Honours `NEUTRON_ROUTER_MAX_THINKING_TOKENS` when it parses to a
 * non-negative integer; otherwise returns the safe default (`'0'`). Returned as
 * a string because it is layered straight into the subprocess env overlay.
 */
export function resolveRouterThinkingBudget(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[ROUTER_MAX_THINKING_TOKENS_ENV]
  if (raw === undefined || raw.trim() === '') return ROUTER_MAX_THINKING_TOKENS_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return ROUTER_MAX_THINKING_TOKENS_DEFAULT
  }
  return String(n)
}

/**
 * The router spawn env overlay: a single `MAX_THINKING_TOKENS` entry. Suitable
 * to merge into a CC-subprocess env (warm process spawn OR cold substrate
 * `extra_env`). Kept as a helper so both paths inject the IDENTICAL key/value.
 */
export function routerThinkingEnvOverlay(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return { MAX_THINKING_TOKENS: resolveRouterThinkingBudget(env) }
}
