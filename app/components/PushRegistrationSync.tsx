/**
 * @neutronai/app — keep the device's push registration ALIVE (ISSUES #487).
 *
 * Registration used to happen at exactly one moment: a successful sign-in
 * (`app/app/login.tsx` — `tryEnablePush` at `:228` and `:352`). Nothing ever
 * re-registered. A session persists across launches for weeks, so on a device
 * that signed in once and stayed signed in, the register endpoint is never
 * called again — and if the row is missing or the Expo token has rotated, push
 * is dead until the owner happens to sign out and back in.
 *
 * That is not hypothetical. Measured on the live instance 2026-08-06:
 * `device_push_tokens` held **0 rows**, and the server journal showed **zero**
 * `devices/register` requests in 14 days. Consequence: every proactive surface
 * — the morning brief, the evening wrap, idle nudges, and a ritual re-approval
 * request — was visible ONLY when the owner happened to open a client. A
 * re-approval request that nobody sees is how the brief and the wrap both
 * silently skipped for 16 hours that day.
 *
 * WHY FOREGROUND AND NOT JUST LAUNCH. The failures this heals have different
 * timing. A missing row is repaired by any single call, so a launch-time pass
 * would cover it. But an Expo token ROTATES while the app stays installed and
 * warm, and notification permission is granted in the OS Settings app — which
 * backgrounds us and foregrounds us again. Re-running on the background→active
 * edge is what makes both self-heal; a launch-only hook would leave a rotated
 * token stale for as long as the app never cold-starts.
 *
 * SAFE TO CALL REPEATEDLY. `POST /api/app/devices/register` upserts on
 * `(project_slug, device_token)` (`gateway/push/store.ts:91-94`), so a
 * foreground that changes nothing costs one request and one `updated_at`.
 * Re-requesting permission is likewise cheap: once the OS holds a decision,
 * `requestPermissionsAsync` resolves from it without showing UI, so this never
 * nags.
 *
 * DELIBERATELY SILENT, NEVER UNOBSERVED. Renders nothing and tells the user
 * nothing — push is a background concern and must not interrupt someone trying
 * to use the app. Every outcome, failures included, is recorded by
 * `enablePushForUser` through `lib/push-observability`, which is the half of
 * #487 that shipped first: the empty table had no trace anywhere of WHY, and
 * that is what kept it invisible for weeks.
 *
 * The decisions live in `lib/push-registration-sync.ts` (no `react-native` /
 * `expo-notifications` imports, so they are reachable from bun test); this file
 * is only the platform shell. Mounted inside `AuthSessionProvider` in
 * `app/app/_layout.tsx`, alongside `DiagnosticsSync`, whose shape it follows.
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { loadAppConfig } from '../lib/config';
import { enablePushForUser } from '../lib/push';
import {
  cameToForeground,
  syncPushRegistration,
  type ForegroundState,
} from '../lib/push-registration-sync';
import { useAuthSession } from '../lib/session';

function asForegroundState(status: AppStateStatus): ForegroundState {
  return status === 'active' || status === 'background' || status === 'inactive'
    ? status
    : 'unknown';
}

export function PushRegistrationSync(): null {
  const { user } = useAuthSession();
  const inFlight = useRef(false);
  const appState = useRef<ForegroundState>(asForegroundState(AppState.currentState));

  useEffect(() => {
    if (user === null) return;
    const config = loadAppConfig();
    if (!config.configured) return;

    const run = (): void => {
      void syncPushRegistration({
        enable: enablePushForUser,
        base_url: config.gateway_base_url,
        token: user.token,
        in_flight: inFlight,
      });
    };

    // The authenticated-launch pass. This is the one that repairs a MISSING row
    // on a device that has been signed in, and not re-signed-in, for weeks.
    run();

    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const to = asForegroundState(next);
      const forward = cameToForeground(appState.current, to);
      appState.current = to;
      if (forward) run();
    });
    return () => {
      sub.remove();
    };
  }, [user]);

  return null;
}
