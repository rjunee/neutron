/**
 * @neutronai/app — a sent voice note, rendered as a PLAYBACK CONTROL.
 *
 * THE DEFECT THIS CLOSES. A voice message arrived in the transcript as a file
 * chip: a 🎵 glyph and the clip's storage hash, truncated. No play button, no
 * length, no way to hear it — the audio was unlistenable from the app that had
 * just recorded it. `AuthedAttachmentImage`'s dispatcher already DETECTED audio
 * (`isAudioAttachmentUrl`) and picked the icon; only the rendering stopped
 * short. This component is the missing half.
 *
 * WHAT IT IS. The shape every messaging client converges on: a play/pause
 * control, the clip's length, and a track that reports position while it plays
 * and accepts a tap to seek. The track is a real control, not decoration — a
 * painted waveform that ignores playback position is the thing this component
 * exists NOT to be.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG, AND ARE HANDLED HERE:
 *
 *   ONE CLIP AT A TIME. Each bubble owns its own player and cannot see its
 *   siblings, so exclusivity lives in a module-level registry
 *   (`lib/voice-playback.ts`) that every bubble claims before it plays.
 *
 *   THE SESSION IS RELEASED. A chat list recycles rows; a player still holding
 *   an audio session after its bubble scrolled away is the mirror image of the
 *   hot-microphone leak `use-voice-recorder` guards against, and on iOS it will
 *   eventually break RECORDING. Unmount pauses, gives up the registry slot, and
 *   lets `useAudioPlayer` release the native object. Finishing does the same.
 *
 *   THE CLIP IS BEARER-AUTHED. `/api/app/upload/<user>/<hash>.m4a` honors only
 *   `Authorization: Bearer` (`gateway/http/app-upload-surface.ts`), so a naked
 *   URL handed to a player 401s. Native platforms accept per-source headers
 *   (`AVURLAssetHTTPHeaderFieldsKey` on iOS, ExoPlayer's
 *   `setDefaultRequestProperties` on Android), so the bearer rides along with
 *   the source. RN-web's player is an `HTMLAudioElement`, which cannot carry a
 *   header at all — so there we fetch the bytes WITH the bearer and play the
 *   resulting object URL, exactly as `AuthedAttachmentImageView` does for a
 *   picture.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { resolveAttachmentSource, type AttachmentAuthCtx } from '../lib/attachment-url';
import {
  claimVoicePlayback,
  formatClipLength,
  formatPlaybackPosition,
  playbackControlLabel,
  playbackFraction,
  releaseVoicePlayback,
  seekSecondsForTap,
  UNKNOWN_LENGTH_LABEL,
  type PausablePlayback,
} from '../lib/voice-playback';
import { SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

/**
 * How often the native player reports position. `expo-audio` defaults to 500ms,
 * which makes the progress bar visibly step rather than travel; 100ms matches
 * the recorder's own `ELAPSED_TICK_MS` so the two halves of a voice message
 * move at the same cadence.
 */
const PROGRESS_UPDATE_MS = 100;

/**
 * How long a clip may fail to report itself loaded before the bubble says so.
 *
 * `expo-audio` surfaces no load-error event — its only channel is a status
 * update, and a source that 404s or 401s simply never becomes `isLoaded`. A
 * deadline is therefore the only honest way to distinguish "still coming over a
 * slow connection" from "this will never play", and 20s is well past the former
 * for a clip capped at ~2.4MB.
 */
const LOAD_DEADLINE_MS = 20_000;

/** Track height. Thin enough to read as a scrubber, thick enough to hit. */
const TRACK_HEIGHT = 4;
/** Fully-rounded ends on the track and its fill. */
const TRACK_RADIUS = 2;
/** Diameter of the play/pause control. */
const CONTROL_SIZE = 32;
/** Reserved width for the time readout so the track does not resize per tick. */
const TIME_WIDTH = 40;
/** Padding around the track, enlarging its tap target without thickening it. */
const TRACK_TOUCH_PAD = SPACING.sm;

export interface VoiceNoteBubbleProps {
  url: string;
  auth: AttachmentAuthCtx | null;
}

/**
 * A voice note the owner can actually play.
 *
 * Mounted only for audio attachments — `AuthedAttachmentImage` dispatches by
 * type, so this component's hook count is stable for the life of an instance
 * even when a recycled row's `url` flips between attachment kinds (the
 * rules-of-hooks structure documented on that dispatcher).
 */
export function VoiceNoteBubble({ url, auth }: VoiceNoteBubbleProps): React.ReactElement {
  const resolved = useMemo(() => resolveAttachmentSource(url, auth), [url, auth]);
  const bearer = resolved.headers?.Authorization;
  // RN-web plays through an <audio> element, which drops per-source headers —
  // the bytes have to be fetched with the bearer and played from an object URL.
  const needsWebFetch = Platform.OS === 'web' && bearer !== undefined;

  /** Bumped by the retry affordance; re-runs the fetch and re-loads the player. */
  const [attempt, setAttempt] = useState(0);
  const [webUri, setWebUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [track_width, setTrackWidth] = useState(0);

  useEffect(() => {
    if (!needsWebFetch || bearer === undefined) return undefined;
    let active = true;
    let created: string | null = null;
    const ac = new AbortController();
    fetch(resolved.uri, { method: 'GET', headers: { Authorization: bearer }, signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`voice note fetch failed (status ${res.status})`);
        const blob = await res.blob();
        const obj = URL.createObjectURL(blob);
        if (active) {
          created = obj;
          setWebUri(obj);
        } else {
          URL.revokeObjectURL(obj);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      ac.abort();
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [needsWebFetch, resolved.uri, bearer, attempt]);

  // The source handed to the player. `null` while the web fetch is in flight —
  // `useAudioPlayer(null)` is legal and simply holds an empty player, so the
  // control renders (disabled-looking, never dead) instead of the row popping
  // into existence once the bytes land.
  const source = useMemo(() => {
    if (needsWebFetch) return webUri === null ? null : { uri: webUri };
    return bearer === undefined ? { uri: resolved.uri } : { uri: resolved.uri, headers: { Authorization: bearer } };
  }, [needsWebFetch, webUri, resolved.uri, bearer]);

  const player = useAudioPlayer(source, { updateInterval: PROGRESS_UPDATE_MS });
  const status = useAudioPlayerStatus(player);

  // A registry handle whose identity is stable for this component's lifetime,
  // so a displaced bubble can still be silenced after its player was swapped
  // (a retry replaces the player object; the claim must survive that).
  const player_ref = useRef(player);
  player_ref.current = player;
  const handle_ref = useRef<PausablePlayback | null>(null);
  if (handle_ref.current === null) {
    handle_ref.current = {
      pause: () => {
        try {
          player_ref.current.pause();
        } catch {
          // Already released (its row unmounted between claim and displacement).
        }
      },
    };
  }
  const handle = handle_ref.current;

  const duration = status.duration;
  const playing = status.playing;
  const has_length = Number.isFinite(duration) && duration > 0;
  const length_label = formatClipLength(duration);
  const fraction = playbackFraction(status.currentTime, duration);

  // Load deadline — see LOAD_DEADLINE_MS. Armed only while a source exists and
  // NOTHING about the clip has come back, so a slow-but-successful load simply
  // disarms it. Deliberately three ways to disarm rather than one: platforms
  // disagree about when `isLoaded` flips for a streamed source, and a known
  // duration or audible playback both prove the bytes are reachable, which is
  // the only thing this deadline is trying to find out. Calling a clip that is
  // ALREADY PLAYING "unavailable" would be a worse bug than the one this
  // guards against.
  useEffect(() => {
    if (failed || source === null || status.isLoaded || has_length || playing) return undefined;
    const timer = setTimeout(() => setFailed(true), LOAD_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [failed, source, status.isLoaded, has_length, playing]);

  // Finished: give the speaker back and rewind, so the next tap replays from
  // the top rather than sitting dead at the end.
  useEffect(() => {
    if (!status.didJustFinish) return;
    releaseVoicePlayback(handle);
    try {
      void player.seekTo(0)?.catch?.(() => undefined);
    } catch {
      // A player released between the status event and this effect.
    }
  }, [status.didJustFinish, player, handle]);

  // Never leave a clip sounding — or holding the speaker — past this bubble.
  // `useAudioPlayer` releases the native object itself; pausing first closes the
  // window where a recycled row is still audible during that release.
  useEffect(
    () => () => {
      releaseVoicePlayback(handle);
      handle.pause();
    },
    [handle],
  );

  const toggle = useCallback((): void => {
    if (failed) {
      setFailed(false);
      setAttempt((n) => n + 1);
      if (needsWebFetch) {
        // Web: drop the object URL so the effect re-fetches the bytes.
        setWebUri(null);
      } else if (source !== null) {
        // Native: the source is unchanged, so nothing would re-load on its own
        // (`useAudioPlayer` keys its player on the serialized source). Ask the
        // existing player to load it again — otherwise "tap to retry" would
        // clear the message and then sit there, which is the dead control this
        // state exists to avoid.
        try {
          player.replace(source);
        } catch {
          setFailed(true);
        }
      }
      return;
    }
    if (playing) {
      player.pause();
      releaseVoicePlayback(handle);
      return;
    }
    // Claim BEFORE playing: claiming afterwards leaves a window in which two
    // clips are sounding at once.
    claimVoicePlayback(handle);
    if (Platform.OS === 'web') {
      // A browser only honors playback started inside the click's user
      // activation, so nothing may be awaited before `play()` here.
      player.play();
      return;
    }
    void (async () => {
      try {
        // iOS keeps the session in the RECORDING category after a note is
        // captured, which routes playback to the earpiece at a whisper. Put it
        // back to playback (and keep it audible with the ringer switch
        // silenced) before starting.
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      } catch {
        // A session we could not reconfigure still plays, just possibly quietly.
      }
      try {
        player.play();
      } catch {
        setFailed(true);
      }
    })();
  }, [failed, playing, player, handle, needsWebFetch, source]);

  const seek = useCallback(
    (x: number): void => {
      const seconds = seekSecondsForTap(x, track_width, duration);
      if (seconds === null) return;
      try {
        void player.seekTo(seconds)?.catch?.(() => undefined);
      } catch {
        // Released mid-gesture; nothing to seek.
      }
    },
    [track_width, duration, player],
  );

  const onTrackLayout = useCallback((e: LayoutChangeEvent): void => {
    setTrackWidth(e.nativeEvent.layout.width);
  }, []);

  if (failed) {
    return (
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel="Voice message unavailable, tap to retry"
        style={({ pressed }) => [styles.shell, pressed && styles.pressed]}
        testID="voice-note-player"
      >
        <Text style={styles.glyph}>⟳</Text>
        <Text style={styles.failure} numberOfLines={1}>
          Voice message unavailable — tap to retry
        </Text>
      </Pressable>
    );
  }

  // While playing (or parked mid-clip) the readout counts the position; at rest
  // it shows how long the clip is. Both are real numbers — neither is `0:00`
  // standing in for "not known yet", which reads as an empty recording.
  const time_label =
    has_length && (playing || status.currentTime > 0)
      ? formatPlaybackPosition(status.currentTime)
      : length_label;

  return (
    <View style={styles.shell} testID="voice-note-player">
      <Pressable
        onPress={toggle}
        hitSlop={SPACING.sm}
        accessibilityRole="button"
        accessibilityLabel={playbackControlLabel(playing, length_label)}
        style={({ pressed }) => [styles.control, pressed && styles.pressed]}
        testID="voice-note-toggle"
      >
        <Text style={styles.glyph}>{playing ? '⏸' : '▶'}</Text>
      </Pressable>
      <Pressable
        onPress={(e) => seek(e.nativeEvent.locationX)}
        onLayout={onTrackLayout}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek within voice message"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
        style={styles.track_touch}
      >
        <View style={styles.track}>
          <View
            style={[styles.track_fill, { width: `${fraction * 100}%` }]}
            testID="voice-note-progress"
          />
        </View>
      </Pressable>
      <Text
        style={styles.time}
        numberOfLines={1}
        accessibilityLabel={
          length_label === UNKNOWN_LENGTH_LABEL ? 'Voice message length loading' : undefined
        }
        testID="voice-note-time"
      >
        {time_label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: SPACING.sm,
    minWidth: 200,
    maxWidth: '100%',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm + SPACING.xs,
    borderRadius: 14,
    backgroundColor: THEME.surface,
  },
  pressed: { opacity: 0.6 },
  control: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: CONTROL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface_raised,
  },
  glyph: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
  },
  track_touch: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: TRACK_TOUCH_PAD,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_RADIUS,
    backgroundColor: THEME.text_muted,
    overflow: 'hidden',
  },
  track_fill: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_RADIUS,
    backgroundColor: THEME.accent,
  },
  time: {
    width: TIME_WIDTH,
    textAlign: 'right',
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.caption.fontSize,
    fontVariant: ['tabular-nums'],
  },
  failure: {
    flex: 1,
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
  },
});
