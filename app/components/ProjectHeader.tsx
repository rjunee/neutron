/**
 * @neutronai/app — project header bar (P5.2).
 *
 * Sticky header sitting above `<ProjectTabBar>` and the tab content
 * area. Three children, row-aligned:
 *
 *   - Left: the project name (one-line, truncating).
 *   - Right: ONE menu button (48×48 hit target) → project settings + app settings.
 *
 * ── TWO OWNER ASKS, ONE HEADER ───────────────────────────────────────────────
 *
 * *"Remove the word 'project' from the top of the screen. Just display the name of
 * the project. And use this to recover some vertical space."* The overline said
 * PROJECT above every project name, which is the one thing the owner already knows
 * — he tapped the project to get here. It cost a full line of a header that sits
 * above every screen, on the axis a phone has least of.
 *
 * *"Why are there two hamburger menus, top left and top right? We need to
 * consolidate, and keep only top-right."* Both slots rendered the SAME ☰ glyph for
 * DIFFERENT scopes — left was app-level, right was this project — so the icon
 * carried no information and the only way to learn which was which was to tap one.
 * Now there is one control and the scopes are named in a menu, which is where a
 * distinction belongs: in words, not in two identical glyphs at opposite ends.
 *
 * The app-settings entry MOVED INTO THE MENU rather than being dropped. It is the
 * only signed-in path to the server editor, sign-out and Admin (ISSUES #385,
 * guarded by `__tests__/server-editor-reachability.test.ts`), and a consolidation
 * that quietly stranded it would recreate that exact defect.
 *
 * THE LEFT SLOT USED TO BE A BACK ARROW TO THE PROJECTS LIST. That list screen
 * is deleted (SPEC § Decisions Log 2026-07-27 — the app opens straight into chat
 * and the RAIL is the switcher), which left "back" with nowhere to go and left
 * `/settings` + `/admin` with no entry point at all: the list header was the only
 * place in the app that pushed either (the exact ISSUES #385 defect class, now
 * guarded by `__tests__/server-editor-reachability.test.ts`). So the slot became
 * the app-level entry instead of a second, redundant route to General — the rail's
 * General tile already goes there.
 *
 * Pure presentation. Reads theme tokens from `lib/theme.ts`; no
 * inline magic numbers. Reused by P5.5 (global Focus shell) and P5.7
 * (admin project detail) when those land.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';

export interface ProjectHeaderProps {
  /** Display name rendered as the header title. */
  name: string;
  /**
   * App-settings handler (left slot). Required so the layout can wire
   * `router.push('/settings')` — the only signed-in server editor + sign-out +
   * Admin entry, which must never be unreachable (ISSUES #385).
   */
  onOpenAppSettings: () => void;
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
  onOpenAppSettings,
  onOpenSettings,
  onInvite,
}: ProjectHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  /** Close first, THEN act: the menu must not survive the navigation it triggered. */
  const choose = (run: () => void) => () => {
    setMenuOpen(false);
    run();
  };
  return (
    <View style={styles.header}>
      <View style={styles.center}>
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
        accessibilityLabel="Open menu"
        accessibilityState={{ expanded: menuOpen }}
        testID="project-header-menu"
        onPress={() => setMenuOpen((open) => !open)}
        style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        hitSlop={SPACING.sm}
      >
        <Text style={styles.iconGlyph}>☰</Text>
      </Pressable>
      {menuOpen ? (
        <>
          {/* A tap anywhere else dismisses. Rendered BEFORE the sheet so the sheet
              sits above it, and covering the whole screen because a menu that can
              only be closed by re-tapping its own button is a trap on a phone. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            testID="project-header-menu-scrim"
            onPress={() => setMenuOpen(false)}
            style={styles.scrim}
          />
          <View style={styles.menu} testID="project-header-menu-sheet">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open project settings"
              testID="project-header-settings"
              onPress={choose(onOpenSettings)}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
            >
              <Text style={styles.menuLabel}>Project settings</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            {/* ISSUES #385 — the ONLY signed-in route to the server editor,
                sign-out and Admin. It moved here; it was never dropped. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open app settings"
              testID="project-header-app-settings"
              onPress={choose(onOpenAppSettings)}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
            >
              <Text style={styles.menuLabel}>App settings</Text>
            </Pressable>
          </View>
        </>
      ) : null}
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
    // Recovered vertical space, half of the owner's ask. The other half was the
    // overline's whole line, now gone.
    paddingBottom: SPACING.xs,
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
  /** Full-screen dismiss target. Behind the sheet, above everything else. */
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: -2000,
  },
  menu: {
    position: 'absolute',
    top: ICON_BTN_SIZE + SPACING.xs,
    right: SPACING.sm,
    minWidth: 180,
    borderRadius: DENSITY.composer_radius,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
    overflow: 'hidden',
  },
  menuRow: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  menuLabel: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  menuDivider: { height: 1, backgroundColor: THEME.hairline },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  pressed: { opacity: 0.7 },
});
