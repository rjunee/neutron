/**
 * @neutronai/app — admin tab (P5.7).
 *
 * Per SPEC.md § Phases→Steps / P5.7 — Personality
 * edit, gateway reboot (Open-tier), GBrain browse, connector admin.
 *
 * Structured as one top-level screen with horizontal sub-tabs so the
 * user can cycle without bouncing through router state. Each sub-tab
 * is a pure component that fetches the relevant slice from the
 * `/api/app/admin/*` surface on mount.
 *
 * Current sub-tabs:
 *   - Personality / Gateway / GBrain / Cores / Backup (P5.7 + P7.4)
 *   - Max account (2026-06-01 switch-Max-account sprint) — lets an
 *     already-onboarded owner swap their attached Claude Max
 *     credential to a different Anthropic account without operator
 *     SQL. Calls `AdminClient.mintMaxReauthToken()` to get a fresh
 *     identity-side paste URL and opens it in the browser.
 *
 * Implementation notes:
 *   - Server is authoritative; every PUT/POST round-trips and the
 *     response replaces local state.
 *   - The Gateway tab confirms before signalling the restart (one
 *     mis-tap could otherwise drop the user's session).
 *   - GBrain + Connectors render an empty-state banner when the
 *     surface returns `configured: false` (Open self-hosters without
 *     a GBrain MCP wired, or a fresh instance before Cores
 *     install).
 */

import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useEffect } from 'react';

import { loadAppConfig } from '../lib/config';
import { useAuthSession } from '../lib/session';
import { AdminClient } from '../lib/admin-client';
import { AdminPersonalityClient } from '../lib/admin-personality-client';
import { CoresClient } from '../lib/cores-client';
import { PersonalityPane } from '../features/admin/PersonalityPane';
import { GatewayPane } from '../features/admin/GatewayPane';
import { MemoryPane } from '../features/admin/MemoryPane';
import { CoresPane } from '../features/admin/CoresPane';
import { BackupPane } from '../features/admin/BackupPane';
import { MaxAccountPane } from '../features/admin/MaxAccountPane';

type AdminPaneKey =
  | 'personality'
  | 'gateway'
  | 'memory'
  | 'cores'
  | 'backup'
  | 'maxAccount';

interface PaneSpec {
  key: AdminPaneKey;
  label: string;
}

const PANES: ReadonlyArray<PaneSpec> = [
  { key: 'personality', label: 'Personality' },
  { key: 'gateway', label: 'Gateway' },
  { key: 'memory', label: 'Memory' },
  { key: 'cores', label: 'Cores' },
  { key: 'backup', label: 'Backup' },
  { key: 'maxAccount', label: 'Max account' },
];

export default function AdminScreen() {
  const router = useRouter();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const client = useMemo(() => {
    if (user === null) return null;
    return new AdminClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);
  const coresClient = useMemo(() => {
    if (user === null) return null;
    return new CoresClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);
  const personaClient = useMemo(() => {
    if (user === null) return null;
    return new AdminPersonalityClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [active, setActive] = useState<AdminPaneKey>('personality');

  useEffect(() => {
    if (user === null) router.replace('/login');
  }, [router, user]);

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to projects"
          testID="admin-back"
          onPress={() => router.replace('/projects')}
          style={({ pressed }) => [styles.headerIconBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerOverline}>Admin</Text>
          <Text style={styles.headerTitle}>Settings</Text>
        </View>
        <View style={styles.headerIconBtn} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBarContent}
        style={styles.tabBar}
      >
        {PANES.map((pane) => {
          const isActive = pane.key === active;
          return (
            <Pressable
              key={pane.key}
              accessibilityRole="tab"
              accessibilityLabel={`${pane.label} pane`}
              accessibilityState={{ selected: isActive }}
              testID={`admin-tab-${pane.key}`}
              onPress={() => setActive(pane.key)}
              style={({ pressed }) => [
                styles.tabItem,
                isActive && styles.tabItemActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{pane.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.paneContent}>
        {client === null ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#cfcfcf" />
          </View>
        ) : active === 'personality' ? (
          personaClient !== null ? (
            <PersonalityPane client={personaClient} />
          ) : (
            <View style={styles.centered}>
              <ActivityIndicator color="#cfcfcf" />
            </View>
          )
        ) : active === 'gateway' ? (
          <GatewayPane client={client} />
        ) : active === 'memory' ? (
          <MemoryPane client={client} />
        ) : active === 'backup' ? (
          <BackupPane client={client} />
        ) : active === 'maxAccount' ? (
          <MaxAccountPane client={client} />
        ) : coresClient !== null ? (
          <CoresPane client={coresClient} router={router} />
        ) : (
          <View style={styles.centered}>
            <ActivityIndicator color="#cfcfcf" />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 48 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  pressed: { opacity: 0.7 },
  tabBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  tabBarContent: { paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  tabItem: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'transparent',
  },
  tabItemActive: { backgroundColor: '#1a1a1a' },
  tabLabel: { color: '#888', fontSize: 13, fontWeight: '500' },
  tabLabelActive: { color: '#fafafa', fontWeight: '600' },
  paneContent: { flex: 1 },
});
