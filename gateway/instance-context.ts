/**
 * @neutronai/gateway — instance-context AsyncLocalStorage frame.
 *
 * AsyncLocalStorage-binds
 * `{instance_slug, project_id, topic_id, speaker_user_id}` for the duration
 * of a turn. Read by the logger, MCP server tool calls, scribe pipeline.
 *
 * Distinct from `mcp/topic-context.ts` — that one is the MCP-request frame
 * with the call_id; this one is the broader gateway frame that also covers
 * non-MCP code paths (HTTP middleware, watchdog notifications).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface InstanceContext {
  instance_slug: string
  project_id: string | null
  topic_id: string | null
  speaker_user_id: string | null
}

const storage = new AsyncLocalStorage<InstanceContext>()

export function withInstanceContext<R>(ctx: InstanceContext, fn: () => R | Promise<R>): R | Promise<R> {
  return storage.run(ctx, fn)
}

export function currentInstanceContext(): InstanceContext | undefined {
  return storage.getStore()
}

export function requireInstanceContext(): InstanceContext {
  const ctx = storage.getStore()
  if (!ctx) throw new Error('no instance context bound; called outside an instance frame')
  return ctx
}
