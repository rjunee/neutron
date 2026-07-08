/**
 * @neutronai/contracts — handoff config constants (L2 leaf).
 *
 * L2 (2026-07) — `MOBILE_APP_URL` + `TELEGRAM_BIND_TOKEN_TTL_MS` (and the
 * private `WEB_APP_BASE` helper `MOBILE_APP_URL` derives from) extracted
 * VERBATIM out of `onboarding/interview/final-handoff-config.ts` into this
 * node-free leaf (critic-layering.md §2.1 edges #7 `landing → onboarding`
 * and #9 `cores/free/agent-settings → onboarding`). `landing/server.ts` and
 * `cores/free/agent-settings/src/backend.ts` now import directly from here;
 * `final-handoff-config.ts` keeps a re-export so any other existing import
 * specifier stays valid (test-policy §2.2 barrel rule). The Telegram
 * bot-username / deep-link-building helpers below them in that file are
 * untouched and stay in `onboarding` (they're behavior, not stranded
 * contracts).
 *
 * Preserves the ORIGINAL load-order semantics: `WEB_APP_BASE` reads
 * `process.env.NEUTRON_WEB_APP_BASE` once, at module load, exactly as it did
 * at the old site — only WHERE that read happens moved, not WHEN.
 */

/**
 * Web app base host, env-configured with NO default. On a self-hosted
 * Open install the operator sets `NEUTRON_WEB_APP_BASE` to their web-app
 * origin; when unset it is the empty string and any web-app affordance is
 * absent (Open is local-first).
 */
const WEB_APP_BASE = (process.env.NEUTRON_WEB_APP_BASE ?? '').replace(/\/+$/, '')

/**
 * The mobile install/landing page (`landing/mobile.html`, served at
 * `/mobile` by `landing/server.ts` on the configured web-app + per-instance
 * surfaces). Native apps are not published yet — the page gives honest
 * Add-to-Home-Screen instructions and coming-soon store placeholders
 * (`landing/mobile-install-config.ts`). Derived from `NEUTRON_WEB_APP_BASE`:
 * empty string when the host is not configured (no hosted default).
 */
export const MOBILE_APP_URL = WEB_APP_BASE ? `${WEB_APP_BASE}/mobile` : ''

/**
 * TTL for a freshly-minted Telegram-bind token. The brief calls for 1
 * hour so a user who taps the `[B] Connect a Telegram bot` button has
 * comfortable headroom to follow the deep link (open Telegram, hit
 * "Start", land at the bot). The bot-side `/start bind:<token>` handler
 * is a follow-up sprint — see ISSUES.md.
 */
export const TELEGRAM_BIND_TOKEN_TTL_MS = 60 * 60 * 1_000
