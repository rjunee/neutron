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

import { CronHandlerRegistry } from '../../cron/handlers.ts'
import { CronJobRegistry } from '../../cron/jobs.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import { CoreInstallationsStore } from '../../cores/runtime/installations-store.ts'
import { createCoresSurface } from '../http/cores-surface.ts'
import { ToolRegistry } from '../../tools/registry.ts'
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
    if (input.cores.auth !== undefined && input.cores_surface === undefined) {
      const surface = createCoresSurface({
        cores: coresState,
        installations: new CoreInstallationsStore({ db: input.db }),
        auth: input.cores.auth,
        project_slug: input.project_slug,
        projectDb: input.db,
      })
      input.cores_surface = { handler: surface.handler }
    }
    // Cores OAuth surface auto-build. Requires auth resolver + the
    // OAuth client config + a way to read the live `CoresModuleState`
    // (registry-keyed manifest secrets). We construct the surface by
    // reading from the registry on every request — the `tokens`
    // manager + `pending` store are per-instance per-secrets-store
    // instances, so we re-construct them here against `input.cores`'s
    // shared `secretsStore` to keep the auto-wired path zero-config
    // for the caller.
    if (
      input.cores.auth !== undefined &&
      input.cores.oauth !== undefined &&
      input.cores_oauth_surface === undefined
    ) {
      const { createCoresOAuthSurface } = await import('../http/cores-oauth-surface.ts')
      const { CoresOAuthPendingStore } = await import('../cores/oauth-pending-store.ts')
      const { OAuthTokenManager } = await import('../cores/oauth-token-manager.ts')
      const pending = new CoresOAuthPendingStore({ db: input.db })
      const tokens = new OAuthTokenManager({
        secretsStore: input.cores.secretsStore,
        internal_handle: input.project_slug,
        client_id: input.cores.oauth.clientId,
        client_secret: input.cores.oauth.clientSecret,
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
        secretsStore: input.cores.secretsStore,
        projectDb: input.db,
        dataDir: input.cores.dataDir,
        tools: graph.get<ToolRegistry>('tools'),
        ...(input.cores.backends !== undefined ? { backends: input.cores.backends } : {}),
        project_slug: input.project_slug,
        identityBaseUrl: input.cores.oauth.identityBaseUrl,
        ownerBaseUrl: input.cores.oauth.ownerBaseUrl,
        redirectUri: input.cores.oauth.redirectUri,
        clientId: input.cores.oauth.clientId,
        internalSharedSecret: input.cores.oauth.internalSharedSecret,
        auth: input.cores.auth,
      })
      input.cores_oauth_surface = { handler: surface.handler }

      // Argus PR #210 minor #1 — register the cores_oauth_pending sweep
      // cron so abandoned flows (user closes the tab, callback never
      // fires) don't leak SQLite rows. The store's docblock has
      // promised this cron forever; PR #210 just landed the
      // sweepExpired SQL without ever calling it. Wired here (alongside
      // the OAuth surface) so the cron is unconditional when the OAuth
      // path is mounted.
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
    // Notify the boot shell that the cores module landed so it can
    // hydrate the launcher seed + any other post-compose consumers.
    if (input.on_cores_ready !== undefined) {
      input.on_cores_ready(coresState)
    }
  }
}
