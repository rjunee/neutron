/**
 * @neutronai/app — runtime config (P5.0 rewrite).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 5.3:
 *
 *   `loadAppConfig()` returns `{ auth_base_url, gateway_base_url,
 *    ws_base_url }` resolved from `Constants.expoConfig.extra` with
 *   sensible dev defaults.
 *
 * The legacy single `base_url` field is retained for back-compat —
 * P5.1+ chat surface, P5.6 push, and the docs client all read it.
 * Both shapes resolve from the same `extra.neutron_base_url` key, so
 * the local dev story stays "set one URL and everything points at
 * the same dev gateway."
 */

import Constants from 'expo-constants';

const DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:8080';
// No hosted default — the auth base is operator-configured via
// `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL` (or `extra.neutron_auth_base_url`).
// When unset it resolves to '' and the OAuth affordance is simply absent.
const DEFAULT_AUTH_BASE = '';

export interface NeutronAppConfig {
  /**
   * Per-instance gateway base URL (HTTP). Chat, focus, tasks,
   * reminders, docs, admin, push all point at this. The WS URL is
   * derived from this via `httpToWs`.
   */
  base_url: string;
  /**
   * Alias for `base_url` — explicit name per the P5.0 brief. Equal to
   * `base_url` by design (single dev gateway = single URL).
   */
  gateway_base_url: string;
  /**
   * Identity service base URL — where the OAuth handoff lands and the
   * install-token exchange happens. NOT per-instance; operator-configured
   * via `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL`. Empty when unset.
   */
  auth_base_url: string;
  /**
   * WS-scheme variant of the gateway base URL, e.g.
   * `ws://127.0.0.1:8080`. Pre-computed so the chat surface doesn't
   * have to re-derive it on every reconnect.
   */
  ws_base_url: string;
  /**
   * Telegram-parity hint on the chat screen subtitle. P5.1 leaves
   * this on by default.
   */
  show_telegram_parity_hint: boolean;
}

export function loadAppConfig(): NeutronAppConfig {
  const extra = (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ?? {};
  const fromExtraGateway =
    typeof extra['neutron_base_url'] === 'string' ? (extra['neutron_base_url'] as string) : null;
  const fromEnvGateway =
    typeof process !== 'undefined' && process.env !== undefined
      ? process.env.EXPO_PUBLIC_NEUTRON_BASE_URL
      : undefined;
  const gatewayBase = (fromExtraGateway ?? fromEnvGateway ?? DEFAULT_GATEWAY_BASE).replace(/\/+$/, '');

  const fromExtraAuth =
    typeof extra['neutron_auth_base_url'] === 'string'
      ? (extra['neutron_auth_base_url'] as string)
      : null;
  const fromEnvAuth =
    typeof process !== 'undefined' && process.env !== undefined
      ? process.env.EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL
      : undefined;
  const authBase = (fromExtraAuth ?? fromEnvAuth ?? DEFAULT_AUTH_BASE).replace(/\/+$/, '');

  return {
    base_url: gatewayBase,
    gateway_base_url: gatewayBase,
    auth_base_url: authBase,
    ws_base_url: httpToWs(gatewayBase),
    show_telegram_parity_hint: extra['hide_telegram_parity_hint'] !== true,
  };
}

export function httpToWs(base_url: string): string {
  if (base_url.startsWith('http://')) return 'ws://' + base_url.slice('http://'.length);
  if (base_url.startsWith('https://')) return 'wss://' + base_url.slice('https://'.length);
  return base_url;
}
