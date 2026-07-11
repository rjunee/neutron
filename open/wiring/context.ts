/**
 * @neutronai/open — wiring context (C3a).
 *
 * `OpenWiringContext` is the NARROW typed slice of the `createOpenComposition`
 * closure that the extracted `open/wiring/*` modules read. It carries only the
 * resolved config/identity values + the credential-pool input + the
 * substrate-construction seam those wiring slices actually consume — NOT the
 * whole composition. The composer builds one of these at boot and threads it
 * into `wireSubstrates(ctx)` / `wireMemory(ctx)`.
 *
 * These are NEW leaf modules the composer imports DOWNWARD: they must never
 * import back into `open/composer.ts` (no cycle). Any composer-owned helper the
 * slices need (e.g. `prewarmSubstrate`, which stays exported from the composer
 * for its unit test) is threaded through this context as a function reference
 * rather than imported upward.
 */

import type { CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { Provider } from '@neutronai/runtime/adapters/select-substrate.ts'
import type { McpToolResolver } from '@neutronai/contracts/mcp-tool-resolver.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface OpenWiringContext {
  /**
   * Resolved single-owner Anthropic credential pool (`resolveOpenLlmPool(env)`),
   * or `null` when the box boots LLM-less. Every substrate construction gates on
   * this exactly as the composer did inline.
   */
  llmPool: CredentialPool | null
  /**
   * Optional test-only substrate factory seam (E2E mocked-LLM). Undefined in
   * production → `buildLlmCallSubstrate` falls through to its
   * `createClaudeCodeSubstrateAuto` default. Threaded verbatim into every
   * `buildLlmCallSubstrate({ ... })` call via the
   * `...(substrateFactory !== undefined ? { substrateFactory } : {})` spread.
   */
  substrateFactory?: (opts: ClaudeCodeSubstrateOptions) => Substrate
  /** Frozen single-owner instance handle (== boot slug). Substrate pool key. */
  internal_handle: string
  /** Owner HOME base dir (substrate cwd + GBrain/scribe/reflection data root). */
  owner_home: string
  /** Boot-frozen project slug (metering + pool key). */
  project_slug: string
  /** Process env — read by the GBrain memory wiring. */
  env: NodeJS.ProcessEnv
  /** The boot-provided ProjectDb — read by the GBrain onboarding-key resolver. */
  db: ProjectDb
  /**
   * The composer's `prewarmSubstrate` helper, threaded as a reference so the
   * substrate wiring can fire the (never-rejecting) build-time warm-up without
   * importing upward into the composer.
   */
  prewarmSubstrate: (substrate: Substrate) => Promise<void>
  /**
   * SWAPPABLE MODEL PROVIDER — the CONVERSATIONAL backend for this box. Absent ⇒
   * `'anthropic'` (Claude Code), the default. Set from `NEUTRON_MODEL_PROVIDER`
   * (read in `open/composer.ts` — a Managed-open-contract env read stays under
   * `open/`, never `runtime/`). Applied ONLY to the conversational substrates
   * (`cc-llm-*` phase-spec + `cc-agent-*` live chat); the trident-fire + ephemeral
   * substrates stay Claude-Code by construction (trident's Workflow inner loop has
   * no OpenAI analogue).
   */
  provider?: Provider
  /**
   * Resolved OpenAI credential pool (`OPENAI_API_KEY`), or null when the box has
   * no OpenAI key. Consumed ONLY when `provider === 'openai'`; when a project
   * selects openai but this is null the wiring degrades LOUDLY to Claude Code
   * (logged in the composer) rather than booting a broken openai path.
   */
  openaiLlmPool?: CredentialPool | null
  /**
   * PROJECT-BOUND MCP resolver factory for the OpenAI-family conversational
   * substrate (so tools work in `internal` mode WITH the correct project scope).
   * The composer calls it per turn with the active `project_id`; late-bound to the
   * same in-process McpServer the CC tool bridge uses. Required alongside
   * `provider === 'openai'`.
   */
  bindMcpResolver?: (bind: { project_id?: string }) => McpToolResolver
  /**
   * HONEST TOOL MANIFEST for the OpenAI path — returns only the real
   * MCP-registered tools (never Claude-native built-ins), so the GPT adapter
   * advertises exclusively what its resolver can execute (audit BLOCKER 1).
   */
  toolManifest?: () => ReadonlyArray<{ name: string; description: string; input_schema: unknown }>
  /**
   * Test-only `fetch` override for the OpenAI adapter (E2E mocked GPT). Undefined
   * in production. Mirrors `substrateFactory` — lets a wiring test drive a real GPT
   * dispatch against a mocked Responses stream (e.g. to assert the request body's
   * model id honors `ctx.env` overrides).
   */
  openaiFetchImpl?: typeof fetch
}
