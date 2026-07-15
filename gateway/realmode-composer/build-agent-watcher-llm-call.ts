/**
 * @neutronai/gateway/realmode-composer — agent-watcher LLM call factory (P7.2 S3).
 *
 * Per docs/plans/2026-05-23-003-feat-p7-2-s3-inline-comments-ui-watcher-escalate-plan.md
 * Part B ("Gateway-side agent watcher") § LLM call factory.
 *
 * Produces an `AgentWatcherLlmCall` closure shape — the watcher passes a
 * richer `messages` array (not a single `user` string) and threads an
 * `AbortSignal` for the per-tick timeout.
 *
 * Persona splicing: the factory wraps the underlying substrate dispatch
 * with `composeSystemPrompt({base: call.system, persona, conventions: ''})`
 * so the watcher's LLM sees the same `<persona_file>` framing the
 * resolver + router paths use. Cache anchors stay byte-identical when
 * persona is empty (pre-onboarding-commit instances).
 *
 * NO escalation-context threading. The watcher is NOT a chat surface
 * — escalation context is only relevant to chat turns where the user
 * is the conversation root. Per Plan Part C "Risk Analysis" the
 * watcher's job is to reply to inline comments, not to consume the
 * `<escalated_comment_threads>` block.
 *
 * Returns `null` when no substrate is supplied (caller already determined
 * that no Anthropic credentials are available) — the watcher then is NOT
 * constructed (see gateway/index.ts wiring) and inline-comment agent
 * replies are silently disabled for that instance.
 *
 * Migration (sprint cc-substrate-migration-3-sites, 2026-05-31):
 * this file no longer makes direct HTTPS calls to upstream LLM
 * endpoints. Every dispatch flows through the shared
 * `buildLlmCallSubstrate` helper (per memory
 * `feedback_cc_subprocess_substrate.md` — Neutron substrate is CC-spawn-
 * and-stdio; direct upstream calls are forbidden in instance code).
 * The factory is now SYNCHRONOUS — credential resolution
 * is the caller's responsibility via `buildLlmCallSubstrate`. The
 * returned closure is still async because each LLM call is async.
 */

import {
  collectTokensToString,
  renderMessagesArray,
} from './build-llm-call-substrate.ts'
import { composeSystemPrompt } from './index.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('agent-watcher')
import type { PersonaPromptLoader } from './persona-loader.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'

/**
 * Substrate-shaped LLM call the watcher invokes. `system` carries the
 * watcher's full reply-agent prompt + the per-comment doc-excerpt
 * stub; `messages` carries the user comment body (and any prior
 * thread replies). `signal` carries the per-tick `AbortSignal.timeout(
 * REPLY_TIMEOUT_MS)` so the watcher can bound the wall-clock cost of
 * a stuck LLM call.
 */
export type AgentWatcherLlmCall = (call: {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  max_tokens: number
  signal?: AbortSignal
}) => Promise<{ text: string }>

export interface BuildAgentWatcherLlmCallInput {
  /**
   * Pre-built substrate from `buildLlmCallSubstrate(...)`. Pass `null`
   * when no Anthropic credentials are available — this factory then
   * returns `null` and the caller does not construct the watcher.
   */
  substrate: Substrate | null
  /** Used only for log slug formatting. Optional; defaults to 'unknown'. */
  url_slug?: string
  /** Defaults to BEST_MODEL (Opus 4.7) per memory feedback_default_to_opus.md. */
  model?: string
  /**
   * Optional persona loader. When supplied, every watcher LLM call
   * has its `system` re-composed via
   * `composeSystemPrompt({base: system, persona: await loader.load()})`
   * so the agent's reply respects the owner's SOUL / USER /
   * priority-map files. Pass `null` to skip persona splicing.
   */
  personaLoader?: PersonaPromptLoader | null
}

/**
 * Build the production agent-watcher LLM call closure. Returns `null`
 * when the caller passes `substrate: null` (no Anthropic credentials
 * resolved for the instance) — the watcher then SHOULD NOT be
 * constructed (no point firing tick after tick that all log
 * `no_credentials`).
 *
 * Credential resolution is the caller's responsibility now — wire
 * `buildLlmCallSubstrate({pool | resolvePool, ...})` upstream and pass
 * the resulting Substrate (or null) here. That keeps every LLM call
 * site dispatching through the same CC-subprocess substrate with the
 * same credential rotation, OAuth refresh, and cooldown discipline.
 */
export function buildAgentWatcherLlmCall(
  input: BuildAgentWatcherLlmCallInput,
): AgentWatcherLlmCall | null {
  const log_slug = input.url_slug ?? 'unknown'
  if (input.substrate === null) {
    moduleLog.info('watcher_disabled_no_substrate', { project: log_slug })
    return null
  }
  const substrate = input.substrate
  const personaLoader = input.personaLoader ?? null

  // Tests cover the no-persona path by passing personaLoader: null —
  // the wrapper short-circuits to `system` byte-identical so the
  // fixture system matches without persona framing.
  return async (call) => {
    let persona = ''
    if (personaLoader !== null) {
      try {
        persona = await personaLoader.load()
      } catch (err) {
        moduleLog.warn('persona_load_failed', {
          project: log_slug,
          error: err instanceof Error ? err.message : String(err),
        })
        persona = ''
      }
    }
    const composedSystem =
      persona.length === 0
        ? call.system
        : composeSystemPrompt({ base: call.system, persona, conventions: '' })

    // AgentSpec carries a single `prompt: string` field (locked § B.P1 —
    // no separate system_prompt). Pack the composed system + rendered
    // messages into one prompt body. The watcher's existing prompt body
    // is substantive enough that the JSON / prose contract keeps output
    // well-formed; the persona splice still rides inside `composedSystem`
    // so persona-aware replies continue to work.
    const prompt = `${composedSystem}\n\n${renderMessagesArray(call.messages)}`
    if (prompt.length === 0) {
      throw new Error('agent-watcher: empty prompt')
    }

    const spec: AgentSpec = {
      prompt,
      tools: [],
      // Resolve PER-CALL through the dynamic accessor so a watchdog model flip
      // reaches new dispatches; an explicit `input.model` still wins.
      model_preference: [input.model ?? getBestModel()],
      max_tokens: call.max_tokens,
    }

    try {
      const handle = substrate.start(spec)
      const text = await collectTokensToString(handle, call.signal)
      return { text }
    } catch (err) {
      throw new Error(
        `agent-watcher: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
