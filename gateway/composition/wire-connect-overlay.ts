/**
 * Post-compose connect `on_inbound_message` overlay (R5 / audit P2-5).
 *
 * Extracted verbatim from `composeProductionGraph`'s post-`graph.compose()`
 * sequence. Runs AFTER the Cores surface auto-build and BEFORE the HTTP
 * composition — the caller preserves that ordering. Mutates
 * `input.connect_api.handlers.on_inbound_message` in place only when the
 * caller left it undefined and supplied a factory. Behaviour is
 * byte-identical to the inline block.
 */

import { ChannelRouter } from '@neutronai/channels/router.ts'
import type { GatewayModuleGraph } from '../module-graph.ts'
import type { CompositionInput } from './input/composition-input.ts'

export function wireConnectOverlay(
  input: CompositionInput,
  graph: GatewayModuleGraph,
): void {
  // P1.5 wiring — `on_inbound_message` was shipped as `undefined` in P1 S6
  // (see realmode-composer.ts:buildDefaultRealModeComposer). Now that the
  // channels module's router is composed, wire the handler so an inbound
  // POST /connect/v1/messages routes through the receiver's local
  // ChannelRouter ingress queue. The handler also writes an
  // `inbound_messages` audit row BEFORE invoking the router (per
  // docs/plans/P2-onboarding.md § 0a.1 risk row 3).
  //
  // Sprint B (2026-05-20) — the handler factory is supplied by the
  // boot shell via `connect_api.build_on_inbound_message_handler`
  // (DI seam). Managed boot binds the Managed-tier
  // `buildOnInboundMessageHandler`; Open boot leaves it undefined
  // because the connect API surface never mounts on
  // Open self-hosted instances.
  //
  // Only overlay when the caller did NOT supply a real handler — caller-
  // controlled composition stays authoritative for tests + custom paths.
  if (
    input.connect_api !== undefined &&
    input.connect_api.handlers.on_inbound_message === undefined &&
    input.connect_api.build_on_inbound_message_handler !== undefined
  ) {
    const router = graph.get<ChannelRouter>('channels')
    input.connect_api.handlers.on_inbound_message =
      input.connect_api.build_on_inbound_message_handler({
        router,
        db: input.db,
        receiving_instance_slug: input.project_slug,
      })
  }
}
