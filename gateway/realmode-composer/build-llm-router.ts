/**
 * @neutronai/gateway/realmode-composer — LLM conversational router factory.
 *
 * P2-v3 S2 (2026-05-18). Wires the per-instance Anthropic client into a
 * `LlmRouter` instance and binds the router's `onRouteCompleted`
 * telemetry hook to `OnboardingTelemetry.emit('onboarding.router_decision', ...)`.
 *
 * The router is the conversational layer that classifies every freeform
 * inbound during onboarding into `advance` / `answer` / `amend`. The
 * engine calls `route(...)` at its freeform fall-through (engine.ts
 * normalAdvance) when:
 *   - `NEUTRON_ONBOARDING_CONVERSATIONAL` is set to a non-opt-out value
 *     (read via `PlatformAdapter.getOnboardingConversational()`)
 *   - the phase has a non-null `PHASE_KNOWLEDGE` pack
 *
 * Per design § 7.4 the router's `onRouteCompleted` is the single emit
 * site for `onboarding.router_decision`. The engine does NOT re-emit —
 * the composer threads the `project_slug` + `user_id` via the optional
 * `RouterInput` fields (verbatim pass-through to `RouterTelemetryEvent`)
 * so the callback can stamp them onto the persisted event without
 * re-resolving tenancy from the request.
 *
 * CC-substrate migration (sprint cc-substrate-migration-3-sites,
 * 2026-05-31): this file NO LONGER makes direct HTTPS calls to the
 * Anthropic Messages API. Every router-bound dispatch is now routed
 * through the shared `buildLlmCallSubstrate` helper (see
 * `build-llm-call-substrate.ts`) which spawns `claude -p` subprocesses
 * under the per-instance `CredentialPool`, applying the same OAuth
 * refresh + env-scrubbing + cooldown reporting discipline as the
 * history-import pipeline. Direct HTTPS POSTs to the upstream
 * `/v1/messages` endpoint are FORBIDDEN in instance-facing code per
 * memory `feedback_cc_subprocess_substrate.md`.
 */

import {
  buildLlmRouter,
  type LlmRouter,
  type RouterOptions,
  type RouterTelemetryEvent,
} from '../../onboarding/interview/llm-router.ts'
import type { AnthropicMessagesClient } from '../../onboarding/interview/anthropic-client.ts'
import { maybeBuildFixtureClientFromEnv } from '../../onboarding/interview/fixture-anthropic-client.ts'
import type { OnboardingTelemetry } from '../../onboarding/telemetry/event-emitter.ts'
import { composeSystemPrompt } from './index.ts'
import type { PersonaPromptLoader } from './persona-loader.ts'
// Transition re-export (K11a2) — `buildGatewayAnthropicMessagesClient` +
// its input type moved to `build-anthropic-messages-client.ts`. Re-exported
// here so nothing breaks mid-repoint until K11b1 deletes this file's dead
// halves.
export {
  buildGatewayAnthropicMessagesClient,
  type BuildGatewayAnthropicMessagesClientInput,
} from './build-anthropic-messages-client.ts'

export interface BuildLlmRouterDeps {
  anthropicClient: AnthropicMessagesClient
  /** When provided, the router's `onRouteCompleted` hook stamps
   *  `onboarding.router_decision` rows onto the telemetry. When
   *  absent, telemetry is dropped silently (matches the v2 contract). */
  onboardingTelemetry?: OnboardingTelemetry
  options?: RouterOptions
  /**
   * E2E onboarding walkthrough — when set, the deps' `anthropicClient`
   * is REPLACED with this fixture-backed client before the router is
   * built. The harness boots the gateway with this set to a directory
   * of canned LLM responses so the engine's router calls resolve
   * deterministically without touching Anthropic.
   *
   * Per docs/plans/2026-05-22-e2e-onboarding-walkthrough.md § Part A.3.
   *
   * Resolution order:
   *   1. `deps.fixtureAnthropicClient` (this field) — wins when set.
   *   2. `NEUTRON_E2E_LLM_FIXTURES_DIR` env (resolved at factory time
   *      via `maybeBuildFixtureClientFromEnv`) — used when the boot
   *      shell didn't supply a fixture client but the env is set.
   *   3. Otherwise the production `deps.anthropicClient` is wired.
   */
  fixtureAnthropicClient?: AnthropicMessagesClient
  /**
   * ISSUE #36 (v0.1.86) — persona-file loader. When supplied, the
   * factory wraps the resolved `AnthropicMessagesClient` so every
   * router-bound `messages.create({ system, ... })` call has its
   * `system` field re-composed via
   * `composeSystemPrompt({ base: system, persona: await loader.load() })`
   * before reaching Anthropic. Same splice helper the resolver path
   * uses (`build-phase-spec-resolver.ts:212-234`) → the persona block
   * lands above the router's classifier prompt with the SAME
   * `# Persona` header + `<persona_file>` per-file framing.
   *
   * Pass `null`/`undefined` to skip persona splicing entirely (legacy
   * boot paths, unit tests that care only about the classifier
   * contract). Loader read failures are NEVER fatal — the loader logs
   * + skips the affected file (mirrors persona-loader.ts contract);
   * the wrapper additionally swallows any unexpected `load()` throw so
   * a persona-loader contract change can never block the router's
   * upstream LLM call.
   *
   * The production composer (`gateway/index.ts:2641`) threads the SAME
   * `PersonaPromptLoader` instance shared with the phase-spec resolver
   * + the admin-personality surface's `onReload` hook, so a PATCH on
   * SOUL.md cache-busts BOTH the resolver path AND the router path
   * before the very next agent turn.
   *
   * Fixture-mode interaction: when an E2E fixture client is active
   * (either via `fixtureAnthropicClient` or
   * `NEUTRON_E2E_LLM_FIXTURES_DIR`), persona splicing is SKIPPED so
   * the fixture's `{system, messages}` hash-matching stays stable.
   * The E2E walkthrough doesn't currently assert persona-aware router
   * behavior; if a future walkthrough needs it, re-record the
   * fixtures against the persona-spliced system or add a per-fixture
   * opt-in.
   */
  personaLoader?: PersonaPromptLoader | null
}

/**
 * Build the production LLM router instance. The factory composes the
 * existing `buildLlmRouter` with the gateway-side telemetry sink so
 * the engine's `dispatchRouterDecision` never re-emits.
 */
export function buildGatewayLlmRouter(deps: BuildLlmRouterDeps): LlmRouter {
  const telemetry =
    deps.onboardingTelemetry !== undefined
      ? {
          onRouteCompleted: (ev: RouterTelemetryEvent): void => {
            // The router pass-throughs `project_slug` + `user_id` from
            // `RouterInput` onto the event when set. We require both to
            // emit a scoped row; if either is missing (legacy caller),
            // drop the event silently (mirrors design § 7.4 — no
            // unscoped rows in `gateway_events`).
            if (ev.project_slug === undefined || ev.user_id === undefined) {
              return
            }
            void deps.onboardingTelemetry!.emit({
              project_slug: ev.project_slug,
              user_id: ev.user_id,
              event: 'onboarding.router_decision',
              payload: {
                phase: ev.phase,
                action: ev.action,
                confidence: ev.confidence,
                escalated_to_sonnet: ev.escalated_to_sonnet,
                timed_out: ev.timed_out,
                clarify_synthesised: ev.clarify_synthesised,
                reasoning_redacted: redactReasoning(ev.reasoning),
                latency_ms: ev.latency_ms,
              },
            })
          },
        }
      : undefined

  // E2E fixture client wins when supplied OR when the env var is set
  // at factory time — see `fixtureAnthropicClient` JSDoc for the order.
  const fixtureClient =
    deps.fixtureAnthropicClient ?? maybeBuildFixtureClientFromEnv()
  const baseClient: AnthropicMessagesClient =
    fixtureClient ?? deps.anthropicClient

  // ISSUE #36 (v0.1.86) — persona splice wrapper. When the loader is
  // wired AND we're NOT in fixture mode, every router-bound
  // messages.create() has its `system` re-composed through
  // composeSystemPrompt so the classifier sees <owner_home>/persona/
  // {SOUL,USER,priority-map}.md above its own classifier framing.
  // Mirrors the resolver-path wrapper at
  // build-phase-spec-resolver.ts:212-234 + uses the same splice helper
  // (composeSystemPrompt) so persona block formatting is byte-identical
  // across both paths. When the loader is unwired OR persona body
  // resolves to empty (pre-onboarding-commit), composeSystemPrompt
  // short-circuits to `base` byte-identical — the prompt-cache anchor
  // stays stable for instances pre-persona-commit.
  const personaLoader = deps.personaLoader ?? null
  const effectiveClient: AnthropicMessagesClient =
    personaLoader === null || fixtureClient !== null
      ? baseClient
      : wrapClientWithPersonaSplice(baseClient, personaLoader)

  const args: Parameters<typeof buildLlmRouter>[0] = {
    anthropicClient: effectiveClient,
  }
  if (telemetry !== undefined) args.telemetry = telemetry
  if (deps.options !== undefined) args.options = deps.options
  return buildLlmRouter(args)
}

/**
 * Decorator over `AnthropicMessagesClient` that splices the persona
 * body above the inbound `system` field on every
 * `messages.create` call. The splice uses `composeSystemPrompt` so the
 * router path produces the IDENTICAL `# Persona` header +
 * `<persona_file name="…">` framing the resolver path uses.
 *
 * Failure posture: persona load failures are isolated to the loader
 * (per `persona-loader.ts:166-172`) — the loader returns an empty
 * string and `composeSystemPrompt` short-circuits to `base`
 * byte-identical. The wrapper additionally swallows any unexpected
 * `load()` throw so a future persona-loader contract change can never
 * block the router's upstream LLM call.
 */
function wrapClientWithPersonaSplice(
  inner: AnthropicMessagesClient,
  loader: PersonaPromptLoader,
): AnthropicMessagesClient {
  return {
    messages: {
      async create(args) {
        let persona = ''
        try {
          persona = await loader.load()
        } catch (err) {
          console.warn(
            `[llm-router] persona load failed; proceeding without persona splice: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          persona = ''
        }
        const composed = composeSystemPrompt({
          base: args.system ?? '',
          persona,
        })
        return inner.messages.create({ ...args, system: composed })
      },
    },
  }
}

/**
 * Strip the router's internal diagnostic to its first 100 chars before
 * persistence. The router itself caps `reasoning` ≤ 200 chars at parse
 * time; the redaction here keeps the telemetry surface narrow + makes
 * the data engineer-readable in `gateway_events.payload_json` without
 * forcing them to scroll long classifier rationales.
 */
function redactReasoning(s: string): string {
  if (typeof s !== 'string') return ''
  return s.length > 100 ? `${s.slice(0, 97)}...` : s
}
