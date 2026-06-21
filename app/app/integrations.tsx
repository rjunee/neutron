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
 *
 * Agent-native parity: the same actions are available in chat via the
 * `integrations_connect` / `integrations_disconnect` tools — this screen is
 * the visibility+management layer, chat is the parity path.
 *
 * Data + status logic lives in `app/lib/integrations-view.ts` (pure,
 * unit-tested); this component is the RN shell.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { shouldRedirectToLogin } from '../lib/auth-helpers';
import { loadAppConfig } from '../lib/config';
import { useAuthSession } from '../lib/session';
import { THEME } from '../lib/theme';
import {
  CoresClient,
  CoresClientError,
  type IntegrationsResponse,
} from '../lib/cores-client';
import {
  summarizeIntegrations,
  type IntegrationRow,
} from '../lib/integrations-view';

export default function IntegrationsScreen() {
  const router = useRouter();
  const { user, status } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);

  const client = useMemo(() => {
    if (user === null) return null;
    return new CoresClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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

  const fetchAll = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    setError(null);
    try {
      setData(await client.integrations());
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchAll();
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
        <ActivityIndicator color={THEME.text_secondary} />
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
                  placeholderTextColor={THEME.text_muted}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, paddingTop: 48 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  headerIcon: { color: THEME.accent, fontSize: 18, fontWeight: '600' },
  headerCenter: { flex: 1, paddingHorizontal: 4 },
  headerSpacer: { width: 40 },
  headerOverline: {
    color: THEME.text_muted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  headerTitle: { color: THEME.text_primary, fontSize: 18, fontWeight: '700', marginTop: 1 },
  body: { padding: 16, gap: 14 },
  summary: { color: THEME.text_muted, fontSize: 12, fontWeight: '600' },
  section: {
    backgroundColor: THEME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.hairline,
    padding: 14,
    gap: 12,
  },
  sectionTitle: { color: THEME.text_primary, fontSize: 16, fontWeight: '700' },
  muted: { color: THEME.text_muted, fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: THEME.text_primary, fontSize: 14, fontWeight: '600' },
  rowStatus: { color: THEME.text_secondary, fontSize: 12 },
  rowDetail: { color: THEME.text_muted, fontSize: 11, lineHeight: 15 },
  requiredTag: { color: THEME.warning, fontSize: 11, fontWeight: '600' },
  keyBlock: { gap: 10 },
  keyControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  keyInput: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
    color: THEME.text_primary,
    fontSize: 13,
  },
  primaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: THEME.text_primary,
  },
  primaryBtnText: { color: THEME.background, fontSize: 13, fontWeight: '600' },
  secondaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  secondaryBtnText: { color: THEME.text_secondary, fontSize: 13, fontWeight: '500' },
  dangerBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.danger,
  },
  dangerBtnText: { color: THEME.danger, fontSize: 12, fontWeight: '600' },
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
    color: THEME.text_muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
  },
});
