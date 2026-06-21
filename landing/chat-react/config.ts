/**
 * landing/chat-react — bootstrap config for the React/assistant-ui web chat
 * client (Track B Phase 3).
 *
 * The React surface is a NEW client that talks to the **app-ws** WebSocket
 * surface (`/ws/app/chat`) through `@neutron/chat-core`'s `WebChatSession` —
 * the Phase-1 transport with a monotonic per-topic `seq` + resume replay. That
 * is a different surface from the legacy vanilla client's `/ws/chat`, so the
 * two run side by side behind the flag with no shared connection.
 *
 * Identity is derived CLIENT-SIDE from the same one-shot start token the
 * vanilla `chat.html` already stashes on `window.__neutron_start_token` (its
 * `sub` claim is the user id). We never trust this decode for auth — the
 * gateway re-validates the app-ws token on upgrade — it only shapes the topic
 * id + WS URL. The app-ws token itself defaults to the dev-bypass form
 * (`dev:<user_id>`, accepted when `NEUTRON_APP_WS_BYPASS=1`) and is overridden
 * by `window.__neutron_app_ws_token` once the production EdDSA mint lands (the
 * same "later sub-sprint" the app-ws auth resolver itself defers).
 *
 * Everything here is pure given a {@link WindowLike}, so it unit-tests without
 * a DOM.
 */

export interface ProjectTab {
  id: string
  label: string
}

export interface BootstrapConfig {
  /** `wss://host/ws/app/chat?platform=web&token=…` */
  wsUrl: string
  /** The `app:<user_id>` topic this session renders. */
  topicId: string
  userId: string
  /** Active project tag (sent with each message; null = default/General). */
  projectId: string | null
  projects: ProjectTab[]
  /** Page origin (`https://host`) — used to absolutize relative attachment URLs. */
  origin: string
}

export interface WindowLike {
  location: { protocol: string; host: string; search: string }
  __neutron_start_token?: string
  __neutron_app_ws_token?: string
  __neutron_app_ws_url?: string
  __neutron_user_id?: string
  __neutron_projects?: ProjectTab[]
  __neutron_active_project_id?: string
}

/** Synthetic app-ws topic id for a user. Mirrors `appWsTopicId` on the server
 *  (kept inline so the browser bundle doesn't pull in the channels package). */
export function appWsTopicId(userId: string): string {
  return `app:${userId}`
}

/**
 * Decode the `sub` claim from a JWT WITHOUT verifying it. Returns null on any
 * malformed input — the caller falls back to an explicit `__neutron_user_id`
 * (dev) and ultimately surfaces a config error rather than guessing.
 */
export function decodeJwtSub(token: string | undefined | null): string | null {
  if (typeof token !== 'string' || token.length === 0) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  const payloadSeg = parts[1]
  if (payloadSeg === undefined || payloadSeg.length === 0) return null
  try {
    const b64 = payloadSeg.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    // `atob` is present in browsers AND the Bun test runtime; if absent we
    // simply can't decode → null (the caller falls back to __neutron_user_id).
    if (typeof atob !== 'function') return null
    const claims = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null
  } catch {
    return null
  }
}

/** Build the app-ws WebSocket URL for a host + token (+ optional project). */
export function buildWsUrl(
  protocol: string,
  host: string,
  token: string,
  projectId: string | null,
): string {
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams()
  params.set('platform', 'web')
  params.set('token', token)
  if (projectId !== null && projectId.length > 0) params.set('project_id', projectId)
  return `${scheme}//${host}/ws/app/chat?${params.toString()}`
}

export class ChatBootstrapError extends Error {}

/**
 * Resolve the full {@link BootstrapConfig} from the window globals + URL. Throws
 * {@link ChatBootstrapError} when no user identity can be derived (no start
 * token, no `__neutron_user_id`) — the entry point renders a clear error
 * instead of opening a socket that can never authenticate.
 */
export function resolveBootstrapConfig(win: WindowLike): BootstrapConfig {
  const startToken =
    win.__neutron_start_token ?? new URLSearchParams(win.location.search).get('start') ?? undefined
  const userId = win.__neutron_user_id ?? decodeJwtSub(startToken) ?? ''
  if (userId.length === 0) {
    throw new ChatBootstrapError(
      'chat-react: could not derive a user id (no start token sub claim and no __neutron_user_id).',
    )
  }
  const appWsToken = win.__neutron_app_ws_token ?? `dev:${userId}`
  const projects = Array.isArray(win.__neutron_projects) ? win.__neutron_projects : []
  const projectId =
    typeof win.__neutron_active_project_id === 'string' && win.__neutron_active_project_id.length > 0
      ? win.__neutron_active_project_id
      : null
  const wsUrl =
    win.__neutron_app_ws_url ?? buildWsUrl(win.location.protocol, win.location.host, appWsToken, projectId)
  const origin = `${win.location.protocol}//${win.location.host}`
  return { wsUrl, topicId: appWsTopicId(userId), userId, projectId, projects, origin }
}
