/**
 * @neutronai/app — FocusHeroCard (P6.1).
 *
 * Per docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md
 * Part C.3.
 *
 * Renders the LLM's "do this next" pick at the top of the global
 * Focus list. Sourced from `useFocusState().currentFocus`. Designed
 * with the `impeccable` skill discipline:
 *
 *   - Single 1px accent line above the card body.
 *   - Muted surface background (THEME.surface) — distinct from the
 *     standard FocusRow background.
 *   - Title: TYPOGRAPHY.h3 (prominent but not screaming).
 *   - Rationale: TYPOGRAPHY.body_small, THEME.text_secondary, 2-line
 *     truncate with ellipsis.
 *   - Tap target = full card; press routes to `/projects/<id>/tasks`
 *     (or `/projects` when the picked task is owner-level).
 *   - No bouncy / elastic easing. No spring physics. A 200ms fade-in
 *     is acceptable.
 *   - All colors / spacing source from `lib/theme.ts` tokens — zero
 *     inline hex.
 */

import { useRef, useEffect } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import type { CurrentFocusPick } from '../lib/focus-client';
import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

const PICK_BADGE_COPY = "Today's pick";

export interface FocusHeroCardProps {
  pick: CurrentFocusPick;
  /** Fires when the user taps the card. */
  onPress: (pick: CurrentFocusPick) => void;
}

export function FocusHeroCard({ pick, onPress }: FocusHeroCardProps) {
  // Plain fade-in on mount. Per the plan: no bouncy easing, no spring.
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(opacity, {
      toValue: 1,
      duration: MOTION.base,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  const handlePress = () => onPress(pick);

  return (
    <Animated.View style={[styles.wrap, { opacity }]} testID="focus-hero-card">
      <View style={styles.accentLine} testID="focus-hero-accent" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Today's focus pick: ${pick.task.title}`}
        onPress={handlePress}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
        testID="focus-hero-press"
      >
        <Text style={styles.badge} testID="focus-hero-badge">
          {PICK_BADGE_COPY}
        </Text>
        <Text
          numberOfLines={2}
          ellipsizeMode="tail"
          style={styles.title}
          testID="focus-hero-title"
        >
          {pick.task.title}
        </Text>
        <Text
          numberOfLines={2}
          ellipsizeMode="tail"
          style={styles.rationale}
          testID="focus-hero-rationale"
        >
          {pick.llm_rationale}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 0,
  },
  accentLine: {
    height: 1,
    backgroundColor: THEME.accent,
    opacity: 0.6,
  },
  card: {
    backgroundColor: THEME.surface,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.lg,
    borderRadius: DENSITY.banner_radius,
    borderWidth: 1,
    borderColor: THEME.hairline,
    minHeight: 88,
    gap: SPACING.xs,
  },
  cardPressed: { opacity: 0.78 },
  badge: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
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
  rationale: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
});
