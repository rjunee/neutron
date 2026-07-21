/**
 * @neutronai/gateway/wiring — production `AnthropicMessagesClient`
 * factory (CC-subprocess substrate adapter).
 *
 * Extracted from `build-llm-router.ts` (K11a2 — refactor unit; that file's
 * router-factory half dies in K11b1 once `buildGatewayLlmRouter` is
 * unwired). `buildGatewayAnthropicMessagesClient` is THE production LLM
 * client — every composer that needs a live Anthropic-shaped client
 * (the router, the project-doc composer, the kickoff composer, the
 * opening-message composer) is wired through this factory.
 *
 * CC-substrate migration (sprint cc-substrate-migration-3-sites,
 * 2026-05-31): this factory does NOT make direct HTTPS calls to the
 * Anthropic Messages API. Every dispatch is routed through the shared
 * `buildLlmCallSubstrate` helper (see `build-llm-call-substrate.ts`) which
 * spawns `claude -p` subprocesses under the per-instance `CredentialPool`,
 * applying the same OAuth refresh + env-scrubbing + cooldown reporting
 * discipline as the history-import pipeline. Direct HTTPS POSTs to the
 * upstream `/v1/messages` endpoint are FORBIDDEN in instance-facing code
 * per memory `feedback_cc_subprocess_substrate.md`.
 */

import { getBestModel } from '@neutronai/runtime/models.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type {
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from '@neutronai/onboarding/interview/anthropic-client.ts'
import {
  collectTokensToString,
  renderMessagesArray,
} from './build-llm-call-substrate.ts'

/**
 * Production composer-side factory for the `AnthropicMessagesClient`
 * interface the router consumes. Wraps a shared CC-subprocess
 * `Substrate` (built via `buildLlmCallSubstrate`) into the
 * `messages.create({ system, messages, max_tokens, signal })` shape the
 * router expects.
 *
 * Migrated 2026-05-31 (sprint cc-substrate-migration-3-sites) from the
 * prior direct HTTPS implementation that POSTed straight to the
 * Anthropic Messages endpoint. The substrate input bundles per-instance
 * credential resolution + Max OAuth refresh + env-scrubbing + cooldown
 * reporting under one helper — see `build-llm-call-substrate.ts` for
 * the full contract.
 *
 * Architecture constraint: `AgentSpec` (locked in `runtime/substrate.ts:70`
 * per § B.P1) has a single `prompt: string` field — no separate `system`
 * channel. We pack `<system>\n\n<rendered messages>` into `spec.prompt`;
 * the spawned `claude -p` subprocess sees CC's default system prompt
 * plus this packed body in the user turn. The router's existing
 * classifier prompt enforces a strict JSON envelope so output stays
 * well-formed under this packing. Same pattern
 * `build-import-substrate.ts` already uses for Pass-1/Pass-2 chunks.
 */
export interface BuildGatewayAnthropicMessagesClientInput {
  substrate: Substrate
  /**
   * Per-factory DEFAULT model — used only when the caller's `messages.create({model, ...})`
   * does NOT specify a model. Defaults to BEST_MODEL (Opus 4.7) per memory
   * feedback_default_to_opus.md.
   *
   * IMPORTANT: the caller-supplied `args.model` ALWAYS wins. The router's
   * Haiku→Sonnet escalation in `onboarding/interview/llm-router.ts:303-333`
   * relies on this — Pass 1 dispatches the fast model, Pass 2 dispatches
   * the smart model on the same client. Argus r1 BLOCKING #1 (2026-05-31):
   * the previous wiring hard-discarded `args.model` and forced every call
   * to dispatch the factory default, killing the escalation path and
   * making the `[llm-router]` log lines unattributable.
   */
  default_model?: string
}

export function buildGatewayAnthropicMessagesClient(
  input: BuildGatewayAnthropicMessagesClientInput,
): AnthropicMessagesClient {
  return {
    messages: {
      async create(args) {
        const rendered = renderMessagesArray(args.messages)
        const prompt =
          args.system !== undefined && args.system.length > 0
            ? `${args.system}\n\n${rendered}`
            : rendered
        if (prompt.length === 0) {
          throw new Error(
            'llm-router: empty prompt — refusing to dispatch',
          )
        }
        const spec: AgentSpec = {
          prompt,
          tools: [],
          // SECURITY (ISSUES #378 round 2) — this is the PROSE-ONLY synthesis
          // client: it always dispatches `tools: []` and its callers (router,
          // suggesters, per-project opening / kickoff / doc composers) never
          // drive tools. Suppress the native-MCP tool bridge UNCONDITIONALLY so a
          // dispatch over the owner's warm `cc-agent-*` chat substrate (the ONLY
          // one with `enableToolBridge: true`) composes prose WITHOUT inheriting
          // the live `mcp__neutron` tool surface — closing the prompt-injection
          // vector where a user-editable document (README / STATUS / imported
          // transcript) could trigger tool calls with no interactive owner. The
          // per-project SESSION KEY (isolation + grounding) is untouched. On
          // substrates that never enable the bridge this is a harmless no-op.
          suppress_tool_bridge: true,
          // DELIVERY ISOLATION (ISSUES #378 round 3) — this prose-only client is
          // never an owner CHAT turn, yet the per-project opening / kickoff / doc
          // composers ride the owner's warm `cc-agent-*` substrate (for session
          // isolation + grounding), which is the ONE substrate wired with the
          // owner-facing delivery/notice sinks (`substrates.ts` O6). Suppress them
          // per-dispatch so a 429 in the finalize concurrency-3 compose burst can't
          // post a rate-limit banner for a turn the owner never sent, and a recovered
          // dropped compose can't deliver raw README / plan text as an owner chat
          // bubble. On the `cc-llm-*` router/suggester path (no sinks) it is a no-op.
          suppress_owner_delivery: true,
          // Caller-supplied `args.model` wins; factory default is the
          // fallback for callers that omit the field. Pinned by
          // `build-anthropic-messages-client.test.ts` (Argus r1 BLOCKING #1).
          // The ULTIMATE fallback resolves PER-CALL via `getBestModel()` so a
          // model-update watchdog flip reaches new dispatches — never a frozen
          // module-load constant.
          model_preference: [args.model ?? input.default_model ?? getBestModel()],
          max_tokens: args.max_tokens,
        }
        // LIVE per-dispatch project identity (ISSUES #378). When the caller
        // stamps a project_id, fold it into `spec.metering_context.project_id` —
        // the ONE dimension `build-llm-call-substrate.ts` folds into the warm-pool
        // key when the substrate carries no `projectIdResolver` (the openings +
        // kickoff composers run over the `cc-agent-*` substrate, wired that way).
        // Per-dispatch ⇒ race-free across the finalize worker pool's concurrent
        // composes: each project's dispatch keys its OWN warm REPL, so their
        // transcripts never share and one project can never be conditioned on
        // another's (the cross-project content bleed root). Absent project_id
        // leaves the spec byte-identical to before (router / suggester callers).
        if (args.project_id !== undefined && args.project_id.length > 0) {
          spec.metering_context = { project_id: args.project_id }
        }
        const handle = input.substrate.start(spec)
        let text: string
        try {
          text = await collectTokensToString(handle, args.signal)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`llm-router: ${msg}`)
        }
        const out: AnthropicMessageResponse = { content: [{ text }] }
        return out
      },
    },
  }
}
