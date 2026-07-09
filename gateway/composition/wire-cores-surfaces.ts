/**
 * Post-compose Cores HTTP surface auto-build (R5 / audit P2-5).
 *
 * Extracted verbatim from `composeProductionGraph`'s post-`graph.compose()`
 * sequence. Runs AFTER the cron scheduler is started and BEFORE the connect
 * on_inbound overlay — the caller preserves that ordering. Mutates
 * `input.cores_surface` / `input.cores_oauth_surface` in place (caller-
 * supplied surfaces win) and fires `input.on_cores_ready`. Behaviour is
 * byte-identical to the inline block.
 */

import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import { CoreInstallationsStore } from '@neutronai/cores-runtime/installations-store.ts'
import { createCoresSurface } from '../http/cores-surface.ts'
import type { StartOAuthResult } from '../http/cores-oauth-surface.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { GatewayModuleGraph } from '../module-graph.ts'
import type { CompositionInput } from './input/composition-input.ts'

export async function wireCoresSurfaces(
  input: CompositionInput,
  graph: GatewayModuleGraph,
): Promise<void> {
  // P3 cores wire-up — auto-build the `/api/cores` HTTP surface when
  // the cores module is composed AND a bearer-auth resolver was
  // supplied. The surface reads from the composed `CoresModuleState`
  // and a fresh `CoreInstallationsStore` against the per-instance DB
  // (same store the lifecycle wrote into during install). The auto-
  // build pattern mirrors the on_inbound_message overlay below:
  // caller-supplied `cores_surface` wins, otherwise the composer
  // fills it in for the boot shell's downstream `composeHttpHandler`
  // step.
  if (input.cores !== undefined) {
    const coresState = graph.get<CoresModuleState>('cores')
    if (input.cores.auth !== undefined) {
      const auth = input.cores.auth
      const secretsStore = input.cores.secretsStore
      if (input.cores_surface === undefined) {
        const surface = createCoresSurface({
          cores: coresState,
          installations: new CoreInstallationsStore({ db: input.db }),
          auth,
          project_slug: input.project_slug,
          projectDb: input.db,
        })
        input.cores_surface = { handler: surface.handler }
      }

      // OAuth token manager — built under the AUTH gate (not the OAuth-client
      // gate) so the Integrations surface + chat tools can read OAuth-slot
      // status and run local disconnect even on a deployment with NO Google
      // OAuth client. `getStatus` + `disconnect` only read/delete SecretsStore
      // rows; client creds (empty when unconfigured) are needed solely by the
      // refresh/exchange round-trips the OAuth surface drives. The `tokens`
      // manager + `pending` store are per-instance per-secrets-store, so we
      // construct them here against `input.cores`'s shared `secretsStore`.
      const { OAuthTokenManager } = await import('../cores/oauth-token-manager.ts')
      const tokens = new OAuthTokenManager({
        secretsStore,
        internal_handle: input.project_slug,
        client_id: input.cores.oauth?.clientId ?? '',
        client_secret: input.cores.oauth?.clientSecret ?? '',
        onInvalidGrant: async (label) => {
          // Mark every affected Core's runtime row as needing a
          // reconnect. Importing lazily to avoid circular deps.
          const { updateInstallState } = await import('../cores/install-bundled.ts')
          for (const core of coresState.registry.list()) {
            if (core.manifest.secrets.some((s) => s.label === label)) {
              try {
                await updateInstallState(
                  input.db,
                  input.project_slug,
                  core.slug,
                  'install_failed_runtime',
                )
              } catch {
                // best-effort
              }
            }
          }
        },
      })

      // `startOAuth` — the in-process grant start the chat `integrations_connect`
      // tool calls. Real when a Google OAuth client is wired; otherwise a stub
      // that reports `oauth_not_configured` so connecting an OAuth slot fails
      // with a clear message (API-key connect still works either way).
      let startOAuth: (labels: string[]) => Promise<StartOAuthResult> =
        async () => ({
          ok: false,
          status: 503,
          code: 'oauth_not_configured',
          message: 'Google OAuth is not configured on this deployment',
        })

      // Cores OAuth surface auto-build. Requires the OAuth client config in
      // addition to the auth resolver. We read from the registry on every
      // request and share the `tokens` manager built above.
      if (input.cores.oauth !== undefined && input.cores_oauth_surface === undefined) {
        const oauth = input.cores.oauth
        const { createCoresOAuthSurface } = await import('../http/cores-oauth-surface.ts')
        const { CoresOAuthPendingStore } = await import('../cores/oauth-pending-store.ts')
        const pending = new CoresOAuthPendingStore({ db: input.db })
        const surface = createCoresOAuthSurface({
          cores: {
            registry: coresState.registry,
            installed: coresState.installed,
            failures: coresState.failures,
            launcherIcons: coresState.launcherIcons,
            discovered: coresState.registry.list().length,
          },
          pending,
          tokens,
          secretsStore,
          projectDb: input.db,
          dataDir: input.cores.dataDir,
          tools: graph.get<ToolRegistry>('tools'),
          ...(input.cores.backends !== undefined ? { backends: input.cores.backends } : {}),
          project_slug: input.project_slug,
          identityBaseUrl: oauth.identityBaseUrl,
          ownerBaseUrl: oauth.ownerBaseUrl,
          redirectUri: oauth.redirectUri,
          clientId: oauth.clientId,
          internalSharedSecret: oauth.internalSharedSecret,
          auth,
        })
        input.cores_oauth_surface = { handler: surface.handler }
        // Reuse the OAuth surface's in-process start so chat-connect hands
        // back the SAME public Google authorize_url the UI uses.
        startOAuth = (labels) => surface.startOAuth(labels)

        // Argus PR #210 minor #1 — register the cores_oauth_pending sweep
        // cron so abandoned flows (user closes the tab, callback never
        // fires) don't leak SQLite rows. Wired alongside the OAuth surface so
        // the cron is unconditional when the OAuth path is mounted.
        const {
          buildCoresOAuthPendingSweepHandler,
          registerCoresOAuthPendingSweepCron,
        } = await import('../cores/oauth-pending-sweep-cron.ts')
        const cron = graph.get<{
          jobs: CronJobRegistry
          handlers: CronHandlerRegistry
        }>('cron')
        const sweepHandler = buildCoresOAuthPendingSweepHandler({ db: input.db })
        registerCoresOAuthPendingSweepCron({
          project_slug: input.project_slug,
          jobs: cron.jobs,
          handlers: cron.handlers,
          handler: sweepHandler,
        })
      }

      // WAVE 2 Track A — unified Integrations HTTP surface. Mounted under the
      // AUTH gate, INDEPENDENT of the OAuth-client gate (Argus PR #13
      // IMPORTANT #2), so standalone API-key management (e.g. Tavily) works on
      // a Cores + bearer-auth deployment with no Google OAuth client. Owns
      // `GET /api/cores/integrations` + `/api/cores/api-keys/*`.
      if (input.cores_integrations_surface === undefined) {
        const { createCoresIntegrationsSurface } = await import(
          '../http/cores-integrations-surface.ts'
        )
        const integrationsSurface = createCoresIntegrationsSurface({
          registry: coresState.registry,
          tokens,
          secretsStore,
          db: input.db,
          project_slug: input.project_slug,
          auth,
        })
        input.cores_integrations_surface = { handler: integrationsSurface.handler }
      }

      // WAVE 2 Track A — agent-native Integrations parity. Register the
      // `integrations_list` / `integrations_connect` / `integrations_disconnect`
      // chat tools against the same ToolRegistry the Cores register into,
      // sharing the `tokens` manager + `secretsStore` + registry + `db` the
      // HTTP surfaces hold so chat and UI hit one code path (including the
      // shared `disconnectOAuth` brain, which needs `db` to flag affected
      // Cores). Registered independent of the OAuth-client gate, mirroring the
      // surface above. Idempotent on a re-wire: skip already-registered tools
      // (the registry throws on duplicate name).
      const { buildIntegrationsTools } = await import('../cores/integrations-tools.ts')
      const toolRegistry = graph.get<ToolRegistry>('tools')
      const integrationsTools = buildIntegrationsTools({
        registry: coresState.registry,
        tokens,
        secretsStore,
        project_slug: input.project_slug,
        db: input.db,
        startOAuth,
      })
      for (const tool of integrationsTools) {
        if (toolRegistry.get(tool.name) === undefined) {
          toolRegistry.register(tool)
        }
      }
    }
    // Notify the boot shell that the cores module landed so it can
    // hydrate the launcher seed + any other post-compose consumers.
    if (input.on_cores_ready !== undefined) {
      input.on_cores_ready(coresState)
    }
  }
}
