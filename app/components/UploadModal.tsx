/**
 * @neutronai/app — chat upload progress modal.
 *
 * Sits over the chat surface while a ChatGPT/Claude history-import ZIP
 * (or a chat-attached image) uploads. Shows the filename, MIME, size,
 * a determinate progress bar driven by `upload-client`'s
 * `UploadProgress` callback, and a phase indicator that walks through
 * `uploading` → `processing` → `analyzing`.
 *
 * Design vocabulary stays on the P5.x chat surface:
 *   - Surface tint over the page background (no pure black, no
 *     bordered "card-in-card").
 *   - Single rounded surface with a hairline border + a single line of
 *     accent on the progress bar — no gradients, no shadow stacks.
 *   - Motion: smooth ease-in-out only. No bouncing, no elastic, no
 *     spring overshoot. Bar fill animates over MOTION.base; phase chip
 *     swaps with a MOTION.fast crossfade (handled by Animated.View
 *     opacity transitions, not a layout dance).
 *   - Typography hierarchy: filename = h4, meta line = body_small,
 *     phase = caption with accent for the active step.
 *
 * Cancel button is the user's escape hatch — wired to the
 * AbortController passed in by the caller. On error the modal stays
 * sticky with the error + a retry button (handler also caller-owned).
 * On success the modal lingers MOTION.slow with a check + analyzing
 * hint before fading out (the fade is opacity only — no scale, no
 * translate, no spring).
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { MOTION, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export type UploadModalPhase =
  | 'uploading'
  | 'processing'
  | 'analyzing'
  | 'complete'
  | 'error';

export interface UploadModalProps {
  visible: boolean;
  phase: UploadModalPhase;
  filename: string;
  mime_type?: string;
  /** Bytes uploaded so far. */
  bytes_sent?: number;
  /** Total bytes to upload. */
  bytes_total?: number;
  /** Error message when phase === 'error'. */
  error_message?: string;
  /** Variant — affects the phase labels (history-import vs image attach). */
  kind: 'history-import-zip' | 'image';
  onCancel?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const PHASE_LABELS_ZIP: Record<UploadModalPhase, string> = Object.freeze({
  uploading: 'Uploading',
  processing: 'Processing',
  analyzing: 'Analyzing your conversations',
  complete: 'Done',
  error: 'Upload failed',
});

const PHASE_LABELS_IMAGE: Record<UploadModalPhase, string> = Object.freeze({
  uploading: 'Uploading',
  processing: 'Processing',
  analyzing: 'Attaching',
  complete: 'Done',
  error: 'Upload failed',
});

export function UploadModal({
  visible,
  phase,
  filename,
  mime_type,
  bytes_sent,
  bytes_total,
  error_message,
  kind,
  onCancel,
  onRetry,
  onDismiss,
}: UploadModalProps) {
  const progressFraction = useMemo(() => {
    if (phase === 'complete') return 1;
    if (typeof bytes_total === 'number' && bytes_total > 0 && typeof bytes_sent === 'number') {
      return Math.max(0, Math.min(1, bytes_sent / bytes_total));
    }
    return undefined;
  }, [phase, bytes_sent, bytes_total]);

  const widthAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const target = progressFraction ?? 0;
    Animated.timing(widthAnim, {
      toValue: target,
      duration: MOTION.base,
      // smooth ease-in-out; no bounce, no spring, no elastic.
      easing: undefined,
      useNativeDriver: false,
    }).start();
  }, [progressFraction, widthAnim]);

  const labels = kind === 'history-import-zip' ? PHASE_LABELS_ZIP : PHASE_LABELS_IMAGE;

  const showCancel = phase === 'uploading' || phase === 'processing';
  const showRetry = phase === 'error';
  const isError = phase === 'error';

  // Determinate when we have a fraction, indeterminate shimmer otherwise.
  const indeterminate = progressFraction === undefined && phase !== 'complete' && phase !== 'error';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss ?? onCancel}
    >
      <View style={styles.scrim} pointerEvents="auto">
        <View style={styles.card} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Text style={styles.title} numberOfLines={1}>
            {filename}
          </Text>
          <Text style={styles.meta}>
            {[
              kind === 'history-import-zip' ? 'ChatGPT / Claude export' : 'Image attachment',
              mime_type ?? null,
              formatSize(bytes_total),
            ]
              .filter((s): s is string => typeof s === 'string' && s.length > 0)
              .join(' · ')}
          </Text>

          <View style={styles.bar} accessibilityLabel="Upload progress">
            {indeterminate ? (
              <IndeterminateShimmer />
            ) : (
              <Animated.View
                style={[
                  styles.barFill,
                  {
                    width: widthAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0%', '100%'],
                    }),
                  },
                  isError && styles.barFillError,
                ]}
              />
            )}
          </View>

          <View style={styles.phaseRow}>
            <PhaseChip label={labels.uploading} active={phase === 'uploading'} done={phaseRank(phase) > 0} error={false} />
            <PhaseChip label={labels.processing} active={phase === 'processing'} done={phaseRank(phase) > 1} error={false} />
            <PhaseChip label={labels.analyzing} active={phase === 'analyzing'} done={phaseRank(phase) > 2} error={false} />
          </View>

          {phase === 'complete' ? (
            <Text style={styles.completeHint}>
              {kind === 'history-import-zip'
                ? 'Analyzing your conversations…'
                : 'Attached.'}
            </Text>
          ) : null}

          {isError ? (
            <Text style={styles.errorText}>{error_message ?? 'Something went wrong.'}</Text>
          ) : null}

          <View style={styles.actions}>
            {showCancel ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel upload"
                onPress={onCancel}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
                testID="upload-modal-cancel"
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
            ) : null}
            {showRetry ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry upload"
                onPress={onRetry}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
                testID="upload-modal-retry"
              >
                <Text style={styles.primaryBtnText}>Retry</Text>
              </Pressable>
            ) : null}
            {isError ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
                onPress={onDismiss}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
                testID="upload-modal-dismiss"
              >
                <Text style={styles.secondaryBtnText}>Dismiss</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function PhaseChip({
  label,
  active,
  done,
  error,
}: {
  label: string;
  active: boolean;
  done: boolean;
  error: boolean;
}) {
  return (
    <View
      style={[
        styles.phaseChip,
        active && styles.phaseChipActive,
        done && styles.phaseChipDone,
        error && styles.phaseChipError,
      ]}
    >
      <Text
        style={[
          styles.phaseChipText,
          active && styles.phaseChipTextActive,
          done && styles.phaseChipTextDone,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

function IndeterminateShimmer() {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: MOTION.pulse * 2,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <Animated.View
      style={[
        styles.shimmer,
        {
          opacity: anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.35, 0.75, 0.35] }),
        },
      ]}
    />
  );
}

function phaseRank(phase: UploadModalPhase): number {
  switch (phase) {
    case 'uploading':
      return 0;
    case 'processing':
      return 1;
    case 'analyzing':
      return 2;
    case 'complete':
      return 3;
    case 'error':
      return -1;
  }
}

function formatSize(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    borderRadius: 14,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.lg,
    gap: SPACING.md,
  },
  title: {
    ...TYPOGRAPHY.h4,
    color: THEME.text_primary,
  },
  meta: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_muted,
  },
  bar: {
    width: '100%',
    height: 6,
    borderRadius: 999,
    backgroundColor: THEME.surface_raised,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: THEME.accent,
  },
  barFillError: {
    backgroundColor: THEME.danger,
  },
  shimmer: {
    height: '100%',
    width: '100%',
    backgroundColor: THEME.accent,
  },
  phaseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs + 2,
  },
  phaseChip: {
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: SPACING.xs,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.hairline,
    backgroundColor: THEME.surface_raised,
  },
  phaseChipActive: {
    borderColor: THEME.accent,
  },
  phaseChipDone: {
    backgroundColor: 'rgba(224,224,224,0.10)',
  },
  phaseChipError: {
    borderColor: THEME.danger,
  },
  phaseChipText: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
  },
  phaseChipTextActive: {
    color: THEME.text_primary,
    fontWeight: '600',
  },
  phaseChipTextDone: {
    color: THEME.text_secondary,
  },
  completeHint: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_secondary,
    fontStyle: 'italic',
  },
  errorText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.danger,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
  },
  primaryBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm + 2,
    borderRadius: 10,
    backgroundColor: THEME.accent,
  },
  primaryBtnText: {
    ...TYPOGRAPHY.body_small,
    fontWeight: '700',
    color: THEME.background,
  },
  secondaryBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm + 2,
    borderRadius: 10,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  secondaryBtnText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_primary,
  },
  pressed: { opacity: 0.7 },
});
