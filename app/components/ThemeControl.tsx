/**
 * @neutronai/app — the light / dark / system control, for Settings.
 *
 * Owner request (2026-08-10): *"I want a light/dark/system toggle somewhere in
 * settings"*. The RN twin of `landing/chat-react/ThemeToggle.tsx`'s
 * `ThemeControl`, and deliberately the same SHAPE as it: a three-way segmented
 * control with the state named in words, not a cycling glyph. A cycle button is
 * fine as a secondary affordance on a desktop top bar (which is why the web has
 * one there too); as the ONLY control it makes the owner tap to discover what the
 * next state is.
 *
 * `System` carries the resolved scheme in its own label — "System (light)" — so
 * the reading of the control is never ambiguous about what is on screen. That
 * matters most for exactly the case the label exists for: the preference is
 * `system`, so the app's appearance is being decided somewhere else.
 *
 * Every segment is a real `Pressable` with an `accessibilityRole="radio"` and an
 * accessible name, so the reachability probe can PRESS it. A control whose value
 * is that the owner can reach it should be tested by reaching it, not by finding
 * it in a tree (CLAUDE.md rule 8).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, TYPOGRAPHY, type NeutronTheme, type ThemePreference } from '../lib/theme';
import { useThemeState, useThemedStyles } from '../lib/theme-context';

/** Display order. `System` first because it is the default. */
const OPTIONS: readonly ThemePreference[] = ['system', 'light', 'dark'];

function optionLabel(pref: ThemePreference): string {
  if (pref === 'light') return 'Light';
  if (pref === 'dark') return 'Dark';
  return 'System';
}

export function ThemeControl() {
  const styles = useThemedStyles(makeStyles);
  const { preference, scheme, setPreference } = useThemeState();

  return (
    <View style={styles.wrap} testID="settings-theme">
      <Text style={styles.title}>Appearance</Text>
      <Text style={styles.subtitle}>
        {preference === 'system'
          ? `Following your device — currently ${scheme}.`
          : `Always ${optionLabel(preference).toLowerCase()}, whatever your device is set to.`}
      </Text>
      <View style={styles.segmented} accessibilityRole="radiogroup">
        {OPTIONS.map((opt) => {
          const selected = preference === opt;
          const label = opt === 'system' ? `System (${scheme})` : optionLabel(opt);
          return (
            <Pressable
              key={opt}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={`Theme ${optionLabel(opt)}`}
              testID={`settings-theme-${opt}`}
              onPress={() => setPreference(opt)}
              style={({ pressed }) => [
                styles.segment,
                selected && styles.segmentOn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    wrap: {
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.md,
      gap: SPACING.sm,
    },
    title: {
      ...TYPOGRAPHY.h4,
      color: theme.text_primary,
    },
    subtitle: {
      ...TYPOGRAPHY.body_small,
      color: theme.text_muted,
    },
    segmented: {
      flexDirection: 'row',
      gap: SPACING.xs,
      marginTop: SPACING.xs,
    },
    segment: {
      flex: 1,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: SPACING.sm,
      borderRadius: DENSITY.banner_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.surface,
    },
    // The SELECTED segment is carried by hue, the same decision the rail's
    // selected row records: a neutral one step up reads as "raised", not as "this
    // one". `user_bubble` is the product's blue and `user_ink` is what is legible
    // on it in both themes, which is exactly the pair this needs.
    segmentOn: {
      backgroundColor: theme.user_bubble,
      borderColor: theme.user_bubble,
    },
    segmentText: {
      ...TYPOGRAPHY.body_small,
      color: theme.text_secondary,
      fontWeight: '600',
    },
    segmentTextOn: {
      color: theme.user_ink,
    },
    pressed: { opacity: 0.7 },
  });
