/**
 * @neutronai/app — lightweight transient toast (M2.4).
 *
 * Surfaces a one-line confirmation that auto-dismisses. Built for the
 * invitee's "Joined <project> shared by <owner>" message after they
 * accept an invite, but generic enough to reuse.
 *
 * Motion: enters with a short translateY + opacity ramp on an
 * ease-out curve (no bounce — `lib/theme.ts` MOTION tokens), holds,
 * then fades out before `onDismiss`. Disabled under reduce-motion
 * (matches the SlotFader pattern in `projects/[id]/_layout.tsx`).
 * Tap anywhere on the toast to dismiss early.
 *
 * Tokens only. Positioned at the top, inset for the status bar /
 * header; the host screen decides placement context.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface ToastProps {
  /** Bold leading line, e.g. "Joined Acme". */
  message: string;
  /** Muted trailing detail, e.g. "shared by Casey". Optional. */
  detail?: string;
  visible: boolean;
  onDismiss: () => void;
  /** Visible duration before auto-dismiss (ms). Default 3800. */
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 3800;
const ENTER_OFFSET = 12;

export function Toast({
  message,
  detail,
  visible,
  onDismiss,
  durationMs = DEFAULT_DURATION_MS,
}: ToastProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-ENTER_OFFSET)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((rm) => {
        if (!cancelled) setReduceMotion(rm);
      })
      .catch(() => {
        if (!cancelled) setReduceMotion(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;

    if (reduceMotion) {
      opacity.setValue(1);
      translateY.setValue(0);
    } else {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: MOTION.base,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: MOTION.base,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }

    const timer = setTimeout(() => {
      if (reduceMotion) {
        onDismiss();
        return;
      }
      Animated.timing(opacity, {
        toValue: 0,
        duration: MOTION.fast,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => onDismiss());
    }, durationMs);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduceMotion, durationMs]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { opacity, transform: [{ translateY }] }]}
    >
      <Pressable
        accessibilityRole="alert"
        accessibilityLabel={detail !== undefined && detail.length > 0 ? `${message}, ${detail}` : message}
        onPress={onDismiss}
        style={styles.toast}
        testID="toast"
      >
        <Text style={styles.check}>✓</Text>
        <View style={styles.copy}>
          <Text style={styles.message} numberOfLines={1}>
            {message}
          </Text>
          {detail !== undefined && detail.length > 0 ? (
            <Text style={styles.detail} numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: SPACING.md,
    left: SPACING.lg,
    right: SPACING.lg,
    alignItems: 'center',
    zIndex: 50,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    maxWidth: 420,
    backgroundColor: THEME.surface_raised,
    borderColor: THEME.hairline,
    borderWidth: 1,
    borderRadius: DENSITY.banner_radius,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
  },
  check: {
    color: THEME.link,
    fontSize: TYPOGRAPHY.h4.fontSize,
    fontWeight: '700',
  },
  copy: { flexShrink: 1 },
  message: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '600',
  },
  detail: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
});
