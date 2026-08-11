/**
 * @neutronai/app — Integrations admin screen (WAVE 2 Track A).
 *
 * One surface that SHOWS everything connected and lets the user manage it:
 *
 *   - Google OAuth accounts — per-Core `oauth_token` slots (Calendar,
 *     Email, Google Workspace). Connect opens the system browser on the
 *     gateway's `/api/cores/oauth/google/start` flow (Google blocks OAuth
 *     in webviews); Disconnect revokes + deletes the tokens.
 *   - Standalone API keys — per-Core `byo_api_key` slots (e.g. Research
 *     Core's Tavily). Paste a key to store it; Clear removes it.
 *   - Shared credentials — the free-form credential store's GLOBAL defaults:
 *     services the owner names themselves, available to every project. This is
 *     the ONE place they are authored (ISSUES #486). A project's Settings tab
 *     lists them read-only, because a global write made from inside one project
 *     silently changed every other one.
 *
 * Agent-native parity: the same actions are available in chat via the
 * `integrations_connect` / `integrations_disconnect` tools — this screen is
 * the visibility+management layer, chat is the parity path.
 *
 * Data + status logic lives in `app/lib/integrations-view.ts` (pure,
 * unit-tested); this component is the RN shell.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { appStateBecameActive } from '../lib/app-state-refetch';
import { shouldRedirectToLogin } from '../lib/auth-helpers';
import { CodexCredentialClient, type CodexStatus } from '../lib/codex-credential-client';

/**
 * The credential-store service id the trident review lane looks a Kimi key up
 * under. It MUST match `trident/kimi-key.ts`'s `KIMI_CREDENTIAL_SERVICE`, and the
 * literal is repeated rather than imported because the app bundle is deliberately
 * free of workspace dependencies (the same convention every client here follows).
 * A mismatch would store the key where nothing reads it — the row would look like
 * it worked and the reviewer would stay silent, which is the worst outcome a
 * settings control can have.
 */
const KIMI_SERVICE = 'kimi';
import { loadAppConfig } from '../lib/config';
import { useAuthSession } from '../lib/session';
import { type NeutronTheme } from '../lib/theme';
import { useTheme, useThemedStyles } from '../lib/theme-context';
import {
  CoresClient,
  CoresClientError,
  type IntegrationsResponse,
} from '../lib/cores-client';
import {
  ProjectCredentialsClient,
  type ProjectCredentialRecord,
} from '../lib/project-credentials-client';
import {
  summarizeIntegrations,
  type IntegrationRow,
} from '../lib/integrations-view';

export default function IntegrationsScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user, status } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);

  const client = useMemo(() => {
    if (user === null) return null;
    return new CoresClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const credsClient = useMemo(() => {
    if (user === null) return null;
    return new ProjectCredentialsClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const codexClient = useMemo(() => {
    if (user === null) return null;
    return new CodexCredentialClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [data, setData] = useState<IntegrationsResponse | null>(null);
  // ── Shared (global-scope) credentials ──
  const [sharedCreds, setSharedCreds] = useState<ProjectCredentialRecord[]>([]);
  const [credService, setCredService] = useState('');
  const [credToken, setCredToken] = useState('');
  const [credLabel, setCredLabel] = useState('');
  const [credBusy, setCredBusy] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // ── Model providers (Codex subscription + Kimi K3 key) ──
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [codexAuth, setCodexAuth] = useState('');
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [kimiKey, setKimiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Redirect to /login only once auth has RESOLVED to genuinely-
    // unauthenticated. `user` is transiently null while the session provider
    // hydrates the token from storage; treating that as "logged out" would
    // bounce an already-signed-in user to /login on a direct load / refresh /
    // deep-link of /integrations. Shared guard (see app/settings.tsx).
    if (shouldRedirectToLogin({ status, user })) router.replace('/login');
  }, [router, status, user]);

  // `silent` skips the full-screen loading state so a foreground refetch keeps
  // the current rows visible (no spinner flash) instead of blanking the screen.
  const fetchAll = useCallback(async (opts?: { silent?: boolean }) => {
    if (client === null) return;
    if (opts?.silent !== true) setLoading(true);
    setError(null);
    try {
      setData(await client.integrations());
    } catch (err) {
      setError(formatErr(err));
    } finally {
      if (opts?.silent !== true) setLoading(false);
    }
  }, [client]);

  const fetchSharedCreds = useCallback(async () => {
    if (credsClient === null) return;
    setCredError(null);
    try {
      setSharedCreds(await credsClient.listGlobal());
    } catch (err) {
      setSharedCreds([]);
      setCredError(formatErr(err));
    }
  }, [credsClient]);

  // ── Codex: the cross-model reviewer's ChatGPT subscription ──
  const fetchCodex = useCallback(async () => {
    if (codexClient === null) return;
    try {
      setCodexStatus(await codexClient.status());
    } catch {
      // A failed status read is "not connected" for display purposes. It is NOT
      // written anywhere and nothing is disconnected — an unreachable server must
      // never look like a credential the owner has to re-enter.
      setCodexStatus({ status: 'not_connected' });
    }
  }, [codexClient]);

  useEffect(() => {
    void fetchAll();
    void fetchSharedCreds();
    void fetchCodex();
  }, [fetchAll, fetchSharedCreds, fetchCodex]);

  const handleConnectCodex = useCallback(async () => {
    if (codexClient === null) return;
    const auth = codexAuth.trim();
    if (auth.length === 0 || codexBusy) return;
    setCodexBusy(true);
    setCodexError(null);
    try {
      const next = await codexClient.connect(auth);
      setCodexStatus(next);
      // Cleared on SUCCESS only. Keeping the paste on failure means the owner can
      // read the error and retry without going back to their terminal for the file.
      setCodexAuth('');
    } catch (err) {
      // The gateway's message is shown verbatim because it is the actionable part:
      // pasting a metered API key instead of a subscription bundle is the common
      // mistake, and the reply says exactly that.
      setCodexError(formatErr(err));
    } finally {
      setCodexBusy(false);
    }
  }, [codexClient, codexAuth, codexBusy]);

  const handleDisconnectCodex = useCallback(() => {
    if (codexClient === null) return;
    Alert.alert('Disconnect Codex?', 'Cross-model review will stop until you reconnect.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          setCodexBusy(true);
          setCodexError(null);
          void codexClient
            .disconnect()
            .then(() => fetchCodex())
            .catch((err: unknown) => setCodexError(formatErr(err)))
            .finally(() => setCodexBusy(false));
        },
      },
    ]);
  }, [codexClient, fetchCodex]);

  // ── Kimi K3: a plain API key, stored under the service id the review lane reads ──
  //
  // Goes through the SAME global-credential store the free-text form below writes
  // to, on purpose. A named row that used its own storage path would mean a key
  // entered here and a key entered there behaved differently, which is exactly the
  // kind of split that makes a settings screen untrustworthy. This row is a
  // labelled affordance over one code path, not a second one.
  const handleSaveKimi = useCallback(async () => {
    if (credsClient === null) return;
    const secret = kimiKey.trim();
    if (secret.length === 0 || credBusy) return;
    setCredBusy(true);
    setCredError(null);
    try {
      await credsClient.setGlobal({ service: KIMI_SERVICE, token: secret, label: 'Kimi K3' });
      setKimiKey('');
      await fetchSharedCreds();
    } catch (err) {
      setCredError(formatErr(err));
    } finally {
      setCredBusy(false);
    }
  }, [credsClient, kimiKey, credBusy, fetchSharedCreds]);

  /**
   * Is a Kimi key stored?
   *
   * DERIVED from the same shared-credential list the free-text form renders, not
   * tracked separately: a key added through either control lights up this row, and
   * removing it through either clears it. Two sources of truth for one fact is how
   * a settings screen starts lying about its own state.
   */
  const kimiConnected = sharedCreds.some((r) => r.service === KIMI_SERVICE);

  const handleAddSharedCred = useCallback(async () => {
    if (credsClient === null) return;
    const service = credService.trim();
    const secret = credToken.trim();
    if (service.length === 0 || secret.length === 0 || credBusy) return;
    const label = credLabel.trim();
    setCredBusy(true);
    setCredError(null);
    try {
      await credsClient.setGlobal({ service, token: secret, ...(label.length > 0 ? { label } : {}) });
      setCredService('');
      setCredToken('');
      setCredLabel('');
      await fetchSharedCreds();
    } catch (err) {
      setCredError(formatErr(err));
    } finally {
      setCredBusy(false);
    }
  }, [credsClient, credService, credToken, credLabel, credBusy, fetchSharedCreds]);

  const handleRemoveSharedCred = useCallback(
    (service: string) => {
      if (credsClient === null) return;
      Alert.alert(
        'Remove shared credential',
        `Remove the shared ${service} credential? Every project that relies on it loses access.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              setCredBusy(true);
              setCredError(null);
              credsClient
                .removeGlobal(service)
                .then(() => fetchSharedCreds())
                .catch((err) => setCredError(formatErr(err)))
                .finally(() => setCredBusy(false));
            },
          },
        ],
      );
    },
    [credsClient, fetchSharedCreds],
  );

  // Refetch when the app returns to the foreground. `Connect` hands off to the
  // system browser (Google blocks OAuth in webviews) via `Linking.openURL`,
  // which backgrounds the app WITHOUT unmounting/blurring this screen — so the
  // mount-time fetch never re-runs and the row would keep reading the stale
  // pre-grant status ("Not connected") even though the connect succeeded. A
  // foreground refetch reconciles it. (The web sibling tab has a manual Refresh
  // button for the same reason.)
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (appStateBecameActive(appState.current, next)) void fetchAll({ silent: true });
      appState.current = next;
    });
    return () => sub.remove();
  }, [fetchAll]);

  const view = useMemo(
    () => (data !== null ? summarizeIntegrations(data) : null),
    [data],
  );

  const handleConnectOAuth = useCallback(
    async (label: string) => {
      if (client === null) return;
      setBusy(true);
      setError(null);
      try {
        const started = await client.oauthStart([label]);
        await Linking.openURL(started.authorize_url);
      } catch (err) {
        setError(formatErr(err));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const handleDisconnectOAuth = useCallback(
    (label: string) => {
      if (client === null) return;
      Alert.alert(
        'Disconnect',
        `This will disable tools that depend on ${label}. Continue?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disconnect',
            style: 'destructive',
            onPress: () => {
              setBusy(true);
              setError(null);
              client
                .oauthDisconnect(label)
                .then(() => fetchAll())
                .catch((err) => setError(formatErr(err)))
                .finally(() => setBusy(false));
            },
          },
        ],
      );
    },
    [client, fetchAll],
  );

  const handleSaveKey = useCallback(
    async (label: string) => {
      if (client === null) return;
      const value = (drafts[label] ?? '').trim();
      if (value.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        await client.setApiKey(label, value);
        setDrafts((d) => ({ ...d, [label]: '' }));
        await fetchAll();
      } catch (err) {
        setError(formatErr(err));
      } finally {
        setBusy(false);
      }
    },
    [client, drafts, fetchAll],
  );

  const handleClearKey = useCallback(
    (label: string) => {
      if (client === null) return;
      Alert.alert(
        'Clear key',
        `Remove the stored API key for ${label}?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Clear',
            style: 'destructive',
            onPress: () => {
              setBusy(true);
              setError(null);
              client
                .deleteApiKey(label)
                .then(() => fetchAll())
                .catch((err) => setError(formatErr(err)))
                .finally(() => setBusy(false));
            },
          },
        ],
      );
    },
    [client, fetchAll],
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={theme.text_secondary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="integrations-back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerIconBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerOverline}>Settings</Text>
          <Text style={styles.headerTitle}>Integrations</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}

        {view !== null ? (
          <Text style={styles.summary} testID="integrations-summary">
            {view.connectedCount} of {view.totalCount} connected
          </Text>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Google accounts</Text>
          {view === null || view.oauth.length === 0 ? (
            <Text style={styles.muted}>No OAuth integrations declared.</Text>
          ) : null}
          {view?.oauth.map((row) => (
            <View key={row.id} style={styles.row} testID={`integration-oauth-${row.id}`}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{row.title}</Text>
                <Text style={styles.rowStatus}>{row.statusLabel}</Text>
                <Text style={styles.rowDetail}>{row.detail}</Text>
              </View>
              {row.connected ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Disconnect ${row.id}`}
                  testID={`integration-disconnect-${row.id}`}
                  disabled={busy}
                  onPress={() => handleDisconnectOAuth(row.id)}
                  style={({ pressed }) => [
                    styles.dangerBtn,
                    busy && styles.btnDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.dangerBtnText}>Disconnect</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Connect ${row.id}`}
                  testID={`integration-connect-${row.id}`}
                  disabled={busy}
                  onPress={() => void handleConnectOAuth(row.id)}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    busy && styles.btnDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryBtnText}>Connect</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>API keys</Text>
          {view === null || view.apiKeys.length === 0 ? (
            <Text style={styles.muted}>No API-key integrations declared.</Text>
          ) : null}
          {view?.apiKeys.map((row) => (
            <View key={row.id} style={styles.keyBlock} testID={`integration-apikey-${row.id}`}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>
                  {row.title}
                  {row.required ? <Text style={styles.requiredTag}> · required</Text> : null}
                </Text>
                <Text style={styles.rowStatus}>{row.statusLabel}</Text>
                <Text style={styles.rowDetail}>{row.detail}</Text>
              </View>
              <View style={styles.keyControls}>
                <TextInput
                  style={styles.keyInput}
                  testID={`integration-apikey-input-${row.id}`}
                  placeholder={row.connected ? 'Paste new key to rotate' : 'Paste API key'}
                  placeholderTextColor={theme.text_muted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  value={drafts[row.id] ?? ''}
                  onChangeText={(t) => setDrafts((d) => ({ ...d, [row.id]: t }))}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Save key for ${row.id}`}
                  testID={`integration-apikey-save-${row.id}`}
                  disabled={busy || (drafts[row.id] ?? '').trim().length === 0}
                  onPress={() => void handleSaveKey(row.id)}
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    (busy || (drafts[row.id] ?? '').trim().length === 0) &&
                      styles.btnDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryBtnText}>Save</Text>
                </Pressable>
                {row.connected ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Clear key for ${row.id}`}
                    testID={`integration-apikey-clear-${row.id}`}
                    disabled={busy}
                    onPress={() => handleClearKey(row.id)}
                    style={({ pressed }) => [
                      styles.dangerBtn,
                      busy && styles.btnDisabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.dangerBtnText}>Clear</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </View>

        {/* MODEL PROVIDERS — named rows for the two credentials the build and review
            lanes actually read. They sit ABOVE "Shared credentials" so the
            free-text form below reads as the escape hatch it is: before this, the
            only way to connect either was to know the exact service id and type it
            into that box, and Codex could not be connected from a phone at all. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Model providers</Text>
          <Text style={styles.muted}>
            Accounts the coding agent uses to build and review. Both are account-wide.
          </Text>

          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Codex (ChatGPT subscription)</Text>
              <Text style={styles.rowStatus} testID="codex-status">
                {codexStatus === null
                  ? 'Checking…'
                  : codexStatus.status === 'connected'
                    ? 'Connected — cross-model review is on'
                    : codexStatus.status === 'expired'
                      ? 'Expired — paste a fresh auth.json to reconnect'
                      : 'Not connected — reviews run without a second model family'}
              </Text>
            </View>
            {codexStatus?.status === 'connected' || codexStatus?.status === 'expired' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Disconnect Codex"
                testID="codex-disconnect"
                disabled={codexBusy}
                onPress={handleDisconnectCodex}
                style={({ pressed }) => [
                  styles.dangerBtn,
                  codexBusy && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.dangerBtnText}>Disconnect</Text>
              </Pressable>
            ) : null}
          </View>
          {codexError !== null ? (
            <Text style={styles.bannerError} testID="codex-error">
              {codexError}
            </Text>
          ) : null}
          {codexStatus?.status !== 'connected' ? (
            <View style={styles.keyBlock}>
              <Text style={styles.muted}>
                Run <Text style={styles.mono}>codex login</Text> on any machine, then paste that
                account&apos;s <Text style={styles.mono}>~/.codex/auth.json</Text> here. A metered
                API key will be rejected — this needs the subscription bundle.
              </Text>
              <TextInput
                style={styles.keyInput}
                testID="codex-auth-input"
                placeholder="Paste ~/.codex/auth.json"
                placeholderTextColor={theme.text_muted}
                secureTextEntry
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                editable={!codexBusy}
                value={codexAuth}
                onChangeText={setCodexAuth}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Connect Codex"
                testID="codex-connect"
                disabled={codexBusy || codexAuth.trim().length === 0}
                onPress={() => void handleConnectCodex()}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (codexBusy || codexAuth.trim().length === 0) && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryBtnText}>{codexBusy ? 'Connecting…' : 'Connect'}</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Kimi K3</Text>
              <Text style={styles.rowStatus} testID="kimi-status">
                {kimiConnected
                  ? 'Key saved — K3 joins the review panel'
                  : 'No key — the review panel stays one model family'}
              </Text>
            </View>
            {kimiConnected ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove Kimi key"
                testID="kimi-remove"
                disabled={credBusy}
                onPress={() => handleRemoveSharedCred(KIMI_SERVICE)}
                style={({ pressed }) => [
                  styles.dangerBtn,
                  credBusy && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.dangerBtnText}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.keyControls}>
            <TextInput
              style={styles.keyInput}
              testID="kimi-key-input"
              placeholder={kimiConnected ? 'Paste a new key to replace it' : 'Paste your Kimi API key'}
              placeholderTextColor={theme.text_muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!credBusy}
              value={kimiKey}
              onChangeText={setKimiKey}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save Kimi key"
              testID="kimi-save"
              disabled={credBusy || kimiKey.trim().length === 0}
              onPress={() => void handleSaveKimi()}
              style={({ pressed }) => [
                styles.primaryBtn,
                (credBusy || kimiKey.trim().length === 0) && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryBtnText}>Save</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Shared credentials</Text>
          <Text style={styles.muted}>
            Keys every project can use. A project that stores its own key for the same
            service uses that one instead.
          </Text>
          {credError !== null ? <Text style={styles.bannerError}>{credError}</Text> : null}
          {sharedCreds.length === 0 ? (
            <Text style={styles.muted} testID="shared-creds-empty">
              No shared credentials yet.
            </Text>
          ) : null}
          {sharedCreds.map((rec) => (
            <View key={rec.service} style={styles.row} testID={`shared-cred-${rec.service}`}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{rec.service}</Text>
                {rec.label !== null && rec.label.length > 0 ? (
                  <Text style={styles.rowDetail}>{rec.label}</Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove shared ${rec.service} credential`}
                testID={`shared-cred-remove-${rec.service}`}
                disabled={credBusy}
                onPress={() => handleRemoveSharedCred(rec.service)}
                style={({ pressed }) => [
                  styles.dangerBtn,
                  credBusy && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.dangerBtnText}>Remove</Text>
              </Pressable>
            </View>
          ))}
          <View style={styles.keyControls}>
            <TextInput
              style={styles.keyInput}
              testID="shared-cred-service"
              placeholder="Service (e.g. openai)"
              placeholderTextColor={theme.text_muted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!credBusy}
              value={credService}
              onChangeText={setCredService}
            />
            <TextInput
              style={styles.keyInput}
              testID="shared-cred-token"
              placeholder="Paste the secret"
              placeholderTextColor={theme.text_muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!credBusy}
              value={credToken}
              onChangeText={setCredToken}
            />
            <TextInput
              style={styles.keyInput}
              testID="shared-cred-label"
              placeholder="Label (optional)"
              placeholderTextColor={theme.text_muted}
              editable={!credBusy}
              value={credLabel}
              onChangeText={setCredLabel}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add shared credential"
              testID="shared-cred-add"
              disabled={credBusy || credService.trim().length === 0 || credToken.trim().length === 0}
              onPress={() => void handleAddSharedCred()}
              style={({ pressed }) => [
                styles.secondaryBtn,
                (credBusy || credService.trim().length === 0 || credToken.trim().length === 0) &&
                  styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryBtnText}>Add</Text>
            </Pressable>
          </View>
        </View>

        <Text style={styles.footnote}>
          You can also connect or disconnect any of these from chat — just ask.
        </Text>
      </ScrollView>
    </View>
  );
}

function formatErr(err: unknown): string {
  if (err instanceof CoresClientError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background, paddingTop: 48 },
    centered: { alignItems: 'center', justifyContent: 'center' },
    pressed: { opacity: 0.7 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingBottom: 12,
      gap: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
    },
    headerIconBtn: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    headerIcon: { color: theme.accent, fontSize: 18, fontWeight: '600' },
    headerCenter: { flex: 1, paddingHorizontal: 4 },
    headerSpacer: { width: 40 },
    headerOverline: {
      color: theme.text_muted,
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    headerTitle: { color: theme.text_primary, fontSize: 18, fontWeight: '700', marginTop: 1 },
    body: { padding: 16, gap: 14 },
    summary: { color: theme.text_muted, fontSize: 12, fontWeight: '600' },
    section: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.hairline,
      padding: 14,
      gap: 12,
    },
    sectionTitle: { color: theme.text_primary, fontSize: 16, fontWeight: '700' },
    muted: { color: theme.text_muted, fontSize: 13 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { color: theme.text_primary, fontSize: 14, fontWeight: '600' },
    rowStatus: { color: theme.text_secondary, fontSize: 12 },
    rowDetail: { color: theme.text_muted, fontSize: 11, lineHeight: 15 },
    // Monospace for the two inline shell/path references in the Codex guidance. A
    // pasted path is easier to read as code, and `THEME` carries no mono token.
    mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    requiredTag: { color: theme.warning, fontSize: 11, fontWeight: '600' },
    keyBlock: { gap: 10 },
    keyControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    keyInput: {
      flex: 1,
      height: 40,
      borderRadius: 8,
      paddingHorizontal: 10,
      backgroundColor: theme.surface_raised,
      borderWidth: 1,
      borderColor: theme.hairline,
      color: theme.text_primary,
      fontSize: 13,
    },
    primaryBtn: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: theme.text_primary,
    },
    primaryBtnText: { color: theme.background, fontSize: 13, fontWeight: '600' },
    secondaryBtn: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: theme.surface_raised,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    secondaryBtnText: { color: theme.text_secondary, fontSize: 13, fontWeight: '500' },
    dangerBtn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.danger,
    },
    dangerBtnText: { color: theme.danger, fontSize: 12, fontWeight: '600' },
    btnDisabled: { opacity: 0.5 },
    bannerError: {
      backgroundColor: '#3b1212',
      color: '#fecaca',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#7f1d1d',
      fontSize: 12,
    },
    footnote: {
      color: theme.text_muted,
      fontSize: 12,
      textAlign: 'center',
      marginTop: 4,
      lineHeight: 16,
    },
  });
