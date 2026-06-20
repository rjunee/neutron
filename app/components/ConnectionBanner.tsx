/**
 * @neutronai/app — connection-state sticky banner (P5.1).
 *
 * Renders at the top of the chat region. Three states:
 *   - connected: no banner.
 *   - disconnected / reconnecting (sticky after 2s): yellow banner.
 *   - auth_failed: red banner with a Sign out button + dev-token hint.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppWsClientState } from '../lib/ws-client';
import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';

const STALL_THRESHOLD_MS = 2_000;

export interface ConnectionBannerProps {
  wsState: AppWsClientState;
  onSignOut?: () => void;
}

declare const __DEV__: boolean | undefined;

export function ConnectionBanner({ wsState, onSignOut }: ConnectionBannerProps) {
  const [showStall, setShowStall] = useState(false);

  useEffect(() => {
    if (wsState === 'disconnected' || wsState === 'reconnecting') {
      const t = setTimeout(() => setShowStall(true), STALL_THRESHOLD_MS);
      return () => clearTimeout(t);
    }
    setShowStall(false);
    return undefined;
  }, [wsState]);

  if (wsState === 'auth_failed') {
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__ === true;
    return (
      <View style={[styles.banner, styles.bannerDanger]} accessibilityLabel="Auth failed">
        <View style={styles.bannerBody}>
          <Text style={styles.bannerText}>
            Auth failed. Your session may have expired — sign out and back in.
          </Text>
          {isDev ? (
            <Text style={styles.bannerHint}>
              Dev: paste a dev token via /login with `NEUTRON_APP_WS_BYPASS=1` on the gateway.
            </Text>
          ) : null}
        </View>
        {onSignOut !== undefined ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={onSignOut}
            style={({ pressed }) => [styles.signOutBtn, pressed && styles.pressed]}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (wsState === 'connected') return null;
  if (wsState === 'connecting' && !showStall) return null;
  if ((wsState === 'disconnected' || wsState === 'reconnecting') && !showStall) return null;

  return (
    <View style={[styles.banner, styles.bannerWarn]} accessibilityLabel="Connection lost">
      <Text style={styles.bannerText}>Connection lost. Reconnecting…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: DENSITY.banner_radius,
    marginHorizontal: SPACING.md,
    marginTop: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  bannerWarn: {
    backgroundColor: '#3d2d10',
    borderWidth: 1,
    borderColor: THEME.warning,
  },
  bannerDanger: {
    backgroundColor: '#3a1414',
    borderWidth: 1,
    borderColor: THEME.danger,
  },
  bannerBody: {
    flex: 1,
    gap: SPACING.xs,
  },
  bannerText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_primary,
    fontWeight: '600',
  },
  bannerHint: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_secondary,
  },
  signOutBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
    borderRadius: 8,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  signOutText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.danger,
    fontWeight: '700',
  },
  pressed: { opacity: 0.7 },
});
