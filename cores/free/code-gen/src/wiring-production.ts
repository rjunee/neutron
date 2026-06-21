/**
 * @neutronai/codegen-core — production wiring helper.
 *
 * Single source of truth for how the production composer assembles
 * the Code-Gen Core's runtime: per-project sidecar resolver +
 * substrate-runtime tool loop + sub-agent dispatch + `RuntimeCodegen-
 * Runner` + `CodegenOrchestrator` + `/code` chat-command context
 * factory. Both `gateway/index.ts` AND the production-composer test
 * invoke THIS factory so a wireup gap in production is caught by the
 * test on the same code path.
 *
 * Mirrors `cores/free/research/src/wiring-production.ts` shape; the
 * Code-Gen Core ships a `build_chat_command_context` factory rather
 * than a finished `ChatCommandFilter` because `/code` resolves its
 * project_id + user_id from the inbound envelope at the gateway-side
 * filter boundary.
 *
 * Per docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md
 * § Phase 4 "Gateway-side credential factory + production wiring".
 */

import {
  CodegenOrchestrator,
  type CodegenRunner,
} from './backend.ts'
import type {
  CodeCommandContext,
  CodegenChatNotifier,
} from './chat-commands.ts'
import type {
  HostBunTestRunner,
  HostGhRunner,
  HostGitRunner,
} from './host-runners.ts'
import {
  buildRuntimeCodegenRunner,
  type SubagentDispatch,
} from './runtime-runner.ts'
import {
  CodegenSidecarResolver,
  type CodegenSidecar,
} from './sidecar/store.ts'
import {
  buildRuntimeSubagentDispatch,
  type CodegenLlmCall,
} from './substrate-runtime.ts'
import {
  ARGUS_TOOL_DEFS,
  ATLAS_TOOL_DEFS,
  FORGE_TOOL_DEFS,
  SENTINEL_TOOL_DEFS,
  buildArgusToolHandlers,
  buildAtlasToolHandlers,
  buildForgeToolHandlers,
  buildSentinelToolHandlers,
} from './tool-handlers.ts'

export interface BuildCodegenWiringOptions {
  /** Opaque LLM-call closure the gateway built against instance creds. */
  llm_call: CodegenLlmCall
  /** Instance home dir — sidecar + worktree land under `<owner_home>/Projects/...`. */
  owner_home: string
  /** Instance key threaded into sub-agent dispatch + sidecar resolver. */
  instance_key: string
  /** Host CLI runners — gateway wires the production gh / git / bun-test shells. */
  gh_runner: HostGhRunner
  git_runner: HostGitRunner
  bun_test_runner: HostBunTestRunner
  /** Chat notifier — the orchestrator's autonomous loop pings here on terminal. */
  chat_notifier: CodegenChatNotifier
  /**
   * Friendly message surfaced when no Anthropic credential resolves at
   * factory time. When set, `build_chat_command_context` includes the
   * message on every returned `CodeCommandContext` so `executeDispatch`
   * short-circuits to a friendly reply BEFORE the orchestrator's
   * `dispatch` runs. Sub-agent dispatch is also shorted to throw with
   * the same message — defence in depth in case a different code path
   * reaches the dispatcher.
   */
  unavailable_message?: string
  forge_model?: string
  argus_model?: string
  max_argus_rounds?: number
  subagent_timeout_ms?: number
  default_project_id?: string
}

export interface BuildCodegenWiringResult {
  sidecar_resolver: CodegenSidecarResolver
  orchestrator: CodegenOrchestrator
  /** The underlying runner — exposed for tests + diagnostics. */
  runner: CodegenRunner
  /**
   * Factory for the per-request `CodeCommandContext`. Wired into the
   * gateway-side `/code` chat-filter; the filter resolves `project_id`
   * + `user_id` from the inbound envelope, calls this, and hands the
   * resulting context to `parseAndExecuteCodeCommand`.
   */
  build_chat_command_context(input: {
    project_id: string
    user_id: string
  }): CodeCommandContext
}

/**
 * Assemble the full Code-Gen Core production wiring. See file header
 * for the layer cake.
 */
export function buildCodegenWiring(
  opts: BuildCodegenWiringOptions,
): BuildCodegenWiringResult {
  const sidecar_resolver = new CodegenSidecarResolver({
    owner_home: opts.owner_home,
  })

  const resolve_sidecar = async (project_id: string): Promise<CodegenSidecar> =>
    sidecar_resolver.resolve(project_id)

  // Build SubagentDispatch from the llm_call + tool defs + handlers.
  // When the gateway resolved no credential, we wire a throwing stub —
  // the orchestrator's dispatch will surface this via CodegenRunError.
  // The chat-command short-circuit (via `unavailable_message` on the
  // context) catches it BEFORE reaching the orchestrator on the happy
  // path; the stub is defence-in-depth.
  const dispatch_subagent: SubagentDispatch =
    opts.unavailable_message !== undefined
      ? async () => {
          throw new Error(opts.unavailable_message)
        }
      : buildRuntimeSubagentDispatch({
          llm_call: opts.llm_call,
          // Each kind gets its own role-appropriate surface. Keyed by
          // kind (NOT a single merged handler map) so a shared tool name
          // — `bash` — can carry different gating per role: Forge/Atlas
          // run unrestricted bash, Argus is allowlist-gated read-only,
          // Sentinel has no shell at all.
          tool_defs_by_kind: {
            forge: FORGE_TOOL_DEFS,
            argus: ARGUS_TOOL_DEFS,
            atlas: ATLAS_TOOL_DEFS,
            sentinel: SENTINEL_TOOL_DEFS,
          },
          tool_handlers_by_kind: {
            forge: buildForgeToolHandlers(),
            argus: buildArgusToolHandlers(),
            atlas: buildAtlasToolHandlers(),
            sentinel: buildSentinelToolHandlers(),
          },
        })

  // Build the runtime CodegenRunner. The Code-Gen Core's tool handlers
  // share the per-invocation worktree context with the multi-turn
  // loop; the runner threads `instance_key` + `parent_task_id` +
  // `worktree_path` through each tool call.
  const runner_opts: Parameters<typeof buildRuntimeCodegenRunner>[0] = {
    dispatch_subagent,
    owner_home: opts.owner_home,
    instance_key: opts.instance_key,
    resolve_sidecar: ({ project_id }) => resolve_sidecar(project_id),
    gh_runner: opts.gh_runner,
    git_runner: opts.git_runner,
    bun_test_runner: opts.bun_test_runner,
  }
  if (opts.default_project_id !== undefined) {
    runner_opts.default_project_id = opts.default_project_id
  }
  if (opts.forge_model !== undefined) runner_opts.forge_model = opts.forge_model
  if (opts.argus_model !== undefined) runner_opts.argus_model = opts.argus_model
  if (opts.max_argus_rounds !== undefined) runner_opts.max_argus_rounds = opts.max_argus_rounds
  if (opts.subagent_timeout_ms !== undefined) {
    runner_opts.subagent_timeout_ms = opts.subagent_timeout_ms
  }
  const runner = buildRuntimeCodegenRunner(runner_opts)
  const orchestrator = new CodegenOrchestrator({ runner })

  function build_chat_command_context(input: {
    project_id: string
    user_id: string
  }): CodeCommandContext {
    const ctx: CodeCommandContext = {
      orchestrator,
      resolve_sidecar,
      project_id: input.project_id,
      user_id: input.user_id,
      now: new Date(),
      chat_notifier: opts.chat_notifier,
    }
    if (opts.unavailable_message !== undefined) {
      ctx.unavailable_message = opts.unavailable_message
    }
    return ctx
  }

  return {
    sidecar_resolver,
    orchestrator,
    runner,
    build_chat_command_context,
  }
}
