/**
 * @neutronai/app — admin tab, Cores pane.
 *
 * Bundled Tier 1 Cores. Tap a Core to open its setup screen — connect
 * OAuth, view tools, install / uninstall.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CoresClient, type CoreSummary } from '../../lib/cores-client';
import { formatCoresError } from './format';

export function CoresPane({
  client,
  router,
}: {
  client: CoresClient;
  router: ReturnType<typeof useRouter>;
}) {
  const [cores, setCores] = useState<CoreSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await client.list();
      setCores(list);
    } catch (err) {
      setError(formatCoresError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const handleInstall = useCallback(
    async (slug: string) => {
      setPendingSlug(slug);
      try {
        await client.install(slug);
        await fetchAll();
      } catch (err) {
        setError(formatCoresError(err));
      } finally {
        setPendingSlug(null);
      }
    },
    [client, fetchAll],
  );

  const handleUninstall = useCallback(
    async (slug: string) => {
      setPendingSlug(slug);
      try {
        await client.uninstall(slug);
        await fetchAll();
      } catch (err) {
        setError(formatCoresError(err));
      } finally {
        setPendingSlug(null);
      }
    },
    [client, fetchAll],
  );

  const handleOpenCore = useCallback(
    (slug: string) => {
      router.push(`/cores/${slug}`);
    },
    [router],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Cores</Text>
        <Text style={styles.paneSubtitle}>
          Bundled Tier 1 Cores. Tap a Core to open its setup screen — connect
          OAuth, view tools, install / uninstall.
        </Text>
      </View>

      {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}

      {cores !== null && cores.length === 0 ? (
        <Text style={styles.muted}>No Cores discovered.</Text>
      ) : null}

      {(cores ?? []).map((c) => (
        <CoreRow
          key={c.slug}
          core={c}
          busy={pendingSlug === c.slug}
          onInstall={() => void handleInstall(c.slug)}
          onUninstall={() => void handleUninstall(c.slug)}
          onOpen={() => handleOpenCore(c.slug)}
        />
      ))}
    </ScrollView>
  );
}

function CoreRow({
  core,
  busy,
  onInstall,
  onUninstall,
  onOpen,
}: {
  core: CoreSummary;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onOpen: () => void;
}) {
  const isInstalled = core.install_state === 'installed';
  const isFailed =
    core.install_state === 'failed' ||
    core.install_state === 'install_failed_runtime' ||
    core.install_state === 'install_failed_dependency_missing';
  const needsOAuth =
    isFailed && core.required_oauth_labels.length > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${core.display_name} Core`}
      testID={`admin-core-${core.slug}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.coreCard, pressed && styles.pressed]}
    >
      <View style={styles.coreHeaderRow}>
        <Text style={styles.coreTitle}>{core.display_name}</Text>
        <CoreStateBadge state={core.install_state} />
      </View>
      {core.description.length > 0 ? (
        <Text style={styles.coreDescription}>{core.description}</Text>
      ) : null}
      {core.install_error !== undefined ? (
        <Text style={styles.coreError}>
          {core.install_error.code}: {core.install_error.message}
        </Text>
      ) : null}
      <View style={styles.coreActionsRow}>
        {needsOAuth ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Connect ${core.display_name}`}
            testID={`admin-core-${core.slug}-connect`}
            onPress={onOpen}
            style={({ pressed }) => [
              styles.primaryActionBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryActionBtnText}>Connect</Text>
          </Pressable>
        ) : isInstalled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Uninstall ${core.display_name}`}
            testID={`admin-core-${core.slug}-uninstall`}
            disabled={busy}
            onPress={onUninstall}
            style={({ pressed }) => [
              styles.secondaryActionBtn,
              busy && styles.actionBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryActionBtnText}>
              {busy ? 'Uninstalling…' : 'Uninstall'}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Install ${core.display_name}`}
            testID={`admin-core-${core.slug}-install`}
            disabled={busy}
            onPress={onInstall}
            style={({ pressed }) => [
              styles.primaryActionBtn,
              busy && styles.actionBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryActionBtnText}>
              {busy ? 'Installing…' : 'Install'}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${core.display_name}`}
          testID={`admin-core-${core.slug}-open`}
          onPress={onOpen}
          style={({ pressed }) => [styles.tertiaryActionBtn, pressed && styles.pressed]}
        >
          <Text style={styles.tertiaryActionBtnText}>Open</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function CoreStateBadge({ state }: { state: CoreSummary['install_state'] }) {
  const label = stateLabel(state);
  const style =
    state === 'installed'
      ? styles.coreBadgeOk
      : state === 'not_installed'
        ? styles.coreBadgeNeutral
        : styles.coreBadgeWarn;
  return <Text style={[styles.coreBadge, style]}>{label}</Text>;
}

function stateLabel(state: CoreSummary['install_state']): string {
  switch (state) {
    case 'installed':
      return 'Installed';
    case 'not_installed':
      return 'Not installed';
    case 'failed':
      return 'Setup required';
    case 'install_failed_runtime':
      return 'Reconnect';
    case 'install_failed_dependency_missing':
      return 'Disconnected';
    default:
      return state;
  }
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  paneScroll: { padding: 16, gap: 12 },
  intro: { gap: 6, marginBottom: 8 },
  paneTitle: { color: '#fafafa', fontSize: 22, fontWeight: '700' },
  paneSubtitle: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
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
  muted: { color: '#7a7a7a', fontSize: 13 },
  coreCard: {
    backgroundColor: '#121212',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 14,
    gap: 8,
  },
  coreHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  coreTitle: { color: '#fafafa', fontSize: 16, fontWeight: '700' },
  coreDescription: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
  coreError: { color: '#fecaca', fontSize: 11, fontFamily: 'Menlo' },
  coreActionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  primaryActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#ffffff',
  },
  primaryActionBtnText: { color: '#0a0a0a', fontSize: 13, fontWeight: '600' },
  secondaryActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  secondaryActionBtnText: { color: '#e0e0e0', fontSize: 13, fontWeight: '500' },
  tertiaryActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  tertiaryActionBtnText: { color: '#9a9a9a', fontSize: 13, fontWeight: '500' },
  actionBtnDisabled: { opacity: 0.5 },
  coreBadge: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  coreBadgeOk: { color: '#bbf7d0', backgroundColor: '#0f2418' },
  coreBadgeNeutral: { color: '#bdbdbd', backgroundColor: '#1f1f1f' },
  coreBadgeWarn: { color: '#fed7aa', backgroundColor: '#3b1d12' },
  pressed: { opacity: 0.7 },
});
