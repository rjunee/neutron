/**
 * @neutronai/app — the mic button, with both iMessage recording gestures
 * already wired to `useVoiceRecorder`.
 *
 * The composer does not have to know the gesture rules. It renders this where
 * its send button would sit when the text field is empty, hands it the hook
 * value, and that is the whole integration:
 *
 * ```tsx
 * {draft.length === 0
 *   ? <VoiceMicButton voice={voice} />
 *   : <SendButton onPress={handleSend} />}
 * ```
 *
 * WHICH GESTURE HAPPENED is decided on release, from how long the press lasted
 * — the same disambiguation iMessage uses, and the reason both modes can share
 * one button:
 *
 *   held ≥ LONG_PRESS_MS   a deliberate hold. Release sends; releasing after
 *                          sliding past the cancel threshold discards.
 *   released sooner        a tap. The recording LATCHES and keeps running with
 *                          no finger down, and the overlay grows a ■ stop
 *                          button that drops the clip into review.
 *
 * Capture starts on press-in either way, so the first syllable is never
 * clipped waiting to find out which gesture it was.
 */

import { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, Text, type GestureResponderEvent } from 'react-native';

import { SPACING, THEME } from '../lib/composer-constants';
import { type VoiceRecorderValue } from '../lib/use-voice-recorder';

/**
 * Press duration above which a release counts as the end of a deliberate hold
 * rather than a tap. 350ms is the platform long-press feel: long enough that a
 * quick tap never sends a fragment, short enough that a hold responds at once.
 */
export const LONG_PRESS_MS = 350;

export interface VoiceMicButtonProps {
  voice: VoiceRecorderValue;
  /** Disables the button (offline, composer gated, not signed in). */
  disabled?: boolean;
}

export function VoiceMicButton({
  voice,
  disabled = false,
}: VoiceMicButtonProps): React.ReactElement {
  const pressed_at = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const onPressIn = useCallback(
    (event: GestureResponderEvent) => {
      pressed_at.current = Date.now();
      const { pageX, pageY } = event.nativeEvent;
      origin.current = { x: pageX, y: pageY };
      void voice.start();
    },
    [voice],
  );

  const onTouchMove = useCallback(
    (event: GestureResponderEvent) => {
      const from = origin.current;
      if (from === null || voice.latched) return;
      const { pageX, pageY } = event.nativeEvent;
      // dx is LEFTWARD travel — the discard affordance sits to the left of the
      // mic, so a finger moving toward it produces a positive number.
      voice.updateDrag(from.x - pageX, pageY - from.y);
    },
    [voice],
  );

  const onPressOut = useCallback(() => {
    const began = pressed_at.current;
    pressed_at.current = null;
    origin.current = null;
    // A latched recording already let go of the finger; a second release must
    // not stop it.
    if (voice.latched) return;
    const held = began === null ? 0 : Date.now() - began;
    if (held >= LONG_PRESS_MS) {
      void voice.finish();
      return;
    }
    voice.latch();
  }, [voice]);

  const recording = voice.phase === 'recording' || voice.phase === 'requesting';
  const cancelling = recording && !voice.latched && voice.intent === 'cancel';

  return (
    <Pressable
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onTouchMove={onTouchMove}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: voice.active }}
      accessibilityLabel={
        recording ? 'Release to send voice message' : 'Record a voice message'
      }
      accessibilityHint="Hold to record, release to send. Slide away to cancel. Tap to record hands-free."
      style={[
        styles.button,
        recording ? styles.button_recording : null,
        cancelling ? styles.button_cancelling : null,
        disabled ? styles.button_disabled : null,
      ]}
    >
      {/* While held, the mic BECOMES the send affordance — that swap is the
          whole point of the long-press mode, and it flips to ✕ once the slide
          crosses the cancel threshold. */}
      <Text style={styles.glyph}>{cancelling ? '✕' : recording ? '➤' : '🎙'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: SPACING.xs,
    backgroundColor: THEME.surface_raised,
  },
  button_recording: {
    backgroundColor: THEME.danger,
  },
  button_cancelling: {
    backgroundColor: THEME.surface_raised,
  },
  button_disabled: {
    opacity: 0.4,
  },
  glyph: {
    fontSize: 16,
    color: THEME.text_primary,
  },
});
