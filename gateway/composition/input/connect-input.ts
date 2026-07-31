import type {
  ConnectApiHandlers,
  JwtBearerMiddlewareOptions,
} from '@neutronai/runtime/connect-handlers.ts'
import type { ChannelRouter } from '@neutronai/channels/router.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface ConnectCompositionInput {
  /**
   * Optional connect API config. When supplied (production path),
   * `composeProductionGraph` builds the connect API handler + sets
   * it as `http_handler`. The user-supplied `http_handler` (above) wins
   * when both are present so caller-controlled composition stays
   * authoritative.
   */
  connect_api?: {
    auth: JwtBearerMiddlewareOptions
    handlers: ConnectApiHandlers
    /**
     * ISSUES #421 — the owner's project DB, read by the CONNECT SURFACE STATE
     * GATE (`connect/surface-gate.ts`) on every inbound `/connect/v1/*` request.
     * REQUIRED, and deliberately a DB rather than a boolean: reachability is a
     * function of the instance's own connect state (a live invite, or a
     * non-revoked collaborator), so no caller — Open, Managed, or a test — can
     * configure the surface open. Supplying `connect_api` mounts the ONE code
     * path; the rows decide whether it answers.
     */
    owner_db: ProjectDb
    /**
     * Sprint B (2026-05-20) — boot-shell-supplied factory for the
     * default `on_inbound_message` handler, for a caller that wants the
     * composer to build the handler from the composed graph's router + db
     * instead of supplying it directly. The Open composer supplies
     * `handlers.on_inbound_message` outright (`open/wiring/connect-node.ts`)
     * and leaves this undefined — not because Connect is Managed-only
     * (ISSUES #421 retired that framing) but because it already holds the
     * router at assembly time.
     *
     * When `handlers.on_inbound_message` is undefined AND this factory
     * is supplied, the composer auto-overlays the constructed handler
     * onto `handlers`. When the factory is undefined and
     * `on_inbound_message` is also undefined, the handler stays
     * undefined (the caller is responsible for supplying it).
     */
    build_on_inbound_message_handler?: (input: {
      router: ChannelRouter
      db: ProjectDb
      receiving_instance_slug: string
    }) => NonNullable<ConnectApiHandlers['on_inbound_message']>
    /**
     * M2.6 Ph3 — public-edge rate limiter. CONNECT-NODE ONLY (the boot shell
     * wires it in the `NEUTRON_ROLE=connect` block). When set it is threaded
     * into `createConnectApiHandler` so the public guest-auth + message
     * edge rejects floods (429) before `resolve_member` / the ingress run.
     * `unknown` keeps this composer off a static import edge on the Managed
     * `connect/api/edge-rate-limiter.ts` type — the boot shell
     * supplies the concrete instance and the narrow cast below applies it.
     */
    rate_limiter?: unknown
    /**
     * M2.6 Ph6 — the per-account `ConnectUsageMeter`. HOSTED-RELAY ONLY (the
     * boot shell wires it in the `NEUTRON_ROLE=connect` block ONLY when
     * `isHostedRelay` — a self-hosted connect node leaves it undefined and
     * meters nothing). An in-process reference for the eventual paywall + the
     * Managed admin surface; the read SURFACE itself is mounted on the
     * operator-internal default-handler edge, never on the connect guest
     * edge. `unknown` keeps this composer off the static `connect/`
     * import edge — the boot shell supplies the concrete `ConnectUsageMeter`.
     */
    connect_usage_meter?: unknown
  }
}
