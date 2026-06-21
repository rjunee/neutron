/**
 * landing/web-chat-flag — which web chat client to serve at `/chat`.
 *
 * Track B Phase 3 ships the React/assistant-ui client BEHIND A FLAG with the
 * battle-tested vanilla-TS client as the default fallback — no cutover. The
 * flag is resolved per request from two inputs, query overriding env:
 *
 *   1. env `NEUTRON_WEB_CHAT_CLIENT` — the deploy-wide default. `react` opts an
 *      instance into the new client; anything else (unset, `vanilla`) keeps the
 *      vanilla default.
 *   2. query `?client=react|vanilla` — a per-request override so an operator can
 *      A/B the two surfaces on the same instance without flipping the env. An
 *      unrecognized value is ignored (falls back to the env default).
 *
 * Pure + side-effect free so it unit-tests without a server.
 */

export type WebChatClient = 'react' | 'vanilla'

export interface ResolveWebChatClientInput {
  /** `NEUTRON_WEB_CHAT_CLIENT` (or any injected default). */
  envDefault?: string | undefined
  /** The request URL's `?client=` query value, if present. */
  queryClient?: string | null | undefined
}

function normalize(value: string | null | undefined): WebChatClient | null {
  if (value === 'react') return 'react'
  if (value === 'vanilla') return 'vanilla'
  return null
}

/**
 * Resolve the effective client. Query wins over env; env sets the default;
 * absent/garbage on both → `vanilla` (the safe, shipped surface).
 */
export function resolveWebChatClient(input: ResolveWebChatClientInput): WebChatClient {
  return normalize(input.queryClient) ?? normalize(input.envDefault) ?? 'vanilla'
}
