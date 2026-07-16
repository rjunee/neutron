/**
 * @neutronai/codegen-core — capability-guarded MCP tool wiring.
 *
 * Four tools the manifest declares (codegen_dispatch /
 * codegen_status / codegen_fetch / codegen_cancel). Each is wrapped by
 * the Sprint 31 `CapabilityGuard.wrapToolHandler` so every dispatch:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` when the manifest's tool / capability
 *     declarations don't match
 *   - records `op='tool_call' outcome='error'` if the inner handler
 *     throws (and re-throws the error)
 *
 * The runtime composer (P3+) registers `buildTools(deps)` output with
 * the MCP host at install time; for tests, the helpers are directly
 * callable. Capability strings are imported from `manifest.ts` so a
 * stray edit to the manifest body that drifts from the locked
 * `read:/write:codegen_core.tasks` pair surfaces as a tool-mismatch
 * the guard rejects at the first dispatch.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import type {
  CodegenDispatchInput,
  CodegenOrchestrator,
  CodegenRunResult,
  CodegenTaskStatus,
} from './backend.ts'

export interface CodegenDispatchToolInput extends CodegenDispatchInput {}

export interface CodegenDispatchToolOutput {
  task_id: string
}

export interface CodegenStatusToolInput {
  task_id: string
}

export interface CodegenStatusToolOutput {
  status: CodegenTaskStatus
}

export interface CodegenFetchToolInput {
  task_id: string
}

export interface CodegenFetchToolOutput extends CodegenRunResult {}

export interface CodegenCancelToolInput {
  task_id: string
}

export interface CodegenCancelToolOutput {
  cancelled: boolean
  prior_status: CodegenTaskStatus
}

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer (P3+) constructs this at install time and passes it into
 * `buildTools` — tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  orchestrator: CodegenOrchestrator
}

export interface BuiltTools {
  codegen_dispatch: (
    input: CodegenDispatchToolInput,
  ) => Promise<CodegenDispatchToolOutput>
  codegen_status: (
    input: CodegenStatusToolInput,
  ) => Promise<CodegenStatusToolOutput>
  codegen_fetch: (
    input: CodegenFetchToolInput,
  ) => Promise<CodegenFetchToolOutput>
  codegen_cancel: (
    input: CodegenCancelToolInput,
  ) => Promise<CodegenCancelToolOutput>
}

/**
 * Construct the three tool handlers, each wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch is audited.
 *
 * The capability strings match the manifest's `tools[]` declarations
 * exactly — wrapping with a different `capability_required` value
 * trips the guard's `capability_mismatch` check at the FIRST call.
 */
export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const codegen_dispatch = guard.wrapToolHandler<
    CodegenDispatchToolInput,
    CodegenDispatchToolOutput
  >({
    tool_name: 'codegen_dispatch',
    capability_required: WRITE_CAPABILITY,
    fn: async (
      input: CodegenDispatchToolInput,
    ): Promise<CodegenDispatchToolOutput> => {
      return deps.orchestrator.dispatch(input)
    },
  })

  const codegen_status = guard.wrapToolHandler<
    CodegenStatusToolInput,
    CodegenStatusToolOutput
  >({
    tool_name: 'codegen_status',
    capability_required: READ_CAPABILITY,
    fn: async (
      input: CodegenStatusToolInput,
    ): Promise<CodegenStatusToolOutput> => {
      // Pass the raw input through — the orchestrator runs
      // `validateStatusInput` and throws `CodegenInputError` on shape
      // mismatch (distinct from `CodegenTaskNotFoundError` on a real
      // miss). `McpServer.dispatch` does not enforce the manifest's
      // input_schema at runtime, so this validator is the boundary.
      return deps.orchestrator.status(input)
    },
  })

  const codegen_fetch = guard.wrapToolHandler<
    CodegenFetchToolInput,
    CodegenFetchToolOutput
  >({
    tool_name: 'codegen_fetch',
    capability_required: READ_CAPABILITY,
    fn: async (
      input: CodegenFetchToolInput,
    ): Promise<CodegenFetchToolOutput> => {
      // Same boundary semantics as `codegen_status`.
      return deps.orchestrator.fetch(input)
    },
  })

  const codegen_cancel = guard.wrapToolHandler<
    CodegenCancelToolInput,
    CodegenCancelToolOutput
  >({
    tool_name: 'codegen_cancel',
    capability_required: WRITE_CAPABILITY,
    fn: async (
      input: CodegenCancelToolInput,
    ): Promise<CodegenCancelToolOutput> => {
      // Orchestrator throws CodegenTaskNotFoundError on miss; the
      // CapabilityGuard wrapper re-throws unchanged.
      return deps.orchestrator.cancel(input)
    },
  })

  return { codegen_dispatch, codegen_status, codegen_fetch, codegen_cancel }
}
