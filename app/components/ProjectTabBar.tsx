/**
 * @neutronai/app — project tab bar (P5.2).
 *
 * Renders the locked 5-tab set (chat / launcher / tasks / reminders /
 * docs). Two layouts:
 *
 *   - Narrow (`<800` CSS px) OR any native target: horizontal
 *     scrollable strip below the project header. Each tab is a pill.
 *   - Wide (≥800px AND `Platform.OS === 'web'`): 200px-wide vertical
 *     sidebar on the left of the tab content area. Each tab is a full-
 *     width row.
 *
 * Pure presentation — receives the active tab + an `onSelect` callback.
 * The opacity-fade Slot transition lives in the layout (so the fade
 * survives across `<Slot />` child swaps); the tab bar only signals
 * the selection.
 */

import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { BREAKPOINTS, DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';

export type ProjectTabKey = 'chat' | 'launcher' | 'tasks' | 'reminders' | 'docs';

export interface ProjectTabSpec {
  key: ProjectTabKey;
  label: string;
}

/**
 * The LOCKED tab set per § B.P5 of engineering-plan.md + § 4.1 of the
 * P5.2 brief. Notes is intentionally NOT here — it's a Core that the
 * launcher icons point at, not a top-level lens.
 */
export const PROJECT_TABS: readonly ProjectTabSpec[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'launcher', label: 'Apps' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'docs', label: 'Docs' },
];

export interface ProjectTabBarProps {
  /** The highlighted tab, or `null` on a non-tab sub-route (no tab active). */
  active: ProjectTabKey | null;
  onSelect: (key: ProjectTabKey) => void;
  tabs?: readonly ProjectTabSpec[];
}

export function ProjectTabBar({ active, onSelect, tabs = PROJECT_TABS }: ProjectTabBarProps) {
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;
  return wide ? (
    <WideTabBar tabs={tabs} active={active} onSelect={onSelect} />
  ) : (
    <NarrowTabBar tabs={tabs} active={active} onSelect={onSelect} />
  );
}

function NarrowTabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly ProjectTabSpec[];
  active: ProjectTabKey | null;
  onSelect: (key: ProjectTabKey) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.narrowContent}
      style={styles.narrowBar}
      testID="project-tab-bar-narrow"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityLabel={`${tab.label} tab`}
            accessibilityState={{ selected: isActive }}
            testID={`tab-${tab.key}`}
            onPress={() => {
              if (!isActive) onSelect(tab.key);
            }}
            style={({ pressed }) => [
              styles.narrowItem,
              isActive && styles.narrowItemActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.narrowLabel, isActive && styles.narrowLabelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function WideTabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly ProjectTabSpec[];
  active: ProjectTabKey | null;
  onSelect: (key: ProjectTabKey) => void;
}) {
  return (
    <View style={styles.wideBar} testID="project-tab-bar-wide">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityLabel={`${tab.label} tab`}
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
          </Pressable>
        );
      })}
    </View>
  );
}

const WIDE_SIDEBAR_WIDTH = 200;
const WIDE_ITEM_ACCENT_WIDTH = 3;

const styles = StyleSheet.create({
  narrowBar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
    backgroundColor: THEME.background,
  },
  narrowContent: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
    alignItems: 'center',
  },
  narrowItem: {
    paddingHorizontal: SPACING.md + SPACING.xs,
    paddingVertical: SPACING.sm,
    borderRadius: DENSITY.composer_radius,
    backgroundColor: 'transparent',
  },
  narrowItemActive: {
    backgroundColor: THEME.surface_raised,
  },
  narrowLabel: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '500',
  },
  narrowLabelActive: {
    color: THEME.text_primary,
    fontWeight: '600',
  },
  wideBar: {
    width: WIDE_SIDEBAR_WIDTH,
    paddingTop: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.md,
    gap: SPACING.xs,
    backgroundColor: THEME.background,
    borderRightWidth: 1,
    borderRightColor: THEME.hairline,
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
    backgroundColor: THEME.surface_raised,
  },
  wideAccent: {
    width: WIDE_ITEM_ACCENT_WIDTH,
    height: 16,
    borderRadius: WIDE_ITEM_ACCENT_WIDTH,
    backgroundColor: 'transparent',
  },
  wideAccentActive: {
    backgroundColor: THEME.text_primary,
  },
  wideLabel: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '500',
  },
  wideLabelActive: {
    color: THEME.text_primary,
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
});
