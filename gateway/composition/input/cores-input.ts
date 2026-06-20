import type {
  CoreBackendFactoryMap,
  InstallTelemetryEvent,
} from '../../cores/install-bundled.ts'
import type { CoresModuleState } from '../../cores/composer-state.ts'
import type { BundledRegistryEvent } from '../../../cores/runtime/bundled-registry.ts'
import type { SecretsPrompter } from '../../../cores/runtime/lifecycle.ts'
import type { AppWsAuthResolver } from '../../../channels/adapters/app-ws/auth.ts'
import type { SecretsStore } from '../../../auth/secrets-store.ts'

export interface CoresCompositionInput {
  /**
   * P3 cores wire-up (2026-05-18). When supplied, the composer builds
   * the bundled-Cores registry, drives each Core's idempotent install
   * lifecycle, allocates per-Core data dirs, and registers each
   * Core's `buildTools(deps)` output against the production
   * `ToolRegistry`. The populated `CoresModuleState` (registry +
   * installed map + per-Core failure transcript) is exposed via
   * `graph.get<CoresModuleState>('cores')` so the HTTP surface
   * (`/api/cores`) and the launcher seed can read it.
   *
   * Optional — when omitted, no Cores boot and the `cores` module is
   * not registered. Tests + legacy P1 composers that never reached
   * the Cores runtime continue to compose cleanly.
   *
   * Per docs/plans/P3-cores-wireup-sprint-brief.md § 2.
   */
  cores?: {
    /**
     * Per-instance data dir — sidecar files land at
     * `<dataDir>/cores/<slug>.db`. Production wires `<owner_home>`.
     */
    dataDir: string
    /** Pre-built SecretsStore (the same instance other modules use). */
    secretsStore: SecretsStore
    /**
     * Repo roots the bundled registry walks. Production wires
     * `platform.getBundledCoreRoots()`. When `platform` is also set
     * and `rootDirs` is omitted, the composer pulls the roots from
     * the platform adapter automatically.
     */
    rootDirs?: readonly string[]
    /** Per-slug backend factories. Missing slugs register
     *  `not_implemented` stubs. */
    backends?: CoreBackendFactoryMap
    /** Override the install-time secrets prompter (testing seam). */
    prompter?: SecretsPrompter
    /** Override the structured-log sink (testing seam). */
    log?: (event: BundledRegistryEvent | InstallTelemetryEvent) => void
    /** Override the failure-rate hard-fail threshold (testing seam). */
    hardFailFailureRatio?: number
    /**
     * Bearer-auth resolver for the auto-built `/api/cores` surface.
     * When supplied AND `cores_surface` is unset, the composer
     * auto-builds `createCoresSurface(...)` from the composed cores
     * module and writes it back to `input.cores_surface`. When
     * omitted, the surface is not auto-built; the boot shell can
     * still construct it manually and pass it via
     * `input.cores_surface`.
     */
    auth?: AppWsAuthResolver
    /**
     * Cores OAuth surface config — when present + `auth` is set, the
     * composer auto-builds the `cores_oauth_surface` and writes it
     * back to `input.cores_oauth_surface`. All four fields are
     * required; if any is missing the OAuth surface stays unmounted
     * and the boot warns.
     */
    oauth?: {
      clientId: string
      clientSecret: string
      identityBaseUrl: string
      ownerBaseUrl: string
      redirectUri: string
      internalSharedSecret: string
    }
  }
  /**
   * P3 — `GET /api/cores` HTTP handler. When supplied, the composed
   * HTTP chain mounts the bundled-Cores admin endpoint ahead of the
   * landing routes (so `/api/cores...` is unambiguously owned).
   *
   * Surface factory: `gateway/http/cores-surface.ts:createCoresSurface`.
   * Per docs/plans/P3-cores-wireup-sprint-brief.md § 3.
   */
  cores_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * Notes Core S1 — drawer-browser HTTP surface. When supplied, the
   * composed HTTP chain mounts `/api/cores/notes/...` (drawers /
   * notes / search / traverse / tunnel) ahead of the bundled-Cores
   * admin surface. HTTP-only, bearer-auth-gated.
   *
   * Surface factory: `cores/free/notes/src/ui/drawer-browser-surface.ts:createNotesDrawerBrowserSurface`.
   * Per docs/plans/notes-core-tier1-brief.md § 3.3.
   */
  notes_drawer_browser_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * Cores OAuth secret-resolution sprint — owns
   * `/api/cores/oauth/google/{start,ingest,disconnect/<label>,status}`.
   * Mounted ahead of `/api/cores` so the OAuth paths are unambiguous.
   * Per docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 4.1.
   */
  cores_oauth_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P3 — post-compose hook fired with the live `CoresModuleState`
   * after `composeProductionGraph` lands the `cores` module. The
   * production composer wires this to populate the launcher store's
   * seed (so `DEFAULT_LAUNCHER_SEED`'s hardcoded list is replaced by
   * the live bundled-Cores registry's installed slugs). Per
   * docs/plans/P3-cores-wireup-sprint-brief.md § 4.1.
   *
   * Optional — when omitted the launcher seed falls back to its
   * static default and the cores state simply isn't propagated to
   * any downstream consumer that opted in.
   */
  on_cores_ready?: (state: CoresModuleState) => void
}
