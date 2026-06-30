/**
 * @neutronai/onboarding/history-import — Substrate-backed Pass-1 + Pass-2 LLM callers (T7).
 *
 * Per docs/plans/P2-onboarding-v2.md § 1.3 (T7 Pass-1 / Pass-2 substrate
 * contract) + the archived v1 § 2.3 / § 4.7 (ImportJobRunner contracts).
 * The v0.1.78 (2026-05-22) `BudgetCap` removal is documented in
 * `onboarding/history-import/index.ts`.
 *
 * **2026-05-31 (Pass-1 = Opus 4.7 by default, Sam-locked).** The v1 spec
 * line "Pass 1 (fast triage, Haiku 4.5 default)" is REJECTED. Pass-1 now
 * dispatches `BEST_MODEL` (Opus 4.7) by default — same model as Pass-2 —
 * because every Pass-1 chunk spawns a `claude` subprocess against the
 * owner's Max OAuth substrate, so there is no marginal cost to running the
 * Max plan's flagship model. Haiku 4.5 / Sonnet 4.6 remain available via
 * `model_preference` overrides for cost-sensitive BYO-API-key owners but
 * production defaults to Opus. See `docs/plans/P2-onboarding-v2.md § 1.3`
 * for the spec update.
 *
 * T7 (2026-05-14) — closes the gap left by T4: the `ImportJobRunner` shipped
 * with `pass1Llm` / `pass2Llm` defaulting to a placeholder closure that throws
 * `ImportError('llm_unwired', ...)` at fetch time. That kept the engine's
 * `failed` sub_step UX honest (CLAUDE.md "Spec is the source of truth"), but it
 * meant a real import never produced any Pass-1 / Pass-2 analysis.
 *
 * This module turns the Substrate abstraction (`runtime/substrate.ts`) into the
 * two LLM callers the runner consumes:
 *
 *   buildPass1SubstrateCaller(deps) -> Pass1LlmCall
 *     - Builds an AgentSpec with BEST_MODEL (Opus 4.7) per the 2026-05-31
 *       Sam-locked architecture review (was FAST_MODEL pre-2026-05-31).
 *     - Renders chunk.text into the user message; loads pass1Prompt as system.
 *     - Iterates the SessionHandle events, collects token text, parses JSON.
 *     - Returns { result: <parsed object>, dollars_billed: <estimated cost> }.
 *
 *   buildPass2SubstrateCaller(deps) -> Pass2LlmCall
 *     - Same shape, BEST_MODEL (Opus 4.7) per § 2.3 Pass-2 synthesis.
 *     - Renders aggregated Pass-1 summary as the user message; loads
 *       pass2Prompt as the system body.
 *     - Returns { result, dollars_billed } against Opus 4.7 pricing.
 *
 * Cost accounting. The CC adapter's `completion` event does NOT carry the
 * `dollars` field (per `runtime/events.ts` that field is reserved for the
 * Private substrate). We estimate dollars from the completion's `TokenUsage`
 * using the published Anthropic 2026 prices baked in below. The runner
 * accumulates the returned value onto `import_jobs.dollars_spent` for
 * telemetry only — nothing reads it for control flow (the v0.1.78 BudgetCap
 * removal axed the enforcement path entirely).
 *
 * Errors. A `kind: 'error'` event before completion throws
 * `ImportError('substrate_error', ...)` so the runner's outer catch surfaces
 * the failure to the engine (which emits the `failed` sub_step prompt with
 * retry/skip). An empty / non-JSON response yields `result: null` and the
 * pass1-triage / pass2-synthesis parsers fall back to empty arrays — a
 * SINGLE bad chunk doesn't tank the whole job, matching T4's catch-and-continue
 * behavior for transient LLM glitches.
 */

import type { Substrate } from '../../runtime/substrate.ts'
import type { Event } from '../../runtime/events.ts'
import type { Pass1LlmCall } from './pass1-triage.ts'
import type { Pass2LlmCall, AggregatedPass1 } from './pass2-synthesis.ts'
import { getBestModel } from '../../runtime/models.ts'
import { resolveModelPricing } from '../../runtime/model-pricing.ts'
import { ImportError, type Chunk } from './types.ts'

/**
 * P2-v2 S21 — payload handed to the substrate caller's fallback hook
 * when an Opus 4.7 429 forced us to dispatch the same Pass-2 prompt
 * against Sonnet 4.6. Production wires this through the gateway to
 * `OnboardingTelemetry.emit('onboarding.pass2_sonnet_fallback_used',
 * ...)` so the metrics view can roll-up fallback frequency. Tests
 * inject a recorder.
 */
export interface Pass2SonnetFallbackInfo {
  /** What forced the fallback. Stable enum for SQL grouping. */
  reason: '429_exhausted_on_opus'
  /** The model id that produced the synthesis (typically `SONNET_MODEL`). */
  synthesizer_model: string
  /** The primary model id that 429'd (typically `BEST_MODEL`). */
  primary_model: string
  /** The original 429 error message that triggered the fallback. */
  primary_error_message: string
  /**
   * P2-v2 S22 — current import source (`chatgpt-zip` / `claude-zip` /
   * etc.). Populated when the runner threads `source` through
   * `pass2Synthesize` → `Pass2LlmCall` input (the production path).
   * Omitted when callers invoke `Pass2LlmCall` without `source`
   * (legacy test mocks); the telemetry hook tolerates the missing
   * field and stamps a sentinel for the event payload.
   */
  source?: string
}

export type Pass2SonnetFallbackHook = (
  info: Pass2SonnetFallbackInfo,
) => void | Promise<void>

/**
 * Anthropic per-million-token list prices live in `runtime/model-pricing.ts`
 * — the single source of truth for every `$X / MTok` constant in Neutron.
 *
 * P2-v2 S23 (2026-05-17) — pre-S23 this file inlined `HAIKU_4_5_*`,
 * `OPUS_4_7_*`, and `SONNET_4_6_*` constants and the Pass-2 fallback
 * resolved a separate `fallback_pricing` block. Two follow-up bugs Codex
 * GPT-5 flagged from S21 R2 / S22 R3:
 *
 *   1. The fallback `fallback_pricing` block was hard-coded to Sonnet 4.6
 *      rates. If an operator overrode `NEUTRON_SONNET_MODEL` to a
 *      different id (e.g. piloting a Sonnet successor), Sonnet usage was
 *      billed at the old Sonnet 4.6 table — same shape as the S21 R1 bug
 *      shifted one layer.
 *   2. Haiku 4.5 was left at the legacy Haiku 3.5 rates ($0.8/$4.0). The
 *      current Haiku 4.5 list price is $1/$5 per MTok per docs.claude.com.
 *
 * S23 closes both by replacing the inline constants with
 * `resolveModelPricing(modelId)` lookups — pricing is now derived from
 * the model id actually dispatched, NOT from a parallel set of constants
 * that drift independently. Operators overriding any model env var get a
 * descriptive startup throw if the override id isn't registered, instead
 * of silently billing at the wrong rate.
 *
 * NOTE on cache pricing: cache_creation_input_tokens are billed at the
 * same rate as input_tokens per Anthropic's 2024-08 cache-control docs;
 * cache_read is billed at 10% of input. For Pass-1 (50K-token chunks)
 * we never hit the cache (each chunk is unique); for Pass-2 the
 * aggregated summary is unique per import. The simple input+output
 * model under-estimates only when an owner reruns the same import,
 * which Pass-1 dedup short-circuits at $0 anyway.
 */

export interface BuildPass1SubstrateCallerDeps {
  substrate: Substrate
  /**
   * Override `model_preference`. Defaults to `[BEST_MODEL]` (Opus 4.7 per
   * the 2026-05-31 Sam-locked architecture review — production runs
   * pass-1 against the Max plan's flagship model since every chunk
   * spawns a `claude` subprocess against the owner's OAuth substrate
   * and there is no marginal cost). Pre-2026-05-31 default was
   * `[FAST_MODEL]` (Haiku 4.5); cost-sensitive BYO-API-key owners can
   * still pass `[FAST_MODEL]` or `[SONNET_MODEL]` here to opt down.
   */
  model_preference?: ReadonlyArray<string>
  /**
   * Optional max-tokens override for the Pass-1 output budget. Default 1500
   * — Pass-1 prompts ask for a structured-JSON triage, which typically lands
   * under 500 tokens; we headroom to 1500 so an unusually-long voice-signals
   * array doesn't truncate.
   */
  max_tokens?: number
  /**
   * Pricing override (test seam). Defaults to the per-model rate resolved
   * through `runtime/model-pricing.ts` for whatever `model_preference[0]`
   * resolved to (Opus 4.7 by default — see the `model_preference` doc
   * above). Tests inject `{0, 0}` so dollar-billing assertions stay
   * deterministic without depending on the real price table.
   */
  pricing?: { input_usd_per_m: number; output_usd_per_m: number }
}

export interface BuildPass2SubstrateCallerDeps {
  substrate: Substrate
  /**
   * Override `model_preference`. Defaults to `[BEST_MODEL]` (Opus 4.7 per
   * § 2.3 — "Pass 2 (synthesis, Opus 4.7 default)").
   */
  model_preference?: ReadonlyArray<string>
  /**
   * P2-v2 S21 (2026-05-17) — Sonnet fallback for Pass-2 429
   * exhaustion. When set AND the primary call throws a 429-shaped
   * `ImportError`, the caller dispatches ONE additional
   * `substrate.start(...)` against this fallback `model_preference`
   * before propagating the error to the runner. Sonnet 4.6
   * (`SONNET_MODEL`) draws from a different Anthropic rate-limit
   * bucket than Opus 4.7 (`BEST_MODEL`) so a cumulatively-exhausted
   * Max-tier Opus can still produce a successful Pass-2 result.
   *
   * Live walkthroughs during P2-v2 development showed Pass-2
   * cumulatively 429ing even after S13's `[0, 5s, 15s, 45s]` retry-
   * on-429 schedule was applied — backoff smooths transient bursts
   * but doesn't solve sustained quota exhaustion. S21 closes that
   * gap by adding a second model bucket to the caller; the runner's
   * S13 retry schedule is unchanged.
   *
   * The fallback path:
   *   1. Primary call against `model_preference` throws a 429.
   *   2. Caller invokes `onSonnetFallback` (if set) so the composer
   *      can emit `onboarding.pass2_sonnet_fallback_used`.
   *   3. Caller dispatches a SECOND `substrate.start` against this
   *      `fallback_model_preference` with the same prompt body +
   *      `max_tokens`.
   *   4. Successful Sonnet result is returned with
   *      `synthesizer_model: <sonnet>`. A Sonnet failure (incl.
   *      another 429) is propagated as `ImportError('substrate_error',
   *      null, ...)` so the runner's S13 backoff handles it the same
   *      way pre-S21 — including the eventual `failed` sub_step UX.
   *
   * Non-429 primary errors (parse failures, 400/403, OAuth expiry)
   * are NOT eligible for fallback — propagated immediately so the
   * engine's `failed` sub_step fires on permanent errors instead of
   * burning a second model bucket on the same broken request.
   */
  fallback_model_preference?: ReadonlyArray<string>
  /**
   * P2-v2 S21 — telemetry hook invoked exactly once per fallback
   * dispatch (NOT once per retry). Composer wires this to
   * `OnboardingTelemetry.emit('onboarding.pass2_sonnet_fallback_used',
   * ...)`. Errors thrown by the hook are caught + logged but do NOT
   * abort the fallback attempt — the user-visible "got a working
   * Pass-2" win is not contingent on telemetry succeeding.
   */
  onSonnetFallback?: Pass2SonnetFallbackHook
  /**
   * Pass-2 emits 3-7 project shells + 5-15 tasks + 3-5 reminders + entities +
   * voice signals + facts — bigger output than Pass-1. Default 4096; the
   * runner's aggregated input is capped at ~80K input tokens upstream so the
   * total turn comfortably fits Opus 4.7's window.
   */
  max_tokens?: number
  /** Pricing override for the PRIMARY dispatch; defaults to Opus 4.7 rates. */
  pricing?: { input_usd_per_m: number; output_usd_per_m: number }
  /**
   * P2-v2 S21 r2 (Argus IMPORTANT #1) — pricing override for the
   * Sonnet fallback dispatch. Defaults to Sonnet 4.6 rates
   * ($3/MTok input, $15/MTok output, verified 2026-05-17 from
   * docs.claude.com/en/docs/about-claude/pricing). The fallback path
   * MUST bill against the actual model that produced the synthesis —
   * pre-r2 we resolved `pricing` once before the model switch, which
   * meant a Sonnet completion got billed at Opus's $15/$75 table and
   * overstated `import_jobs.dollars_spent` telemetry by ~5x. Tests
   * can inject `{ 0, 0 }` to keep dollar assertions deterministic.
   */
  fallback_pricing?: { input_usd_per_m: number; output_usd_per_m: number }
}

/**
 * Construct a `Pass1LlmCall` that dispatches through `deps.substrate.start`.
 * The returned function is what `buildImportJobRunnerHook` threads into
 * `ImportJobRunner.pass1`.
 */
export function buildPass1SubstrateCaller(
  deps: BuildPass1SubstrateCallerDeps,
): Pass1LlmCall {
  const explicitPref =
    deps.model_preference !== undefined && deps.model_preference.length > 0
      ? [...deps.model_preference]
      : null
  const maxTokens = deps.max_tokens ?? 1500
  // P2-v2 S23 — pricing is derived from the model id actually dispatched.
  // An EXPLICIT `model_preference` is captured + priced ONCE here so a typo
  // loud-fails at build (resolvePricingFor). The DYNAMIC always-latest default
  // is resolved PER-CALL inside the returned closure (below) so a post-boot
  // model-update-watchdog flip reaches later imports — the import callers are
  // built once at gateway wire-up, so a build-time capture would pin the
  // boot-time model (Codex cross-model review). `deps.pricing` overrides either.
  const explicitPricing =
    explicitPref !== null ? (deps.pricing ?? resolvePricingFor(explicitPref[0]!)) : null
  return async (input: { chunk: Chunk; prompt: string }) => {
    const modelPref = explicitPref ?? [getBestModel()]
    // Dynamic default degrades to $0 telemetry instead of crashing the import
    // when the watchdog adopts a not-yet-priced model.
    const pricing =
      deps.pricing ?? explicitPricing ?? resolvePricingForDynamicDefault(modelPref[0]!)
    const handle = deps.substrate.start({
      prompt: composeSystemPlusUser(input.prompt, renderChunkUserTurn(input.chunk)),
      tools: [],
      model_preference: modelPref,
      max_tokens: maxTokens,
    })
    const { text, usage } = await drainSubstrateEvents(handle, 'pass1')
    return {
      result: extractJsonObject(text),
      dollars_billed: estimateDollars(usage, pricing),
    }
  }
}

/**
 * Construct a `Pass2LlmCall` that dispatches through `deps.substrate.start`.
 *
 * P2-v2 S21 — when `deps.fallback_model_preference` is set, the caller
 * catches 429-shaped `ImportError`s from the primary model and
 * dispatches ONE additional substrate call against the fallback
 * `model_preference`. See `BuildPass2SubstrateCallerDeps.
 * fallback_model_preference` for the full contract.
 */
export function buildPass2SubstrateCaller(
  deps: BuildPass2SubstrateCallerDeps,
): Pass2LlmCall {
  const explicitPref =
    deps.model_preference !== undefined && deps.model_preference.length > 0
      ? [...deps.model_preference]
      : null
  const fallbackPref =
    deps.fallback_model_preference !== undefined && deps.fallback_model_preference.length > 0
      ? [...deps.fallback_model_preference]
      : null
  const maxTokens = deps.max_tokens ?? 4096
  // P2-v2 S23 — pricing derived from each dispatched model id via the registry
  // (fixes the S21 R2 silent-mis-bill). An EXPLICIT primary is captured + priced
  // ONCE here so a typo loud-fails at build; the DYNAMIC always-latest default
  // resolves PER-CALL inside the closure (below) so a post-boot watchdog flip
  // reaches later imports (Codex cross-model review). `deps.pricing` overrides.
  const explicitPricing =
    explicitPref !== null ? (deps.pricing ?? resolvePricingFor(explicitPref[0]!)) : null
  // The fallback is ALWAYS an explicit operator opt-in (`fallback_model_preference`),
  // so resolve its model + pricing eagerly at build time — an unregistered
  // `NEUTRON_SONNET_MODEL` typo fails fast at composer wiring, not at the first 429.
  const fallbackModel: string | null = fallbackPref !== null ? fallbackPref[0]! : null
  const fallbackPricing =
    fallbackModel !== null
      ? (deps.fallback_pricing ?? resolvePricingFor(fallbackModel))
      : null
  return async (input: { aggregated: AggregatedPass1; prompt: string; source?: string }) => {
    const modelPref = explicitPref ?? [getBestModel()]
    const primaryModel = modelPref[0]!
    // Dynamic default degrades to $0 telemetry instead of crashing on a
    // not-yet-priced watchdog-adopted model.
    const pricing =
      deps.pricing ?? explicitPricing ?? resolvePricingForDynamicDefault(primaryModel)
    const body = composeSystemPlusUser(input.prompt, renderAggregatedUserTurn(input.aggregated))
    try {
      const handle = deps.substrate.start({
        prompt: body,
        tools: [],
        model_preference: modelPref,
        max_tokens: maxTokens,
      })
      const { text, usage } = await drainSubstrateEvents(handle, 'pass2')
      return {
        result: extractJsonObject(text),
        dollars_billed: estimateDollars(usage, pricing),
        synthesizer_model: primaryModel,
      }
    } catch (err) {
      // P2-v2 S21 — Sonnet fallback path. ONLY triggers when:
      //   (a) deps.fallback_model_preference is wired by composition, and
      //   (b) the error from the primary call is 429-shaped.
      // Non-429 errors (parse failures, 400/403, OAuth refresh)
      // propagate unchanged — burning a second model bucket on a
      // permanently-broken request is pure waste.
      if (fallbackPref === null || fallbackModel === null || fallbackPricing === null) {
        throw err
      }
      if (!is429ErrorMessage(extractErrorMessage(err))) throw err
      // Telemetry hook fires BEFORE the fallback dispatch so the
      // event timestamp marks "we noticed Opus 429'd and reached
      // for Sonnet" rather than "Sonnet succeeded". A hook throw
      // must not abort the fallback attempt.
      if (deps.onSonnetFallback !== undefined) {
        try {
          const hookInfo: Pass2SonnetFallbackInfo = {
            reason: '429_exhausted_on_opus',
            synthesizer_model: fallbackModel,
            primary_model: primaryModel,
            primary_error_message: extractErrorMessage(err),
          }
          if (input.source !== undefined) hookInfo.source = input.source
          await deps.onSonnetFallback(hookInfo)
        } catch (hookErr) {
          // eslint-disable-next-line no-console
          console.warn(
            `[pass2-substrate-caller] onSonnetFallback hook threw; continuing fallback dispatch:`,
            hookErr instanceof Error ? hookErr.message : hookErr,
          )
        }
      }
      const handle = deps.substrate.start({
        prompt: body,
        tools: [],
        model_preference: fallbackPref,
        max_tokens: maxTokens,
      })
      const { text, usage } = await drainSubstrateEvents(handle, 'pass2')
      return {
        result: extractJsonObject(text),
        // P2-v2 S23 — Sonnet (or whatever model `fallback_model_preference`
        // names) billed at its own registry rate, not Opus's.
        dollars_billed: estimateDollars(usage, fallbackPricing),
        synthesizer_model: fallbackModel,
      }
    }
  }
}

/**
 * P2-v2 S21 — narrow an unknown thrown value to the message string
 * `is429ErrorMessage` can grep for. Mirrors the runner's
 * `is429RetryableError` shape so the two detectors stay in sync.
 */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/**
 * P2-v2 S21 — pattern-match a substrate error message for 429 / rate-
 * limit shapes. Same regexes as `job-runner.is429RetryableError`; kept
 * local to this module so the substrate caller doesn't take a runtime
 * dependency on the runner just for the detector.
 */
function is429ErrorMessage(message: string): boolean {
  if (/HTTP\s+429\b/i.test(message)) return true
  if (/rate[_-]?limit/i.test(message)) return true
  return false
}

/**
 * Combine the prompt template (system-style instructions) with the per-turn
 * user content into a SINGLE user-turn message.
 *
 * Codex r3 P1 (T7 forge-fix r3): the v1 + v2 shape stuffed the prompt
 * body into `messages: [{role:'system', content: <prompt>}]`. The
 * Anthropic Messages API does not accept `role:'system'` inside the
 * `messages` array (system instructions must live in the top-level
 * `system` field, which the current `AgentSpec`/CC adapter shape does
 * not expose). Real production imports through the CC adapter would
 * therefore have 400'd before any analysis completed.
 *
 * v3 collapses the system+user split into one user-turn body. The
 * prompt templates (`prompts/onboarding/import-analyzer-pass{1,2}.md`)
 * already end with their own separator (`---SEPARATOR---` for Pass-1,
 * `---AGGREGATED-INPUT---` for Pass-2), so appending the chunk/aggregated
 * payload after the template body is the contract those prompts were
 * authored for. No behavior change to the prompt parsing downstream —
 * the model still emits the same JSON schema; we just merge the two
 * halves into a single user turn the CC adapter can ship.
 */
function composeSystemPlusUser(systemBody: string, userBody: string): string {
  return `${systemBody.trimEnd()}\n\n${userBody}`
}

/**
 * Render a Pass-1 chunk as the user-turn body the prompt template expects.
 * The template separator `---SEPARATOR---` lives in the system body; the
 * chunk text goes here on the user turn so it's clearly bounded.
 */
function renderChunkUserTurn(chunk: Chunk): string {
  return [
    `conversation_id: ${chunk.conversation_id}`,
    `chunk_index: ${chunk.chunk_index}`,
    `approx_tokens: ${chunk.approx_tokens}`,
    '',
    '---CHUNK BEGIN---',
    chunk.text,
    '---CHUNK END---',
  ].join('\n')
}

/**
 * Render the AggregatedPass1 summary as the user-turn body the Pass-2
 * prompt expects. Keeps the shape JSON-serializable so the LLM sees a
 * structured document, not free-form prose.
 */
function renderAggregatedUserTurn(aggregated: AggregatedPass1): string {
  return JSON.stringify(aggregated, null, 2)
}

interface DrainedTurn {
  text: string
  usage: { input_tokens: number; output_tokens: number }
}

/**
 * Iterate a `SessionHandle.events` stream, collecting assistant token text +
 * the completion's TokenUsage. Throws `ImportError('substrate_error', ...)`
 * when an `error` event lands before completion, OR when the stream finishes
 * without a completion event at all (defensive — every adapter MUST emit one
 * but a buggy upstream could short-circuit).
 *
 * The `pass` parameter selects the `ImportError.source` so the runner's
 * error_message column carries enough context to debug Pass-1 vs Pass-2
 * failures without a stack trace.
 */
async function drainSubstrateEvents(
  handle: { events: AsyncIterable<Event> },
  pass: 'pass1' | 'pass2',
): Promise<DrainedTurn> {
  let text = ''
  let usage: { input_tokens: number; output_tokens: number } | null = null
  for await (const ev of handle.events) {
    if (ev.kind === 'token') {
      text += ev.text
      continue
    }
    if (ev.kind === 'completion') {
      usage = {
        input_tokens: ev.usage.input_tokens,
        output_tokens: ev.usage.output_tokens,
      }
      // Don't break — let the iterator finish so the adapter's finally
      // block runs and the underlying fetch is torn down cleanly.
      continue
    }
    if (ev.kind === 'error') {
      const importErr = new ImportError(
        'substrate_error',
        null,
        `${pass} substrate error: ${ev.message}`,
      )
      // 2026-06-17 (import-analysis-completeness) — carry the substrate's
      // cooldown hint (all-credential cooldown stamps the pool's soonest
      // `cooldown_until` as `retry_after_ms`) up to the runner's
      // `retryWith429`, which sleeps for the precise quota-reset window
      // and surfaces the `waiting_on_cooldown` phase instead of the
      // generic fixed backoff.
      if (typeof ev.retry_after_ms === 'number' && Number.isFinite(ev.retry_after_ms)) {
        importErr.retry_after_ms = ev.retry_after_ms
      }
      throw importErr
    }
    // thinking / tool_call / tool_result_ack / status → ignore for these
    // pure-text Pass-1 / Pass-2 turns. Tools are passed as `tools: []` so
    // the substrate should not emit tool_call events; if a future adapter
    // surfaces a tool_call here, ignoring it is the safe choice (the
    // SessionHandle's `tool_resolution: 'internal'` contract means the
    // adapter handles it server-side).
  }
  if (usage === null) {
    throw new ImportError(
      'substrate_error',
      null,
      `${pass} substrate stream ended without a completion event`,
    )
  }
  return { text, usage }
}

/**
 * P2-v2 S23 — resolve `{ input_usd_per_m, output_usd_per_m }` for a model
 * id through the central pricing registry. Thin adapter so the call sites
 * in this file don't have to import the registry's `ModelPricingEntry`
 * shape (which carries verification metadata they don't need).
 *
 * Throws via `resolveModelPricing` when the id isn't registered — the
 * substrate caller will fail to construct at composer wire-up, which is
 * the desired loud-fail behavior for an EXPLICIT operator model pick (a
 * typo'd `NEUTRON_BEST_MODEL` / `model_preference` / `fallback_model_preference`
 * must not silently bill at the wrong rate). See `runtime/model-pricing.ts`.
 * The DYNAMIC always-latest default uses {@link resolvePricingForDynamicDefault}
 * instead, which degrades rather than throws.
 */
function resolvePricingFor(
  model_id: string,
): { input_usd_per_m: number; output_usd_per_m: number } {
  const entry = resolveModelPricing(model_id)
  return {
    input_usd_per_m: entry.input_usd_per_m,
    output_usd_per_m: entry.output_usd_per_m,
  }
}

/** Models we've already warned about (one warn per id, avoids log spam). */
const UNPRICED_MODEL_WARNED = new Set<string>()

/**
 * always-latest (2026-06-30) — pricing for the DYNAMIC default model
 * (`getBestModel()`), which DEGRADES instead of throwing on an unregistered id.
 *
 * The import default is now the dynamic `getBestModel()` (always-latest
 * directive), so when the model-update watchdog adopts a brand-new top-tier id
 * BEFORE a verified pricing row exists, a strict `resolveModelPricing` would
 * throw — and because pricing resolves at `buildPass{1,2}SubstrateCaller`
 * CONSTRUCTION (import-job-runner wire-up), that throw would break
 * onboarding/imports entirely (Codex cross-model review). `dollars_billed` is
 * TELEMETRY-ONLY (nothing reads it for control flow — see the cost-accounting
 * note at the top of this file), so the right trade-off for the auto-adopted
 * default is: keep the import RUNNING on the latest model and degrade only the
 * cost ESTIMATE to $0, logging once so an operator still sees a row should be
 * added. EXPLICIT operator picks keep the strict {@link resolvePricingFor}
 * loud-fail (typo protection) — only the auto-adopted default degrades.
 */
function resolvePricingForDynamicDefault(
  model_id: string,
): { input_usd_per_m: number; output_usd_per_m: number } {
  try {
    return resolvePricingFor(model_id)
  } catch (err) {
    if (!UNPRICED_MODEL_WARNED.has(model_id)) {
      UNPRICED_MODEL_WARNED.add(model_id)
      console.warn(
        `[import] no pricing registered for auto-adopted latest model ` +
          `"${model_id}" — import runs but dollars_billed (telemetry-only) is ` +
          `estimated at $0 until a row is added to runtime/model-pricing.ts. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      )
    }
    return { input_usd_per_m: 0, output_usd_per_m: 0 }
  }
}

/**
 * Estimate dollars billed from a completion's TokenUsage. Multiplied through
 * with the supplied pricing (Anthropic 2026 list prices by default; tests
 * inject zero so budget-cap assertions stay deterministic).
 */
function estimateDollars(
  usage: { input_tokens: number; output_tokens: number },
  pricing: { input_usd_per_m: number; output_usd_per_m: number },
): number {
  const input =
    (usage.input_tokens * pricing.input_usd_per_m) / 1_000_000
  const output =
    (usage.output_tokens * pricing.output_usd_per_m) / 1_000_000
  return Number((input + output).toFixed(6))
}

/**
 * Parse a JSON object out of the LLM's assistant text. The prompt template
 * instructs "JSON only, no preamble" so the simple `JSON.parse(text)` path
 * is the happy case. When the model wraps the JSON in a markdown code fence
 * (a recurring Anthropic quirk on long-output turns), we strip the first
 * ```json / ``` fence and try again. Anything else returns null — the
 * pass1-triage / pass2-synthesis parsers downstream defensively fall back
 * to empty arrays + degraded aggregates so a single bad LLM emit doesn't
 * tank the job.
 *
 * Exported for unit testing.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  // Direct JSON
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through
  }
  // Markdown-fenced JSON: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/)
  if (fenceMatch !== null && typeof fenceMatch[1] === 'string') {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch {
      // fall through
    }
  }
  // First-object substring: model emitted preamble like
  // "Here's the JSON: { ... }". Find the first { and take through the
  // matching } (depth-counted). Only used as a last resort.
  const firstBrace = trimmed.indexOf('{')
  if (firstBrace !== -1) {
    const slice = sliceBalancedObject(trimmed, firstBrace)
    if (slice !== null) {
      try {
        return JSON.parse(slice)
      } catch {
        // fall through
      }
    }
  }
  return null
}

/**
 * Walk forward from `start` (pointing at a `{`) and return the substring
 * through the matching `}`. Respects string literals + escape sequences so
 * a `}` inside a quoted value doesn't close the outer object prematurely.
 * Returns null when no balanced object is found.
 */
function sliceBalancedObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
