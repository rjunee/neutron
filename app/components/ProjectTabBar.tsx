/**
 * @neutronai/app — project tab bar (P5.2; registry-driven WAVE 3 PR-3).
 *
 * Renders whatever ordered tab set the layout hands it. The set is
 * REGISTRY-DRIVEN: the layout fetches `GET /api/app/projects/<id>/tabs`
 * (engine resolver — `tabs/registry.ts`) and feeds the resolved descriptors
 * in via the `tabs` prop. {@link PROJECT_TABS} (the legacy hardcoded 5-tab
 * set) survives ONLY as the pre-fetch loading default. Two layouts:
 *
 *   - Narrow (`<800` CSS px) OR any native target: horizontal
 *     scrollable strip below the project header. Each tab is a pill.
 *   - Wide (≥800px AND `Platform.OS === 'web'`): 200px-wide vertical
 *     sidebar on the left of the tab content area. Each tab is a full-
 *     width row.
 *
 * BOTH layouts USED TO terminate in the usage meter, and neither may draw it now:
 * the owner asked for that reading to sit above the message input instead ("move
 * the hairline session status bar to instead be on the top of the message input
 * box, rather than at the top of the screen"), so it is published by the composer
 * dock and this component no longer takes a `usage` prop at all. The narrow band
 * therefore draws its own bottom hairline again — it had stopped, because the
 * meter WAS that seam. The wide sidebar needed no restoration: its visible
 * boundary is the RIGHT border, which never depended on the meter.
 *
 * Pure presentation — receives the active tab + an `onSelect` callback.
 * The opacity-fade Slot transition lives in the layout (so the fade
 * survives across `<Slot />` child swaps); the tab bar only signals
 * the selection.
 */

import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { BREAKPOINTS, DENSITY, SPACING, TYPOGRAPHY, type NeutronTheme, type NeutronPhaseColors } from '../lib/composer-constants';
import { usePhase, useThemedStyles } from '../lib/theme-context';
import { PROJECT_TABS, type ProjectTabSpec } from '../lib/project-tabs';

/**
 * The builtin native-tab keys the loading default ({@link PROJECT_TABS})
 * still uses. Post-WAVE-3 the rendered tab set is registry-driven, so a tab
 * `key` is no longer restricted to this union: builtin descriptors use
 * `'chat' | 'documents' | 'tasks'` and Core descriptors use `'core:<slug>'`.
 * The bar is therefore generic over `string` keys; this alias is retained for
 * back-compat callers that still talk about the locked native set.
 */
export type ProjectTabKey = 'chat' | 'launcher' | 'tasks' | 'reminders' | 'docs';

// `ProjectTabSpec` + `PROJECT_TABS` now live in the RN-free `lib/project-tabs`
// (so the tab-mapping logic stays unit-testable). Re-exported here so existing
// importers (`_layout.tsx`, tests) keep their `components/ProjectTabBar` path.
export { PROJECT_TABS };
export type { ProjectTabSpec };

export interface ProjectTabBarProps {
  /** The highlighted tab key, or `null` on a non-tab sub-route (no tab active). */
  active: string | null;
  onSelect: (key: string) => void;
  tabs?: readonly ProjectTabSpec[];
  /**
   * M1 UX REDESIGN PR-6 — per-tab-key badge counts (the Work tab's live-run
   * count). A tab with a count `> 0` renders a tinted `.cap`-style badge; 0 /
   * absent → no badge. Keyed by tab `key` so it stays generic.
   */
  badges?: ReadonlyMap<string, number>;
  /**
   * (removed) the usage reading used to be drawn here as the band's bottom seam.
   * Defaults to "unknown", which renders as the plain hairline — so a caller
   * that has not wired the meter yet gets exactly the divider that was there
   * before it existed.
   */
}

export function ProjectTabBar({
  active,
  onSelect,
  tabs = PROJECT_TABS,
  badges,
}: ProjectTabBarProps) {
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;
  return wide ? (
    <WideTabBar tabs={tabs} active={active} onSelect={onSelect} badges={badges} />
  ) : (
    <NarrowTabBar
      tabs={tabs}
      active={active}
      onSelect={onSelect}
      badges={badges}
    />
  );
}

/** The tinted live-count badge (prototype `.tab .cap`). Renders only for `> 0`. */
function TabBadge({ count }: { count: number }) {
  const phase = usePhase();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.cap} testID="tab-badge">
      <Text style={styles.capText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

function badgeCountFor(
  badges: ReadonlyMap<string, number> | undefined,
  key: string,
): number {
  const n = badges?.get(key);
  return typeof n === 'number' && n > 0 ? n : 0;
}

function NarrowTabBar({
  tabs,
  active,
  onSelect,
  badges,
}: {
  tabs: readonly ProjectTabSpec[];
  active: string | null;
  onSelect: (key: string) => void;
  badges?: ReadonlyMap<string, number>;
}) {
  const phase = usePhase();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.narrowBand} testID="project-tab-bar-narrow">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.narrowContent}
      >
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          const badge = badgeCountFor(badges, tab.key);
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={`${tab.label} tab${badge > 0 ? `, ${badge} running` : ''}`}
              accessibilityState={{ selected: isActive }}
              testID={`tab-${tab.key}`}
              onPress={() => {
                if (!isActive) onSelect(tab.key);
              }}
              style={({ pressed }) => [
                styles.seatTab,
                isActive && styles.seatTabActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.seatLabel, isActive && styles.seatLabelActive]}>{tab.label}</Text>
              {badge > 0 ? <TabBadge count={badge} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function WideTabBar({
  tabs,
  active,
  onSelect,
  badges,
}: {
  tabs: readonly ProjectTabSpec[];
  active: string | null;
  onSelect: (key: string) => void;
  badges?: ReadonlyMap<string, number>;
}) {
  const phase = usePhase();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.wideBar} testID="project-tab-bar-wide">
      <View style={styles.wideItems}>
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          const badge = badgeCountFor(badges, tab.key);
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={`${tab.label} tab${badge > 0 ? `, ${badge} running` : ''}`}
              accessibilityState={{ selected: isActive }}
              testID={`tab-${tab.key}`}
              onPress={() => {
                if (!isActive) onSelect(tab.key);
              }}
              style={({ pressed }) => [
                styles.wideItem,
                isActive && styles.wideItemActive,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.wideAccent, isActive && styles.wideAccentActive]} />
              <Text style={[styles.wideLabel, isActive && styles.wideLabelActive]}>{tab.label}</Text>
              {badge > 0 ? <TabBadge count={badge} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const WIDE_SIDEBAR_WIDTH = 200;
const WIDE_ITEM_ACCENT_WIDTH = 3;

const TAB_SEAT_RADIUS = 9;

const makeStyles = (theme: NeutronTheme, phase: NeutronPhaseColors) =>
  StyleSheet.create({
    // Seated tab band (M1 UX REDESIGN PR-6, mirror of PR-3 web `.tabs`): a
    // `surface` band with a bottom hairline; tabs sit on it as top-rounded
    // sheets, the active one fused to the content sheet below.
    // THE BAND DRAWS ITS OWN BOTTOM HAIRLINE AGAIN. It had stopped, because
    // `UsageMeter` rendered as the band's last child and WAS that seam — "one line,
    // one owner". The meter has moved to sit above the message input at the owner's
    // request, so the band would otherwise lose its edge entirely; the issue that
    // recorded the move called this consequence out, and this is it being honoured.
    narrowBand: {
      flexGrow: 0,
      backgroundColor: theme.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.hairline,
    },
    narrowContent: {
      paddingHorizontal: SPACING.sm,
      paddingTop: SPACING.sm,
      gap: SPACING.xs / 2,
      alignItems: 'flex-end',
    },
    // One seated tab (prototype `.tab`): top-rounded, transparent 1px border,
    // muted label. Touch-sized padding.
    seatTab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.xs + 2,
      paddingHorizontal: SPACING.md + SPACING.xs,
      paddingVertical: SPACING.sm + 2,
      borderTopLeftRadius: TAB_SEAT_RADIUS,
      borderTopRightRadius: TAB_SEAT_RADIUS,
      borderWidth: 1,
      borderColor: 'transparent',
      borderBottomWidth: 0,
    },
    // Active tab (prototype `.tab.active`): seats onto the content sheet — content
    // `background`, hairline border. The old -1px overhang is gone: the seam it
    // used to notch out is now the usage meter, and a gap in a fill bar reads as a
    // wrong number rather than as a fused tab.
    seatTabActive: {
      backgroundColor: theme.background,
      borderColor: theme.hairline,
    },
    seatLabel: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      fontWeight: '500',
    },
    seatLabelActive: {
      color: theme.text_primary,
      fontWeight: '600',
    },
    // The live-run count badge (prototype `.tab .cap`): phase-build tinted pill.
    cap: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 5,
      borderRadius: TAB_SEAT_RADIUS,
      backgroundColor: phase.build.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    capText: {
      color: phase.build.fg,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '700',
    },
    wideBar: {
      width: WIDE_SIDEBAR_WIDTH,
      backgroundColor: theme.background,
      borderRightWidth: 1,
      borderRightColor: theme.hairline,
    },
    // The tab rows own the sidebar's padding. This dates from when the usage meter
    // sat beneath them and had to run the rail's full width; the meter has since
    // moved above the message input, and the padding is left here because the
    // sidebar's visible boundary is its RIGHT border, which never depended on it.
    wideItems: {
      paddingTop: SPACING.sm,
      paddingHorizontal: SPACING.sm,
      paddingBottom: SPACING.md,
      gap: SPACING.xs,
    },
    wideItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.md - SPACING.xs / 2,
      borderRadius: DENSITY.composer_radius,
      backgroundColor: 'transparent',
      gap: SPACING.sm,
    },
    wideItemActive: {
      backgroundColor: theme.surface_raised,
    },
    wideAccent: {
      width: WIDE_ITEM_ACCENT_WIDTH,
      height: 16,
      borderRadius: WIDE_ITEM_ACCENT_WIDTH,
      backgroundColor: 'transparent',
    },
    wideAccentActive: {
      backgroundColor: theme.text_primary,
    },
    wideLabel: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
      fontWeight: '500',
    },
    wideLabelActive: {
      color: theme.text_primary,
      fontWeight: '600',
    },
    pressed: { opacity: 0.7 },
  });
