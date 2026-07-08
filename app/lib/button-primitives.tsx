/**
 * @neutronai/app — button-primitive renderers for the chat surface (P5.1).
 *
 * Two row components, both pure (props-only, no React hooks except the
 * disable-while-tapping latch). The parent `<MessageItem>` owns the
 * dispatch path (`chooseOption` from `useChatState`) and forwards it
 * via `onChoose(value, prompt_id?)`.
 *
 * Wire shape note: tapping an option sends `value` as the user_message
 * body — NOT `label`. The gateway's outstanding-prompt store maps the
 * value back to the canonical `ButtonChoice`. The MVP's
 * "fill the draft with label" was wrong on two counts: (a) `label` is
 * the visible face, not the routing key; (b) requiring an extra tap
 * to send is the wrong UX.
 *
 * Anti-double-tap: the FIRST tap fires `onChoose`; subsequent taps in
 * the same render window are no-ops. The whole row visually disables
 * (opacity 0.5) immediately. Once `chosen_value` is set on the parent
 * message, the row collapses to a single "→ {chosen.label}" line.
 */

import { useCallback, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from './theme';
import type { AppWsOutboundAgentMessageOption } from '@neutronai/wire-types';

export interface ButtonOptionRowProps {
  options: ReadonlyArray<AppWsOutboundAgentMessageOption>;
  /** Optional prompt id forwarded to the dispatcher. */
  prompt_id?: string;
  /** Set when the user has already tapped — collapses to a summary row. */
  chosen_value?: string;
  /** Tap handler; called with the option's `value` (NOT label). */
  onChoose: (value: string, prompt_id?: string) => void;
  /** When true, the row renders as already-chosen (used during retries). */
  disabled?: boolean;
}

export function ButtonOptionRow({
  options,
  prompt_id,
  chosen_value,
  onChoose,
  disabled = false,
}: ButtonOptionRowProps) {
  const [tapping, setTapping] = useState(false);
  const handle = useCallback(
    (value: string) => {
      if (disabled || tapping || chosen_value !== undefined) return;
      setTapping(true);
      onChoose(value, prompt_id);
      // Release the tapping latch after MOTION.base ms so a missed
      // dispatch can be retried (without re-rendering the parent the
      // whole row stays disabled because `chosen_value` is set; the
      // latch is the bridge between tap and parent state update).
      setTimeout(() => setTapping(false), MOTION.base);
    },
    [disabled, tapping, chosen_value, onChoose, prompt_id],
  );

  if (chosen_value !== undefined) {
    const chosen = options.find((o) => o.value === chosen_value);
    return (
      <View style={styles.collapsedRow}>
        <Text style={styles.collapsedText}>→ {chosen?.label ?? chosen_value}</Text>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {options.map((opt) => {
        const isDisabled = disabled || tapping;
        const variantStyle =
          opt.decoration?.style === 'destructive'
            ? styles.btnDestructive
            : opt.decoration?.style === 'primary'
              ? styles.btnPrimary
              : styles.btnDefault;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
            accessibilityState={isDisabled ? { disabled: true } : undefined}
            disabled={isDisabled}
            onPress={() => handle(opt.value)}
            style={({ pressed }) => [
              styles.btn,
              variantStyle,
              isDisabled && styles.btnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[
                styles.btnText,
                opt.decoration?.style === 'primary' && styles.btnTextPrimary,
                opt.decoration?.style === 'destructive' && styles.btnTextDestructive,
              ]}
              numberOfLines={2}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface ImageGalleryRowProps {
  options: ReadonlyArray<AppWsOutboundAgentMessageOption>;
  prompt_id?: string;
  chosen_value?: string;
  onChoose: (value: string, prompt_id?: string) => void;
  disabled?: boolean;
}

/**
 * Image-gallery prompt: a 2-column grid of thumbnails for options that
 * carry an `image_url`, plus a separate control-row for options
 * without (regen / skip / pause / upload). Tap → same post-back shape
 * as `<ButtonOptionRow>`.
 */
export function ImageGalleryRow({
  options,
  prompt_id,
  chosen_value,
  onChoose,
  disabled = false,
}: ImageGalleryRowProps) {
  const [tapping, setTapping] = useState(false);
  const handle = useCallback(
    (value: string) => {
      if (disabled || tapping || chosen_value !== undefined) return;
      setTapping(true);
      onChoose(value, prompt_id);
      setTimeout(() => setTapping(false), MOTION.base);
    },
    [disabled, tapping, chosen_value, onChoose, prompt_id],
  );

  if (chosen_value !== undefined) {
    const chosen = options.find((o) => o.value === chosen_value);
    return (
      <View style={styles.collapsedRow}>
        <Text style={styles.collapsedText}>→ {chosen?.label ?? chosen_value}</Text>
      </View>
    );
  }

  const gallery = options.filter((o) => typeof o.image_url === 'string' && o.image_url.length > 0);
  const controls = options.filter((o) => !(typeof o.image_url === 'string' && o.image_url.length > 0));
  const isDisabled = disabled || tapping;
  return (
    <View>
      <View style={styles.gallery}>
        {gallery.map((opt) => (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
            disabled={isDisabled}
            onPress={() => handle(opt.value)}
            style={({ pressed }) => [
              styles.galleryTile,
              isDisabled && styles.btnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Image
              source={{ uri: opt.image_url! }}
              style={styles.galleryImage}
              accessibilityLabel={opt.label}
              resizeMode="cover"
            />
            <View style={styles.galleryLabelOverlay}>
              <Text style={styles.galleryLabel} numberOfLines={1}>
                {opt.label}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
      {controls.length > 0 ? (
        <View style={[styles.row, { marginTop: SPACING.sm }]}>
          {controls.map((opt) => (
            <Pressable
              key={opt.value}
              accessibilityRole="button"
              accessibilityLabel={opt.label}
              disabled={isDisabled}
              onPress={() => handle(opt.value)}
              style={({ pressed }) => [
                styles.btn,
                styles.btnDefault,
                isDisabled && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.btnText} numberOfLines={2}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs + 2,
    marginTop: SPACING.sm,
  },
  btn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
    borderRadius: 10,
    borderWidth: 1,
    minHeight: 36,
    justifyContent: 'center',
  },
  btnDefault: {
    backgroundColor: THEME.surface,
    borderColor: THEME.hairline,
  },
  btnPrimary: {
    backgroundColor: THEME.accent,
    borderColor: THEME.accent,
  },
  btnDestructive: {
    backgroundColor: 'transparent',
    borderColor: THEME.danger,
  },
  btnText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_secondary,
    fontWeight: '500',
  },
  btnTextPrimary: {
    color: THEME.background,
    fontWeight: '700',
  },
  btnTextDestructive: {
    color: THEME.danger,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  pressed: { opacity: 0.6 },
  collapsedRow: {
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: DENSITY.banner_radius,
    backgroundColor: THEME.surface,
  },
  collapsedText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_muted,
  },
  gallery: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  galleryTile: {
    width: '48%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: THEME.hairline,
    backgroundColor: THEME.surface,
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  galleryLabelOverlay: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    backgroundColor: 'rgba(10, 10, 10, 0.7)',
  },
  galleryLabel: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_primary,
    fontWeight: '600',
  },
});
