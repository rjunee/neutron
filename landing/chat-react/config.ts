/**
 * landing/chat-react — bootstrap config for the React/assistant-ui web chat
 * client (Track B Phase 3).
 *
 * The React surface is the web client that talks to the **app-ws** WebSocket
 * surface (`/ws/app/chat`) through `@neutronai/chat-core`'s `WebChatSession` —
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

import { initialDocLinkFromLocation } from './doc-link-nav.ts'
// L6 — topic-id derivation moved to the node-free @neutronai/wire-types leaf.
// This file's inline `appWsTopicId` / `appWsProjectTopicId` mirror existed ONLY
// to keep the browser bundle from pulling in the (node-only) channels package;
// wire-types being node-free removes that reason. BROWSER-SAFETY: import from
// the NARROW `topic-id` subpath — NOT the barrel — so this browser bundle
// doesn't drag in the leaf's `doc-links` module (which reads `process.env`).
// Imported for local use here and re-exported below so any importer stays valid.
import { appWsProjectTopicId, appWsTopicId } from '@neutronai/wire-types/topic-id.ts'

export interface ProjectTab {
  id: string
  label: string
  /** Per-project rail glyph. Always a non-empty emoji from the server (an
   *  explicit choice, or a deterministic default from the name). Optional on the
   *  wire for back-compat; the rail falls back to a generic glyph if absent. */
  emoji?: string
  /** Unread agent-message count for this project (Telegram-style badge). 0 =
   *  caught up. Optional for back-compat (absent ⇒ no badge). */
  unread?: number
  /** ISO-8601 activity sort key. The server already orders the list
   *  most-recent-first; kept for optional client-side re-sort. */
  last_activity_at?: string
  /** M1 UX REDESIGN — the derived rail state. Optional on the wire for
   *  back-compat (absent ⇒ the rail treats the project as idle). */
  activity?: 'idle' | 'working' | 'attention'
  /** M1 UX REDESIGN — the last message, server-truncated + markdown-stripped, for
   *  the rail's second line. Null/absent ⇒ no preview line. */
  preview?: string | null
  /** M1 UX REDESIGN — who sent the previewed message, for a `You: ` prefix. */
  preview_from?: 'user' | 'agent' | null
  /** M1 UX REDESIGN — count of live (non-terminal) bound runs, for the Work-tab
   *  badge + pane toggle count. Absent/0 ⇒ no badge. */
  live_runs?: number
}

export interface BootstrapConfig {
  /** `wss://host/ws/app/chat?platform=web&token=…` — the INITIAL socket URL
   *  (carries the bootstrap `project_id`, if any). On a project switch the
   *  controller rebuilds this per scope via {@link buildWsUrl}. */
  wsUrl: string
  /**
   * Explicit WS-URL override (`window.__neutron_app_ws_url`), when present. A
   * dev/test escape hatch: when set, the controller reuses it verbatim across
   * project switches (single fixed socket) instead of deriving a per-project
   * URL. Absent in production (the Open composer doesn't inject it), so the
   * controller derives `?project_id=<id>` per scope.
   */
  wsUrlOverride?: string
  /** The `app:<user_id>` topic this session renders (General). Per-project
   *  scopes derive `app:<user>:<project>` via {@link topicForProject}. */
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
   * ISSUES #40 — the browser/OS IANA timezone
   * (`Intl.DateTimeFormat().resolvedOptions().timeZone`) detected ONCE at boot.
   * Carried on the WS URL `&tz=` so the gateway persists it for the daily nudge.
   * Resolved once here and reused for EVERY per-scope socket URL the controller
   * rebuilds (see `main.tsx` `wsUrlFor`), so a project switch keeps sending it.
   * `null` when the runtime can't resolve a zone → the `tz` param is omitted.
   * Optional + defaults to undefined so existing config literals (tests) need no
   * change; `resolveBootstrapConfig` always sets it.
   */
  timeZone?: string | null
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
  /**
   * Managed post-onboarding claim redirect target. Present ONLY when the server
   * injected `window.__neutron_post_onboarding_claim_url` (from env
   * `NEUTRON_POST_ONBOARDING_CLAIM_URL` — a Managed-overlay config). When set,
   * the controller navigates the browser here on the `onboarding_completed`
   * frame; when ABSENT (the Open self-host default) the redirect no-ops and
   * onboarding completes normally. Optional + defaults to undefined so existing
   * config literals (tests) need no change; there is ONE code path
   * (redirect-if-present), never an on/off flag.
   */
  postOnboardingClaimUrl?: string
  /**
   * Doc-link deep-link 404 fix — the doc-link target parsed from the page URL
   * when the SPA was hard-loaded at a `/projects/<id>/docs?path=…` deep link
   * (the gateway's SPA catch-all served the shell). Present ONLY on such a boot;
   * `ProjectShell` consumes it once to switch to that project's Documents tab
   * and open the doc. Absent on a normal `/chat` boot. Optional + defaults to
   * undefined so existing config literals (tests) need no change.
   */
  initialDocLink?: { projectId: string; path: string }
}

export interface WindowLike {
  location: { protocol: string; host: string; search: string; pathname: string }
  __neutron_start_token?: string
  __neutron_app_ws_token?: string
  __neutron_app_ws_url?: string
  __neutron_user_id?: string
  __neutron_projects?: ProjectTab[]
  __neutron_active_project_id?: string
  __neutron_onboarding_active?: boolean
  __neutron_post_onboarding_claim_url?: string
}

// L6 — `appWsTopicId` / `appWsProjectTopicId` now come from the narrow
// `@neutronai/wire-types/topic-id` subpath (imported above); re-exported here so
// existing `landing/chat-react/config` importers keep resolving them from this
// module without dragging the leaf's `doc-links` into the browser bundle.
export { appWsProjectTopicId, appWsTopicId } from '@neutronai/wire-types/topic-id.ts'

/**
 * The store key + WS topic for a given active project (null = General). The
 * controller calls this on a project switch to re-scope the session: each
 * project's durable transcript lives under its own topic in the shared store.
 */
export function topicForProject(userId: string, projectId: string | null): string {
  return projectId !== null && projectId.length > 0
    ? appWsProjectTopicId(userId, projectId)
    : appWsTopicId(userId)
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

/**
 * ISSUES #40 — detect the browser/OS IANA timezone
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`, e.g. `America/New_York`)
 * so the gateway can persist it and the daily nudge keys the owner's local day
 * on THEIR zone. Guarded: returns `null` if `Intl` is unavailable or resolves no
 * zone, so the connect path simply omits `tz` and the server keeps its default.
 */
export function detectClientTimezone(
  resolve: () => string | undefined = () =>
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  try {
    const tz = resolve()
    return typeof tz === 'string' && tz.length > 0 ? tz : null
  } catch {
    return null
  }
}

/** Build the app-ws WebSocket URL for a host + token (+ optional project +
 *  optional device id for receipt attribution + optional IANA timezone). */
export function buildWsUrl(
  protocol: string,
  host: string,
  token: string,
  projectId: string | null,
  deviceId?: string,
  timeZone?: string | null,
): string {
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams()
  params.set('platform', 'web')
  params.set('token', token)
  if (projectId !== null && projectId.length > 0) params.set('project_id', projectId)
  if (deviceId !== undefined && deviceId.length > 0) params.set('device_id', deviceId)
  // ISSUES #40 — ride the owner's IANA zone on the existing connect query string
  // (alongside platform/device_id). The gateway validates + de-dupes it, so a
  // reconnect reporting the same zone is a server-side no-op.
  if (timeZone !== undefined && timeZone !== null && timeZone.length > 0) {
    params.set('tz', timeZone)
  }
  return `${scheme}//${host}/ws/app/chat?${params.toString()}`
}

/**
 * The per-scope socket URL FACTORY the controller calls for EVERY connect —
 * the initial open, a project switch, and a reconnect (`main.tsx` `wsUrlFor`
 * delegates here). Honors an explicit `wsUrlOverride` (dev/test single fixed
 * socket) verbatim; otherwise derives the URL from the resolved config, carrying
 * `token` / `device_id` AND — ISSUES #40 — the boot-detected IANA `tz`, so every
 * reconnect keeps reporting the owner's zone (not just the first bootstrap URL).
 */
export function wsUrlForScope(config: BootstrapConfig, projectId: string | null): string {
  if (config.wsUrlOverride !== undefined) return config.wsUrlOverride
  const u = new URL(config.origin)
  return buildWsUrl(
    u.protocol,
    u.host,
    config.token,
    projectId,
    config.deviceId,
    config.timeZone ?? null,
  )
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
  // ISSUES #40 — detect the owner's IANA zone ONCE and reuse it for every
  // per-scope socket URL the controller later rebuilds (`main.tsx` `wsUrlFor`),
  // so a project switch never drops the `tz`.
  const timeZone = detectClientTimezone()
  const wsUrl =
    win.__neutron_app_ws_url ??
    buildWsUrl(
      win.location.protocol,
      win.location.host,
      appWsToken,
      projectId,
      deviceId,
      timeZone,
    )
  const origin = `${win.location.protocol}//${win.location.host}`
  const config: BootstrapConfig = {
    wsUrl,
    topicId: appWsTopicId(userId),
    userId,
    projectId,
    projects,
    origin,
    deviceId,
    timeZone,
    token: appWsToken,
    onboardingActive: win.__neutron_onboarding_active === true,
  }
  if (win.__neutron_app_ws_url !== undefined) config.wsUrlOverride = win.__neutron_app_ws_url
  // Managed-overlay claim redirect target — set ONLY when the server injected a
  // non-empty URL. Absent ⇒ the controller's redirect no-ops (Open self-host).
  if (
    typeof win.__neutron_post_onboarding_claim_url === 'string' &&
    win.__neutron_post_onboarding_claim_url.length > 0
  ) {
    config.postOnboardingClaimUrl = win.__neutron_post_onboarding_claim_url
  }
  // Doc-link deep-link 404 fix — recover the doc target from the boot URL when
  // the SPA was hard-loaded at a `/projects/<id>/docs?path=…` deep link (the
  // gateway's SPA catch-all served the shell). Set ONLY when the current URL is
  // a valid project doc link; a normal `/chat` boot leaves it undefined.
  const initialDocLink = initialDocLinkFromLocation(
    win.location.pathname,
    win.location.search,
    origin,
  )
  if (initialDocLink !== null) config.initialDocLink = initialDocLink
  return config
}
