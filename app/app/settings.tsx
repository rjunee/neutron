/**
 * @neutronai/app — top-level Settings route (P5.0).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 4.6 + § 5.2:
 *
 *   "Settings" header. Card showing current user (avatar placeholder
 *   + displayName + email + provider tag). "Sign out" button. P5.0
 *   lists nothing else; future sprints add personality / push toggles
 *   / connector management here.
 *
 * Focus + Settings live OUTSIDE the per-project tab bar per § B.P5 of
 * the engineering plan ("Focus is a projection, not a source of
 * truth"). Project-scoped settings live in the per-project settings
 * drawer; the GLOBAL settings live here.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { signOut } from '../lib/auth';
import { shouldRedirectToLogin } from '../lib/auth-helpers';
import { loadAppConfig } from '../lib/config';
import { disablePushForUser } from '../lib/push';
import { useAuthSession } from '../lib/session';
import { THEME } from '../lib/theme';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, status, clear } = useAuthSession();

  useEffect(() => {
    // Only redirect to /login once the session provider has finished
    // hydrating — otherwise a fresh page-load on /settings bounces to
    // /login during the first paint even when a token exists in
    // persistent storage. Shared guard (see app/integrations.tsx).
    if (shouldRedirectToLogin({ status, user })) {
      router.replace('/login');
    }
  }, [router, status, user]);

  const handleSignOut = useCallback(async () => {
    // Best-effort push-binding revocation BEFORE clearing auth state.
    // Mirrors the same call from `app/projects/index.tsx` — the
    // revocation POST is bearer-authenticated, so it has to fire
    // while the current `user.token` is still valid.
    if (user !== null) {
      try {
        const cfg = loadAppConfig();
        await disablePushForUser({ base_url: cfg.base_url, token: user.token });
      } catch (err) {
        console.warn('[push] unexpected error during disable', err);
      }
    }
    await signOut();
    clear();
    router.replace('/login');
  }, [clear, router, user]);

  if (user === null) {
    // Either hydrating from storage (first paint after a refresh) or
    // genuinely signed out — show a neutral loading state. The
    // useEffect above handles the actual redirect once `status === 'ready'`.
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
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerIconBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerOverline}>Settings</Text>
          <Text style={styles.headerTitle}>Account</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.userCard} testID="settings-user-card">
          <View style={styles.avatar} accessibilityElementsHidden>
            <Text style={styles.avatarInitial}>{initial(user.displayName)}</Text>
          </View>
          <View style={styles.userText}>
            <Text style={styles.userName} numberOfLines={1}>
              {user.displayName}
            </Text>
            <Text style={styles.userEmail} numberOfLines={1}>
              {user.email}
            </Text>
            <View style={styles.providerBadge}>
              <Text style={styles.providerBadgeText}>{user.provider.toUpperCase()}</Text>
            </View>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Integrations"
          testID="settings-integrations"
          onPress={() => router.push('/integrations')}
          style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
        >
          <View style={styles.navRowText}>
            <Text style={styles.navRowTitle}>Integrations</Text>
            <Text style={styles.navRowSubtitle}>
              Google accounts + API keys your Cores connect to.
            </Text>
          </View>
          <Text style={styles.navRowChevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          testID="settings-sign-out"
          onPress={handleSignOut}
          style={({ pressed }) => [
            styles.signOutBtn,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>

        <Text style={styles.footnote}>
          Personality and push toggles land in future P5.x sprints.
        </Text>
      </ScrollView>
    </View>
  );
}

function initial(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  return trimmed.slice(0, 1).toUpperCase();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, paddingTop: 48 },
  centered: { alignItems: 'center', justifyContent: 'center' },
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
  pressed: { opacity: 0.7 },
  body: { padding: 16, gap: 16 },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: THEME.surface_raised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  avatarInitial: {
    color: THEME.text_primary,
    fontSize: 22,
    fontWeight: '700',
  },
  userText: { flex: 1, gap: 2 },
  userName: { color: THEME.text_primary, fontSize: 17, fontWeight: '600' },
  userEmail: { color: THEME.text_secondary, fontSize: 13 },
  providerBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
    marginTop: 4,
  },
  providerBadgeText: {
    color: THEME.text_secondary,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  navRowText: { flex: 1, gap: 3 },
  navRowTitle: { color: THEME.text_primary, fontSize: 15, fontWeight: '600' },
  navRowSubtitle: { color: THEME.text_secondary, fontSize: 12, lineHeight: 16 },
  navRowChevron: { color: THEME.text_muted, fontSize: 22, fontWeight: '400' },
  signOutBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.danger,
  },
  signOutText: { color: THEME.danger, fontSize: 15, fontWeight: '600' },
  footnote: {
    color: THEME.text_muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 16,
  },
});
