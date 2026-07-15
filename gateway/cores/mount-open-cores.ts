/**
 * @neutronai/gateway/cores — compose the free Cores into the single-owner **Open**
 * boot path (Vajra→Neutron parity gap #2, 2026-06-25 scan §5 #2 + the gap-#6
 * forge's repo-wide chat-command-filter finding).
 *
 * THE GAP: `open/composer.ts` never set `composition.cores`, so
 * `gateway/composition/build-core-modules.ts:535` skipped the cores module →
 * `installBundledCores` never ran in Open → no Core MCP tools registered. And the
 * Open web-chat path (`buildLandingStack` → `gateway/http/chat-bridge.ts`) had no
 * chat-command-filter seam at all (only the Expo `createAppWsSurface` did), so a
 * typed `/cal` / `/email` / `/research` / `/remind` fell straight through to the
 * LLM instead of being routed to its Core. The Calendar/Email/Google factories +
 * the `buildChainedChatCommandFilter` chain existed in `gateway/boot-helpers.ts`
 * but were only re-exported by `gateway/index.ts` — their real call sites live in
 * the carved-out Managed composer.
 *
 * THIS HELPER closes both by REUSING the exact Managed mechanism (no Open-only
 * fork):
 *   1. `buildCoresBackendFactories(...)` → the `CoreBackendFactoryMap` the Open
 *      composer hands to `composition.cores.backends` so `installBundledCores`
 *      registers every bundled Core's `buildTools(deps)` MCP surface.
 *   2. `buildChainedChatCommandFilter([...])` over the bundled free-Core filters
 *      (`/cal`, `/email`, `/remind`, `/research`) — the SAME backend
 *      instance powers a Core's MCP tools AND its chat-command filter
 *      (agent-native parity): the pre-built `calendarClient` seam, one shared
 *      `EmailProjectCacheResolver`, and the Research `project_backend`.
 *
 * OPTIONAL-UNTIL-CREDENTIALED: a per-instance `OAuthTokenManager` over the shared
 * `SecretsStore`. When `NEUTRON_CORES_GOOGLE_CLIENT_ID` is unset (the zero-creds
 * Open default) the Google access-token accessor is `null` / `emailOAuthTokens`
 * is `undefined` → the Calendar/Gmail/Workspace backends fall back to the
 * in-memory clients (exactly as `buildCoresBackendFactories` does for OAuth-less
 * boxes). `/cal`/`/email` then dispatch against an empty calendar/inbox — a
 * graceful "nothing yet", never a hard error, never a boot block. The moment a
 * Google grant is connected the SAME wiring goes live with no further changes.
 */

import {
  buildCalendarChatCommandFilter,
  buildChainedChatCommandFilter,
  buildCoresBackendFactories,
  buildRemindersChatCommandFilter,
  buildResearchLlmCallForOwner,
  readPatternFromPrompts,
} from '../boot-helpers.ts'
import type { CoreBackendFactoryMap } from './install-bundled.ts'
import { SecretsStorePrompter } from './install-bundled.ts'
// L3 (2026-07) — the Open agent-profile backend is INJECTED (built by
// `open/composer.ts` and passed in as `agentSettingsProfile`) rather than
// imported here, so this gateway composition core no longer reaches UP into the
// `open` band. Only the structural `AgentProfileBackend` type is referenced.
import type { AgentProfileBackend } from '@neutronai/agent-settings'
import type { ChatCommandFilter } from '../http/app-ws-surface.ts'
import { OAuthTokenManager } from './oauth-token-manager.ts'
import { CoreCredentialResolver } from './core-credential-resolver.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { buildCalendarCacheResolver } from './calendar-wiring.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import { collectTokensToString } from '../wiring/build-llm-call-substrate.ts'

import type { CalendarClient } from '@neutronai/calendar-core'
import {
  buildGoogleCalendarClient,
  buildInMemoryCalendarClient,
  OAUTH_SECRET_LABEL as CALENDAR_OAUTH_LABEL,
} from '@neutronai/calendar-core'
import type { GmailClient } from '@neutronai/email-managed-core'
import {
  EmailProjectCacheResolver,
  buildGoogleGmailClient,
  buildInMemoryGmailClient,
  createEmailChatCommandFilter,
  OAUTH_SECRET_LABEL as EMAIL_OAUTH_LABEL,
} from '@neutronai/email-managed-core'
import { buildReminderStoreBackend, buildSmartWrapComposer } from '@neutronai/reminders-core'
import { buildProductionResearchCoreWiring } from '@neutronai/research-core'

/** The Google OAuth client-id env var. Present ⇒ the Cores OAuth path is
 *  configured; absent ⇒ the zero-creds Open default (in-memory Core clients). */
export const GOOGLE_CLIENT_ID_ENV = 'NEUTRON_CORES_GOOGLE_CLIENT_ID'
export const GOOGLE_CLIENT_SECRET_ENV = 'NEUTRON_CORES_GOOGLE_CLIENT_SECRET'

export interface MountOpenCoresInput {
  /** Per-instance ProjectDb (the same handle boot opened). */
  projectDb: ProjectDb
  /** Single-owner data dir (`<owner_home>`). Caches + sidecars live under it. */
  owner_home: string
  /** Instance slug — provenance, audit, OAuth-token keying. */
  project_slug: string
  /** Per-instance encrypted secrets store (OAuth tokens). Built once by the
   *  composer (`new SecretsStore({ data_dir: owner_home, db })`). */
  secretsStore: SecretsStore
  /**
   * D2 (2026-07-01) — the canonical per-project credential store (the SAME
   * instance the Settings CRUD surface mounts). The Cores' credential accessors
   * resolve through it (`resolveCredential(activeProjectId, service)`:
   * per-project → global → unset), so a project can carry its own Drive / static
   * service token distinct from the instance default while Email/Calendar stay
   * global. Required — the resolver is THE path (no flag, no legacy dual path).
   */
  projectCredentialStore: ProjectCredentialStore
  /** Process env (Google OAuth client config). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * The owner's warm CC-subprocess substrate (the SAME `Substrate` the live chat
   * uses — never a direct api.anthropic.com call). Powers the Research Core's
   * `llm_call` and the Email Core's triage/summarize LLM. Pass `null` on an
   * LLM-less box: the Research filter still claims `/research` but the orchestrator
   * surfaces a "reconnect" failure instead of crashing, and the Email triage path
   * degrades to its deterministic structured-row fallback. Both still BOOT.
   */
  substrate?: Substrate | null
  /** Default project_id for filters whose inbound omits one. */
  default_project_id?: string
  /**
   * The Settings Core (M1) agent-profile writer — INJECTED by the composer
   * (`open/composer.ts` builds `buildOpenAgentProfileBackend({...})` and passes
   * it here) so `update_agent_name` / `update_personality` persist to
   * `<owner_home>/persona/{agent-profile.json,SOUL.md}` and reflect on the next
   * agent turn. Wiring it in from the composition root keeps this gateway core
   * from importing the `open` band (L3 DAG cut). Optional — when omitted (tests
   * that don't exercise agent-settings) the Cores backend factory falls back to
   * its `available:false` no-op. The composer wires the backend's own
   * `onProfileChange` to the persona-loader cache invalidation.
   */
  agentSettingsProfile?: AgentProfileBackend
}

export interface MountedOpenCores {
  /** Backend-factory map for `composition.cores.backends` (→ MCP tool install). */
  readonly backends: CoreBackendFactoryMap
  /** Chained free-Core chat-command filter for `buildLandingStack`. */
  readonly chatCommandFilter: ChatCommandFilter
  /**
   * Install-time secrets prompter for `composition.cores.prompter`. Reads any
   * connected OAuth token out of the shared `SecretsStore` so the Calendar /
   * Email / Google-Workspace Cores install LIVE the moment their grant exists
   * (and fail-soft / hidden until then — the optional-until-credentialed contract
   * at the install layer).
   */
  readonly prompter: SecretsStorePrompter
  /** True when the Google OAuth client is configured (live-cred path possible). */
  readonly oauthConfigured: boolean
  /** Close the per-Core cache/sidecar handles. Register on `realmode_cleanups`. */
  cleanup(): void
}

/**
 * Wrap a warm substrate into the one-shot `(prompt) => Promise<string>` LLM call
 * the Email Core's triage/summarize agents consume. Each call is an isolated
 * dispatch on the substrate; the reply text is returned verbatim.
 */
function buildOneShotSubstrateLlm(
  substrate: Substrate,
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const spec: AgentSpec = {
      prompt,
      tools: [],
      // Resolve PER-CALL — the watchdog's adopted id reaches each one-shot
      // Core LLM dispatch instead of a frozen module-load constant.
      model_preference: [getBestModel()],
      max_tokens: 2048,
    }
    return await collectTokensToString(substrate.start(spec))
  }
}

/**
 * Compose the free Cores into the Open boot. Returns the backend map + the
 * chained chat-command filter the composer threads into `composition.cores` and
 * `buildLandingStack`. Pure construction — no schedulers started here (the
 * scribe phase-2 fan-out is mounted separately by `mountCoresScribeFanOut`).
 */
export async function mountOpenCores(
  input: MountOpenCoresInput,
): Promise<MountedOpenCores> {
  const env = input.env ?? process.env
  const default_project_id = input.default_project_id ?? 'default'
  const substrate = input.substrate ?? null

  // ── Optional-until-credentialed Google OAuth ───────────────────────────────
  const googleClientId = env[GOOGLE_CLIENT_ID_ENV] ?? ''
  const oauthConfigured = googleClientId.length > 0
  const oauthTokens = new OAuthTokenManager({
    secretsStore: input.secretsStore,
    internal_handle: input.project_slug,
    client_id: googleClientId,
    client_secret: env[GOOGLE_CLIENT_SECRET_ENV] ?? '',
  })
  // Lazy access-token accessor. Non-null ONLY when the OAuth client is configured,
  // exactly mirroring the Managed gate (`gateway/index.ts` supplies the accessor
  // only when all OAuth envs resolved). Returns null when no grant is connected →
  // the Google client treats it as "not connected" (graceful, no throw). When the
  // OAuth client is unconfigured the accessor is null → in-memory fallback clients.
  const googleOAuthAccessToken: ((label: string) => Promise<string | null>) | null =
    oauthConfigured
      ? async (label: string): Promise<string | null> => {
          try {
            return await oauthTokens.getAccessToken(label)
          } catch {
            return null
          }
        }
      : null
  const emailOAuthTokens = oauthConfigured ? oauthTokens : undefined

  // ── D2 credential resolver (2026-07-01) ────────────────────────────────────
  // The one seam every Google-backed Core resolves its credential through:
  // per-project → global → OAuthTokenManager (legacy global) → unset. Email +
  // Calendar are forced to GLOBAL scope by SERVICE_SCOPE (no per-project
  // re-consent), a project's own Drive (`google_workspace`) + static service
  // tokens resolve per-project → global. Reads the ACTIVE project from the
  // ambient `runWithActiveProject` frame the chat-command path binds; on the
  // General topic / MCP-tool path the frame is absent → global scope (= today's
  // per-instance behavior, no regression). `oauthTokens` is always constructed;
  // it's the resolver's global fallback (used only when live per the gate below).
  const credentialResolver = new CoreCredentialResolver({
    owner_slug: input.project_slug,
    store: input.projectCredentialStore,
    oauthTokens,
  })

  // ── Shared per-Core backends (one instance → MCP tools AND chat filter) ─────
  // Calendar: ONE client powers the `calendar_core` MCP tools (via the pre-built
  // `calendarClient` seam) AND the `/cal` filter (+ the brief scheduler elsewhere).
  const calendarClient: CalendarClient =
    googleOAuthAccessToken !== null
      ? buildGoogleCalendarClient({
          // D2: route through the resolver (GLOBAL scope for Calendar — the
          // active project is ignored, so effective behavior is unchanged).
          accessToken: credentialResolver.accessorFor(CALENDAR_OAUTH_LABEL),
        })
      : buildInMemoryCalendarClient()
  const calendarCache = buildCalendarCacheResolver(input.owner_home)

  // Email: the `email_managed_core` factory builds its OWN Gmail client from
  // `emailOAuthTokens`; the `/email` filter uses this one. Both read the same
  // account (same token manager) / both an empty in-memory inbox when OAuth-less.
  const gmailClient: GmailClient =
    emailOAuthTokens !== undefined
      ? buildGoogleGmailClient({
          // D2: route through the resolver (GLOBAL scope for Email — the active
          // project is ignored, so effective behavior is unchanged).
          accessToken: credentialResolver.accessorFor(EMAIL_OAUTH_LABEL),
        })
      : buildInMemoryGmailClient()
  const emailResolver = new EmailProjectCacheResolver({ owner_home: input.owner_home })

  // Reminders: the chat-command-create backend (the fire-time dispatcher is wired
  // separately in the composer). `/remind` parses + persists a reminder row that
  // the existing tick loop fires.
  const reminderBackend = buildReminderStoreBackend({
    project_slug: input.project_slug,
    projectDb: input.projectDb,
  })
  const reminderSmartWrap = buildSmartWrapComposer({
    loadPattern: (name) => readPatternFromPrompts(name),
  })

  // Research: ONE production wiring → the `project_backend` feeds the MCP tools
  // AND the `/research` filter shares it (same per-project SQLite + substrate).
  const researchWiring = buildProductionResearchCoreWiring({
    project_slug: input.project_slug,
    owner_home: input.owner_home,
    llm_call: buildResearchLlmCallForOwner({
      project_slug: input.project_slug,
      slug_suffix: input.project_slug,
      substrate,
    }),
    default_project_id,
  })

  // Email triage/summarize LLM — substrate-backed when available, else a stub that
  // throws so the Email Core renders its deterministic structured-row fallback.
  const emailLlm: (prompt: string) => Promise<string> =
    substrate !== null
      ? buildOneShotSubstrateLlm(substrate)
      : async (): Promise<string> => {
          throw new Error('no email triage llm (LLM-less Open box)')
        }

  // ── Backend-factory map (drives `installBundledCores` MCP-tool registration) ─
  const backends = await buildCoresBackendFactories({
    projectDb: input.projectDb,
    owner_home: input.owner_home,
    emailResolver,
    ...(emailOAuthTokens !== undefined ? { emailOAuthTokens } : {}),
    emailLlm,
    // Thunk (not a snapshot) so the email Core's stamped model resolves
    // per-call, aligned with the per-call `emailLlm` dispatch after a flip.
    emailModel: getBestModel,
    googleOAuthAccessToken,
    // D2: the MCP-tool backend factories resolve their Google credential through
    // the SAME resolver as the chat-filter clients (per-project → global → unset).
    credentialResolver,
    calendarClient,
    researchProjectBackend: researchWiring.project_backend,
    // Settings Core (M1) — the Open-appropriate agent-profile writer, INJECTED
    // by the composer (L3 DAG cut) so `update_agent_name` / `update_personality`
    // actually persist (to `<owner_home>/persona/{agent-profile.json,SOUL.md}`)
    // and reflect on the next agent turn, instead of falling back to the
    // `available:false` no-op that returned SETTINGS_BACKEND_UNAVAILABLE_ERROR on
    // every Open box. When absent (agent-settings-agnostic tests) the backend
    // factory installs its own no-op fallback.
    ...(input.agentSettingsProfile !== undefined
      ? { agentSettingsProfile: input.agentSettingsProfile }
      : {}),
  })

  // ── Chained chat-command filter (the repo-wide gap — chain ALL free filters) ─
  const chatCommandFilter = buildChainedChatCommandFilter([
    buildCalendarChatCommandFilter({
      client: calendarClient,
      cacheFor: calendarCache.cacheFor,
    }),
    createEmailChatCommandFilter({
      resolver: emailResolver,
      client: gmailClient,
      llm: emailLlm,
      // Pass the accessor (thunk) so the reported model resolves PER-CALL,
      // aligned with the per-call `emailLlm` dispatch after a watchdog flip.
      model: getBestModel,
      default_project_id,
    }),
    buildRemindersChatCommandFilter({
      backend: reminderBackend,
      smartWrap: reminderSmartWrap,
    }),
    researchWiring.chat_command_filter,
  ])

  return {
    backends,
    chatCommandFilter,
    prompter: new SecretsStorePrompter({
      secretsStore: input.secretsStore,
      project_slug: input.project_slug,
    }),
    oauthConfigured,
    cleanup(): void {
      try {
        calendarCache.closeAll()
      } catch {
        // best-effort shutdown
      }
      try {
        emailResolver.closeAll()
      } catch {
        // best-effort shutdown
      }
    },
  }
}
