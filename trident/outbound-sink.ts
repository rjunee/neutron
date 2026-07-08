/**
 * @neutronai/trident — outbound delivery seam (L2 leaf).
 *
 * L2 (2026-07) — `OutboundSink` was independently declared TWICE
 * (byte-identical shape) in `trident/delivery.ts` and
 * `gateway/proactive/sink.ts`. Unified onto this ONE leaf declaration; both
 * old sites now re-export from here (test-policy §2.2 barrel rule). Kept
 * inside `trident/` (not the shared `contracts/` leaf) because the shape
 * depends on `OutgoingMessage` (`channels/types.ts`, platform band) — a
 * `contracts`-band leaf may not import platform per the layering ratchet
 * (`.dependency-cruiser.cjs` `contracts-are-leaves` rule), but `trident`
 * (services band) already legitimately does.
 */

import type { OutgoingMessage } from '../channels/types.ts'

/**
 * Minimal structural outbound seam — the subset of `ChannelRouter` this
 * module needs. `ChannelRouter.send(OutgoingMessage)` satisfies it
 * structurally, so production passes the router directly; tests pass a
 * recording fake. Kept structural (not an import of `ChannelRouter`) so
 * the trident package stays free of the channels runtime.
 */
export interface OutboundSink {
  send(message: OutgoingMessage): Promise<string>
}
