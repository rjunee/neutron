/**
 * @neutronai/app — runtime config (P5.0 rewrite; ISSUES #385 server URL).
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
 *
 * ISSUES #385 — THERE IS NO LONGER A LOOPBACK DEFAULT. The old
 * `DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:8080'` meant every build
 * that didn't set a build-time URL (i.e. every build ever shipped, since
 * `app/eas.json` had no `env` block) resolved to the PHONE itself, so
 * every request failed silently. An unconfigured app now reports
 * `gateway_base_url: ''` + `configured: false`, and the root layout
 * renders the first-run "Connect to your Neutron" gate instead of the
 * app tree.
 *
 * SYNCHRONOUS BY DESIGN. `loadAppConfig()` is called from ~20 call
 * sites, most inside `useMemo` (e.g. `app/app/admin.tsx:84`,
 * `app/app/integrations.tsx:55`, `app/components/ChatSyncSurface.tsx:92`).
 * Making it async would mean refactoring all of them, so the persisted
 * runtime value is hydrated ONCE at boot into a module-level cache via
 * `hydrateServerConfig()` (awaited by `app/app/_layout.tsx` before the
 * app tree renders) and `loadAppConfig()` stays sync.
 *
 * The env tier below MUST use literal `process.env.EXPO_PUBLIC_*` member
 * reads — see the comment in `resolveBases()`; aliasing them defeats
 * Expo's static inlining and silently disables build-time configuration.
 */

import Constants from 'expo-constants';

import { resolveServerBases, type ResolvedServerBases } from './server-url';
import {
  EMPTY_SERVER_CONFIG,
  tokenStorage,
  type PersistedServerConfig,
} from './token-storage';

export interface NeutronAppConfig {
  /**
   * Per-instance gateway base URL (HTTP). Chat, focus, tasks,
   * reminders, docs, admin, push all point at this. The WS URL is
   * derived from this via `httpToWs`. EMPTY when unconfigured — check
   * `configured` before using it.
   */
  base_url: string;
  /**
   * Alias for `base_url` — explicit name per the P5.0 brief. Equal to
   * `base_url` by design (single dev gateway = single URL).
   */
  gateway_base_url: string;
  /**
   * Identity service base URL — where the OAuth handoff lands and the
   * install-token exchange happens. NOT per-instance; set either in-app
   * or via `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL`. Empty when unset, in
   * which case the OAuth affordance is simply absent.
   */
  auth_base_url: string;
  /**
   * WS-scheme variant of the gateway base URL, e.g.
   * `wss://neutron.example.com`. Pre-computed so the chat surface
   * doesn't have to re-derive it on every reconnect. Empty when
   * unconfigured.
   */
  ws_base_url: string;
  /**
   * Telegram-parity hint on the chat screen subtitle. P5.1 leaves
   * this on by default.
   */
  show_telegram_parity_hint: boolean;
  /**
   * `false` until a server URL exists from SOME source. The root layout
   * gates the app tree on this (ISSUES #385) — no request should ever
   * be issued against an unconfigured install.
   */
  configured: boolean;
}

/**
 * Module-level cache of the persisted runtime server config. Populated
 * exactly once per app launch by `hydrateServerConfig()`; mutated by
 * `setRuntimeServerConfig()` when the owner changes the server in-app.
 */
let runtimeServerConfig: PersistedServerConfig = EMPTY_SERVER_CONFIG;
let runtimeServerHydrated = false;
/**
 * Bumped on every `setRuntimeServerConfig`. `loadAppConfig()` is frozen
 * for a component's lifetime at ~10 `useMemo(() => loadAppConfig(), [])`
 * call sites (`app/components/ChatSyncSurface.tsx:92`,
 * `app/lib/chat-core/use-mobile-chat.ts:94`,
 * `app/app/projects/[id]/_layout.tsx:120`, `app/app/admin.tsx:84`,
 * `app/app/integrations.tsx:55`, `app/app/cores/[slug].tsx:48`,
 * `app/app/projects/[id]/{settings,docs,workboard,backups}.tsx`), so
 * mutating the cache alone left ALREADY-MOUNTED screens issuing HTTP +
 * WS at the OLD host after a server change (Argus r2 MAJOR).
 * `app/app/_layout.tsx` subscribes and keys the whole app tree on this
 * epoch, so a change REMOUNTS every screen and every `useMemo` re-reads.
 */
let runtimeServerEpoch = 0;
const serverConfigListeners = new Set<() => void>();

/** `true` once `hydrateServerConfig()` has resolved (success OR failure). */
export function isServerConfigHydrated(): boolean {
  return runtimeServerHydrated;
}

/** The cached persisted values. Exposed for the Settings editor + tests. */
export function getRuntimeServerConfig(): PersistedServerConfig {
  return runtimeServerConfig;
}

/**
 * Read the persisted server config into the module cache. MUST be
 * awaited before the app tree renders — see `app/app/_layout.tsx`.
 * Never throws: a storage failure leaves the app unconfigured, which holds
 * the owner on `/login` rather than producing a silent broken state.
 */
export async function hydrateServerConfig(storage?: {
  getServerConfig(): Promise<PersistedServerConfig>;
}): Promise<PersistedServerConfig> {
  try {
    const store = storage ?? tokenStorage();
    runtimeServerConfig = await store.getServerConfig();
  } catch (err) {
    console.warn('[config] server-config hydrate failed:', err);
    runtimeServerConfig = EMPTY_SERVER_CONFIG;
  } finally {
    runtimeServerHydrated = true;
  }
  return runtimeServerConfig;
}

/**
 * Monotonic counter identifying the CURRENT server configuration. The
 * root layout uses it as a React `key` so the app tree is torn down and
 * rebuilt whenever the server changes.
 */
export function getServerConfigEpoch(): number {
  return runtimeServerEpoch;
}

/**
 * Subscribe to server-config changes. Returns the unsubscribe function.
 * Sole consumer is the root layout (`app/app/_layout.tsx`).
 */
export function subscribeServerConfig(listener: () => void): () => void {
  serverConfigListeners.add(listener);
  return (): void => {
    serverConfigListeners.delete(listener);
  };
}

/**
 * Update the cache after a successful persist so every subsequent
 * synchronous `loadAppConfig()` sees the new server immediately, bump
 * the epoch, and notify subscribers so mounted screens are rebuilt
 * against the new host instead of retaining the old one.
 */
export function setRuntimeServerConfig(config: PersistedServerConfig): void {
  runtimeServerConfig = config;
  runtimeServerHydrated = true;
  runtimeServerEpoch += 1;
  // Snapshot: a listener may unsubscribe (unmount) during notification.
  for (const listener of [...serverConfigListeners]) {
    try {
      listener();
    } catch (err) {
      console.warn('[config] server-config listener threw:', err);
    }
  }
}

/**
 * Test-only — wipe the cache so each test starts unconfigured. Exercised
 * by `app/__tests__/server-config-wiring.test.ts`, which virtualizes
 * `expo-constants` so this module (and therefore the real
 * hydrate → cache → `loadAppConfig()` wiring) is importable under
 * `bun test`.
 */
export function __resetServerConfigForTests(): void {
  runtimeServerConfig = EMPTY_SERVER_CONFIG;
  runtimeServerHydrated = false;
  runtimeServerEpoch = 0;
  serverConfigListeners.clear();
}

/**
 * Resolve the effective bases. Precedence (per field):
 * persisted runtime > `extra.neutron_*` > `EXPO_PUBLIC_NEUTRON_*` >
 * unconfigured. Pure logic lives in `lib/server-url.ts`.
 */
function resolveBases(): ResolvedServerBases {
  const extra = (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ?? {};
  return resolveServerBases({
    persisted: runtimeServerConfig,
    extra: {
      gateway_base_url: extra['neutron_base_url'],
      auth_base_url: extra['neutron_auth_base_url'],
    },
    // MUST stay a literal `process.env.<NAME>` member expression.
    // `babel-preset-expo`'s inline-env-vars plugin only rewrites
    // `EXPO_PUBLIC_*` reads whose object is literally `process.env`
    // (`isProcessEnv`: `t.isMemberExpression(object) && object.object.name
    // === 'process'`), so hoisting that object into a local variable first
    // and reading the name off the alias silently kills the whole tier: no
    // inlining in a production build and no `expo/virtual/env` rewrite in
    // dev, i.e. `eas env:create EXPO_PUBLIC_NEUTRON_BASE_URL=…` and a
    // local `.env` both become no-ops (Argus r1 BLOCKER). Expo's docs are
    // explicit: env vars must be "statically referenced as a property of
    // process.env using dot notation". Do NOT destructure, alias, or
    // guard-wrap these two reads.
    env: {
      gateway_base_url: process.env.EXPO_PUBLIC_NEUTRON_BASE_URL,
      auth_base_url: process.env.EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL,
    },
  });
}

export function loadAppConfig(): NeutronAppConfig {
  const extra = (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ?? {};
  const bases = resolveBases();
  return {
    base_url: bases.gateway_base_url,
    gateway_base_url: bases.gateway_base_url,
    auth_base_url: bases.auth_base_url,
    ws_base_url: httpToWs(bases.gateway_base_url),
    show_telegram_parity_hint: extra['hide_telegram_parity_hint'] !== true,
    configured: bases.configured,
  };
}

export function httpToWs(base_url: string): string {
  if (base_url.startsWith('http://')) return 'ws://' + base_url.slice('http://'.length);
  if (base_url.startsWith('https://')) return 'wss://' + base_url.slice('https://'.length);
  return base_url;
}
