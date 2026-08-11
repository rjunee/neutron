import { Stack, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { DiagnosticsErrorBoundary } from '../components/DiagnosticsErrorBoundary';
import { DiagnosticsSync } from '../components/DiagnosticsSync';
import { PushRegistrationSync } from '../components/PushRegistrationSync';
import {
  getServerConfigEpoch,
  hydrateServerConfig,
  loadAppConfig,
  subscribeServerConfig,
} from '../lib/config';
import { installDiagnostics, setDiagnosticsOrigin } from '../lib/diagnostics';
import { AuthSessionProvider } from '../lib/session';
import { docLinkToRouterPath, parseDocLink } from '../lib/doc-links';
import { installPushTapHandler } from '../lib/push';
import { type NeutronTheme, type ResolvedTheme } from '../lib/theme';
import { ThemeProvider, useTheme, useThemeState, useThemedStyles } from '../lib/theme-context';

/**
 * Remote diagnostics — installed at MODULE SCOPE, not in an effect.
 *
 * This file is the app entry point, so importing it is the earliest moment any
 * of our code runs. A failure during boot — the server-config hydrate, the
 * first render, a module-level throw in a screen — happens BEFORE any effect
 * would have fired, and a boot failure is precisely the case that is invisible
 * today. `installDiagnostics()` is idempotent, so a re-import (fast refresh)
 * does not chain the handler to itself.
 *
 * See `app/lib/diagnostics.ts` for what this does and does NOT catch — in
 * particular it does not catch native crashes, which still need logcat.
 */
installDiagnostics();

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
function useDocLinkRouting(enabled: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, router]);
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
function usePushTapRouting(enabled: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const handle = installPushTapHandler((path) => {
      // Cast through `unknown` because expo-router's typed-routes lock
      // the route literal at compile time; push deep links are dynamic.
      router.push(path as unknown as Parameters<typeof router.push>[0]);
    });
    return (): void => handle.remove();
  }, [enabled, router]);
}

/**
 * Server-config hydration phase (ISSUES #385; reshaped for LOGIN-FIRST).
 *
 * `loadAppConfig()` is synchronous (~20 call sites read it inside
 * `useMemo`), so the persisted server URL has to be in the module cache
 * BEFORE the app tree mounts. That is the ONLY thing this phase gates:
 *
 *   'hydrating' → await `hydrateServerConfig()`
 *   'ready'     → render the Stack
 *
 * WHAT CHANGED, AND WHY. #385 added a third phase, `'setup'`, which
 * rendered the typed-URL "Connect to your Neutron" form INSTEAD of the
 * Stack whenever `configured === false`. That made "type your instance
 * address" the first thing a new owner saw. Ryan: *"why does it have to
 * ask? it should just open with a login screen, and once you login it
 * should know the url."* So the unconfigured branch is GONE: an
 * unconfigured install now mounts the Stack and lands on `/login`
 * (`app/app/index.tsx` redirects there whenever there is no session OR no
 * server), signs in against central identity, and DISCOVERS its own
 * address from `/v1/route` (`lib/identity-client.ts`). The typed-URL form
 * still exists — demoted to the self-host section of `/login`, which is
 * where a self-hoster (who runs no identity service) connects.
 *
 * The #385 INVARIANT it protected is kept by other means: nothing may
 * fire a request at an unconfigured install. `/login` issues no gateway
 * requests, `app/app/index.tsx` refuses to leave `/login` until a server
 * exists, and the two deep-link routers below stay disabled while
 * unconfigured — a push tap must not jump straight into a project screen
 * that would immediately fetch from nowhere.
 */
type BootPhase = 'hydrating' | 'ready';

/**
 * ISSUES #385 — the server-config EPOCH, used as the app tree's React
 * `key`.
 *
 * `loadAppConfig()` is synchronous and ~10 screens freeze its result for
 * their whole lifetime inside `useMemo(() => loadAppConfig(), [])`. So
 * mutating the module cache is not enough: a screen mounted before the
 * change keeps firing HTTP + WS at the OLD host (Argus r2 MAJOR).
 * Re-keying the tree on the epoch unmounts every screen and every frozen
 * memo along with it, so nothing can survive a server change still
 * pointing at the previous instance.
 */
function useServerConfigEpoch(): number {
  const [epoch, setEpoch] = useState(() => getServerConfigEpoch());
  useEffect(
    () =>
      subscribeServerConfig(() => {
        setEpoch(getServerConfigEpoch());
      }),
    [],
  );
  return epoch;
}

/**
 * THE THEME BOUNDARY, and why it is the outermost thing in the app.
 *
 * `RootLayout` itself reads the palette (the boot spinner is themed), so the
 * provider cannot live inside it — it has to wrap it. The error boundary wraps
 * BOTH, deliberately: it is the only component that must still render when the
 * theming layer is the thing that threw, and it is written to survive having no
 * provider above it (see `CrashFallback`).
 */
export default function RootLayout() {
  return (
    <DiagnosticsErrorBoundary>
      <ThemeProvider>
        <RootLayoutShell />
      </ThemeProvider>
    </DiagnosticsErrorBoundary>
  );
}

/**
 * NATIVE SYSTEM CHROME follows the RESOLVED scheme, not the OS.
 *
 * `app.json` sets `userInterfaceStyle: "automatic"`, which hands the status-bar
 * icon styling to the OS. That is right for a preference of `system` and WRONG
 * for an explicit override: an owner who picks Light on a dark-OS phone got a
 * light app under light-on-dark status-bar icons, i.e. invisible time and battery.
 * The whole point of an override is that it overrides.
 *
 * `style` names the CONTENT: `light` = light icons, for a dark ground. So it is
 * the inverse of the scheme name, which reads backwards and is why it is spelled
 * out here.
 */
function NeutronStatusBar({ scheme }: { scheme: ResolvedTheme }) {
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

function RootLayoutShell() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { hydrated: themeHydrated, scheme } = useThemeState();
  const [phase, setPhase] = useState<BootPhase>('hydrating');
  const serverEpoch = useServerConfigEpoch();
  // Read fresh on every render, deliberately NOT memoised. `loadAppConfig()`
  // reads a module-level cache, so it is not reactive on its own — what makes
  // this correct is that `serverEpoch` is state, so committing a server
  // (discovery, or the self-host form) re-renders this component and the next
  // read sees it. Memoising on `serverEpoch` would express the same thing
  // while looking like a dependency the linter can't verify.
  const configured = phase === 'ready' && loadAppConfig().configured;
  useDocLinkRouting(configured);
  usePushTapRouting(configured);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await hydrateServerConfig();
      if (cancelled) return;
      // Bind every report captured from here on to THIS gateway, so a report
      // queued against one instance can never be delivered to another after a
      // server change. Set before the tree mounts, so a crash in the very first
      // screen is already bound.
      setDiagnosticsOrigin(loadAppConfig().gateway_base_url);
      // LOGIN-FIRST: there is no server-setup phase any more. The app opens on
      // login and DISCOVERS its instance URL, so boot goes straight to 'ready'
      // and the login screen decides what the owner sees.
      setPhase('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The boot gate also waits for the stored theme PREFERENCE. This is mobile's
  // equivalent of the web's pre-paint inline script (`landing/chat-react.html`):
  // reading the preference is a storage round-trip, so without this gate the first
  // real screen paints with the OS-resolved theme and then snaps to the owner's
  // override a frame later — the flash of the wrong theme that script exists to
  // prevent. The spinner itself is themed, so it is never a white flash either.
  if (phase === 'hydrating' || !themeHydrated) {
    return (
      <View style={styles.booting}>
        <NeutronStatusBar scheme={scheme} />
        <ActivityIndicator color={theme.text_secondary} />
      </View>
    );
  }

  return (
    <>
      <NeutronStatusBar scheme={scheme} />
      {/* `key` = the server epoch: changing the server rebuilds the entire
          tree so no mounted screen keeps a `useMemo`-frozen config pointing
          at the old host (Argus r2 MAJOR). */}
      <AuthSessionProvider key={`server-${serverEpoch}`}>
        <DiagnosticsSync />
        <PushRegistrationSync />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="index" />
          <Stack.Screen name="focus" />
          <Stack.Screen name="projects/[id]" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="integrations" />
          <Stack.Screen name="admin" />
          <Stack.Screen name="codegen" />
          <Stack.Screen name="usage" />
        </Stack>
      </AuthSessionProvider>
    </>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    booting: {
      flex: 1,
      backgroundColor: theme.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
