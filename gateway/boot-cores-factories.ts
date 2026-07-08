/**
 * gateway/boot-cores-factories.ts — the per-slug Cores backend factory
 * map (`buildCoresBackendFactories`) + the Research MCP default-project
 * wrapper.
 *
 * Split out of the former monolithic `gateway/boot-helpers.ts` (C2
 * refactor). This is the single largest cohesive cluster: one factory-map
 * function whose branches wire each Tier-1 Core's `ToolDeps` backend
 * (Tasks / Reminders / Calendar / Email / Google-Workspace / Research /
 * Scraping / Code-Gen / Settings). Every Core module is lazily
 * `import(...)`-ed inside its factory branch so this module carries no
 * eager Core module-load. This module MUST NEVER import `gateway/index.ts`.
 *
 * Open-classified and import-clean of Managed dirs.
 */

import { readPatternFromPrompts } from './boot-chat-command-filters.ts'
import type { CoreBackendFactoryMap } from './cores/install-bundled.ts'
import type { CoresBackendFactoriesOptions } from './boot-cores-factories-types.ts'

// Re-export the Cores-factory type contracts through this module so
// existing importers of `TasksCoreOwnerRegistry` / `CoresBackendFactoriesOptions`
// from `./boot-cores-factories.ts` (and the composer-contract seam) resolve
// unchanged after the C2 type split.
export type {
  TasksCoreOwnerRegistry,
  CoresBackendFactoriesOptions,
} from './boot-cores-factories-types.ts'

export async function buildCoresBackendFactories(
  opts: CoresBackendFactoriesOptions,
): Promise<CoreBackendFactoryMap> {
  const {
    projectDb,
    canonicalTaskStore,
    emailResolver,
    emailOAuthTokens,
    emailLlm,
    emailModel,
    tasksCoreRegistry,
    pickNextLlmClient,
    researchProjectBackend,
    codegenOrchestrator: codegenOrchestratorFromOpts,
    credentialResolver,
  } = opts
  const googleOAuthAccessToken = opts.googleOAuthAccessToken ?? null
  const preBuiltCalendarClient = opts.calendarClient ?? null
  return {
    tasks_core: async ({ project_slug }) => {
      // Wire the Core's tool surface to the SAME canonical task store
      // that backs the app's `/api/app/projects/<id>/tasks` and
      // `/api/app/focus` HTTP surfaces, AND attach the projection /
      // reminder-link subscribers `tasksModule.init` registered against
      // that store. Without both seams, `tasks_create` writes through
      // the Core would either land in a process-local in-memory store
      // invisible to the HTTP surfaces, or in a subscriber-free store
      // that bypasses STATUS.md projection entirely. Same pattern
      // Reminders Core uses (`buildReminderStoreBackend` below).
      const mod = await import('@neutronai/tasks-core')
      const store = mod.buildSubstrateTaskStoreBackend({
        project_slug,
        projectDb,
        ...(canonicalTaskStore !== undefined ? { store: canonicalTaskStore } : {}),
      })
      // Tasks Core S1 — build the LLM-driven pick-next service. Tests
      // inject the deterministic stub; the production composer wires
      // the live Sonnet-fallback client. `pickNext` rides through
      // `normalizeBackend` because `'store'` is in the canonical
      // backend-key list (see gateway/cores/install-bundled.ts:861) —
      // the object is passed through verbatim to `buildTools(deps)`.
      const llm = pickNextLlmClient ?? mod.buildStubPickNextLlmClient()
      const pickNext = mod.buildPickNextService({ store, llm })
      if (tasksCoreRegistry !== undefined) {
        tasksCoreRegistry.set(project_slug, { store, pickNext })
      }
      return { store, pickNext }
    },
    reminders_core: async ({ project_slug }) => {
      const mod = await import('@neutronai/reminders-core')
      return {
        backend: mod.buildReminderStoreBackend({
          project_slug,
          projectDb,
        }),
        // S1 — Shape A / B / C composer threaded into the production
        // wiring so the chat-command dispatcher can compose the
        // `message` body BEFORE persisting (deterministic prelude
        // prepend for Shape B; pattern body load + FILL: slot
        // substitution for Shape C; NO LLM call at create time).
        smartWrap: mod.buildSmartWrapComposer({
          loadPattern: (name) => readPatternFromPrompts(name),
        }),
      }
    },
    calendar_core: async () => {
      // Argus r2 BLOCKER #1 — when the gateway boot pre-built a
      // CalendarClient (so the same instance powers the chat-command
      // dispatcher + the pre-meeting-brief scheduler), return it
      // verbatim instead of constructing a second one. Without this
      // seam the Core's MCP tools would dispatch against a SEPARATE
      // in-memory store from the one /cal show / scheduler observe.
      if (preBuiltCalendarClient !== null) {
        return { client: preBuiltCalendarClient }
      }
      const mod = await import('@neutronai/calendar-core')
      // Calendar Core S1 (2026-05-20) — wire the production Google v3
      // REST client whose access-token accessor reads through the
      // shared OAuthTokenManager for transparent refresh. The
      // accessor argument is supplied to this factory ONLY when the
      // Cores OAuth surface mounts (i.e. all four envs were resolved
      // at boot — see gateway/index.ts:3079-3106). Otherwise fall
      // back to the in-memory client so the install pipeline still
      // installs the Core (dispatches against an empty calendar) —
      // preserves the existing __tests__/install-lifecycle.test.ts
      // shape + the dev boot.
      if (googleOAuthAccessToken !== null) {
        // D2: route through the resolver (Email/Calendar stay GLOBAL scope —
        // the active project is ignored for `google_calendar`), else the raw
        // per-instance accessor. Effective behavior identical for Calendar.
        return {
          client: mod.buildGoogleCalendarClient({
            accessToken:
              credentialResolver !== undefined
                ? credentialResolver.accessorFor(mod.OAUTH_SECRET_LABEL)
                : () => googleOAuthAccessToken(mod.OAUTH_SECRET_LABEL),
          }),
        }
      }
      return { client: mod.buildInMemoryCalendarClient() }
    },
    email_managed_core: async () => {
      // Email-Managed Core S1 (2026-05-20) — wires the production
      // Gmail v1 REST client whose lazy access-token accessor reads
      // through the OAuthTokenManager for transparent refresh. When
      // the Cores OAuth surface is unmounted (envs absent), falls
      // back to the in-memory Gmail client so install pipeline still
      // installs the Core. Identical dual-mode shape Calendar Core
      // mirrors in PR #248's sibling sprint. Per
      // docs/plans/email-managed-core-tier1-brief.md § 4.
      const mod = await import('@neutronai/email-managed-core')
      const client =
        emailOAuthTokens !== undefined
          ? mod.buildGoogleGmailClient({
              // D2: route through the resolver (Email stays GLOBAL scope — the
              // active project is ignored for `gmail_compose`), else the raw
              // per-instance OAuthTokenManager read. Effective behavior identical.
              accessToken:
                credentialResolver !== undefined
                  ? credentialResolver.accessorFor(mod.OAUTH_SECRET_LABEL)
                  : async () => {
                      try {
                        return await emailOAuthTokens.getAccessToken(mod.OAUTH_SECRET_LABEL)
                      } catch {
                        return null
                      }
                    },
            })
          : mod.buildInMemoryGmailClient()
      const factoryDeps: {
        client: import('@neutronai/email-managed-core').GmailClient
        summarizer: import('@neutronai/email-managed-core').EmailSummarizer
        cacheFor: (project_id: string) => Promise<import('@neutronai/email-managed-core').EmailProjectCache>
        llm?: (prompt: string) => Promise<string>
        model?: string | (() => string)
      } = {
        client,
        summarizer: mod.buildStubEmailSummarizer(),
        cacheFor: (project_id) => emailResolver.resolve(project_id),
      }
      if (emailLlm !== undefined) factoryDeps.llm = emailLlm
      if (emailModel !== undefined) factoryDeps.model = emailModel
      return factoryDeps
    },
    google_workspace_core: async () => {
      // Google Workspace Core (gap-audit P0-6, 2026-06-20) — wires the
      // production Drive v3 / Sheets v4 / Docs v1 REST client whose lazy
      // access-token accessor reads through the shared OAuthTokenManager
      // for transparent refresh, EXACTLY like the Calendar + Email Cores.
      // When the Cores OAuth surface is unmounted (envs absent), falls
      // back to the in-memory client so the install pipeline still
      // installs the Core (dispatches against an empty workspace). The
      // grant is stored under the distinct `google_workspace` label so
      // it connects/disconnects independently of the Calendar/Email
      // grants — per-Core OAuth, NOT a shared global token.
      const mod = await import('@neutronai/google-workspace-core')
      if (googleOAuthAccessToken !== null) {
        // D2: a project's OWN Drive resolves PER-PROJECT → global. The resolver
        // consults `project_credentials` for the active project's
        // `google_workspace` token first, then falls back to the instance-wide
        // OAuthTokenManager grant. Legacy raw accessor when no resolver wired.
        return {
          client: mod.buildGoogleWorkspaceClient({
            accessToken:
              credentialResolver !== undefined
                ? credentialResolver.accessorFor(mod.OAUTH_SECRET_LABEL)
                : () => googleOAuthAccessToken(mod.OAUTH_SECRET_LABEL),
          }),
        }
      }
      return { client: mod.buildInMemoryGoogleWorkspaceClient() }
    },
    research_core: async () => {
      // Argus r1 BLOCKER #3 + #4: the composer ALWAYS threads the real
      // per-instance project backend through here so the MCP tools
      // (`research_deep`/`research_list`/...) share the SAME
      // `ResearchStoreResolver` + runtime substrate + sub-agent
      // dispatcher the chat-bridge `/research` filter uses. Without
      // this share the MCP path lands on a different (per-call,
      // process-local) backend and the on-disk SQLite divergence
      // surfaces as "I just captured this brief but research_list
      // returns nothing".
      //
      // Argus r2 MINOR #2 (2026-05-21): the previous canned-empty
      // substrate fallback was unreachable in production but matched
      // the Email-Core r1 anti-pattern Sam called out as forbidden in
      // CLAUDE.md ("placeholder phase-prompt bodies that ship as
      // no-ops"). Hard-required `researchProjectBackend` instead;
      // tests inject via the `backends:` override map (which bypasses
      // this factory entirely), production wires the real one via
      // `buildProductionResearchCoreWiring`.
      //
      // Argus r2 BLOCKER (2026-05-21): the legacy `research_start` /
      // `research_status` / `research_fetch` MCP tools take inputs
      // WITHOUT `project_id` (the manifest declares it optional with
      // "defaults to 'default'" semantics). The
      // `ResearchProjectBackend` methods all require `project_id` and
      // throw `ResearchInputError` on the empty string. Wrap the
      // shared backend so omitted/empty `project_id` defaults to
      // `'default'` at the MCP boundary — keeps the orchestrator
      // strict while honoring the documented MCP-tool contract.
      if (researchProjectBackend === undefined) {
        throw new Error(
          '[research_core] composer must thread `researchProjectBackend` ' +
            'into buildCoresBackendFactories. Use ' +
            '`buildProductionResearchCoreWiring(...)` in production and ' +
            'pass `project_backend` through; tests inject via the ' +
            '`backends:` override map.',
        )
      }
      return { backend: wrapResearchBackendWithDefaultProjectId(researchProjectBackend) }
    },
    scraping_core: async ({ installation }) => {
      // Scraping Core (Vajra parity gap #6) — IG/X scraping via Apify.
      // Unlike research_core, this factory is fully SELF-SUFFICIENT: it
      // builds the backend from the per-install capability-gated
      // `SecretsAccessor` (`installation.secrets_accessor`), so the MCP
      // tools (`scrape_instagram` / `scrape_x`) get a real backend even
      // when no composer threads anything in. The token is read PER-CALL
      // via `tokenProviderFromAccessor`, so a token pasted in admin after
      // boot takes effect with no restart — and a missing token no-ops
      // with guidance instead of calling Apify (optional-until-credentialed).
      const mod = await import('@neutronai/scraping-core')
      return {
        backend: mod.buildScrapingBackend({
          tokenProvider: mod.tokenProviderFromAccessor(
            installation.secrets_accessor,
          ),
        }),
      }
    },
    codegen_core: async () => {
      // S2 (2026-05-22) — when the production composer threads its
      // wiring-built orchestrator, reuse it so the Core's MCP tools
      // share the SAME runner + per-project sidecar resolver as the
      // `/code` chat-command filter. When omitted (legacy / tests),
      // fall back to a skeleton-runner orchestrator that fails
      // dispatches loudly + actionably — install_ok stays TRUE.
      if (codegenOrchestratorFromOpts !== undefined) {
        return { orchestrator: codegenOrchestratorFromOpts }
      }
      // Trident-port close-out (2026-06-24) — the codegen_core module now ONLY
      // backs the four legacy `codegen_*` MCP tools; `/code <task>` no longer
      // touches it (it dispatches through foundational Trident on the
      // CC-subprocess substrate — see `buildTridentCodeChatCommandFilter` +
      // `trident/substrate-dispatch.ts`). The Code-Gen Core's production
      // WRAPPER (`gateway/cores/code-gen-factory.ts` +
      // `build-production-codegen-wiring.ts` + `buildCodegenChatCommandFilter`)
      // was RETIRED in that close-out, so no composer threads a real
      // `codegenOrchestrator` here anymore: the codegen_* MCP tools dispatch
      // into `buildSkeletonCodegenRunner`, whose `run(...)` throws
      // `CodegenNotConfiguredError`. The skeleton STAYS — it is the legitimate
      // Tier-1 safe-install shape (install_ok must stay TRUE); we keep the
      // fall-through observable so it never silently masquerades as a real
      // runner.
      console.warn(
        '[codegen_core] note: no real `codegenOrchestrator` is wired — the ' +
          'legacy codegen_* MCP tools dispatch into the SKELETON runner ' +
          '(CodegenNotConfiguredError). This is EXPECTED post Trident-port ' +
          'close-out: `/code <task>` runs on foundational Trident (the ' +
          'CC-subprocess substrate), not the retired Code-Gen Core wrapper.',
      )
      const mod = await import('@neutronai/codegen-core')
      const runner = mod.buildSkeletonCodegenRunner()
      return { orchestrator: new mod.CodegenOrchestrator({ runner }) }
    },
    agent_settings: async () => {
      // Settings Core (2026-06-03) — the six "tweak later" tools.
      // Project ops (list/rename/delete/merge) hit the per-instance
      // canonical `projects` table directly via `projectDb`. Personality
      // + agent-name ops route through the injected `AgentProfileBackend`
      // (registry RW); Telegram confirmations + topic retitle/archive
      // route through the injected sink. Both are best-effort: when the
      // composer didn't thread them, a no-op stands in so install +
      // project ops still work.
      const mod = await import('@neutronai/agent-settings')
      const profile: import('@neutronai/agent-settings').AgentProfileBackend =
        opts.agentSettingsProfile ?? {
          // Argus r5 IMPORTANT (2026-06-03): mark the no-op fallback
          // `available:false` so update_personality / update_agent_name
          // report an honest failure instead of a success that silently
          // no-ops. The fallback can STAY (non-Managed deploys without a
          // registry writer); it just must signal honestly.
          available: false,
          async get() {
            return { agent_name: null, agent_personality: null }
          },
          async setAgentName() {
            /* no-op: registry RW unavailable */
          },
          async setAgentPersonality() {
            /* no-op: registry RW unavailable */
          },
        }
      const telegram: import('@neutronai/agent-settings').AgentSettingsTelegram =
        opts.agentSettingsTelegram ?? {
          async sendConfirmation() {
            /* no-op: telegram sink unavailable */
          },
          async renameTopic() {
            /* no-op */
          },
          async archiveTopic() {
            /* no-op */
          },
        }
      return {
        backend: mod.buildAgentSettingsBackend({
          projectDb,
          profile,
          telegram,
          // Item 3 (2026-06-10) — resumable Telegram connect. When the
          // composer didn't thread a minter (bind secret unwired), omit
          // it so `connect_telegram` reports the honest unavailable
          // error instead of pretending to mint.
          ...(opts.agentSettingsBindLink !== undefined
            ? { bindLink: opts.agentSettingsBindLink }
            : {}),
        }),
      }
    },
  }
}

/**
 * Argus r2 BLOCKER close (2026-05-21) — wrap a `ResearchProjectBackend`
 * so the legacy MCP tool inputs (`research_start` / `research_status` /
 * `research_fetch`) work without a caller-supplied `project_id`. The
 * manifest declares `project_id` OPTIONAL on those three tools with
 * "defaults to 'default'" semantics; the production orchestrator
 * requires it and throws `ResearchInputError('project_id', ...)` on the
 * empty string. The chat-bridge `/research` filter applies the same
 * default at its boundary; this wrapper does it at the MCP boundary so
 * an LLM agent calling `research_start({query:'foo'})` per the
 * documented schema lands on the canonical 'default' sidecar instead of
 * 500'ing. Keeps the orchestrator strict (the wrapper is the seam) and
 * matches the chat-path behavior exactly.
 */
export function wrapResearchBackendWithDefaultProjectId(
  backend: import('@neutronai/research-core').ResearchProjectBackend,
): import('@neutronai/research-core').ResearchProjectBackend {
  const DEFAULT_PROJECT_ID = 'default'
  const withProjectId = <T extends { project_id?: string }>(input: T): T & { project_id: string } => {
    const project_id =
      typeof input.project_id === 'string' && input.project_id.trim().length > 0
        ? input.project_id
        : DEFAULT_PROJECT_ID
    return { ...input, project_id }
  }
  return {
    start: (input) => backend.start(withProjectId(input)),
    deep: (input) => backend.deep(withProjectId(input)),
    list: (input) => backend.list(withProjectId(input)),
    find: (input) => backend.find(withProjectId(input)),
    cite: (input) => backend.cite(withProjectId(input)),
    claimsForTask: (input) => backend.claimsForTask(withProjectId(input)),
    status: (input) => backend.status(withProjectId(input)),
    fetch: (input) => backend.fetch(withProjectId(input)),
  }
}
