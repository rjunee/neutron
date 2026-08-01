/**
 * @neutronai/app — the voice-message UI that sits over the composer bar.
 *
 * Renders whatever `useVoiceRecorder` is currently doing. The host composer
 * keeps its own mic button (that button drives the hook's gestures); this
 * component covers the text field while a note is being recorded, reviewed, or
 * uploaded, exactly the way iMessage swaps its input row for a recording row.
 *
 * Four faces, one per non-idle phase:
 *
 *   recording   pulsing red dot · elapsed `M:SS` · "‹ Slide to cancel", which
 *               turns into a live ✕ once the finger crosses the threshold
 *   review      ▶/⏸ preview · elapsed · ✕ discard · ➤ send
 *   uploading   "Sending…" with the elapsed length still visible
 *   error       the hook's message plus a dismiss
 *
 * Nothing here reaches for the recorder itself — it is a pure function of the
 * `VoiceRecorderValue` handed in, so it renders identically in a test.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';
import { type VoiceRecorderValue } from '../lib/use-voice-recorder';

export interface VoiceRecorderOverlayProps {
  voice: VoiceRecorderValue;
}

export function VoiceRecorderOverlay({ voice }: VoiceRecorderOverlayProps): React.ReactElement | null {
  if (!voice.active) return null;
  if (voice.phase === 'error') return <VoiceErrorRow voice={voice} />;
  if (voice.phase === 'review') return <VoiceReviewRow voice={voice} />;
  return <VoiceRecordingRow voice={voice} />;
}

/** Recording (and the brief `requesting` / `uploading` states). */
function VoiceRecordingRow({ voice }: VoiceRecorderOverlayProps): React.ReactElement {
  const uploading = voice.phase === 'uploading';
  const cancelling = voice.intent === 'cancel';
  const pulse = usePulse(voice.phase === 'recording');

  return (
    <View style={styles.row} accessibilityLabel="Voice message recording">
      <Animated.View
        style={[
          styles.dot,
          cancelling ? styles.dot_cancel : null,
          { opacity: uploading ? 0.4 : pulse },
        ]}
      />
      <Text style={styles.elapsed} accessibilityLabel={`Recorded ${voice.elapsed_label}`}>
        {voice.elapsed_label}
      </Text>
      {uploading ? (
        <Text style={styles.hint}>Sending…</Text>
      ) : (
        <Text style={[styles.hint, cancelling ? styles.hint_cancel : null]} numberOfLines={1}>
          {/* A latched recording has no finger down, so slide-to-cancel is
              meaningless — offer the stop button instead. */}
          {voice.latched
            ? 'Recording — tap ■ to review'
            : cancelling
              ? '✕  Release to cancel'
              : '‹  Slide to cancel'}
        </Text>
      )}
      {!uploading && (
        <Pressable
          onPress={() => {
            void voice.cancel();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Discard voice message"
          style={styles.icon_button}
        >
          <Text style={styles.icon_cancel}>✕</Text>
        </Pressable>
      )}
      {!uploading && voice.latched && (
        <Pressable
          onPress={() => {
            void voice.stopForReview();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Stop recording"
          style={[styles.icon_button, styles.send_button]}
        >
          <Text style={styles.icon_stop}>■</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Tap-mode review: play it back, discard it, or send it. */
function VoiceReviewRow({ voice }: VoiceRecorderOverlayProps): React.ReactElement {
  const player = useAudioPlayer(voice.preview_uri ?? undefined);
  const status = useAudioPlayerStatus(player);
  const playing = status.playing;

  return (
    <View style={styles.row} accessibilityLabel="Voice message preview">
      <Pressable
        onPress={() => {
          if (playing) {
            player.pause();
            return;
          }
          // Replay from the top once it has run to the end.
          if (status.didJustFinish || status.currentTime >= status.duration) {
            void player.seekTo(0);
          }
          player.play();
        }}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause preview' : 'Play preview'}
        style={styles.icon_button}
      >
        <Text style={styles.icon_play}>{playing ? '⏸' : '▶'}</Text>
      </Pressable>
      <Text style={styles.elapsed}>{voice.elapsed_label}</Text>
      <View style={styles.spacer} />
      <Pressable
        onPress={() => {
          void voice.cancel();
        }}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Discard voice message"
        style={styles.icon_button}
      >
        <Text style={styles.icon_cancel}>✕</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          void voice.send();
        }}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Send voice message"
        style={[styles.icon_button, styles.send_button]}
      >
        <Text style={styles.icon_send}>➤</Text>
      </Pressable>
    </View>
  );
}

function VoiceErrorRow({ voice }: VoiceRecorderOverlayProps): React.ReactElement {
  return (
    <View style={styles.row} accessibilityLabel="Voice message error">
      <Text style={styles.error} numberOfLines={2}>
        {voice.error_message ?? 'Could not record.'}
      </Text>
      <View style={styles.spacer} />
      <Pressable
        onPress={voice.reset}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Dismiss voice message error"
        style={styles.icon_button}
      >
        <Text style={styles.icon_cancel}>✕</Text>
      </Pressable>
    </View>
  );
}

/**
 * Slow breathing opacity on the record dot. A steady sine-ish loop rather than
 * a blink — a hard on/off reads as an error indicator, not a live capture.
 */
function usePulse(active: boolean): Animated.Value {
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      value.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 0.25,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, value]);
  return value;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: THEME.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: THEME.hairline,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: THEME.danger,
  },
  dot_cancel: {
    backgroundColor: THEME.text_muted,
  },
  elapsed: {
    ...TYPOGRAPHY.mono,
    color: THEME.text_primary,
    // Tabular-ish: a fixed width stops the row jittering as digits change.
    minWidth: 48,
  },
  hint: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_muted,
    flexShrink: 1,
  },
  hint_cancel: {
    color: THEME.danger,
  },
  spacer: {
    flex: 1,
  },
  icon_button: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  send_button: {
    backgroundColor: THEME.surface_raised,
  },
  icon_cancel: {
    fontSize: 16,
    color: THEME.text_muted,
  },
  icon_play: {
    fontSize: 15,
    color: THEME.text_primary,
  },
  icon_stop: {
    fontSize: 13,
    color: THEME.danger,
  },
  icon_send: {
    fontSize: 15,
    color: THEME.text_primary,
  },
  error: {
    ...TYPOGRAPHY.body_small,
    color: THEME.danger,
    flexShrink: 1,
  },
});
