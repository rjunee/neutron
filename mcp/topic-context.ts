/**
 * @neutronai/mcp — request topic context.
 *
 * The per-instance MCP server is multiplexed across topics within an instance;
 * every tool call carries `topic_context: { topic_id, project_id,
 * speaker_user_id }` in the request envelope, which we bind to an
 * AsyncLocalStorage frame for the duration of the call so handlers see
 * consistent context without threading it through every method signature.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface TopicContext {
  /** Neutron topic UUID (the `topics.id` row in the project DB). */
  topic_id: string
  /** Project the topic belongs to. NULL for instance-level topics. */
  project_id: string | null
  /** Speaker user_id for group-project turns. NULL for solo or system. */
  speaker_user_id: string | null
  /** The originating call_id (caller-provided; uniqueness is the caller's problem). */
  call_id: string
}

const storage = new AsyncLocalStorage<TopicContext>()

/** Run `fn` with `ctx` bound. The frame is restored on return. */
export function withTopicContext<R>(ctx: TopicContext, fn: () => R | Promise<R>): R | Promise<R> {
  return storage.run(ctx, fn)
}

/** Read the currently-bound context. Returns undefined outside any frame. */
export function currentTopicContext(): TopicContext | undefined {
  return storage.getStore()
}

/**
 * Read the currently-bound context, throwing if absent. Use inside tool
 * handlers that REQUIRE a topic — fail-loud rather than silently widening
 * the call into "instance-level".
 */
export function requireTopicContext(): TopicContext {
  const ctx = storage.getStore()
  if (!ctx) throw new Error('no topic context bound; tool handler called outside a topic frame')
  return ctx
}
