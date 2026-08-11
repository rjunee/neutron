/**
 * @neutronai/app — `/login`: the DEFAULT surface, and where the app learns
 * its own instance address (SPEC § Decisions Log 2026-07-25).
 *
 * Ryan: *"why does it have to ask? it should just open with a login screen,
 * and once you login it should know the url."*
 *
 * Before this, ISSUES #385 made the typed-URL "Connect to your Neutron"
 * form the FIRST-RUN surface (`app/app/_layout.tsx` rendered
 * `ServerSetupGate` instead of the `<Stack>` while unconfigured), so a new
 * owner's first task was to know and type a hostname. Now:
 *
 *   1. An unconfigured install mounts the Stack and lands here
 *      (`app/app/index.tsx` redirects to `/login` while there is no server
 *      OR no session).
 *   2. The owner signs in against central identity — with their provider
 *      (`POST {auth_base}/v1/oauth/<p>/start` → consent → `…/exchange`) or
 *      with an email + password (`POST {auth_base}/v1/login`). BOTH lanes
 *      are wired, because an account made through the provider front door
 *      has no usable password and no way to set one — password-only sign-in
 *      would strand that owner permanently.
 *   3. The app DISCOVERS its instance — `POST {auth_base}/v1/route` returns
 *      `publicUrl`, which it adopts as the gateway base through the same
 *      `commitServerConfig` path a typed URL uses.
 *   4. It enters the app. ZERO typing in the happy path.
 *
 * EVERY branch of step 3 is a reachable on-screen state, not a spinner:
 * several instances → a PICKER over the returned slugs, which re-calls
 * `/v1/route` with the chosen slug; no instance yet → an explicit
 * not-provisioned state; a network/5xx failure → an actionable error with
 * Retry. Which stage follows which failure — and what the retry control
 * does — lives in `lib/login-stage.ts` as pure functions, so those branches
 * are covered by real assertions instead of greps over this file.
 *
 * TWO TOKENS. `/v1/login` yields an ACCOUNT-scoped token whose only job is
 * to authenticate the `/v1/route` call; `/v1/route` yields the
 * INSTANCE-scoped token the instance actually verifies. Only the latter is
 * persisted as the session. `lib/identity-client.ts` documents the split.
 *
 * THE TYPED-URL FORM SURVIVES, DEMOTED. The self-host card at the bottom of
 * this screen is ALWAYS rendered, in every stage — so it is the escape
 * hatch from a discovery failure, from an unconfigured identity service,
 * and from a stale persisted host with no session left to reach
 * `/settings` with (#385 / Argus r2 MAJOR). A self-hoster runs no identity
 * service at all, so manual entry can never be removed.
 *
 * NOTHING here hardcodes an instance or identity address: `auth_base_url`
 * comes from `loadAppConfig()` (`extra.neutron_auth_base_url` →
 * `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL`), and when it is absent the screen
 * says so instead of fabricating one.
 */

import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ServerConnectForm, type ServerSavedResult } from '../components/ServerConnectForm';
import { signInWithDevToken } from '../lib/auth';
import { getRuntimeServerConfig, loadAppConfig, setRuntimeServerConfig } from '../lib/config';
import {
  adoptDiscoveredInstance,
  discoverInstance,
  isIdentityConfigured,
  signInWithOauth,
  signInWithPassword,
  type DiscoveredInstance,
  type IdentityOauthProvider,
  type IdentityResult,
  type IdentitySession,
} from '../lib/identity-client';
import {
  clearsSession,
  nextStageForFailure,
  retryLabelForStage,
  retryTargetForStage,
  type Stage,
} from '../lib/login-stage';
import { enablePushForUser } from '../lib/push';
import { LOCAL_DEV_SUGGESTION } from '../lib/server-url';
import { useAuthSession } from '../lib/session';
import { type NeutronTheme } from '../lib/theme';
import { useTheme, useThemedStyles } from '../lib/theme-context';
import { tokenStorage } from '../lib/token-storage';

import type { AuthProvider, AuthUser } from '../lib/auth';

// Web builds finish a redirect-based auth session on load; harmless elsewhere.
WebBrowser.maybeCompleteAuthSession();

async function tryEnablePush(base_url: string, token: string): Promise<void> {
  // P5.6 — best-effort push registration. Sign-in must NOT be blocked by a
  // permission-denied / unsupported-platform / gateway-unreachable error.
  // `enablePushForUser` never throws; it surfaces every failure mode as a
  // structured result.
  //
  // The result is no longer only console-logged (ISSUES #487): as of the
  // observability change `enablePushForUser` records every outcome into the
  // diagnostics buffer and queues a report for the owner's own gateway when
  // the failure is actionable — see `lib/push-observability.ts`. The
  // `console.warn` below stays for the developer loop only; it is not the
  // reporting path, because a console line on a phone is not observable by
  // anyone. This call sits BEFORE `setUser` on purpose (see below): the
  // queued report is flushed by `DiagnosticsSync` on this same launch.
  try {
    const result = await enablePushForUser({ base_url, token });
    if (!result.ok) console.warn(`[push] skipped: ${result.reason}`, result.detail ?? '');
  } catch (err) {
    // Defensive — belt and suspenders against an unexpected throw.
    console.warn('[push] unexpected error during enable', err);
  }
}

export default function LoginScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user, setUser } = useAuthSession();

  const config = loadAppConfig();
  const identityConfigured = useMemo(
    () => isIdentityConfigured(config.auth_base_url),
    [config.auth_base_url],
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  /**
   * The ACCOUNT-scoped session, kept so the picker and Retry can re-call
   * `/v1/route` without re-entering credentials. Never persisted.
   */
  const [session, setSession] = useState<IdentitySession | null>(null);
  /** Which lane produced `session`, recorded on the persisted `AuthUser`. */
  const [lane, setLane] = useState<AuthProvider>('password');

  // Self-host lane state (the demoted typed-URL path + the dev-token paste).
  const [editingServer, setEditingServer] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => loadAppConfig().gateway_base_url);
  const [devToken, setDevToken] = useState('');
  const [devBusy, setDevBusy] = useState(false);
  const [devError, setDevError] = useState<string | null>(null);

  /**
   * Adopting an instance bumps the server-config epoch, which re-keys (and
   * therefore REMOUNTS) the whole app tree from `app/app/_layout.tsx`. The
   * remount can land back on this screen with the session already hydrated
   * from storage, so leaving is a mount-time decision, not only a
   * post-submit `router.replace`.
   */
  useEffect(() => {
    if (loadAppConfig().configured && user !== null) router.replace('/');
  }, [router, user]);

  /** Steps 3–4: adopt the discovered address, persist the session, enter. */
  async function enterWithInstance(
    instance: DiscoveredInstance,
    account: IdentitySession,
    provider: AuthProvider,
  ) {
    const accountEmail = account.email;
    const accountUserId = account.user_id;
    const store = tokenStorage();
    const adopted = await adoptDiscoveredInstance({
      instance,
      auth_base_url: config.auth_base_url,
      previous_gateway_base_url: loadAppConfig().gateway_base_url,
      store,
    });
    if (!adopted.ok) {
      // The instance exists but did not answer /healthz — a real, actionable
      // condition (still provisioning, or down), NOT a silent success.
      setStage({ kind: 'error', message: adopted.message, retry_discovery: true });
      return;
    }

    const authUser: AuthUser = {
      // The IDENTITY the instance will see this device as: the `sub` of the very
      // token being persisted. NOT `instance.slug` — a slug names a machine, not
      // a person, and every user-derived identifier downstream (the local
      // transcript key, the `app:<user>` topic the ZIP-import header carries)
      // would then announce a value the instance does not recognise as anyone.
      // `session.user_id` is the same account id the service put in `sub`; it is
      // the fallback for a token whose payload we could not read.
      id: instance.userId ?? accountUserId,
      email: accountEmail,
      displayName: accountEmail,
      provider,
      // The INSTANCE-scoped token — never the account-scoped one.
      token: instance.accessToken,
    };

    // AWAIT the persist BEFORE bumping the epoch. `setRuntimeServerConfig`
    // remounts the tree, and the remounted `AuthSessionProvider` hydrates
    // the user FROM STORAGE — so a fire-and-forget `setUser` would race the
    // remount and could land us back on a signed-out /login.
    //
    // The identity session goes down with it. The instance bearer is
    // short-lived, so without the refresh token persisted alongside it the
    // owner would be back at this screen typing credentials a day later;
    // `renewSessionIfExpired` (app/app/index.tsx) spends it on every launch.
    try {
      await Promise.all([
        store.setUser(authUser),
        store.setToken(authUser.token),
        store.setIdentitySession({
          user_id: accountUserId,
          email: accountEmail,
          refresh_token: account.refresh_token,
          slug: instance.slug,
        }),
      ]);
    } catch (err) {
      setStage({
        kind: 'error',
        message: `Could not save the session on this device (${err instanceof Error ? err.message : String(err)}). Try again.`,
        retry_discovery: true,
      });
      return;
    }

    await tryEnablePush(instance.publicUrl, authUser.token);
    setUser(authUser);
    setRuntimeServerConfig(adopted.config);
    router.replace('/');
  }

  /**
   * Step 3: `/v1/route`. `slug` is set only from the picker.
   *
   * `provider` IS A PARAMETER, NOT READ FROM `lane`. `afterSignIn` calls
   * `setLane(provider)` and then this function in the SAME render tick, so the
   * `lane` this closure captured is still the previous render's value — for a
   * first sign-in, the `'password'` initial state. A "Continue with Google" would
   * therefore persist `provider: 'password'` on the `AuthUser` and settings would
   * show a PASSWORD badge for an account that has no password. The retry and
   * picker call sites pass `lane`, which by then is committed state and correct.
   */
  async function runDiscovery(
    active: IdentitySession,
    provider: AuthProvider,
    slug?: string,
  ) {
    setStage({ kind: 'busy', label: 'Finding your Neutron…' });
    const found = await discoverInstance({
      auth_base_url: config.auth_base_url,
      session_token: active.session_token,
      ...(slug === undefined ? {} : { slug }),
    });
    if (found.ok) {
      await enterWithInstance(found.value, active, provider);
      return;
    }
    // The failure → stage mapping lives in `lib/login-stage.ts` so it is
    // covered by real assertions rather than by grepping this file.
    if (clearsSession(found.failure)) setSession(null);
    setStage(nextStageForFailure(found.failure, found.message));
  }

  /** Step 2 exit, shared by every sign-in lane: hold the session, then discover. */
  async function afterSignIn(
    result: IdentityResult<IdentitySession>,
    provider: AuthProvider,
  ) {
    if (!result.ok) {
      setSession(null);
      setStage(nextStageForFailure(result.failure, result.message));
      return;
    }
    setLane(provider);
    setSession(result.value);
    setPassword('');
    // `provider` is threaded through explicitly — `setLane` above has NOT taken
    // effect in this closure yet. See `runDiscovery`.
    await runDiscovery(result.value, provider);
  }

  /** Steps 2–3, provider lane. */
  async function handleOauth(provider: IdentityOauthProvider) {
    setStage({ kind: 'busy', label: `Signing in with ${provider === 'google' ? 'Google' : 'Apple'}…` });
    await afterSignIn(
      await signInWithOauth({
        auth_base_url: config.auth_base_url,
        provider,
        // The app's OWN deep link. `Linking.createURL` resolves the right form
        // per platform (a `neutron://` scheme on native, an https origin on
        // web), so nothing about the redirect target is hardcoded either.
        redirect_uri: Linking.createURL('/oauth/callback'),
        openAuthSession: (authorizeUrl, redirectUri) =>
          WebBrowser.openAuthSessionAsync(authorizeUrl, redirectUri),
      }),
      provider,
    );
  }

  /** Steps 2–3, password lane. */
  async function handleSignIn() {
    setStage({ kind: 'busy', label: 'Signing in…' });
    await afterSignIn(
      await signInWithPassword({ auth_base_url: config.auth_base_url, email, password }),
      'password',
    );
  }

  function handleRetry() {
    // BOTH the label and the action come from `retryTargetForStage`, so the
    // control can never do the opposite of what it says. Branching on
    // `session !== null` alone would re-run discovery on a stale token even
    // when the stage exists precisely to demand credentials again.
    if (retryTargetForStage(stage, session !== null) === 'discovery' && session !== null) {
      // `lane` is committed state by the time a retry is possible, so it is the
      // correct provider here (unlike inside `afterSignIn` — see `runDiscovery`).
      void runDiscovery(session, lane);
    } else {
      setStage({ kind: 'idle' });
    }
  }

  const handleServerSaved = (result: ServerSavedResult): void => {
    setServerUrl(result.gateway_base_url);
    setEditingServer(false);
    setDevError(null);
    // A token minted by the previous instance is worthless on the new one;
    // drop whatever is typed so it can't be sent to the new host.
    if (result.host_changed) setDevToken('');
  };

  /** The self-host sign-in lane: the token the gateway printed on start. */
  async function handleDevConnect() {
    setDevError(null);
    if (devToken.trim().length === 0) {
      setDevError('Paste the access token your gateway printed on first run.');
      return;
    }
    if (!loadAppConfig().configured) {
      setDevError('Set your server address first, above.');
      return;
    }
    setDevBusy(true);
    try {
      // Connects to the configured gateway (NEUTRON_APP_WS_BYPASS=1 or
      // NEUTRON_APP_WS_DEV_SECRET=…) using the access token the harness
      // prints on `neutron start` (`bin/neutron:82`).
      const devUser = await signInWithDevToken({ token: devToken });
      setUser(devUser);
      await tryEnablePush(loadAppConfig().base_url, devUser.token);
      router.replace('/');
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err));
    } finally {
      setDevBusy(false);
    }
  }

  const busy = stage.kind === 'busy';
  /** Only ONE writer may touch the persisted server config at a time. */
  const serverLaneLocked = busy || devBusy;

  /**
   * BRING THE STAGE CARD INTO VIEW. The picker / not-provisioned / error cards
   * render BELOW the brand block and the full sign-in card, which on the smallest
   * supported viewport puts them off-screen. The owner would press "Sign in",
   * watch the spinner stop, and see nothing change — "a press that does nothing,
   * with no feedback", which is the exact failure this screen is built to forbid.
   * Scrolling to the end on a stage that renders a card is the whole fix; those
   * cards are the last content in the scroll view.
   */
  const scrollRef = useRef<ScrollView | null>(null);
  const cardStage =
    stage.kind === 'picker' || stage.kind === 'no_instance' || stage.kind === 'error'
      ? stage.kind
      : null;
  useEffect(() => {
    if (cardStage === null) return;
    // One frame of slack so the card has been laid out before we scroll to it.
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [cardStage]);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.brand}>
        <Text style={styles.title}>Neutron</Text>
        <Text style={styles.subtitle}>Sign in — this app finds your instance</Text>
      </View>

      {/* PRIMARY surface: sign in. Rendered only when there is an identity
          service to sign in against — otherwise the honest notice below. */}
      {identityConfigured ? (
        <View style={styles.card} testID="login-signin-card">
          <Text style={styles.heading}>Sign in</Text>
          <Text style={styles.sub}>
            Use your Neutron account. After you sign in, this app looks up
            where your instance lives — there is no address to type.
          </Text>
          {/* PROVIDER LANES FIRST. An account created through the provider
              front door has no usable password and no way to set one, so for
              those owners this is the ONLY way in — it cannot be the buried
              option below the form. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            testID="login-google"
            disabled={busy}
            onPress={() => {
              void handleOauth('google');
            }}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            <Text style={styles.buttonText}>Continue with Google</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue with Apple"
            testID="login-apple"
            disabled={busy}
            onPress={() => {
              void handleOauth('apple');
            }}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryBtnText}>Continue with Apple</Text>
          </Pressable>
          <Text style={styles.divider}>or use your email and password</Text>
          <TextInput
            accessibilityLabel="Email"
            testID="login-email"
            placeholder="you@example.com"
            placeholderTextColor={theme.text_muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            // Let the platform password manager fill AND offer to save. Without
            // these the screen this sprint exists to de-type would still make
            // the owner type both fields by hand every time.
            autoComplete="email"
            textContentType="emailAddress"
            value={email}
            editable={!busy}
            onChangeText={setEmail}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Password"
            testID="login-password"
            placeholder="Password"
            placeholderTextColor={theme.text_muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            value={password}
            editable={!busy}
            onChangeText={setPassword}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            testID="login-submit"
            disabled={busy}
            onPress={() => {
              void handleSignIn();
            }}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            {busy ? (
              <ActivityIndicator color={theme.background} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.card} testID="login-identity-unconfigured">
          <Text style={styles.heading}>No identity service configured</Text>
          <Text style={styles.sub}>
            This build has no account service set, so it cannot look up your
            instance for you. Connect straight to your own Neutron below —
            that is the self-hosted path, and it needs no account.
          </Text>
        </View>
      )}

      {/* Discovery progress — labelled, so it is never a bare spinner. */}
      {busy ? (
        <View style={styles.statusRow} testID="login-busy">
          <ActivityIndicator color={theme.text_secondary} />
          <Text style={styles.statusText}>{stage.label}</Text>
        </View>
      ) : null}

      {/* MANY INSTANCES — pick one, then re-call /v1/route with that slug. */}
      {stage.kind === 'picker' ? (
        <View style={styles.card} testID="login-instance-picker">
          <Text style={styles.heading}>Choose your Neutron</Text>
          <Text style={styles.sub}>
            This account has more than one instance. Pick the one to open on
            this device; you can change it later in Settings.
          </Text>
          {stage.slugs.map((slug) => (
            <Pressable
              key={slug}
              accessibilityRole="button"
              accessibilityLabel={`Open ${slug}`}
              testID={`login-instance-${slug}`}
              onPress={() => {
                // A press that does nothing, with no feedback, is the one thing
                // this screen's state model forbids. Losing the session while a
                // picker is up shouldn't be reachable — say so if it happens.
                if (session === null) {
                  setStage({
                    kind: 'error',
                    message: 'That sign-in expired before you picked an instance. Sign in again.',
                    retry_discovery: false,
                  });
                  return;
                }
                void runDiscovery(session, lane, slug);
              }}
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryBtnText}>{slug}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* ZERO INSTANCES — an explicit state, not a crash and not a spinner. */}
      {stage.kind === 'no_instance' ? (
        <View style={styles.card} testID="login-no-instance">
          <Text style={styles.heading}>No instance yet</Text>
          <Text style={styles.sub}>{stage.message}</Text>
          {/* The label comes from `retryLabelForStage`, NOT a literal — the
              error card below already did this, and hardcoding it here made a
              second source for the same string, which is the drift
              `lib/login-stage.ts` exists to prevent. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={retryLabelForStage(stage, session !== null)}
            testID="login-no-instance-retry"
            onPress={handleRetry}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryBtnText}>
              {retryLabelForStage(stage, session !== null)}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* FAILURE — actionable: the real message plus Retry. The self-host
          card below stays on screen, so the fallback is always reachable. */}
      {stage.kind === 'error' ? (
        <View style={styles.card} testID="login-error">
          <Text style={styles.errorText} testID="login-error-message">
            {stage.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            testID="login-retry"
            onPress={handleRetry}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryBtnText}>
              {retryLabelForStage(stage, session !== null)}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* SELF-HOST / ADVANCED — the demoted typed-URL path. ALWAYS mounted,
          in every stage, and reachable with NO session.

          LOCKED OUT WHILE DISCOVERY IS IN FLIGHT (`busy`), not just while its
          own submit is (`devBusy`). Both lanes write the SAME persisted server
          config: saving a LAN host mid-discovery lets the still-in-flight
          `adoptDiscoveredInstance` overwrite it moments later, carrying a
          now-stale `previous_gateway_base_url` that corrupts the host-changed
          session-wipe bookkeeping. One writer at a time. */}
      <View style={styles.card} testID="login-server-card">
        <Text style={styles.heading}>Self-hosting?</Text>
        <Text style={styles.sub}>
          Running your own Neutron, or on a LAN? Name its address and connect
          with the token the harness printed. No account needed.
        </Text>
        <Text style={styles.serverUrl} numberOfLines={2} testID="login-server-url">
          {serverUrl.length > 0 ? serverUrl : 'Not configured'}
        </Text>
        {editingServer ? (
          <ServerConnectForm
            initialUrl={serverUrl.length > 0 ? serverUrl : LOCAL_DEV_SUGGESTION}
            initialAuthUrl={getRuntimeServerConfig().auth_base_url ?? ''}
            submitLabel="Save server"
            onSaved={handleServerSaved}
            onCancel={() => setEditingServer(false)}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change server"
            testID="login-change-server"
            disabled={serverLaneLocked}
            onPress={() => setEditingServer(true)}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryBtnText}>
              {serverUrl.length > 0 ? 'Change server' : 'Enter server address'}
            </Text>
          </Pressable>
        )}
        <TextInput
          accessibilityLabel="Access token"
          testID="login-dev-token"
          placeholder="Paste your access token"
          placeholderTextColor={theme.text_muted}
          autoCapitalize="none"
          autoCorrect={false}
          value={devToken}
          editable={!serverLaneLocked}
          onChangeText={setDevToken}
          style={styles.input}
        />
        {devError !== null ? (
          <Text style={styles.errorText} testID="login-dev-error">
            {devError}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connect directly"
          testID="login-dev-submit"
          disabled={serverLaneLocked}
          onPress={() => {
            void handleDevConnect();
          }}
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
        >
          {devBusy ? (
            <ActivityIndicator color={theme.text_secondary} />
          ) : (
            <Text style={styles.secondaryBtnText}>Connect directly</Text>
          )}
        </Pressable>
      </View>

      <Text style={styles.footnote}>
        Tokens live only on your machine and this device. Local-first by
        default.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    scroll: { flex: 1, backgroundColor: theme.background },
    container: {
      paddingHorizontal: 32,
      paddingTop: 64,
      paddingBottom: 32,
      gap: 14,
    },
    brand: { alignItems: 'flex-start', marginBottom: 6 },
    title: {
      color: theme.text_primary,
      fontSize: 44,
      fontWeight: '700',
      letterSpacing: -1,
    },
    subtitle: { color: theme.text_muted, fontSize: 17, marginTop: 8 },
    card: {
      padding: 16,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.hairline,
      gap: 10,
    },
    heading: { color: theme.text_primary, fontSize: 16, fontWeight: '600' },
    sub: { color: theme.text_muted, fontSize: 13, lineHeight: 18 },
    input: {
      color: theme.text_primary,
      fontSize: 14,
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: theme.background,
      fontFamily: 'Menlo',
    },
    button: {
      height: 48,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.text_primary,
    },
    buttonText: { color: theme.background, fontSize: 16, fontWeight: '600' },
    secondaryBtn: {
      height: 44,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    secondaryBtnText: { color: theme.text_secondary, fontSize: 15, fontWeight: '600' },
    divider: {
      color: theme.text_muted,
      fontSize: 12,
      textAlign: 'center',
      marginTop: 4,
    },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    statusText: { color: theme.text_secondary, fontSize: 14 },
    serverUrl: { color: theme.text_secondary, fontSize: 13, fontFamily: 'Menlo' },
    errorText: { color: theme.danger, fontSize: 13, lineHeight: 18 },
    pressed: { opacity: 0.7 },
    footnote: { color: theme.text_muted, fontSize: 12, textAlign: 'center' },
  });
