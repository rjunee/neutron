/**
 * @neutronai/app — pure global Focus header (P5.6).
 *
 *   TODAY
 *   Focus                           [ Refresh ] [ Projects ] [ Sign out ]
 *
 * Overline (`TODAY`) + title (`Focus`) on the left; right group hosts
 * three buttons:
 *
 *   - **Refresh** — the web equivalent of pull-to-refresh; web has no
 *     native pull gesture and the header button is the canonical web
 *     refresh affordance. Visible on all platforms (deliberate double
 *     affordance — native pull + header button both call the same
 *     provider `refresh()` action). When `refreshing === true` the
 *     button renders an ActivityIndicator + `accessibilityState=
 *     {{busy: true}}` so the busy state is announced.
 *   - **Projects** — opens the project launcher at `/projects`.
 *   - **Sign out** — clears the session + routes to `/login`.
 *
 * No state lives here; the parent route file wires the
 * `useFocusState().refresh` + sign-out + projects-link callbacks.
 * Every visual sources from `lib/theme.ts` tokens.
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface FocusHeaderProps {
  refreshing: boolean;
  onRefresh: () => void;
  onProjectsLink: () => void;
  onSignOut: () => void;
}

export function FocusHeader({
  refreshing,
  onRefresh,
  onProjectsLink,
  onSignOut,
}: FocusHeaderProps) {
  return (
    <View style={styles.header} testID="focus-header">
      <View style={styles.intro}>
        <Text style={styles.overline}>Today</Text>
        <Text style={styles.title} accessibilityRole="header">
          Focus
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh"
          accessibilityState={{ busy: refreshing }}
          testID="focus-refresh-btn"
          disabled={refreshing}
          onPress={onRefresh}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        >
          {refreshing ? (
            <ActivityIndicator
              color={THEME.text_secondary}
              size="small"
              testID="focus-refresh-busy"
            />
          ) : (
            <Text style={styles.btnText}>Refresh</Text>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Projects"
          testID="focus-projects-btn"
          onPress={onProjectsLink}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        >
          <Text style={styles.btnText}>Projects</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          testID="focus-signout-btn"
          onPress={onSignOut}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        >
          <Text style={styles.btnText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
    gap: SPACING.md,
  },
  intro: { flex: 1, gap: SPACING.xs / 2 },
  overline: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h1.fontSize,
    lineHeight: TYPOGRAPHY.h1.lineHeight,
    fontWeight: TYPOGRAPHY.h1.fontWeight,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  btn: {
    paddingHorizontal: SPACING.md - 2,
    paddingVertical: SPACING.xs + 2,
    borderRadius: DENSITY.banner_radius,
    borderWidth: 1,
    borderColor: THEME.hairline,
    backgroundColor: THEME.surface_raised,
    minWidth: 56,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: { opacity: 0.78 },
  btnText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
  },
});
