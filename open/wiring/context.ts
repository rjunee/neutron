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
import type {
  ClaudeCodeSubstrateOptions,
  RecoveredReply,
} from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { Provider, ProviderSelection } from '@neutronai/runtime/adapters/select-substrate.ts'
import type { ResolvedOwnerMcpServer } from '@neutronai/runtime/mcp-servers.ts'
import type { McpToolResolver } from '@neutronai/contracts/mcp-tool-resolver.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { SubstrateNoticeSinks } from '@neutronai/gateway/http/substrate-notice-sink.ts'

export interface OpenWiringContext {
  startCodexOwner?: import('@neutronai/gateway/wiring/build-llm-call-substrate.ts').BuildLlmCallSubstrateInput['startCodexOwner']
  /**
   * #1226 — the owner conversation's project-workspace terminal. Wired onto the
   * live-chat (`cc-agent-*`) family ONLY: every Claude conversation spawn is placed
   * as its dispatch's `Chat` tab through the shared strict host. Undefined off Herdr.
   */
  conversationTerminal?: import('@neutronai/runtime/adapters/claude-code/persistent/project-workspace-host.ts').ConversationTerminal
  /**
   * #1226 — the project-scope lifecycle owner (`project-scope-lifecycle.ts`). Wired onto
   * the live-chat family ONLY, beside `conversationTerminal`: the scope's Chat credential
   * is pinned while usable and a re-key retires the old exact owner before the new Chat
   * spawns (a verified handoff, never a second Chat).
   */
  conversationLifecycle?: import('@neutronai/gateway/wiring/build-llm-call-substrate.ts').ConversationLifecycle
  /** Stored native-provider projects at boot; keeps their shared chat intake reachable without API pools. */
  codexOwnerProjects?: readonly string[]
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
  owner_handle: string
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
   * Static provider for standalone callers. Production resolves the stored
   * project/instance choice per turn through providerResolver; an absent choice
   * inherits the application default (Claude Code).
   */
  provider?: Provider
  /** Live per-turn project/instance/application resolution with provenance. */
  providerResolver?: (projectId?: string, scope?: 'conversation') => ProviderSelection
  /**
   * Resolved OpenAI credential pool (`OPENAI_API_KEY`), or null when the box has
   * no OpenAI key. Consumed by the OpenAI-family adapters; when a project
   * selects openai but this is null the dispatch refuses with a terminal error.
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
  /** Test seam for actual Codex CLI dispatch. */
  codexSpawnImpl?: import('@neutronai/runtime/adapters/codex-cli/index.ts').CodexCliSubstrateOptions['spawnImpl']
  /**
   * O6 — the notice-family sinks (`onDeadTurnNotice` / `onSizeAlert` /
   * `onRateLimitBanner`) the composer builds over the app-ws push registry +
   * `system_events` journal. Wired ONLY onto the owner's WARM conversational
   * substrate (`cc-agent-*`) so a usage-capped / dead-turn / size-alert / rate-
   * limit state surfaces as an owner chat bubble instead of stderr. Absent (LLM-
   * less / tests that don't exercise notices) ⇒ the substrate keeps its stderr-
   * only default.
   */
  liveAgentNoticeSinks?: SubstrateNoticeSinks
  /**
   * The JOURNAL-ONLY notice sinks for the timer-driven nudge substrate
   * (`cc-nudge-*`), built over the same `system_events` journal but with NO chat
   * delivery seam — so a notice from that lane is journalled and never becomes a
   * bubble in the owner's chat. Journalling is BEST-EFFORT, like every other caller
   * of this sink: an unregistered ambient sink is a no-op and a write failure is
   * swallowed, so this buys an attempt at a queryable row, not a guarantee of one.
   * That is still the difference between a clamp being findable and it existing
   * only on a stderr stream nobody reads.
   *
   * WHY A SECOND SET RATHER THAN REUSING `liveAgentNoticeSinks`. The nudge lane
   * shares `PROFILE_WARM_CHAT`, so it carries `frontier_model_floor` and CAN be
   * clamped — which made its clamp stderr-only, the exact silent degradation the
   * floor notice exists to end. Handing it the live sinks would fix the silence by
   * letting a background timer push a chat bubble, which is the one thing this lane
   * is built not to do. Splitting the two surfaces keeps both promises: the clamp is
   * recorded, the owner is not interrupted. Only `onModelFloorApplied` is consumed
   * today (see `substrates.ts`).
   */
  backgroundNoticeSinks?: SubstrateNoticeSinks
  /**
   * O6 / #106 — the recovered-reply sink (deliver-or-persist into the
   * `RecoveredReplyStore`) the composer builds over the same push registry. Wired
   * ONLY onto `cc-agent-*`; the substrate calls it when its replay-after-resume
   * path recovers a reply a crash dropped. Absent ⇒ the recovered reply degrades
   * to the substrate's stderr fallback.
   */
  liveAgentRecoveredReplySink?: (reply: RecoveredReply) => void
  /**
   * The owner's APPROVED installed MCP servers, resolved per dispatch.
   *
   * Wired ONLY onto the owner's warm conversational substrate (`cc-agent-*`) — the
   * same one substrate that gets `enableToolBridge`, and for the same reason: an
   * owner-installed server is a subprocess, which is a strictly larger capability
   * than a built-in tool, so the untrusted history-import (`cc-import-*`), the
   * per-project compose (`cc-compose-*`) and the disposable Trident
   * (`cc-trident-*` / `cc-trident-fire-*`) substrates must never receive it.
   * `spawn.ts` enforces the tool-bridge condition independently, so both gates must
   * fail before an untrusted REPL could see one.
   *
   * A THUNK because the store is read live: a server installed (or approved, or
   * uninstalled) over the running server has to reach the next turn without a
   * restart. Absent ⇒ the spawned session's `mcpServers` is byte-identical to what it
   * was before this feature existed.
   */
  resolveMcpServers?: () => Promise<ReadonlyArray<ResolvedOwnerMcpServer>>
  /**
   * #1237 — the CURRENT project admission generation for a pool project id
   * (`'general'`/absent = General), read ONCE by the spawn of a project PARENT and
   * stamped into its registry row. Wired onto the live-chat (`cc-agent-*`) family
   * ONLY — the owner's live chat and `makeProjectLiveAgentSubstrate`; the nudge,
   * compose and fire substrates are not project parents. REQUIRED: a parent spawned
   * without it is indistinguishable from a legacy one. `undefined` = unknown scope.
   */
  admissionGenerationFor: (project_id: string | undefined) => Promise<number | undefined>
  /**
   * O6 / #106 — the owner reconnect channel (`app:<owner>`) recorded on a dropped-
   * turn entry so the substrate's replay path can route a recovered reply to the
   * `liveAgentRecoveredReplySink`. Threaded alongside the sink (both wired only on
   * `cc-agent-*`).
   */
  liveAgentDeliveryTopicId?: string
}
