/**
 * @neutronai/gateway/cores — the ambient ACTIVE-PROJECT context (D2 credential
 * resolver, 2026-07-01).
 *
 * The per-instance Core clients (Calendar/Email/Workspace) are built ONCE at
 * boot and read their credential through a `() => Promise<string|null>` accessor
 * closure that carries no per-call arguments — so the active project id can't be
 * threaded through the closure signature without touching every `@neutronai/*`
 * Core package. Instead we bind the active project id as ambient async context
 * at the in-process dispatch boundary that already parses it (the chat-command
 * filter — `gateway/http/chat-bridge.ts`), and the `CoreCredentialResolver`
 * reads it back when the accessor fires. Because the chat-command path is a
 * single in-process `await` chain, the `AsyncLocalStorage` frame propagates
 * straight through to the accessor call.
 *
 * When NO frame is bound (the General topic, or the CC-spawn MCP-tool path which
 * crosses a process + loopback-HTTP boundary the frame can't follow) the active
 * project id resolves to '' → GLOBAL scope, which is exactly the pre-D2
 * per-instance behavior: safe, no regression.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

interface ActiveProjectFrame {
  /** '' == no project (General topic) → global scope. */
  readonly project_id: string
}

const storage = new AsyncLocalStorage<ActiveProjectFrame>()

/**
 * Run `fn` with `project_id` bound as the ambient active project. A missing /
 * blank id binds '' (the General topic → global scope). The frame propagates to
 * every `await` `fn` roots synchronously — including a Core client's lazy
 * `accessToken()` closure.
 */
export function runWithActiveProject<T>(project_id: string | undefined, fn: () => T): T {
  return storage.run({ project_id: (project_id ?? '').trim() }, fn)
}

/** The ambient active project id, or '' when no frame is bound (→ global scope). */
export function currentActiveProjectId(): string {
  return storage.getStore()?.project_id ?? ''
}
