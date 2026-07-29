/**
 * @neutronai/wire-types — node-free wire/shared type leaf (L6).
 *
 * The bottom-band package that owns the wire + shared types the transport
 * and the two clients (web React, Expo mobile) used to DUPLICATE by hand:
 *
 *   - `./option.ts`          — THE canonical `WireAgentMessageOption` (the one
 *                              shape the 5 near-identical option declarations
 *                              collapsed onto; see that file for the two
 *                              explicit projections kept distinct).
 *   - `./app-ws-envelope.ts` — the app-ws WebSocket envelope union (types only;
 *                              `channels/adapters/app-ws/envelope.ts` re-exports
 *                              them + keeps the runtime decode/sanitize helpers).
 *   - `./topic-id.ts`        — `app:<user>[:<project>]` topic-id derivation
 *                              (killed the `landing/chat-react/config.ts` mirror).
 *   - `./doc-links.ts`       — the `docs:/…` marker ⇄ channel-URL algorithm
 *                              (killed the `app/lib/doc-links.ts` byte-twin).
 *   - `./tab-descriptor.ts`  — the engine `TabDescriptor` wire shape (killed the
 *                              `app/lib/tabs-client.ts` + `landing/chat-react/
 *                              tabs-client.ts` mirror type blocks).
 *   - `./agent-engagement.ts`— RE-EXPORT of `@neutronai/contracts`'s
 *                              `AgentEngagementMode` (killed the
 *                              `app/lib/projects-client.ts` mirror).
 *
 * HARD constraints (depcruise `contracts` band, L6): node-free (no `node:*`
 * imports), imports NOTHING upward, zero cycles. Registered as `^wire-types`
 * in `.dependency-cruiser.cjs`'s `L.contracts` band + `includeOnly`.
 */

export * from './option.ts'
export * from './app-ws-envelope.ts'
export * from './topic-id.ts'
export * from './doc-links.ts'
export * from './tab-descriptor.ts'
export * from './agent-engagement.ts'
