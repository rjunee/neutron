/**
 * @neutronai/landing — a voice note in the web transcript, as a playback control.
 *
 * WHY THIS REPLACED `<audio controls>`. The web client rendered a voice note as
 * the browser's own player, which was the right first move — play/pause, a
 * duration and a scrubber, keyboard-accessible, for free. But Chrome's control
 * draws its own filled, rounded panel, so inside a chat bubble it is a box in a
 * box, and on the blue user bubble it is a light-grey slab that owns the whole
 * message. It also renders `0:00 / 0:00` before the metadata arrives — the
 * fabricated zero the mobile player exists to avoid — plus a volume slider and
 * an overflow menu that mean nothing in a transcript.
 *
 * WHAT DID NOT CHANGE. The `<audio>` element is still the transport: the browser
 * still decodes, still fetches nothing on its own (it is handed a bearer-authed
 * object URL), still emits `play` / `pause` / `ended`, and the one-clip-at-a-time
 * registry is still bound to those EVENTS rather than to a click handler, so the
 * OS media keys stay covered. Only `controls` is gone, and with it the panel.
 * What was lost with `controls` — a keyboard-operable play button and scrubber —
 * is given back explicitly: a real `<button>` and a real `<input type="range">`.
 *
 * WHY THIS IS NOT THE MOBILE COMPONENT. React Native has no `HTMLAudioElement`
 * and the browser has no `expo-audio`; the two players share a DESIGN, not code,
 * exactly as `audio-exclusivity.ts` and `lib/voice-playback.ts` share a rule
 * without sharing an implementation. The geometry below is the same measured
 * iMessage geometry `app/components/VoiceNoteBubble.tsx` documents — disc at the
 * leading edge painted in the bubble's foreground with the triangle knocked out
 * of it, the track spanning the middle, the length at the trailing edge, and no
 * container of any kind. The colours come from the bubble through
 * `currentColor` and the `--bubble-ground` custom property, so this file names
 * no palette entry and cannot drift from the bubble it is drawn on.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { claimExclusiveAudio, releaseExclusiveAudio } from './audio-exclusivity.ts'

/**
 * The label shown before the clip's length is known. Deliberately not `0:00`,
 * which reads as an empty recording — the same sentinel the mobile client uses
 * (`app/lib/voice-playback.ts` `UNKNOWN_LENGTH_LABEL`).
 */
const UNKNOWN_LENGTH_LABEL = '--:--'

/** Resolution of the seek control. Fine enough that a drag feels continuous. */
const SCRUB_STEPS = 1000

/** `M:SS`, or the unknown sentinel when there is no length to state. */
function formatClipLength(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return UNKNOWN_LENGTH_LABEL
  return formatPosition(seconds)
}

/**
 * `M:SS` for a POSITION. Differs from {@link formatClipLength} at zero on
 * purpose: a clip parked at the start really is at 0:00, whereas a clip whose
 * LENGTH is zero is one nobody has measured yet.
 */
function formatPosition(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const total = Math.floor(safe)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function VoiceNotePlayer({ src }: { src: string }): React.JSX.Element {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState<number | null>(null)
  const [position, setPosition] = useState(0)

  const known = duration !== null && Number.isFinite(duration) && duration > 0
  const fraction = known ? Math.min(1, Math.max(0, position / (duration as number))) : 0
  const lengthLabel = formatClipLength(duration)
  // Counting up while it plays or sits mid-clip; the clip's length at rest.
  const timeLabel = known && (playing || position > 0) ? formatPosition(position) : lengthLabel

  // Never leave a clip sounding — or holding the registry slot — past this row.
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el === null) return
      releaseExclusiveAudio(el)
      el.pause()
    }
  }, [])

  const toggle = useCallback((): void => {
    const el = ref.current
    if (el === null) return
    if (el.paused) {
      // Claim BEFORE playing: claiming afterwards leaves a window in which two
      // clips are sounding at once.
      claimExclusiveAudio(el)
      void el.play()?.catch?.(() => undefined)
    } else {
      el.pause()
    }
  }, [])

  const scrub = useCallback(
    (raw: string): void => {
      const el = ref.current
      if (el === null || !known) return
      const next = (Number(raw) / SCRUB_STEPS) * (duration as number)
      if (!Number.isFinite(next)) return
      el.currentTime = next
      setPosition(next)
    },
    [known, duration],
  )

  const label = lengthLabel === UNKNOWN_LENGTH_LABEL ? 'voice message' : `${lengthLabel} voice message`

  return (
    <div className="car-vn" data-testid="voice-note-player">
      <audio
        ref={ref}
        className="car-vn-audio"
        src={src}
        // Fetch enough of the file to know how long it is, so the control shows
        // a real duration before the first play instead of `0:00`.
        preload="metadata"
        // Bound to the media EVENTS, not to the click handler, so the keyboard
        // and the OS media keys are covered too.
        onPlay={(e) => {
          claimExclusiveAudio(e.currentTarget)
          setPlaying(true)
        }}
        onPause={(e) => {
          releaseExclusiveAudio(e.currentTarget)
          setPlaying(false)
        }}
        onEnded={(e) => {
          releaseExclusiveAudio(e.currentTarget)
          setPlaying(false)
          // Rewind, so the next press replays rather than sitting dead at the end.
          e.currentTarget.currentTime = 0
          setPosition(0)
        }}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
      />
      <button
        type="button"
        className="car-vn-toggle"
        aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}
        onClick={toggle}
      >
        <span className={playing ? 'car-vn-pause-mark' : 'car-vn-play-mark'} aria-hidden="true" />
      </button>
      <div className="car-vn-track">
        <div className="car-vn-track-rest" />
        <div
          className="car-vn-track-fill"
          data-testid="voice-note-progress"
          style={{ width: `${fraction * 100}%` }}
        />
        {/* Invisible but fully operable: this is what keeps the scrubber
            keyboard-reachable now that `controls` is gone. Its box is taller
            than the painted track so the pointer target is comfortable. */}
        <input
          type="range"
          className="car-vn-scrub"
          min={0}
          max={SCRUB_STEPS}
          step={1}
          value={Math.round(fraction * SCRUB_STEPS)}
          disabled={!known}
          aria-label="Seek within voice message"
          onChange={(e) => scrub(e.currentTarget.value)}
        />
      </div>
      <span className="car-vn-time" data-testid="voice-note-time">
        {timeLabel}
      </span>
    </div>
  )
}
