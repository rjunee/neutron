/**
 * @neutronai/app — native push notifications (P5.6).
 *
 * Bridges the Expo client's `expo-notifications` module to the
 * gateway's `/api/app/devices/(register|unregister)` surface
 * (`devices-client.ts`). The login flow calls `enablePushForUser`
 * once after a successful sign-in; sign-out calls
 * `disablePushForUser` to revoke the device-instance binding.
 *
 * Platform behaviour:
 *   * iOS / Android (managed Expo workflow) — `getDevicePushTokenAsync`
 *     returns an `ExponentPushToken[...]` string; permission is
 *     requested at first call. A default in-foreground notification
 *     handler is set so the user sees the banner even when the app
 *     is open.
 *   * Web — the Expo push token API is not supported in the browser
 *     today; calling into this module is a graceful no-op (returns
 *     `{ skipped: true, reason: 'unsupported_platform' }`). Web push
 *     via service workers is reserved for a follow-up sprint.
 *   * Permission denied — also a graceful no-op. The user can opt in
 *     later via Settings (out of scope for v1).
 *
 * Per SPEC.md § Phases→Steps / P5.6 and
 * docs/engineering-plan.md § B.P5.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import { DevicesClient, type DevicePlatform } from './devices-client';
import { resolvePushRoute, type PushPayload } from './push-deep-link-dispatch';
import {
  pushTapDedupeStore,
  type PushTapDedupeStore,
} from './push-tap-dedupe-store';

export type PushEnableSkipReason =
  | 'unsupported_platform'
  | 'permission_denied'
  | 'no_project_id'
  | 'token_error';

export type PushEnableResult =
  | { ok: true; device_token: string; platform: DevicePlatform }
  | { ok: false; skipped: true; reason: PushEnableSkipReason; detail?: string };

/**
 * Returns true iff the runtime can request push permissions and mint a
 * native push token. Web is excluded — web push lands separately.
 */
export function isPushSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/**
 * Configure the in-foreground handler so the user sees the
 * notification even when the app is open. Expo's default is to
 * suppress in-foreground banners. Idempotent — re-setting is harmless.
 */
let foregroundHandlerInstalled = false;
export function installForegroundNotificationHandler(): void {
  if (foregroundHandlerInstalled) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
  foregroundHandlerInstalled = true;
}

/**
 * Request push permission + mint an Expo push token. Web returns
 * `{ skipped: true, reason: 'unsupported_platform' }` so the caller
 * doesn't have to branch on Platform.OS.
 *
 * Errors from `getExpoPushTokenAsync` (no projectId, EAS misconfig)
 * surface as a `{ skipped: true, reason: 'token_error' }` result
 * rather than throwing, so login + push registration cannot wedge
 * the auth flow.
 */
export async function getExpoPushTokenForDevice(): Promise<PushEnableResult> {
  if (!isPushSupported()) {
    return { ok: false, skipped: true, reason: 'unsupported_platform' };
  }
  // Permission gate. Expo collapses status to one of granted /
  // denied / undetermined.
  const perm = await Notifications.getPermissionsAsync();
  let status = perm.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') {
    return { ok: false, skipped: true, reason: 'permission_denied' };
  }
  // ProjectId comes from app.json `expo.extra.eas.projectId` (or the
  // newer `expo.eas.projectId` shape Expo SDK 49+ exposes). For dev
  // builds without EAS configured Expo falls back to a project-less
  // mode that still mints tokens; we only treat missing projectId as
  // an error when Expo itself throws.
  const projectId = resolveProjectId();
  try {
    const tokenInput: Parameters<typeof Notifications.getExpoPushTokenAsync>[0] =
      projectId !== null ? { projectId } : undefined;
    const tokenResult = await Notifications.getExpoPushTokenAsync(tokenInput);
    return {
      ok: true,
      device_token: tokenResult.data,
      platform: Platform.OS as DevicePlatform,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/projectId/i.test(detail)) {
      return { ok: false, skipped: true, reason: 'no_project_id', detail };
    }
    return { ok: false, skipped: true, reason: 'token_error', detail };
  }
}

/**
 * End-to-end enable: mint the token + POST it to the gateway. Wraps
 * the two steps so the login screen only has to call one function.
 *
 * Returns the gateway's confirmed registration result OR a skip
 * record. Never throws — every failure (permission denied, network,
 * Expo error) is surfaced as `{ skipped: true, ... }` so login flows
 * stay healthy when push is unavailable.
 */
export async function enablePushForUser(input: {
  base_url: string;
  token: string;
}): Promise<PushEnableResult & { registered?: boolean }> {
  const local = await getExpoPushTokenForDevice();
  if (!local.ok) return local;
  // Foreground handler only needs to install once a device has any
  // chance of receiving a notification, so we defer it until past the
  // permission gate.
  installForegroundNotificationHandler();
  const client = new DevicesClient({ base_url: input.base_url, token: input.token });
  try {
    await client.registerToken(local.device_token, local.platform);
    return { ...local, registered: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      skipped: true,
      reason: 'token_error',
      detail: `gateway register failed: ${detail}`,
    };
  }
}

/**
 * Mirror of `enablePushForUser` — looks up the current device token
 * and POSTs `unregister`. Best-effort: silent on failure so sign-out
 * is never blocked by a push outage.
 */
export async function disablePushForUser(input: {
  base_url: string;
  token: string;
}): Promise<void> {
  if (!isPushSupported()) return;
  let device_token: string | null = null;
  try {
    const result = await getExpoPushTokenForDevice();
    if (result.ok) device_token = result.device_token;
  } catch {
    // If we can't even mint a token we definitely can't unregister it.
    return;
  }
  if (device_token === null) return;
  const client = new DevicesClient({ base_url: input.base_url, token: input.token });
  try {
    await client.unregisterToken(device_token);
  } catch {
    // best-effort — the gateway's row may have been pruned already
  }
}

/**
 * Push tap deep-link handler (2026-05-22 push-deeplink-wow sprint).
 *
 * Subscribes to `Notifications.addNotificationResponseReceivedListener`
 * AND consults `getLastNotificationResponseAsync()` for cold-start
 * taps. Each response's `request.content.data` is parsed by
 * `resolvePushRoute(...)`; a non-null path drives the supplied
 * router-push callback exactly once.
 *
 * Lifecycle:
 *   - install once at app boot (typically from `_layout.tsx`).
 *   - The returned `remove()` tears down the subscription; the
 *     listener is automatically a no-op on web / unsupported platforms
 *     (the brief explicitly defers web push) so the caller never has
 *     to branch on Platform.OS.
 *   - Cold-start taps fire AT MOST ONCE per response identifier —
 *     Expo's `getLastNotificationResponseAsync` keeps returning the
 *     SAME last response on every later launch until explicitly
 *     cleared. (Codex r1 P2 + Argus r1 I2 round 2 — replaying a stale
 *     tap on a normal app open is the failure mode this dedupe blocks.)
 *
 * Dedupe substrate (Argus r1 I2 — 2026-05-22 round 2 follow-up):
 *   - Backed by `PushTapDedupeStore` (`./push-tap-dedupe-store.ts`)
 *     which persists seen identifiers to AsyncStorage on native with
 *     a 7-day TTL. Round 1 used an unbacked module-level Set, which
 *     wiped on force-quit + relaunch and replayed the same cold-start
 *     tap on every subsequent launch until a newer push arrived.
 *   - Hydration is fired at install. The cold-start dispatch path
 *     AWAITS hydration so a same-launch cold-start sees the persisted
 *     set; the warm-tap path does NOT await (the user-initiated tap
 *     is already racing against itself in-memory).
 *   - Belt-and-braces: every routed cold-start response is dismissed
 *     via `Notifications.dismissNotificationAsync(notificationId)` so
 *     Expo itself stops re-surfacing it from
 *     `getLastNotificationResponseAsync()` — defense in depth on top
 *     of the persisted set.
 *
 * Errors:
 *   - `getLastNotificationResponseAsync` failure → swallowed (logged
 *     by Expo); the warm listener still installs.
 *   - `resolvePushRoute` returning null → no push fires; a structured
 *     warn lands via the helper's logger.
 *   - Dedupe-store hydrate / persist failure → in-memory set still
 *     dedupes for this launch; the next force-quit-relaunch may
 *     replay (degraded mode, not crashing).
 *
 * Failure-safe: any throw in the user-supplied `push(...)` callback
 * propagates to the listener's microtask, which Expo catches and
 * logs. The handler never wedges the app even on a bad payload.
 */
export interface InstallPushTapHandlerOpts {
  /**
   * Optional injection for the persistent dedupe store. Defaults to
   * the process-wide `pushTapDedupeStore()` (AsyncStorage on native,
   * `localStorage` on web). Tests pass a stub store with an in-
   * memory backing.
   */
  dedupeStore?: PushTapDedupeStore;
}

export function installPushTapHandler(
  push: (path: string) => void,
  opts: InstallPushTapHandlerOpts = {},
): {
  remove: () => void;
} {
  if (!isPushSupported()) {
    return { remove: (): void => undefined };
  }
  const store = opts.dedupeStore ?? pushTapDedupeStore();
  // Kick off hydration immediately. The cold-start branch below
  // awaits this so a stale `getLastNotificationResponseAsync` payload
  // from a prior launch can be deduped before we dispatch.
  const hydrated = store.hydrate();

  // Dispatch helper — dedupes by request.identifier so the same
  // notification can't drive `push()` twice (Codex r1 P2 + Argus r1
  // I2 round 2). Cold-start + warm listener share the same store;
  // every routed cold-start response is also dismissed via
  // `dismissNotificationAsync` so Expo itself stops re-surfacing it
  // on a future cold-start before the TTL prunes the persisted id.
  // A missing/empty identifier (defensive — Expo always supplies one
  // per `NotificationRequest`) routes once and is never re-seen
  // because there's nothing to remember.
  const dispatch = (
    response: import('expo-notifications').NotificationResponse,
    opts: { dismiss: boolean },
  ): void => {
    const id = response.notification.request.identifier;
    if (typeof id === 'string' && id.length > 0) {
      if (store.has(id)) return;
      // Fire-and-forget persist — the in-memory `has` check above
      // already deduped the current dispatch synchronously. The
      // markSeen await is only material for the post-launch persisted
      // round.
      void store.markSeen(id);
      if (opts.dismiss) {
        // Belt-and-braces: clear the OS notification so Expo's
        // `getLastNotificationResponseAsync` stops returning it on
        // future cold-starts before the persisted TTL prunes. Best-
        // effort — a missing API or a denied dismiss never blocks
        // the route.
        Notifications.dismissNotificationAsync(id).catch(() => undefined);
      }
    }
    const path = resolvePushRoute(
      (response.notification.request.content.data ?? {}) as PushPayload,
    );
    if (path !== null) push(path);
  };

  // Cold-start: the OS opened the app from a notification tap. Expo
  // surfaces the response on `getLastNotificationResponseAsync()` —
  // returns null when the app opened without a notification. Note:
  // this keeps returning the SAME last response on later launches
  // until the response is consumed or dismissed; the persisted
  // dedupe store + the per-response dismiss together make the
  // second-launch-replay safe.
  hydrated
    .then(() => Notifications.getLastNotificationResponseAsync())
    .then((response) => {
      if (response === null) return;
      dispatch(response, { dismiss: true });
    })
    .catch(() => undefined);
  // Warm tap: app was already foreground/backgrounded and the user
  // tapped a notification. `addNotificationResponseReceivedListener`
  // fires synchronously on tap.
  const sub = Notifications.addNotificationResponseReceivedListener(
    (response) => dispatch(response, { dismiss: false }),
  );
  return { remove: (): void => sub.remove() };
}

/**
 * Test-only seam — clears the in-process dedupe set so consecutive
 * `installPushTapHandler` invocations in a test suite don't bleed
 * state across cases. Exposed so the bun-test suite's `beforeEach`
 * can reset between tests; not part of the production runtime
 * contract.
 *
 * Argus r1 I2 round 2: now also resets the singleton persistent
 * dedupe store so tests that exercise the persisted-set path don't
 * leak the prior test's seen identifiers.
 */
export function __resetPushTapDedupeForTesting(): void {
  void pushTapDedupeStore().reset();
}

function resolveProjectId(): string | null {
  // Expo SDK 49+ exposes `expo.extra.eas.projectId` via Constants.expoConfig.
  const extra = (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ?? {};
  const eas = extra['eas'] as { projectId?: unknown } | undefined;
  if (eas !== undefined && typeof eas.projectId === 'string' && eas.projectId.length > 0) {
    return eas.projectId;
  }
  // Some older shapes put it directly under `extra.projectId`.
  if (typeof extra['projectId'] === 'string' && (extra['projectId'] as string).length > 0) {
    return extra['projectId'] as string;
  }
  // EAS-built standalone apps expose the id on Constants.easConfig when
  // expoConfig is absent (e.g. release / OTA-update environments).
  // Without this fallback, getExpoPushTokenAsync silently degrades to
  // no_project_id / token_error in production builds.
  const easCfg = Constants.easConfig as { projectId?: unknown } | null | undefined;
  if (
    easCfg !== null &&
    easCfg !== undefined &&
    typeof easCfg.projectId === 'string' &&
    easCfg.projectId.length > 0
  ) {
    return easCfg.projectId;
  }
  return null;
}
