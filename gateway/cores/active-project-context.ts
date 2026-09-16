/**
 * @neutronai/gateway/cores — the ambient ACTIVE-PROJECT context (D2 credential
 * resolver, 2026-07-01).
 *
 * The per-instance Core clients (Calendar/Email/Workspace) are built ONCE at
 * boot and read their credential through a `() => Promise<string|null>` accessor
 * closure that carries no per-call arguments — so the active project id can't be
 * threaded through the closure signature without touching every `@neutronai/*`
 * Core package. Instead we bind the active project id as ambient async context
 * (`AsyncLocalStorage`) around the tool handler at the in-process dispatch
 * boundary (X6: `McpServer.dispatch`, wired with `bindActiveProject:
 * runWithActiveProject` — the ONLY production binder), and the
 * `CoreCredentialResolver` reads it back when the accessor fires. Because the
 * handler runs as a single in-process `await` chain, the frame propagates
 * straight through to the accessor call.
 *
 * The agent's native MCP-tool path crosses a process + loopback-HTTP boundary an
 * in-memory frame cannot follow — so X6 does NOT try to propagate it. Instead the
 * originating project_id is THREADED through the tool-call envelope
 * (`ReplSession.projectId → McpServer.dispatch({project_id})`) and re-bound as a
 * FRESH frame in the gateway process AT THE TOOL BOUNDARY (`McpServer` is wired
 * with `bindActiveProject: runWithActiveProject`), so a Core tool's credential
 * accessor resolves per-project on the agent's native tool path.
 *
 * Credential reads require a known project. Missing or blank context refuses
 * access, including instance-wide fallback. This is API scoping only: code with
 * the readable shared key can still decrypt stored envelopes directly.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

interface ActiveProjectFrame {
  /** '' == unknown project; credential reads refuse. */
  readonly project_id: string
}

const storage = new AsyncLocalStorage<ActiveProjectFrame>()

/**
 * Run `fn` with `project_id` bound as the ambient active project. A missing /
 * blank id binds '' (credential reads refuse). The frame propagates to
 * every `await` `fn` roots synchronously — including a Core client's lazy
 * `accessToken()` closure.
 */
export function runWithActiveProject<T>(project_id: string | null | undefined, fn: () => T): T {
  return storage.run({ project_id: (project_id ?? '').trim() }, fn)
}

/** The ambient active project id, or '' when no frame is bound. */
export function currentActiveProjectId(): string {
  return storage.getStore()?.project_id ?? ''
}

/** Preserve the difference between an absent host frame and a bound unknown id. */
export function currentActiveProjectFrame(): Readonly<ActiveProjectFrame> | undefined {
  return storage.getStore()
}
