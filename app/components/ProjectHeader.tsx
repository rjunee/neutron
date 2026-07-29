/**
 * @neutronai/app — project header bar (P5.2).
 *
 * Sticky header sitting above `<ProjectTabBar>` and the tab content
 * area. Three children, row-aligned:
 *
 *   - Left: back-arrow button (48×48 hit target). Tap → onBack().
 *   - Center: PROJECT overline + project name (one-line, truncating).
 *   - Right: settings gear button (48×48 hit target). Tap → onOpenSettings().
 *
 * Pure presentation. Reads theme tokens from `lib/theme.ts`; no
 * inline magic numbers. Reused by P5.5 (global Focus shell) and P5.7
 * (admin project detail) when those land.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';

export interface ProjectHeaderProps {
  /** Display name rendered as the header title. */
  name: string;
  /** Optional overline text — defaults to "PROJECT". */
  overline?: string;
  /** Back-arrow handler. Required so the layout can wire router.replace. */
  onBack: () => void;
  /** Settings-gear handler. Required so the layout can flip the drawer open. */
  onOpenSettings: () => void;
  /**
   * Invite handler (M2.4). When provided, an "Invite" pill renders
   * left of the settings gear. Omit it on surfaces where inviting
   * doesn't apply.
   */
  onInvite?: () => void;
}

export function ProjectHeader({
  name,
  overline = 'PROJECT',
  onBack,
  onOpenSettings,
  onInvite,
}: ProjectHeaderProps) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to projects"
        testID="project-header-back"
        onPress={onBack}
        style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        hitSlop={SPACING.sm}
      >
        <Text style={styles.iconGlyph}>←</Text>
      </Pressable>
      <View style={styles.center}>
        <Text style={styles.overline} numberOfLines={1}>
          {overline}
        </Text>
        <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
          {name}
        </Text>
      </View>
      {onInvite !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Invite to project"
          testID="project-header-invite"
          onPress={onInvite}
          style={({ pressed }) => [styles.invitePill, pressed && styles.pressed]}
          hitSlop={SPACING.sm}
        >
          <Text style={styles.inviteLabel}>Invite</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open project settings"
        testID="project-header-settings"
        onPress={onOpenSettings}
        style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        hitSlop={SPACING.sm}
      >
        <Text style={styles.iconGlyph}>☰</Text>
      </Pressable>
    </View>
  );
}

const ICON_BTN_SIZE = 40;
const ICON_HIT_SIZE = 48;

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.md,
    gap: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
    backgroundColor: THEME.background,
    minHeight: ICON_HIT_SIZE,
  },
  iconBtn: {
    width: ICON_BTN_SIZE,
    height: ICON_BTN_SIZE,
    borderRadius: DENSITY.composer_radius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  iconGlyph: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  invitePill: {
    height: ICON_BTN_SIZE,
    paddingHorizontal: SPACING.md,
    borderRadius: DENSITY.chip_radius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  inviteLabel: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '600',
  },
  center: { flex: 1, paddingHorizontal: SPACING.xs },
  overline: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
    letterSpacing: 1,
  },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
    marginTop: 1,
  },
  pressed: { opacity: 0.7 },
});
