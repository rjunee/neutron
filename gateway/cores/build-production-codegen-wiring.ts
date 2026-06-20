/**
 * @neutronai/gateway/cores — Code-Gen Core production wiring entrypoint.
 *
 * Single source of truth for how the production graph composer assembles
 * the Code-Gen Core runtime end-to-end:
 *
 *   credential resolution            (buildCodeGenLlmCall)
 *     → orchestrator + runner + sidecar resolver   (buildCodegenWiring)
 *       → `/code` chat-command filter (buildCodegenChatCommandFilter)
 *
 * Mirrors `cores/free/research/src/wiring-production.ts`'s
 * `buildProductionResearchCoreWiring`: ONE call returns every primitive
 * the boot path threads — the `codegen_orchestrator` for
 * `buildCoresBackendFactories({ codegenOrchestrator })` (so the four
 * `codegen_*` MCP tools share the runner) AND the `chat_command_filter`
 * for the app-WS surface (so `/code` dispatches through the SAME runner +
 * per-project sidecar resolver).
 *
 * WHY THIS EXISTS (Trident-port PR-1, 2026-06-19). Before this entrypoint,
 * the production composer had to hand-chain THREE separate pieces:
 *   1. `buildCodeGenLlmCall(...)`            (gateway/cores/code-gen-factory.ts)
 *   2. `buildCodegenWiring(...)`             (cores/free/code-gen/src/wiring-production.ts)
 *   3. `buildCodegenChatCommandFilter(...)`  (gateway/boot-helpers.ts)
 * and then thread (2)'s orchestrator into `buildCoresBackendFactories`.
 * Drop ANY link of that chain — most easily by omitting `codegenOrchestrator`
 * from the cores-backend factory — and `/code` silently degrades to
 * `buildSkeletonCodegenRunner()`, whose `run(...)` throws
 * `CodegenNotConfiguredError` ("install the Tier 2 Coding Core") even on a
 * fully-credentialed instance where the real Forge → Argus → merge loop
 * COULD run. The Research Core closed this exact class of bug (Argus r1
 * BLOCKER #4) by routing both call sites through ONE wiring helper; this
 * entrypoint does the same for Code-Gen.
 *
 * Unlike research — whose substrate is credential-agnostic, so its
 * entrypoint lives inside the Core — Code-Gen's credential factory
 * (`buildCodeGenLlmCall`) is the SOLE `@anthropic-ai/sdk` importer for
 * Code-Gen and reaches the realmode-composer `OAuthCredentialSource`, so
 * this consolidating entrypoint lives gateway-side.
 */

import {
  buildCodegenWiring,
  type CodegenChatNotifier,
  type CodegenOrchestrator,
  type CodegenRunner,
  type CodegenSidecarResolver,
  type HostBunTestRunner,
  type HostGhRunner,
  type HostGitRunner,
} from '../../cores/free/code-gen/index.ts'
import type { ChatCommandFilter } from '../http/app-ws-surface.ts'
import { buildCodegenChatCommandFilter } from '../boot-helpers.ts'
import {
  buildCodeGenLlmCall,
  type CodegenAnthropicFactory,
} from './code-gen-factory.ts'
import type { OAuthCredentialSource } from '../realmode-composer/resolve-llm-credentials.ts'

export interface BuildProductionCodegenCoreWiringOptions {
  /* ---- credential resolution (buildCodeGenLlmCall) ---- */
  /** Frozen instance `internal_handle` — threaded to the OAuth loader. */
  project_slug: string
  /**
   * Anthropic Max OAuth source. Production wires
   * `wrapMaxOAuthSource(maxOAuthClient)`; pass `null` to skip the Max
   * OAuth resolution step (forces BYO env or the no-credential sentinel).
   */
  oauth_source: OAuthCredentialSource | null
  /** Env bag — read `NEUTRON_ANTHROPIC_API_KEY` (BYO fallback). */
  env: Readonly<Record<string, string | undefined>>
  /** SDK factory — defaults to dynamic `await import('@anthropic-ai/sdk')`; tests inject. */
  anthropic_factory?: CodegenAnthropicFactory

  /* ---- runtime wiring (buildCodegenWiring) ---- */
  /** Instance home dir — sidecar + worktree land under `<owner_home>/Projects/...`. */
  owner_home: string
  /** Instance key threaded into sub-agent dispatch + the sidecar resolver. */
  instance_key: string
  gh_runner: HostGhRunner
  git_runner: HostGitRunner
  bun_test_runner: HostBunTestRunner
  /** Chat notifier — the orchestrator's autonomous loop pings here on terminal. */
  chat_notifier: CodegenChatNotifier
  forge_model?: string
  argus_model?: string
  max_argus_rounds?: number
  subagent_timeout_ms?: number

  /* ---- chat-command filter (buildCodegenChatCommandFilter) ---- */
  /** Default project_id when the inbound `/code` envelope omits one. */
  default_project_id?: string
}

export interface ProductionCodegenCoreWiring {
  /**
   * Thread into `buildCoresBackendFactories({ codegenOrchestrator })` so
   * the four `codegen_*` MCP tools share THIS runner + per-project
   * sidecar resolver with the `/code` chat filter.
   */
  codegen_orchestrator: CodegenOrchestrator
  /**
   * Thread into the app-WS surface (typically via the chained
   * chat-command filter) so `/code` dispatches through the SAME runner.
   */
  chat_command_filter: ChatCommandFilter
  /** Per-project sidecar resolver — exposed for shutdown (`closeAll()`) + diagnostics. */
  sidecar_resolver: CodegenSidecarResolver
  /** Underlying runner — exposed for tests + diagnostics. */
  runner: CodegenRunner
  /** How the Anthropic credential resolved — surfaced for boot telemetry. */
  credential_source: 'max_oauth_subscription' | 'byo_env_api_key' | 'none'
}

/**
 * Assemble the full production Code-Gen Core wiring in ONE call. See the
 * file header for the layer cake + the drift class it closes.
 *
 * When no Anthropic credential resolves (`credential_source === 'none'`)
 * the wiring still returns a REAL orchestrator — `buildCodegenWiring`
 * threads the friendly `unavailable_message` so `/code <task>` short-
 * circuits with the install hint at the chat boundary BEFORE the
 * orchestrator's dispatch runs. The skeleton runner is NEVER used on this
 * path; "no credential" is a soft, actionable state, not a Tier-2 wall.
 */
export async function buildProductionCodegenCoreWiring(
  opts: BuildProductionCodegenCoreWiringOptions,
): Promise<ProductionCodegenCoreWiring> {
  const llmCallOpts: Parameters<typeof buildCodeGenLlmCall>[0] = {
    project_slug: opts.project_slug,
    oauth_source: opts.oauth_source,
    env: opts.env,
  }
  if (opts.anthropic_factory !== undefined) {
    llmCallOpts.anthropic_factory = opts.anthropic_factory
  }
  const llm = await buildCodeGenLlmCall(llmCallOpts)

  const wiringOpts: Parameters<typeof buildCodegenWiring>[0] = {
    llm_call: llm.llm_call,
    owner_home: opts.owner_home,
    instance_key: opts.instance_key,
    gh_runner: opts.gh_runner,
    git_runner: opts.git_runner,
    bun_test_runner: opts.bun_test_runner,
    chat_notifier: opts.chat_notifier,
  }
  if (llm.unavailable_message !== undefined) {
    wiringOpts.unavailable_message = llm.unavailable_message
  }
  if (opts.default_project_id !== undefined) {
    wiringOpts.default_project_id = opts.default_project_id
  }
  if (opts.forge_model !== undefined) wiringOpts.forge_model = opts.forge_model
  if (opts.argus_model !== undefined) wiringOpts.argus_model = opts.argus_model
  if (opts.max_argus_rounds !== undefined) {
    wiringOpts.max_argus_rounds = opts.max_argus_rounds
  }
  if (opts.subagent_timeout_ms !== undefined) {
    wiringOpts.subagent_timeout_ms = opts.subagent_timeout_ms
  }
  const wiring = buildCodegenWiring(wiringOpts)

  const filterDeps: Parameters<typeof buildCodegenChatCommandFilter>[0] = {
    build_chat_command_context: wiring.build_chat_command_context,
  }
  if (opts.default_project_id !== undefined) {
    filterDeps.default_project_id = opts.default_project_id
  }
  const chat_command_filter = buildCodegenChatCommandFilter(filterDeps)

  return {
    codegen_orchestrator: wiring.orchestrator,
    chat_command_filter,
    sidecar_resolver: wiring.sidecar_resolver,
    runner: wiring.runner,
    credential_source: llm.credential_source,
  }
}
