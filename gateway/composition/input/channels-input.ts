import type { ChannelRouter } from '@neutronai/channels/router.ts'
import type { Topic, IncomingEvent } from '@neutronai/channels/types.ts'

export interface ChannelsCompositionInput {
  /**
   * Topic handler invoked by the channel router. The boot shell wires the
   * production handler (substrate dispatcher); tests + dev pass a stub.
   */
  topic_handler: (topic: Topic, event: IncomingEvent) => Promise<void>
  /**
   * Sprint 19 — optional pre-constructed `ChannelRouter`. When supplied,
   * `composeProductionGraph` REUSES this instance instead of constructing
   * its own from `(db, project_slug, topic_handler)`.
   *
   * Why this exists: the production composer needs to pre-build the router
   * so the Telegram webhook handler can hold a reference to the SAME
   * router the graph exposes. The webhook handler is constructed in
   * `gateway/wiring/build-telegram-webhook.ts` BEFORE the graph
   * composes — without this seam the handler would have to wait on a
   * post-compose hook (`on_graph_composed`) or a `DeferredEventReceiver`
   * shim, both of which the v2 plan deliberately drops.
   *
   * Backward-compat: tests + legacy P1 callers leave this unset; the
   * `channels` module then constructs its own router as before. The
   * behaviour for those callers is unchanged.
   *
   * See `docs/plans/2026-05-05-002-feat-sprint-19-wiring-wiring-plan.md`
   * § Architectural revision: drop `DeferredEventReceiver` + `on_graph_composed`.
   */
  channel_router?: ChannelRouter
}
