import { Stack, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useEffect } from 'react';

import { AuthSessionProvider } from '../lib/session';
import { docLinkToRouterPath, parseDocLink } from '../lib/doc-links';
import { installPushTapHandler } from '../lib/push';

/**
 * P7.3 — deep-link handler.
 *
 * The Expo app registers the `neutron` URL scheme (`app/app.json
 * "scheme": "neutron"`). Any `neutron://docs/<project_id>/<path>`
 * link tapped on the device fires the OS handler, which Expo
 * surfaces via `Linking.getInitialURL()` (cold start) and
 * `Linking.addEventListener('url', …)` (warm tap). The handler
 * parses the URL with the in-app mirror of `runtime/doc-links.ts`
 * and routes via `expo-router` to the docs tab at the referenced
 * file location. Vault-legacy URLs route nowhere — the OS opens
 * `vault.example.test` in the browser by default.
 *
 * Web build: the same handler runs but on web Linking.openURL fires
 * a window-level navigation; the in-app router still routes to the
 * docs tab when the URL is on
 * `<web-app-host>/projects/<id>/docs?path=…` (the Expo route
 * the doc-link helper targets per Argus r4 BLOCKING #1).
 *
 * P7.3 line anchors: when the parsed URL carries `?line=<N>` (or
 * the web shape's `&line=<N>`), `docLinkToRouterPath` appends
 * `&line=<N>` to the router target. The docs route at
 * `app/app/projects/[id]/docs.tsx` reads it via
 * `useLocalSearchParams` and scrolls the viewer pane to that line
 * after the body loads (Strategy B heuristic — see brief § 4.3).
 */
function useDocLinkRouting() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const handle = (url: string | null): void => {
      if (cancelled) return;
      if (url === null || url.length === 0) return;
      const parsed = parseDocLink(url);
      if (parsed === null) return;
      const target = docLinkToRouterPath(parsed);
      if (target === null) return;
      // Cast through `unknown` because expo-router's typed-routes lock
      // the route literal at compile time; deep links are dynamic.
      router.push(target as unknown as Parameters<typeof router.push>[0]);
    };
    Linking.getInitialURL()
      .then((url) => handle(url))
      .catch(() => undefined);
    const sub = Linking.addEventListener('url', (event) => handle(event.url));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [router]);
}

/**
 * 2026-05-22 — push tap deep-link routing.
 *
 * Subscribes via `installPushTapHandler` so every push tap (cold-start
 * via `getLastNotificationResponseAsync` + warm via the listener) maps
 * its payload `data` to a router target through `resolvePushRoute`.
 * The handler is a no-op on web / unsupported platforms — see
 * `app/lib/push.ts:installPushTapHandler` for the lifecycle contract.
 *
 * Co-located with `useDocLinkRouting` because both are app-shell
 * concerns that need a single mount point above every Stack screen.
 */
function usePushTapRouting(): void {
  const router = useRouter();
  useEffect(() => {
    const handle = installPushTapHandler((path) => {
      // Cast through `unknown` because expo-router's typed-routes lock
      // the route literal at compile time; push deep links are dynamic.
      router.push(path as unknown as Parameters<typeof router.push>[0]);
    });
    return (): void => handle.remove();
  }, [router]);
}

export default function RootLayout() {
  useDocLinkRouting();
  usePushTapRouting();
  return (
    <AuthSessionProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="index" />
        <Stack.Screen name="focus" />
        <Stack.Screen name="projects/index" />
        <Stack.Screen name="projects/[id]" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="admin" />
      </Stack>
    </AuthSessionProvider>
  );
}
