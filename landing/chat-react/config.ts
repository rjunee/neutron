/**
 * landing/chat-react — bootstrap config for the React/assistant-ui web chat
 * client (Track B Phase 3).
 *
 * The React surface is the web client that talks to the **app-ws** WebSocket
 * surface (`/ws/app/chat`) through `@neutron/chat-core`'s `WebChatSession` —
 * the Phase-1 transport with a monotonic per-topic `seq` + resume replay. This
 * is now the single unified chat socket (the legacy vanilla client's
 * `/ws/chat` onboarding socket was removed).
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
  /**
   * The app-ws bearer token (the same value carried on the WS URL `&token=`).
   * Surfaced here so the chat-attachment surface can authenticate: both the
   * `POST /api/app/upload` compose upload and the bearer-authed
   * `GET /api/app/upload/<user>/<hash>.<ext>` render-back send it as
   * `Authorization: Bearer <token>`. Defaults to the dev-bypass `dev:<user_id>`
   * form (accepted under `NEUTRON_APP_WS_BYPASS=1`); the production EdDSA mint
   * overrides it via `window.__neutron_app_ws_token`. */
  token: string
  /** Track B Phase 4 — this client's device id (read-receipt attribution +
   *  read-tick self-exclusion). Carried on the WS URL `&device_id=`. */
  deviceId: string
  /**
   * BUG 1 (auto-start) — true when the owner has NOT finished onboarding, so a
   * FRESH onboarding session shows a "setting things up…" loader (not the
   * "Send a message to begin." empty state) while the server pushes the first
   * onboarding prompt on connect. Injected by the server into the served /chat
   * HTML (`window.__neutron_onboarding_active`); defaults to false so a
   * returning, genuinely-empty steady-state chat keeps the plain empty state.
   * Optional + defaults to false (absent ⇒ steady-state) so existing config
   * literals (tests) need no change; `resolveBootstrapConfig` always sets it.
   */
  onboardingActive?: boolean
}

export interface WindowLike {
  location: { protocol: string; host: string; search: string }
  __neutron_start_token?: string
  __neutron_app_ws_token?: string
  __neutron_app_ws_url?: string
  __neutron_user_id?: string
  __neutron_projects?: ProjectTab[]
  __neutron_active_project_id?: string
  __neutron_onboarding_active?: boolean
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

/** Build the app-ws WebSocket URL for a host + token (+ optional project +
 *  optional device id for receipt attribution). */
export function buildWsUrl(
  protocol: string,
  host: string,
  token: string,
  projectId: string | null,
  deviceId?: string,
): string {
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams()
  params.set('platform', 'web')
  params.set('token', token)
  if (projectId !== null && projectId.length > 0) params.set('project_id', projectId)
  if (deviceId !== undefined && deviceId.length > 0) params.set('device_id', deviceId)
  return `${scheme}//${host}/ws/app/chat?${params.toString()}`
}

/** Mint a per-page-load device id. Stability across reloads isn't required for
 *  correctness — the web UI only reports reads for agent messages (never the
 *  user's own sends), so a fresh id can't light a sender's own read tick. */
export function makeDeviceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID !== undefined) return `dev-${c.randomUUID()}`
  return `dev-${Math.floor(Math.random() * 1e9).toString(36)}`
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
  const deviceId = makeDeviceId()
  const wsUrl =
    win.__neutron_app_ws_url ??
    buildWsUrl(win.location.protocol, win.location.host, appWsToken, projectId, deviceId)
  const origin = `${win.location.protocol}//${win.location.host}`
  return {
    wsUrl,
    topicId: appWsTopicId(userId),
    userId,
    projectId,
    projects,
    origin,
    deviceId,
    token: appWsToken,
    onboardingActive: win.__neutron_onboarding_active === true,
  }
}
