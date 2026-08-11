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
 * THE PLAYER IS THE BUBBLE'S CONTENT, NOT A PANEL INSIDE IT. The first version
 * of this component drew its own filled, rounded container — so a voice note
 * appeared as a box nested inside the message bubble, which already has an edge
 * and a radius of its own. The owner: *"The voice note playback UX is kinda
 * ugly. Its a box in a box, the play button is a really small tap target... can
 * you make it look like imessage?"* iMessage draws no such frame: the audio
 * message IS the bubble, and every mark in it is painted in the bubble's own
 * foreground colour. That is why this component takes a `BubbleTone` rather than
 * reaching for fixed palette entries — with no panel of its own it has no
 * background it controls, so it has to be told what it is sitting on.
 *
 * THE REFERENCE, AND HOW IT WAS READ. Apple's own asset for "A Messages
 * conversation with an audio message" from the iPhone User Guide
 * (help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/
 * en_US/8d5297e97af5bc312625c6e5859061df.png, linked from
 * support.apple.com/guide/iphone/send-and-receive-audio-messages-iph2e42d3117/ios),
 * pixel-measured — the same method the composer rework used. Every ratio below
 * is a measurement off that image, cross-checked against Apple's standalone
 * play-button glyph asset and against an older (iOS 12-era) audio bubble. The
 * arrangement all three agree on: disc at the LEADING edge, the waveform's slot
 * spanning the middle, the length at the TRAILING edge, and no container of any
 * kind between them and the bubble. Numbers in
 * `docs/as-built/2026-08-01-voice-note-imessage-playback.md`.
 *
 * ONE DELIBERATE DEPARTURE: THE TRACK IS NOT A WAVEFORM. Apple draws a real
 * amplitude envelope — you can see the silence at the head of the clip and the
 * speech in the middle. We have no amplitude to draw. `expo-audio` reports
 * `metering` on a RECORDING only; `AudioStatus`, the playback status this
 * component reads, carries no level and no samples
 * (`expo-audio/build/Audio.types.d.ts:137-169`, `:205`). The one PCM channel it
 * does offer, `useAudioSampleListener`, is real-time-only (nothing exists before
 * the first play), is documented as "not supported on all platforms", and
 * "requires RECORD_AUDIO permission on Android" — asking for the microphone in
 * order to draw a picture is not a trade this component will make. Bars whose
 * heights came from anywhere else (a hash of the URL, a fixed pattern) would
 * LOOK like an amplitude envelope while carrying nothing about the audio, which
 * is a worse lie than an honest bar. So the waveform's SLOT, proportion and
 * behaviour are Apple's; what fills it is a progress track that means exactly
 * what it shows.
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
import { agentBubbleTone, type BubbleTone } from '../lib/chat-bubble-metrics';
import { useTheme } from '../lib/theme-context';
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
import { SPACING, TYPOGRAPHY } from '../lib/theme';

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

/**
 * THE PAINTED DIAMETER of the play/pause disc.
 *
 * Measured twice, independently: 33px in Apple's current in-thread asset at a
 * 1.153 px/pt render scale = 28.7pt, and 87px in an iOS 12-era screenshot
 * captured at a known 3x on a 375pt screen = 29.0pt. Implemented at 30 — within
 * a point of both, and even, so the radius and the glyph ratios below resolve
 * without a half-pixel.
 *
 * Note this is SMALLER than the 32pt disc the first version painted, which is
 * the counter-intuitive half of the owner's "really small tap target". The disc
 * was never the problem; its CONTRAST was. It was `surface_raised` (#1a1a1a) on
 * `surface` (#121212) — invisible — so the only thing the eye could find was the
 * 13pt `▶` text glyph inside it, and a 13pt mark is what "small" was measuring.
 * Apple's disc is filled in the bubble's full foreground colour with the
 * triangle knocked out of it, which is what makes it read as a big target at
 * 29pt. The REACH is fixed separately and honestly, by {@link TAP_TARGET_PT}.
 */
export const CONTROL_DIAMETER_PT = 30;

/**
 * The control's TOUCHABLE size, which is deliberately not its painted size.
 *
 * 44pt is the platform's own minimum comfortable target, and `hitSlop` exists
 * precisely so a control can be reached at 44 while being drawn at the size the
 * design calls for. Delivered as slop rather than as padding on purpose: padding
 * would grow the row and push the bubble taller than iMessage's, which is the
 * proportion this change is trying to match.
 */
export const TAP_TARGET_PT = 44;

/** Slop per side that takes the painted disc up to {@link TAP_TARGET_PT}. */
export const CONTROL_HIT_SLOP_PT = (TAP_TARGET_PT - CONTROL_DIAMETER_PT) / 2;

/**
 * The play triangle, as ratios of the disc's diameter so they hold at any size.
 *
 * Measured off the triangle knocked out of Apple's in-thread disc (11 x 13px in
 * a 33px disc = 0.333 x 0.394) and confirmed against Apple's standalone
 * play-button asset (21 x 24px in a 60px box = 0.350 x 0.400).
 *
 * The nudge is real and it matters: a right-pointing triangle centred on its
 * bounding box looks left-heavy, because its mass sits behind the apex. Apple
 * offsets it — +1px of 33 in the bubble asset, +2.5px of 60 in the glyph asset,
 * i.e. 0.030 and 0.042 of the diameter. 0.035 is the middle of the two.
 */
const GLYPH_WIDTH_RATIO = 0.333;
const GLYPH_HEIGHT_RATIO = 0.394;
const GLYPH_NUDGE_RATIO = 0.035;

/**
 * The pause mark: two bars as tall as the play triangle, so the control does not
 * change visual weight when it flips. Not measured (Apple's downloadable pause
 * asset is a filled disc, not a bare glyph) — derived to land on the triangle's
 * total width, which is the property that keeps the swap from twitching.
 */
const PAUSE_BAR_WIDTH_RATIO = 0.105;
const PAUSE_GAP_RATIO = 0.09;

/**
 * Track height. Apple's waveform envelope is ~26pt tall, but that height is
 * AMPLITUDE — it is drawn by the audio, not chosen. A progress track claiming
 * the same 26pt would just be a fat bar impersonating a waveform, so this is the
 * height of an honest scrubber instead: thick enough to read as a control rather
 * than a hairline, thin enough not to pretend.
 */
const TRACK_HEIGHT_PT = 6;

/** Fully-rounded ends on the track and its fill. */
const TRACK_RADIUS_PT = TRACK_HEIGHT_PT / 2;

/**
 * The unplayed part of the track, as an opacity of the bubble's ink. No
 * measurement exists to copy — Apple's track is an amplitude envelope drawn at
 * full strength, so it has no "not yet reached" state to read a value from.
 * Chosen to sit clearly behind the filled part on both bubble tones.
 */
const TRACK_REST_OPACITY = 0.3;

/**
 * The time readout's opacity against the bubble's ink. MEASURED: the `00:04` in
 * Apple's asset resolves to 0.70 of the foreground, where the waveform beside it
 * is a full-strength 1.0.
 */
const TIME_OPACITY = 0.7;

/**
 * Reserved width for the time readout so the track does not resize per tick.
 * Sized for the widest thing that can appear, which is `--:--`, not `0:07`.
 */
const TIME_WIDTH_PT = 40;

/** Padding around the track, enlarging its tap target without thickening it. */
const TRACK_TOUCH_PAD_PT = SPACING.sm;

/** Slop that takes the track's touch band to {@link TAP_TARGET_PT} tall. */
const TRACK_HIT_SLOP_PT = (TAP_TARGET_PT - TRACK_HEIGHT_PT - 2 * TRACK_TOUCH_PAD_PT) / 2;

/**
 * The narrowest the whole row may be, so a two-second clip still gets a track
 * worth aiming at rather than a stub between the disc and the readout.
 *
 * Held at 200 rather than raised to Apple's ~237pt of bubble content on purpose:
 * the bubble is capped at 90% of a row the project rail has already taken 72pt
 * out of, and on the smallest supported phone that leaves under 200pt. A minimum
 * the container cannot honour does not make the track wider, it makes the bubble
 * overflow. The track is `flex: 1`, so on every phone with room it grows past
 * this on its own.
 */
const ROW_MIN_WIDTH_PT = 200;

export interface VoiceNoteBubbleProps {
  url: string;
  auth: AttachmentAuthCtx | null;
  /**
   * The bubble this player is being painted INTO. Every mark the component draws
   * comes from here — it owns no background of its own (see the file header).
   * Defaults to the agent bubble, which is the correct reading for any dark
   * surface that has not opted in.
   */
  tone?: BubbleTone;
}

/**
 * A voice note the owner can actually play.
 *
 * Mounted only for audio attachments — `AuthedAttachmentImage` dispatches by
 * type, so this component's hook count is stable for the life of an instance
 * even when a recycled row's `url` flips between attachment kinds (the
 * rules-of-hooks structure documented on that dispatcher).
 */
export function VoiceNoteBubble({
  url,
  auth,
  tone,
}: VoiceNoteBubbleProps): React.ReactElement {
  // The default is resolved from the ACTIVE palette, so a player rendered without
  // an explicit tone still matches the bubble it is sitting in after a theme flip.
  // It cannot be a default PARAMETER any more: that expression is evaluated per
  // render but read a frozen module constant, which is the capture this removes.
  const theme = useTheme();
  const resolvedTone = tone ?? agentBubbleTone(theme);
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

  // Finished: stop, give the speaker back, and rewind, so the next tap replays
  // from the top rather than sitting dead at the end.
  //
  // PAUSE BEFORE SEEKING. `didJustFinish` does not leave the player paused — it
  // is still in a playing state, so seeking to 0 on its own hands it a fresh
  // position to play FROM and the clip loops forever. That shipped, and the
  // owner reported it within the hour.
  useEffect(() => {
    if (!status.didJustFinish) return;
    releaseVoicePlayback(handle);
    try {
      player.pause();
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
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        testID="voice-note-player"
      >
        <Text style={[styles.failure, { color: resolvedTone.ink }]} numberOfLines={1}>
          ⟳ Voice message unavailable — tap to retry
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
    <View style={styles.row} testID="voice-note-player">
      <Pressable
        onPress={toggle}
        hitSlop={CONTROL_HIT_SLOP_PT}
        accessibilityRole="button"
        accessibilityLabel={playbackControlLabel(playing, length_label)}
        style={({ pressed }) => [
          styles.control,
          { backgroundColor: resolvedTone.ink },
          pressed && styles.pressed,
        ]}
        testID="voice-note-toggle"
      >
        {playing ? <PauseMark color={resolvedTone.ground} /> : <PlayMark color={resolvedTone.ground} />}
      </Pressable>
      <Pressable
        onPress={(e) => seek(e.nativeEvent.locationX)}
        onLayout={onTrackLayout}
        hitSlop={{ top: TRACK_HIT_SLOP_PT, bottom: TRACK_HIT_SLOP_PT }}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek within voice message"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
        style={styles.track_touch}
      >
        <View style={styles.track}>
          <View style={[styles.track_rest, { backgroundColor: resolvedTone.ink }]} />
          <View
            style={[styles.track_fill, { backgroundColor: resolvedTone.ink, width: `${fraction * 100}%` }]}
            testID="voice-note-progress"
          />
        </View>
      </Pressable>
      <Text
        style={[styles.time, { color: resolvedTone.ink }]}
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

/**
 * The play triangle, drawn from a view rather than typed as a character.
 *
 * `▶` in a `<Text>` takes its size, weight and vertical position from whatever
 * the system font decides, which is how the previous version ended up with a
 * ~13pt mark adrift in a 32pt circle — the same mistake the composer's send
 * arrow was rebuilt to fix. Built from the collapsed-box border technique (a
 * zero-size view whose left border is the only one carrying a colour), the
 * geometry is ours and holds Apple's measured ratios at any diameter.
 */
function PlayMark({ color }: { color: string }): React.ReactElement {
  const width = CONTROL_DIAMETER_PT * GLYPH_WIDTH_RATIO;
  const half_height = (CONTROL_DIAMETER_PT * GLYPH_HEIGHT_RATIO) / 2;
  return (
    <View
      testID="voice-note-play-mark"
      style={{
        width: 0,
        height: 0,
        backgroundColor: 'transparent',
        borderTopWidth: half_height,
        borderBottomWidth: half_height,
        borderLeftWidth: width,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        borderLeftColor: color,
        // Optical centring — see GLYPH_NUDGE_RATIO. Doubled because the mark's
        // own box is the triangle's bounding box, so shifting the box by n moves
        // its visual centre of mass by about n/2.
        marginLeft: CONTROL_DIAMETER_PT * GLYPH_NUDGE_RATIO * 2,
      }}
    />
  );
}

/** The pause mark: two capped bars the same height as the play triangle. */
function PauseMark({ color }: { color: string }): React.ReactElement {
  const bar_width = CONTROL_DIAMETER_PT * PAUSE_BAR_WIDTH_RATIO;
  const bar = {
    width: bar_width,
    height: CONTROL_DIAMETER_PT * GLYPH_HEIGHT_RATIO,
    borderRadius: bar_width / 2,
    backgroundColor: color,
  } as const;
  return (
    <View
      testID="voice-note-pause-mark"
      style={{ flexDirection: 'row', gap: CONTROL_DIAMETER_PT * PAUSE_GAP_RATIO }}
    >
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * NO backgroundColor, NO borderRadius, NO border. That is the whole point of
   * this arrangement: the row IS the bubble's content, and the bubble already
   * drew the container. Anything filled here is the box-in-a-box coming back.
   */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minWidth: ROW_MIN_WIDTH_PT,
    maxWidth: '100%',
  },
  pressed: { opacity: 0.6 },
  control: {
    width: CONTROL_DIAMETER_PT,
    height: CONTROL_DIAMETER_PT,
    borderRadius: CONTROL_DIAMETER_PT / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // MEASURED gaps: 12pt from the disc to the waveform, ~16pt from the waveform
  // to the readout. Apple's spacing is not symmetric, and copying it symmetric
  // is one of the things that makes a clone read as "close, but off".
  track_touch: {
    flex: 1,
    justifyContent: 'center',
    marginLeft: SPACING.md,
    marginRight: SPACING.lg,
    paddingVertical: TRACK_TOUCH_PAD_PT,
  },
  track: {
    height: TRACK_HEIGHT_PT,
    borderRadius: TRACK_RADIUS_PT,
    justifyContent: 'center',
  },
  /** The unplayed remainder, BEHIND the fill rather than around it — a parent
   *  carrying the opacity would drag the fill down with it. */
  track_rest: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: TRACK_RADIUS_PT,
    opacity: TRACK_REST_OPACITY,
  },
  track_fill: {
    height: TRACK_HEIGHT_PT,
    borderRadius: TRACK_RADIUS_PT,
  },
  time: {
    width: TIME_WIDTH_PT,
    textAlign: 'right',
    fontSize: TYPOGRAPHY.body_small.fontSize,
    opacity: TIME_OPACITY,
    fontVariant: ['tabular-nums'],
  },
  failure: {
    flex: 1,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    opacity: TIME_OPACITY,
  },
});
