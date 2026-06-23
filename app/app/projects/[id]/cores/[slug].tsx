/**
 * @neutronai/app — generic Core TAB webview surface (WAVE 3 PR-3).
 *
 * Renders a Core-contributed `project_tab` (engine descriptor
 * `mount.kind === 'webview'`). The registry resolver hands the mobile shell a
 * descriptor whose `mount.target` is the Core's `project_tab` URL (already
 * `<project_id>`-substituted); `lib/project-tabs.ts:resolveTabRoute` routes
 * Core tabs here as `/projects/<id>/cores/<slug>?url=<encoded>&label=<encoded>`.
 *
 * This is the GENERIC fallback for any installed Core's tab — distinct from the
 * hand-built static `cores/dtc-analytics.tsx` (a concrete file route still
 * wins for its exact slug).
 *
 * ── Rendering the Core surface ──────────────────────────────────────────────
 * The Core surface is remote HTML, so it belongs in a webview/iframe:
 *   - WEB (`Platform.OS === 'web'`): an inline `<iframe>` (created via
 *     `createElement` since react-native-web has no iframe primitive). This is
 *     the true inline-webview experience the plan calls for.
 *   - NATIVE: the app does NOT depend on `react-native-webview` (adding it is a
 *     native module + rebuild — out of scope for this wiring PR on a
 *     memory-constrained box). So native opens the Core URL in the system
 *     browser via `expo-web-browser`, mirroring the existing OAuth handoff
 *     (`lib/auth.ts`). The inline-native webview is a documented follow-up.
 *
 * The URL is scheme-validated (`sanitizeCoreTabUrl`) before either path — a
 * malformed/hostile manifest entry renders an error state, never a live load.
 */

import { useLocalSearchParams } from 'expo-router';
import { createElement } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { sanitizeCoreTabUrl } from '../../../../lib/project-tabs';
import { SPACING, THEME, TYPOGRAPHY } from '../../../../lib/composer-constants';

export default function CoreTabScreen() {
  const { slug, url, label } = useLocalSearchParams<{
    slug: string;
    url?: string;
    label?: string;
  }>();
  const coreSlug = typeof slug === 'string' ? slug : '';
  const tabLabel = typeof label === 'string' && label.length > 0 ? label : coreSlug;
  const safeUrl = sanitizeCoreTabUrl(url);

  if (safeUrl === null) {
    return (
      <View style={[styles.container, styles.centered]} testID="core-tab-error">
        <Text style={styles.errorTitle}>Can’t open this Core tab</Text>
        <Text style={styles.errorBody}>
          {tabLabel} didn’t provide a valid web address. Reinstalling the Core
          may fix this.
        </Text>
      </View>
    );
  }

  // WEB — inline iframe (the real inline-webview surface).
  if (Platform.OS === 'web') {
    return (
      <View style={styles.container} testID="core-tab-webview">
        {createElement('iframe', {
          src: safeUrl,
          title: `${tabLabel} Core tab`,
          style: { border: 'none', width: '100%', height: '100%', flex: 1 },
        })}
      </View>
    );
  }

  // NATIVE — open in the system browser (no react-native-webview dependency).
  const openInBrowser = (): void => {
    void WebBrowser.openBrowserAsync(safeUrl);
  };

  return (
    <View style={[styles.container, styles.centered]} testID="core-tab-native">
      <Text style={styles.overline}>Core</Text>
      <Text style={styles.title}>{tabLabel}</Text>
      <Text style={styles.body}>
        This Core tab opens in your browser.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${tabLabel}`}
        testID="core-tab-open"
        onPress={openInBrowser}
        style={({ pressed }) => [styles.openBtn, pressed && styles.pressed]}
      >
        <Text style={styles.openBtnText}>Open {tabLabel} ↗</Text>
      </Pressable>
      <Text style={styles.urlHint} numberOfLines={1}>
        {safeUrl}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xxl,
    gap: SPACING.sm,
  },
  overline: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  body: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    textAlign: 'center',
  },
  openBtn: {
    marginTop: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md - SPACING.xs / 2,
    borderRadius: SPACING.md - SPACING.xs / 2,
    backgroundColor: THEME.text_primary,
  },
  openBtnText: {
    color: THEME.background,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '600',
  },
  urlHint: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    marginTop: SPACING.xs,
    maxWidth: '100%',
  },
  errorTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  errorBody: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    textAlign: 'center',
  },
  pressed: { opacity: 0.7 },
});
