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
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, TYPOGRAPHY, type NeutronTheme } from '../lib/composer-constants';
import { useThemedStyles } from '../lib/theme-context';

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
  const styles = useThemedStyles(makeStyles);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Close first, THEN act: the menu must not survive the navigation it triggered. */
  const choose = (run: () => void) => () => {
    setMenuOpen(false);
    run();
  };
  return (
    <View style={styles.header}>
      {/* THE MARK, leading the bar. Owner: "put the neutron logo in the top left
          corner of the app, before the project name in the title rail." Deliberately
          NOT a button — the rail's General tile is already the way home, and a
          tappable logo would be a second, ambiguous navigation affordance in a bar
          that just had one control removed from it for exactly that reason.
          `accessibilityRole="image"` with a label rather than `none`, so a screen
          reader announces the app it is in instead of skipping a silent graphic. */}
      <Image
        source={require('../assets/images/icon.png')}
        style={styles.logo}
        resizeMode="contain"
        accessibilityRole="image"
        accessibilityLabel="Neutron"
        testID="project-header-logo"
      />
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
      {/* RENDERED IN A MODAL, AND THIS IS A BUG FIX, NOT A STYLE CHOICE.
          
          The first version was an absolutely-positioned sibling inside this header,
          opening BELOW the header's own box. On Android a child that falls outside
          its parent's bounds is CLIPPED regardless of `overflow` — the platform has
          no reliable equivalent of `overflow: visible` — so on device the button
          fired, the sheet mounted, and nothing was visible. Owner: "the hamburger in
          the top right is not tappable, it doesnt work." It was tappable; its output
          was being clipped away, which is indistinguishable from a dead control.
          
          A Modal renders in its OWN window, so there is no ancestor to clip it. That
          is the whole reason for it — not the backdrop, not the animation. Nudging
          offsets or hoisting the sheet up a level would have made it fit THIS layout
          and broken again on the next one.
          
          Note this also fixes it on iOS-in-theory: the sheet was never clipped
          there, so a simulator would have shown it working perfectly. A test that
          asserts on the rendered tree cannot see clipping either, which is why my
          existing menu test passed while the feature was dead on the only platform
          the owner uses. */}
      {/* The Modal is MOUNTED ONLY WHEN OPEN, not merely made invisible. A Modal with
          `visible={false}` still renders its children into the tree on web, so
          "closed" would become "present but hidden" — and every assertion about the
          menu being closed would pass against a menu that is actually there. Keeping
          the mount conditional makes closed mean ABSENT, which is both the honest
          state and the cheaper one. */}
      {menuOpen ? (
      <Modal
        visible
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
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
      </Modal>
      ) : null}
    </View>
  );
}

const ICON_BTN_SIZE = 40;
const ICON_HIT_SIZE = 48;
/** The logo reads as a mark beside the title, not as a second tap target. */
const LOGO_SIZE = 26;
/**
 * How far the header's content sits from the top of the WINDOW. The menu is now a
 * Modal, so it anchors to the window and needs this; the header itself is laid out
 * by the safe-area provider above it. Approximates the status-bar inset — a few
 * pixels either way is invisible on a dropdown, and reading the real inset here
 * would mean threading a hook through a pure presentational component.
 */
const HEADER_TOP_INSET = 44;

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.sm,
      // Recovered vertical space, half of the owner's ask. The other half was the
      // overline's whole line, now gone.
      paddingBottom: SPACING.xs,
      gap: SPACING.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
      backgroundColor: theme.background,
      minHeight: ICON_HIT_SIZE,
    },
    iconBtn: {
      width: ICON_BTN_SIZE,
      height: ICON_BTN_SIZE,
      borderRadius: DENSITY.composer_radius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    iconGlyph: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.h3.fontSize,
      fontWeight: TYPOGRAPHY.h3.fontWeight,
    },
    invitePill: {
      height: ICON_BTN_SIZE,
      paddingHorizontal: SPACING.md,
      borderRadius: DENSITY.chip_radius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    inviteLabel: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      fontWeight: '600',
    },
    logo: {
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      borderRadius: 6,
    },
    center: { flex: 1, paddingHorizontal: SPACING.xs },
    /**
     * Full-screen dismiss target. Inside the Modal it can simply fill the window —
     * the previous `bottom: -2000` existed only to escape the header's box, which is
     * the hack the Modal removes.
     */
    scrim: {
      ...StyleSheet.absoluteFillObject,
    },
    menu: {
      position: 'absolute',
      // Anchored to the window now, not to the header, so it lands just under the
      // control. The header's own height plus a hair — kept as a named sum rather
      // than a magic number so it tracks the button size.
      top: HEADER_TOP_INSET + ICON_BTN_SIZE + SPACING.xs,
      right: SPACING.sm,
      minWidth: 180,
      borderRadius: DENSITY.composer_radius,
      backgroundColor: theme.surface_raised,
      borderWidth: 1,
      borderColor: theme.hairline,
      overflow: 'hidden',
    },
    menuRow: {
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.md,
    },
    menuLabel: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    menuDivider: { height: 1, backgroundColor: theme.hairline },
    title: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.h3.fontSize,
      lineHeight: TYPOGRAPHY.h3.lineHeight,
      fontWeight: TYPOGRAPHY.h3.fontWeight,
    },
    pressed: { opacity: 0.7 },
  });
