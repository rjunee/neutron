/**
 * @neutronai/onboarding — final-handoff configuration constants.
 *
 * Single source of truth for the post-onboarding handoff message
 * (3-button + freeform prompt the user sees in the General topic after
 * `wow_fired → completed`). Per the 2026-05-28 sprint brief:
 *
 *   - `MOBILE_APP_URL` — the mobile install/landing page. ISSUES #208
 *     (2026-06-11): the URL resolves to the `/mobile` page served by
 *     `landing/server.ts` (the configured web-app host is fronted by the
 *     signup-landing process, which delegates to the same route table) —
 *     the prior doc claimed a marketing-site 302 that never existed and
 *     the link 404'd in every delivered handoff message. The page walks
 *     the user through the install path that exists today (phone-browser
 *     Add to Home Screen) and renders native-store links from
 *     `landing/mobile-install-config.ts` (coming-soon placeholders until
 *     the store URLs are filled in). The host is env-configured
 *     (`NEUTRON_WEB_APP_BASE`) with NO default: on a self-hosted Open
 *     install that hasn't set it, `MOBILE_APP_URL` is the empty string and
 *     the mobile-app affordance is simply absent. `landing/server.ts`
 *     re-exports the constant so the landing surface references it without
 *     duplicating the derivation; `landing/__tests__/mobile-route.test.ts`
 *     couples the constant's path to a live route so it can never silently
 *     404 again.
 *
 *   - `DEFAULT_TELEGRAM_BOT_USERNAME` — fallback bot handle for the
 *     `t.me/<bot>?start=bind:<token>` deep link. Production composer
 *     resolves the live value from the `NEUTRON_TELEGRAM_BOT_USERNAME`
 *     env via `resolveTelegramBotUsername()` below; the default keeps
 *     tests + dev deploys functional without env wiring.
 *
 *   - `TELEGRAM_BIND_TOKEN_TTL_MS` — 1-hour validity window per spec.
 *
 * Argus-check: every reference to the mobile-app URL in the prompt
 * builders + landing surface imports `MOBILE_APP_URL` from the canonical
 * derivation — the URL is derived from `NEUTRON_WEB_APP_BASE` in exactly
 * one place (`../../contracts/handoff-config.ts` since L2; this file
 * re-exports it), never typed out as a literal elsewhere.
 *
 * L2 (2026-07) — `MOBILE_APP_URL` + `TELEGRAM_BIND_TOKEN_TTL_MS` (and the
 * private `WEB_APP_BASE` helper) moved to `../../contracts/handoff-config.ts`
 * (a node-free leaf — critic-layering.md §2.1 edges #7 `landing → onboarding`
 * and #9 `cores/free/agent-settings → onboarding`); `landing/server.ts` and
 * `cores/free/agent-settings/src/backend.ts` now import directly from there.
 * Re-exported below so any other existing import specifier stays valid.
 */

export { MOBILE_APP_URL, TELEGRAM_BIND_TOKEN_TTL_MS } from '@neutronai/contracts/handoff-config.ts'

/**
 * Fallback Telegram bot username (without `@`). Production sets
 * `NEUTRON_TELEGRAM_BOT_USERNAME` and `resolveTelegramBotUsername()`
 * reads it. The default is the canonical Nova-handoff bot handle so
 * dev/test runs render a non-empty `t.me/...` URL.
 */
export const DEFAULT_TELEGRAM_BOT_USERNAME = 'neutron_assistant_bot'

/**
 * Resolve the Telegram bot username from env, falling back to the
 * default. Trimmed + `@`-stripped so a misconfigured value like
 * `@my_bot ` still renders correctly.
 */
export function resolveTelegramBotUsername(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.NEUTRON_TELEGRAM_BOT_USERNAME
  if (typeof raw !== 'string') return DEFAULT_TELEGRAM_BOT_USERNAME
  const cleaned = raw.trim().replace(/^@/, '')
  if (cleaned.length === 0) return DEFAULT_TELEGRAM_BOT_USERNAME
  return cleaned
}

/**
 * Build the Telegram bot deep-link URL the engine surfaces in the
 * `[B] Connect a Telegram bot` follow-up. Centralised so the URL shape
 * lives in one place + tests assert against THIS helper rather than the
 * literal string.
 *
 * Codex review fix (2026-05-28): Telegram restricts the `start` payload
 * grammar to `[A-Za-z0-9_-]` (max 64 chars) per the Bot API contract — a
 * colon (`bind:<token>`) or other JWT-typical punctuation would silently
 * break the bind handshake on the bot side. We use `bind_<token>` so the
 * payload stays inside Telegram's grammar AND matches the existing
 * `onboard_<correlator>` shape the first-signin deep link already uses
 * (`provisioning/sign-in-trigger.ts`). The bot-side
 * `/start bind_<token>` consumer (open ISSUE #65) splits on the first
 * `_` to extract the purpose + token.
 *
 * NOTE: production `mintTelegramBindToken` MUST return a URL-safe
 * `[A-Za-z0-9_-]` string ≤ 58 chars (64 minus the 6-char `bind_` prefix)
 * so the concatenated payload stays inside Telegram's cap. A bare JWT
 * (which carries dots / pluses / equals) is NOT acceptable here even
 * though it WAS suggested in the original sprint brief — the production
 * minter must wrap the JWT (e.g. via base64url + chunked storage with
 * a short opaque handle returned in its place) or use a different
 * token shape entirely. The fallback nonce inside the engine already
 * conforms to this grammar.
 */
export const TELEGRAM_BIND_START_PAYLOAD_PREFIX = 'bind_'

/** Maximum total length of the `start` payload Telegram will deliver. */
export const TELEGRAM_START_PAYLOAD_MAX_LEN = 64

/** Allowed character class for a Telegram `start` payload. */
export const TELEGRAM_START_PAYLOAD_GRAMMAR = /^[A-Za-z0-9_-]+$/

export function buildTelegramBindDeepLink(input: {
  bot_username: string
  bind_token: string
}): string {
  return `https://t.me/${input.bot_username}?start=${TELEGRAM_BIND_START_PAYLOAD_PREFIX}${input.bind_token}`
}
