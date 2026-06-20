/**
 * @neutronai/app — per-Core setup screen.
 *
 * Owns `/cores/<slug>` and surfaces:
 *
 *   - The Core's display name + description + install state
 *   - For Cores with `required_oauth_labels[]`: a `Connect Google`
 *     button that opens the OAuth flow (start endpoint returns an
 *     authorize_url which we open with `Linking.openURL` so the
 *     system browser handles the consent screen — Google blocks
 *     OAuth inside webviews).
 *   - For connected Cores: a `Disconnect` button (per-label)
 *   - The list of MCP tools the Core exposes (read-only summary).
 *
 * Per docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 6.1 +
 * the 2026-05-20 Sam spec — Cores tab routes to per-Core screens for
 * setup; the global Cores tab is a directory.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { loadAppConfig } from '../../lib/config';
import { useAuthSession } from '../../lib/session';
import {
  CoresClient,
  CoresClientError,
  type CoreSummary,
  type OAuthStatusLabel,
} from '../../lib/cores-client';

export default function CoreScreen() {
  const router = useRouter();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const slugValue = typeof slug === 'string' ? slug : '';

  const client = useMemo(() => {
    if (user === null) return null;
    return new CoresClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [core, setCore] = useState<CoreSummary | null>(null);
  const [oauthLabels, setOauthLabels] = useState<OAuthStatusLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user === null) router.replace('/login');
  }, [router, user]);

  const fetchAll = useCallback(async () => {
    if (client === null || slugValue.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const list = await client.list();
      const me = list.find((c) => c.slug === slugValue) ?? null;
      setCore(me);
      if ((me?.required_oauth_labels.length ?? 0) > 0) {
        try {
          const status = await client.oauthStatus();
          setOauthLabels(status.labels);
        } catch (err) {
          // Status may 404 if the OAuth surface isn't mounted on this
          // instance — surface the Core info without OAuth state in that
          // case.
          if (!(err instanceof CoresClientError) || err.status !== 401) {
            setOauthLabels([]);
          }
        }
      } else {
        setOauthLabels([]);
      }
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, [client, slugValue]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const handleConnect = useCallback(async () => {
    if (client === null || core === null) return;
    if (core.required_oauth_labels.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const started = await client.oauthStart(core.required_oauth_labels);
      await Linking.openURL(started.authorize_url);
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setBusy(false);
    }
  }, [client, core]);

  const handleDisconnect = useCallback(
    (label: string) => {
      if (client === null || core === null) return;
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
    [client, core, fetchAll],
  );

  const handleInstall = useCallback(async () => {
    if (client === null || core === null) return;
    setBusy(true);
    setError(null);
    try {
      await client.install(core.slug);
      await fetchAll();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setBusy(false);
    }
  }, [client, core, fetchAll]);

  const handleUninstall = useCallback(async () => {
    if (client === null || core === null) return;
    setBusy(true);
    setError(null);
    try {
      await client.uninstall(core.slug);
      await fetchAll();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setBusy(false);
    }
  }, [client, core, fetchAll]);

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }
  if (core === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.muted}>Core not found.</Text>
      </View>
    );
  }

  const needsOAuth = core.required_oauth_labels.length > 0;
  const labelStatusBy = new Map<string, OAuthStatusLabel>();
  for (const l of oauthLabels) labelStatusBy.set(l.label, l);
  const allConnected =
    needsOAuth &&
    core.required_oauth_labels.every((l) => labelStatusBy.get(l)?.connected === true);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="core-back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerIconBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerOverline}>Core</Text>
          <Text style={styles.headerTitle}>{core.display_name}</Text>
        </View>
        <View style={styles.headerIconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <Text style={styles.body}>
            {core.description.length > 0
              ? core.description
              : 'No description provided.'}
          </Text>
          <Text style={styles.meta}>
            {core.package_name} · v{core.package_version}
          </Text>
          <Text style={styles.meta}>State: {core.install_state}</Text>
          {core.install_error !== undefined ? (
            <Text style={styles.errorBody}>
              {core.install_error.code}: {core.install_error.message}
            </Text>
          ) : null}
        </View>

        {needsOAuth ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Google connection</Text>
            <Text style={styles.body}>
              This Core uses Google services. Connect your Google account to
              grant the scopes the Core declares; you can revoke access at any
              time from your Google account dashboard.
            </Text>
            {core.required_oauth_labels.map((label) => {
              const st = labelStatusBy.get(label);
              return (
                <View key={label} style={styles.oauthRow}>
                  <View style={styles.oauthRowLabel}>
                    <Text style={styles.oauthLabelTitle}>{label}</Text>
                    <Text style={styles.oauthLabelMeta}>
                      {st?.connected
                        ? `Connected${st.email !== null ? ` as ${st.email}` : ''}`
                        : 'Not connected'}
                    </Text>
                  </View>
                  {st?.connected ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Disconnect ${label}`}
                      testID={`core-disconnect-${label}`}
                      disabled={busy}
                      onPress={() => handleDisconnect(label)}
                      style={({ pressed }) => [
                        styles.dangerBtn,
                        busy && styles.btnDisabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.dangerBtnText}>Disconnect</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
            {!allConnected ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Connect Google"
                testID="core-connect-google"
                disabled={busy}
                onPress={() => void handleConnect()}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  busy && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryBtnText}>
                  {busy ? 'Opening browser…' : 'Connect Google'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tools</Text>
          {core.tools.length === 0 ? (
            <Text style={styles.muted}>This Core declares no tools.</Text>
          ) : null}
          {core.tools.map((t) => (
            <View key={t.name} style={styles.toolRow}>
              <Text style={styles.toolName}>{t.name}</Text>
              <Text style={styles.toolDescription}>{t.description}</Text>
              <Text style={styles.toolMeta}>{t.capability_required}</Text>
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Install</Text>
          <Text style={styles.body}>
            Bundled Cores auto-install at gateway boot. You can mark a Core
            uninstalled to remove it from the launcher; reinstall reverses the
            mark.
          </Text>
          <View style={styles.installRow}>
            {core.install_state === 'installed' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Uninstall"
                testID="core-uninstall"
                disabled={busy}
                onPress={() => void handleUninstall()}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  busy && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.secondaryBtnText}>
                  {busy ? 'Uninstalling…' : 'Uninstall'}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Install"
                testID="core-install"
                disabled={busy}
                onPress={() => void handleInstall()}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  busy && styles.btnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryBtnText}>
                  {busy ? 'Installing…' : 'Install'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
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
  container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 48 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#121212',
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  headerIcon: { color: '#e0e0e0', fontSize: 18, fontWeight: '600' },
  headerCenter: { flex: 1, paddingHorizontal: 4 },
  headerOverline: {
    color: '#7a7a7a',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 1 },
  scroll: { padding: 16, gap: 14 },
  section: {
    backgroundColor: '#121212',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 14,
    gap: 10,
  },
  sectionTitle: { color: '#fafafa', fontSize: 16, fontWeight: '700' },
  body: { color: '#bdbdbd', fontSize: 13, lineHeight: 18 },
  meta: { color: '#7a7a7a', fontSize: 12 },
  muted: { color: '#7a7a7a', fontSize: 13 },
  errorBody: { color: '#fecaca', fontSize: 12, fontFamily: 'Menlo' },
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
  oauthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 6,
  },
  oauthRowLabel: { flex: 1, gap: 2 },
  oauthLabelTitle: { color: '#e0e0e0', fontSize: 13, fontWeight: '600' },
  oauthLabelMeta: { color: '#9a9a9a', fontSize: 11 },
  primaryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    alignSelf: 'flex-start',
  },
  primaryBtnText: { color: '#0a0a0a', fontSize: 14, fontWeight: '600' },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    alignSelf: 'flex-start',
  },
  secondaryBtnText: { color: '#e0e0e0', fontSize: 13, fontWeight: '500' },
  dangerBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#7f1d1d',
  },
  dangerBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  toolRow: { gap: 2, paddingVertical: 4 },
  toolName: { color: '#e0e0e0', fontSize: 13, fontWeight: '600' },
  toolDescription: { color: '#9a9a9a', fontSize: 12, lineHeight: 16 },
  toolMeta: { color: '#7a7a7a', fontSize: 11, fontFamily: 'Menlo' },
  installRow: { flexDirection: 'row', gap: 8 },
});
