/**
 * gateway/boot-cores-factories-types.ts — the type contracts for the
 * per-slug Cores backend factory map.
 *
 * Split out of `gateway/boot-cores-factories.ts` (C2 refactor) so the
 * large, heavily-documented `CoresBackendFactoriesOptions` shape lives
 * beside the `TasksCoreOwnerRegistry` contract it references, and the
 * factory-map implementation module stays focused on the wiring. Pure
 * type contracts — no runtime code. This module MUST NEVER import
 * `gateway/index.ts`.
 *
 * Open-classified and import-clean of Managed dirs.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
// Type-only alias for the canonical task-store shared across the
// production composer (the composer's dynamic `import('@neutronai/tasks/store.ts')`
// at its surfaces block is unaffected).
import type { TaskStore as TaskStoreType } from '@neutronai/tasks/store.ts'
import type {
  TasksChatOwnerDeps,
  TasksChatRouterDepsResolver,
} from './cores/tasks-chat-router.ts'

/**
 * Per-process Tasks Core deps registry. The `tasks_core` factory
 * populates this map as Cores install; the chat-router resolves
 * deps by project_slug at inbound-event time. Public so tests can
 * pre-populate or assert membership.
 */
export interface TasksCoreOwnerRegistry {
  set(project_slug: string, deps: TasksChatOwnerDeps): void
  get(project_slug: string): TasksChatOwnerDeps | undefined
  asResolver(): TasksChatRouterDepsResolver
}

/**
 * Options for `buildCoresBackendFactories`. Each field threads a
 * per-instance primitive (canonical stores, OAuth accessors, pre-built
 * clients, LLM calls) into the matching Core's backend factory branch.
 * Most are optional so dev boot + install-lifecycle tests can install
 * every Core against in-memory / no-op fallbacks.
 */
export interface CoresBackendFactoriesOptions {
  projectDb: ProjectDb
  /**
   * Canonical `TaskStore` shared across the production composer.
   * When provided, the Tasks-Core adapter binds to THIS instance so
   * Core-driven writes fire the projection writer + reminder-link
   * subscribers `tasksModule.init` registered against that store.
   */
  canonicalTaskStore?: TaskStoreType
  /**
   * Per-instance data dir. Cores use this to resolve their per-project
   * sidecar paths under `<owner_home>/Projects/<project_id>/...`.
   */
  owner_home: string
  /**
   * Email-Managed Core's per-instance per-project cache resolver.
   * Shared with the chat-command filter so triage audits and draft
   * audits captured via `/email ...` land in the same SQLite file
   * the Core's MCP tools read from.
   */
  emailResolver: import('@neutronai/email-managed-core').EmailProjectCacheResolver
  /**
   * Email-Managed Core's OAuth token accessor. When present, the
   * backend factory wires the production Gmail v1 REST client with
   * lazy bearer-token resolution via this closure (the same
   * OAuthTokenManager instance the Cores OAuth surface writes to).
   * When `undefined`, the factory falls back to the in-memory
   * Gmail client so install still succeeds for dev / Open-tier
   * instances without OAuth client envs threaded through.
   */
  emailOAuthTokens?: import('./cores/oauth-token-manager.ts').OAuthTokenManager
  /**
   * Pluggable LLM call for the Email-Managed Core's Haiku-driven
   * triage + summarizer agents. v1 ships a deterministic stub
   * (the in-process composer + chat-bridge supplies the real
   * Haiku-fast call when wired); tests inject their own.
   */
  emailLlm?: (prompt: string) => Promise<string>
  /**
   * Model id (or a thunk resolving it) stamped on email brief/triage
   * metadata. A thunk (e.g. the `getBestModel` accessor) is resolved PER-CALL
   * so the recorded model tracks a watchdog flip (Codex cross-model review).
   */
  emailModel?: string | (() => string)
  /**
   * Tasks Core S1 — per-process Tasks Core deps registry. The
   * `tasks_core` factory stashes the wrapped `{store, pickNext}`
   * here so the chat-router can resolve deps at inbound-event time
   * by project_slug.
   */
  tasksCoreRegistry?: TasksCoreOwnerRegistry
  /**
   * Tasks Core S1 — LLM client for the pick-next service. The
   * production composer wires the `claude-runner` Sonnet 4.6 with
   * Haiku 4.5 fallback path; tests inject `buildStubPickNextLlmClient`.
   */
  pickNextLlmClient?: import('@neutronai/tasks-core').PickNextLlmClient
  /**
   * Calendar Core S1 (2026-05-20) — lazy OAuth access-token
   * resolver. When supplied AND non-null, the `calendar_core` +
   * future Google-backed factories wire `buildGoogleCalendarClient`
   * with this accessor; transparent refresh flows through the
   * shared `OAuthTokenManager`. When omitted OR null (Managed
   * instances without Google OAuth setup, Open self-host without
   * `NEUTRON_CORES_GOOGLE_CLIENT_ID`), the factory falls back to
   * `buildInMemoryCalendarClient` so dev boot + install lifecycle
   * tests continue to install the Core (it just dispatches against
   * an empty calendar).
   */
  googleOAuthAccessToken?:
    | null
    | ((label: string) => Promise<string | null>)
  /**
   * D2 credential resolver (2026-07-01) — the per-project → global → unset
   * seam every Core reads its credential through. When supplied, the three
   * Google factories build their live client with `resolver.accessorFor(label)`
   * (a project's own Drive token wins over the instance default; Email/Calendar
   * stay global) instead of the raw per-instance `googleOAuthAccessToken`
   * closure. `googleOAuthAccessToken` / `emailOAuthTokens` still gate live-vs-
   * in-memory client selection (unchanged). When omitted (tests, non-Open
   * callers), the legacy per-instance accessor is used verbatim.
   */
  credentialResolver?: import('./cores/core-credential-resolver.ts').CoreCredentialResolver
  /**
   * Calendar Core S1 (Argus r2 BLOCKER #1 follow-up) — pre-built
   * `CalendarClient` instance. When supplied, the `calendar_core`
   * factory returns THIS instance verbatim instead of constructing
   * its own. The gateway boot uses this seam so the same client
   * powers (a) the Core's MCP tool surface, (b) the `/cal`
   * chat-command filter, and (c) the pre-meeting-brief scheduler —
   * all three reach the same underlying Google v3 REST wrapper (or
   * in-memory fallback).
   */
  calendarClient?: import('@neutronai/calendar-core').CalendarClient
  /**
   * Research Core S1 — pre-built per-instance project backend. The
   * production composer constructs ONE
   * `buildProjectResearchOrchestrator(...)` instance against the
   * shared `ResearchStoreResolver`, runtime substrate, sub-agent
   * dispatcher, and concurrency gate; the install-bundled factory
   * MUST reuse it so the MCP-tool surface and the chat-bridge
   * `/research` filter land on the SAME per-project SQLite files +
   * the SAME runtime LLM call. Closes Argus r1 BLOCKER #4 (canned
   * substrate would otherwise throw on the first synthesize()).
   */
  researchProjectBackend?: import('@neutronai/research-core').ResearchProjectBackend
  /**
   * Code-Gen Core S2 — an optional pre-built `CodegenOrchestrator`. When
   * supplied, the `codegen_core` factory returns THIS instance for the
   * `codegen_*` MCP tools. When omitted (the current production shape — the
   * retired v1 wiring builder was deleted), the factory falls back to a
   * skeleton runner-backed orchestrator (Tier 1 safe-install behavior). The
   * live `/code` chat command is served by foundational Trident, not this.
   */
  codegenOrchestrator?: import('@neutronai/codegen-core').CodegenOrchestrator
  /**
   * Settings Core (2026-06-03) — agent profile read/write seam
   * for `update_personality` / `update_agent_name`. The per-instance
   * gateway opens registry.db READ-ONLY at boot, so the production
   * composer threads an RW-backed `AgentProfileBackend` here (built
   * against `NEUTRON_REGISTRY_DB_PATH`, the same seam the persona-sync
   * onboarding hook uses). When omitted (registry RW path unavailable),
   * the factory wires a no-op profile so the project tools still
   * install + work and the profile tools fail soft.
   */
  agentSettingsProfile?: import('@neutronai/agent-settings').AgentProfileBackend
  /**
   * Settings Core (2026-06-03) — Telegram side-effect sink for
   * confirmations + forum-topic retitle/archive. Best-effort; a
   * Telegram failure never rolls back the committed DB mutation. When
   * omitted, the factory wires a no-op sink (the DB mutation still
   * lands; no confirmation is sent).
   */
  agentSettingsTelegram?: import('@neutronai/agent-settings').AgentSettingsTelegram
  /**
   * Settings Core — Item 3 (2026-06-10) resumable Telegram
   * connect. Mints a fresh one-time bind deep link for the
   * `connect_telegram` tool via the SAME mint path the wow handoff
   * uses. When omitted (NEUTRON_TELEGRAM_BIND_SECRET unwired), the
   * tool reports the honest CONNECT_TELEGRAM_UNAVAILABLE_ERROR.
   */
  agentSettingsBindLink?: import('@neutronai/agent-settings').TelegramBindLinkMinter
  /**
   * Plan task 8 — LATE-BOUND getter for the engine's ritual registration
   * service. The `reminders_core` factory threads it into
   * `buildReminderStoreBackend({ rituals })` so the `rituals_propose` /
   * `rituals_status` tools deref the service the composer assigns AFTER cores
   * mount (inside `ritual_executor_factory`). Returns `null` on an LLM-less box
   * ⇒ the tools throw `RitualsUnavailableError` (fail closed, no flags).
   */
  ritualRegistration?: () =>
    | import('@neutronai/reminders-core').RemindersRitualService
    | null
}
