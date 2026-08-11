/**
 * @neutronai/app — chat input composer (P5.1).
 *
 * Multiline `TextInput`, auto-grows from one line up to ~6 lines.
 * Web + hardware-keyboard: Cmd/Ctrl-Enter sends, Shift-Enter inserts
 * newline. Mobile (no hardware keyboard): Return inserts a newline,
 * send is the explicit send button.
 *
 * Char counter appears at 90% of MAX_USER_MESSAGE_LEN; at 100% the
 * send button disables + the counter turns danger-colored.
 *
 * Attach control: the leading `+` → image picker (web file input or native
 * pickAttachments hook), which is the job iMessage's leading `+` does.
 *
 * M2 chat-upload UX extensions:
 *   - `onFilesPicked` hook fires when the user drops a file, pastes a
 *     file from the OS clipboard, or selects a file through the web
 *     file input. The parent owns the upload flow + modal lifecycle;
 *     the composer just surfaces the file event so the chat surface can
 *     route it (image → /api/app/upload, ZIP → /api/upload/<source>).
 *   - The hidden web file input accepts both `image/*` AND
 *     `application/zip` so the user can pick a ChatGPT/Claude export
 *     ZIP without leaving the composer.
 *   - `hint` may carry the phase-aware "drag your ZIP" affordance text;
 *     when set, it renders just under the input row with the impeccable
 *     caption styling so the affordance disappears when the phase
 *     leaves.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { MAX_USER_MESSAGE_LEN_CLIENT, SPACING, TYPOGRAPHY, type NeutronTheme } from '../lib/composer-constants';
import { useTheme, useThemedStyles } from '../lib/theme-context';

export interface ComposerAttachment {
  /** Local URI (file:// on native, blob:/data: on web). */
  uri: string;
  /** Optional MIME hint. */
  mime_type?: string;
}

/** Generic file event the composer surfaces. The parent decides how to
 *  route — images flow through `onSend({ attachments })`; ZIPs flow
 *  through the chat surface's history-import upload modal. */
export interface ComposerFileEvent {
  /** Local URI (blob: URL on web, file:// on native). */
  uri: string;
  /** Original filename if known. */
  name: string;
  /** Sniffed MIME (the browser fills this from the OS metadata). */
  mime_type: string;
  /** Size in bytes when the runtime can report it. */
  size_bytes?: number;
}

export interface InputComposerProps {
  /** Dispatcher. Resolves to true on transport success. */
  onSend: (opts: { body: string; attachments: ComposerAttachment[] }) => Promise<boolean>;
  /** When true, the send button shows a spinner. */
  sending?: boolean;
  /** When true, all inputs disable (e.g. WS auth-failed). */
  disabled?: boolean;
  /** Placeholder text. Defaults to a neutral prompt. */
  placeholder?: string;
  /**
   * Hint shown under the composer — currently only the upload affordance's
   * "drag your export ZIP here". It is NOT for restating the placeholder: the
   * freeform-prompt hint that used to live here said the same thing the
   * placeholder does, one line lower, and was removed for it.
   */
  hint?: string;
  /** Hook the attach button can call to surface platform file pickers. */
  pickAttachments?: () => Promise<ComposerAttachment[]>;
  /**
   * M2 chat-upload UX — fired when the user drops, pastes, or picks a
   * file. The parent decides routing (image → onSend attachments, ZIP →
   * history-import upload modal). Return value is ignored; the composer
   * does not block on the parent's promise.
   */
  onFilesPicked?: (files: ReadonlyArray<ComposerFileEvent>) => void;
  /**
   * M2 chat-upload UX — overrides the web file input's `accept` string.
   * Defaults to `image/*,application/zip,.zip` so ZIP uploads work
   * without code changes at the call site.
   */
  file_accept?: string;
  /**
   * ISSUE #17 — prefill seed for the composer draft. When provided
   * AND non-empty, the composer initial-mount populates its `draft`
   * state with this value. Used by the launcher long-press dispatch
   * (`/projects/<id>/chat?prefill=<prefix>`) so a tap on a
   * `chat_send_prefix` row lands the user in chat with `/task ` (or
   * similar) already typed. Subsequent updates to this prop are
   * IGNORED — the user owns the composer state after first paint.
   */
  initial_draft?: string;
  /**
   * Bottom padding for the whole bar, in points. The chat surface computes it
   * with `composerBottomInset` — the home-indicator safe area while the keyboard
   * is DOWN, a bare resting gap while it is UP (never both, or the bar
   * double-offsets and floats over dead background). Defaults to the resting
   * gap for call sites with no safe-area context.
   */
  bottom_inset?: number;
  /**
   * THE VOICE-NOTE SEAM. The composer owns the BUTTON; a separate module owns
   * the RECORDER (capture, permissions, upload). Everything here is the button
   * telling that module what the finger did — the composer never records.
   *
   * iMessage supports two interactions, and both are wired through:
   *   - HOLD: long-press to start, release to send, or slide away past
   *     {@link VOICE_CANCEL_SLIDE_PT} and release to discard. `onVoiceHoldEnd`
   *     receives which of the two happened.
   *   - TAP: tap to start, tap again to stop, then a preview the recorder owns.
   *
   * UNWIRED IS NOT SILENT. With no handlers passed, the button says so on press
   * rather than pretending to record — see {@link VOICE_UNAVAILABLE_NOTICE}.
   */
  onVoiceTap?: () => void;
  /**
   * THE FINGER WENT DOWN — before anything knows whether this is a tap or a
   * hold. Capture starts HERE, not at {@link onVoiceHoldStart}.
   *
   * The gesture recogniser needs {@link VOICE_LONG_PRESS_MS} to tell a tap from
   * a hold, and people begin talking as they press rather than after. Starting
   * capture on the long-press edge therefore threw away every syllable spoken
   * during that window. The microphone does not depend on the verdict, so it no
   * longer waits for it: recording begins on touch-down and the verdict decides
   * what happens TO the recording, not whether it exists.
   */
  onVoicePressIn?: () => void;
  /**
   * The press has been classified as a hold. Capture is ALREADY running (see
   * {@link onVoicePressIn}); this only says the release will be the stop.
   */
  onVoiceHoldStart?: () => void;
  /**
   * The finger moved during a hold. `cancelling` is true once it has slid far
   * enough that releasing would DISCARD — the button renders that state, and
   * the recorder can mirror it in its own UI.
   */
  onVoiceHoldMove?: (state: { cancelling: boolean }) => void;
  /** The hold ended. `intent` is what the release position meant. */
  onVoiceHoldEnd?: (intent: 'send' | 'cancel') => void;
}

const COUNTER_WARN_THRESHOLD = Math.floor(MAX_USER_MESSAGE_LEN_CLIENT * 0.9);

/**
 * Fallback bottom padding when no `bottom_inset` is supplied. Mirrors
 * `lib/keyboard-inset.ts` COMPOSER_BOTTOM_PADDING_PT — NOT imported, because
 * that module is a pure leaf the composer should not pull a dependency edge to;
 * the chat surface passes the real value on every mount that has a safe area.
 */
const COMPOSER_RESTING_BOTTOM_PT = 8;

/**
 * THE COMPOSER'S GEOMETRY — iMessage (owner, 2026-07-31: *"the design is
 * supposed to be imessage. Whatsapp was ONLY suggested if there's something in
 * the imessage UX that just CANNOT be done on android."*). The WhatsApp pass
 * this replaces was built on a fallback that was never actually needed; nothing
 * below turned out to be blocked on Android.
 *
 * THE STRUCTURE, and it is the whole difference from the WhatsApp arrangement:
 *
 *   [ + ]  ( ──── outlined pill ────────────────  (↑) )
 *    ^                                             ^
 *    one control, LEADING, OUTSIDE the field        the send control lives
 *                                                   INSIDE the field's
 *                                                   trailing edge
 *
 * WhatsApp puts a large circular action button OUTSIDE the capsule to the right
 * and fills the capsule; iMessage does neither. The field is an OUTLINED pill —
 * a hairline stroke over the bar's own background, not a filled grey capsule —
 * and the send control is a small filled circle tucked inside it.
 *
 * The pill's radius is half its RESTING height, so one line is a true pill and
 * extra lines grow it into a rounded box. It grows upward and stops at
 * {@link FIELD_MAX_LINES}, after which `maxHeight` makes the `TextInput` scroll
 * INTERNALLY and the bar stops moving. Both the leading control and the in-field
 * action button are bottom-aligned, so they track the LAST line as it grows.
 */
const FIELD_LINE_HEIGHT_PT = TYPOGRAPHY.body.lineHeight ?? 22;
const FIELD_PADDING_V_PT = 7;
/** One line of text plus its padding — the resting pill height. */
const FIELD_MIN_HEIGHT_PT = FIELD_LINE_HEIGHT_PT + FIELD_PADDING_V_PT * 2;
/** iMessage grows to roughly six lines, then scrolls the field, not the bar. */
const FIELD_MAX_LINES = 6;
const FIELD_MAX_HEIGHT_PT = FIELD_LINE_HEIGHT_PT * FIELD_MAX_LINES + FIELD_PADDING_V_PT * 2;

/**
 * THE OUTLINE. `StyleSheet.hairlineWidth` is react-native's thinnest drawable
 * line — one physical pixel — which is the weight iMessage's stroke actually is.
 * A flat `1` would render three device pixels at 3x and read as a heavy box.
 */
const FIELD_BORDER_PT = StyleSheet.hairlineWidth;

/**
 * THE LEADING CONTROL — iMessage's single app/plus button, outside the field on
 * the leading side. It is the ONE control there: iMessage does not stack an
 * emoji button and a paperclip into the field the way the WhatsApp pass put a
 * paperclip at the field's trailing edge.
 *
 * It is wired to the REAL attachment picker (`handleAttachPress`), which is the
 * same job iMessage's + does — it opens the photo/file drawer. A + that opened
 * nothing would be the no-op-control defect this composer already refuses to
 * ship elsewhere.
 */
const LEADING_BUTTON_SIZE_PT = FIELD_MIN_HEIGHT_PT * 0.95;

/**
 * THE IN-FIELD ACTION BUTTON. Its diameter is the field's INNER height — not an
 * arbitrary constant — so the filled circle is concentric with the pill's own
 * rounded cap at rest, which is what iMessage's send button looks like tucked
 * into the trailing end. Deriving it also means it cannot drift out of
 * proportion if the field's height or padding is ever retuned.
 */
const ACTION_BUTTON_SIZE_PT = FIELD_MIN_HEIGHT_PT - FIELD_BORDER_PT * 2;

/**
 * Android's Material minimum touch target. The visuals are smaller than this on
 * purpose, so the difference is made up with `hitSlop` rather than by inflating
 * the artwork.
 */
const MIN_TOUCH_TARGET_PT = 44;
const ACTION_HIT_SLOP_PT = (MIN_TOUCH_TARGET_PT - ACTION_BUTTON_SIZE_PT) / 2;
const LEADING_HIT_SLOP_PT = (MIN_TOUCH_TARGET_PT - LEADING_BUTTON_SIZE_PT) / 2;

/**
 * THE SEND MARK — iMessage's UPWARD ARROW.
 *
 * The owner asked *"Is this up arrow for send how imessage does it? It looks
 * kinda ugly."* The honest answer is yes, that is the mark iMessage uses
 * (`arrow.up` in a filled circle), and "copy it exactly" means keeping it. What
 * was actually ugly was the RENDERING: the pre-#29 code drew a literal `↑` in a
 * `<Text>`, so its size, weight and vertical position all came from whatever the
 * system font's metrics happened to be — which is why it sat low in its circle
 * and looked cheap. It is drawn from views here so its geometry is ours.
 *
 * There is still no icon set in this app's dependency tree — no
 * `@expo/vector-icons`, no `react-native-svg` (re-checked `app/package.json`
 * this change; `expo-audio` was the only dependency PR #24 added) — and this
 * ships over the air, so a native font or SVG package remains unavailable.
 *
 * THE CONSTRUCTION. A vertical shaft plus a two-armed chevron head — an OPEN V,
 * not a solid triangle. That is settled evidence, not a guess: row-scanning
 * Apple's own Send-button asset returns THREE separate ink runs across the head
 * (left arm, background, shaft, background, right arm), which is only possible
 * if the head is two strokes of the same width as the shaft. The solid-wedge
 * version is the common wrong one and is what makes clones look cheap.
 *
 * THE PROPORTIONS BELOW ARE MEASURED off that asset and expressed as ratios of
 * the BUTTON'S DIAMETER, so they hold at any size:
 *
 *   shaft width      0.069 × D
 *   glyph height     0.52  × D   (vertically centred in the circle)
 *   arrowhead width  0.41  × D   (≈ 6 × the shaft width)
 *   included angle   ≈ 80°       — a WIDE head, ≈40° off vertical per side,
 *                                  not the 45° a naive diagonal would give
 *
 * All three bars carry `borderRadius` half their width, which gives the round
 * caps and the round apex join the asset shows (its tip and its shaft's foot
 * each taper to a single pixel).
 *
 * The arms are the shaft's bar rotated ±{@link ARROW_ANGLE_DEG}, positioned by
 * their CENTRES — an arm running from the apex at that angle has its centre half
 * its length along that diagonal, hence the trig below. Deriving every offset
 * rather than hardcoding it is what keeps the head attached to the shaft if the
 * button is ever resized. A rotated bar's layout box legitimately extends past
 * its parent, so the glyph is explicitly `overflow: visible`.
 *
 * Apple's SF Pro and the exact `arrow.up` outline are proprietary, so this is a
 * reconstruction from measured proportions, not a copy of the asset.
 */
const ARROW_SHAFT_RATIO = 0.069;
const ARROW_HEIGHT_RATIO = 0.52;
const ARROW_HEAD_RATIO = 0.41;
const ARROW_ANGLE_DEG = 40;

const ARROW_STROKE_PT = ACTION_BUTTON_SIZE_PT * ARROW_SHAFT_RATIO;
/** The glyph's box is square at its measured height; the head is narrower, so it fits. */
const ARROW_BOX_PT = ACTION_BUTTON_SIZE_PT * ARROW_HEIGHT_RATIO;
const ARROW_APEX_X_PT = ARROW_BOX_PT / 2;
/** Half the head's width — how far each arm's tip reaches from the shaft. */
const ARROW_HEAD_HALF_PT = (ACTION_BUTTON_SIZE_PT * ARROW_HEAD_RATIO) / 2;
const ARROW_ANGLE_RAD = (ARROW_ANGLE_DEG * Math.PI) / 180;
/** Arm length that puts its tip exactly at the head's half-width, at that angle. */
const ARROW_ARM_PT = ARROW_HEAD_HALF_PT / Math.sin(ARROW_ANGLE_RAD);
/** Where an arm's CENTRE lands from the apex, per axis. */
const ARROW_ARM_DX_PT = (ARROW_ARM_PT / 2) * Math.sin(ARROW_ANGLE_RAD);
const ARROW_ARM_DY_PT = (ARROW_ARM_PT / 2) * Math.cos(ARROW_ANGLE_RAD);

function SendArrow({ color }: { color: string }): React.ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.arrowGlyph} testID="composer-send-arrow">
      <View style={[styles.arrowShaft, { backgroundColor: color }]} />
      <View style={[styles.arrowArm, styles.arrowArmLeft, { backgroundColor: color }]} />
      <View style={[styles.arrowArm, styles.arrowArmRight, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * THE PLUS, drawn the same way: two bars crossing at the centre with rounded
 * caps. iMessage's leading control is a plus in a filled grey circle.
 */
const PLUS_BOX_PT = 16;
const PLUS_STROKE_PT = 2;
/** Measured at 13–14pt against a ~35pt circle. */
const PLUS_ARM_PT = 13.5;

function PlusGlyph({ color }: { color: string }): React.ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.plusGlyph} testID="composer-plus-glyph">
      <View style={[styles.plusBarH, { backgroundColor: color }]} />
      <View style={[styles.plusBarV, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * THE MICROPHONE, drawn the same way and for the same reason (no icon set in the
 * dependency tree, and this has to ship over-the-air). Three parts in a 16×16
 * box: a capsule head, a U-shaped cradle made from a box with a transparent top
 * border and rounded bottom corners, and a short stem joining them to the chin.
 *
 * THE ONE DELIBERATE DEVIATION FROM iOS 17/18. Apple puts a DICTATION mic in
 * this slot — speech-to-text into the field. Ours is the VOICE-MESSAGE recorder
 * instead: recording and sending audio is a hard requirement here, and this is
 * the slot the gesture belongs in. The position, the swap and the mark are
 * iMessage's; only what the control does differs. Worth noting that iOS 26 later
 * replaced the dictation mic in this same slot with a waveform Record-Audio
 * control, so Apple converged on this usage.
 */
const MIC_BOX_PT = 16;

function MicGlyph({ color }: { color: string }): React.ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.micGlyph} testID="composer-mic-glyph">
      <View style={[styles.micHead, { backgroundColor: color }]} />
      <View style={[styles.micCradle, { borderColor: color, borderTopColor: 'transparent' }]} />
      <View style={[styles.micStem, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * How far the finger has to travel from where the hold started before releasing
 * DISCARDS instead of sends. iMessage slides left toward a "cancel" affordance;
 * the distance is what makes the gesture forgiving enough to use one-handed.
 */
const VOICE_CANCEL_SLIDE_PT = 64;

/**
 * How far outside the mic button the press stays ALIVE while the finger slides.
 *
 * THIS IS THE SLIDE-TO-CANCEL BUG (#521), and the arithmetic above was never the
 * problem. `Pressable` releases a press once the touch leaves the button plus its
 * retention offset — RN's default is a couple of dozen points, and the mic button
 * is 44pt. The gesture requires travelling {@link VOICE_CANCEL_SLIDE_PT} = 64pt,
 * which is comfortably outside that. So the press TERMINATED mid-slide: `onPressOut`
 * fired while `holding.cancelling` was still false, the release resolved as 'send',
 * and the View stopped receiving `onTouchMove` before the threshold could ever be
 * crossed. Sliding away didn't cancel the recording — it SENT it, which is the
 * worst possible reading of "cancel".
 *
 * The retention region therefore has to be larger than the gesture it is meant to
 * survive, with room for the arc a one-handed thumb actually takes. Generous on
 * purpose: retention costs nothing until a press is already in progress, and the
 * failure it prevents destroys the user's intent in the least recoverable
 * direction.
 */
const VOICE_PRESS_RETENTION_PT = {
  top: VOICE_CANCEL_SLIDE_PT * 2,
  bottom: VOICE_CANCEL_SLIDE_PT * 2,
  left: VOICE_CANCEL_SLIDE_PT * 4,
  right: VOICE_CANCEL_SLIDE_PT * 4,
} as const;

/**
 * How long the finger must stay down before the press counts as a HOLD.
 *
 * This is a classification delay and nothing else. It used to be the delay
 * before the microphone opened, which cost the opening of every held message;
 * capture now starts on touch-down (`onVoicePressIn`) and this only decides
 * which release semantics apply. Lowering it would make deliberate taps read as
 * holds — the value is a gesture-feel constant, not a latency budget.
 */
const VOICE_LONG_PRESS_MS = 250;

/**
 * What the button says when it is pressed and no recorder is wired behind it.
 * The alternative — a control that looks live and does nothing — is the failure
 * this is here to avoid.
 */
const VOICE_UNAVAILABLE_NOTICE = 'Voice messages are not available yet.';

export function InputComposer({
  onSend,
  sending = false,
  disabled = false,
  placeholder = 'Send a message',
  hint,
  pickAttachments,
  onFilesPicked,
  file_accept,
  initial_draft,
  bottom_inset,
  onVoiceTap,
  onVoicePressIn,
  onVoiceHoldStart,
  onVoiceHoldMove,
  onVoiceHoldEnd,
}: InputComposerProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState(initial_draft ?? '');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const inputRef = useRef<TextInput | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isWeb = Platform.OS === 'web';

  const length = draft.length;
  const overLimit = length >= MAX_USER_MESSAGE_LEN_CLIENT;
  const showCounter = length > COUNTER_WARN_THRESHOLD;
  const canSend = !disabled && !sending && !overLimit && (draft.trim().length > 0 || attachments.length > 0);
  // The send control EXISTS only when there is something to send (or a send is
  // in flight, where it holds the spinner). An over-limit draft still shows it,
  // disabled, because vanishing the button is the wrong feedback for "too long"
  // — the counter is what turns red there.
  const showSend = canSend || sending || (overLimit && draft.length > 0);
  const sendReveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!showSend) {
      // Unmounted below, so there is no exit animation to run — just re-arm.
      sendReveal.setValue(0);
      return undefined;
    }
    const reveal = Animated.timing(sendReveal, {
      toValue: 1,
      duration: 140,
      // The native driver is unavailable under react-native-web (the device
      // harness), and opacity + transform are both native-driver-safe.
      useNativeDriver: Platform.OS !== 'web',
    });
    reveal.start();
    return () => reveal.stop();
  }, [showSend, sendReveal]);

  // ── THE VOICE BUTTON ──────────────────────────────────────────────────────
  // The composer drives the gesture and reports it; the recorder module does
  // the recording. `holding` is null when idle, otherwise the live hold.
  const [holding, setHolding] = useState<null | { cancelling: boolean }>(null);
  const holdOriginX = useRef<number | null>(null);
  // A completed hold must not ALSO register as a tap. RN suppresses `onPress`
  // after a long press today, but that is a Pressability implementation detail
  // and this gesture is about to drive a recorder — a double-fire would start a
  // second capture. The ref survives the state reset in `handleVoiceRelease`,
  // which reading `holding` would not.
  const justHeld = useRef(false);
  // A press whose touch-down opened a recording. Every one of these MUST reach a
  // terminal edge in `handleVoiceRelease`, because `onPress` does not fire when
  // the finger leaves the button — and a recording nothing resolves is a hot
  // microphone.
  const pressOpenedCapture = useRef(false);
  // `handleVoiceRelease` already decided what this press meant. The `onPress`
  // that follows it (RN fires press-out, then press) must not decide again.
  const pressResolved = useRef(false);
  // Whether the finger has EVER travelled past the cancel threshold since
  // touch-down. Tracked for every press rather than only holds: a short press
  // that wandered off the button is an abandoned gesture, and since touch-down
  // it has a live recording to dispose of. Sticky on purpose — wandering away
  // and drifting back is still an abandoned press.
  const pressDrifted = useRef(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  const handleVoicePressIn = useCallback(() => {
    // Clearing here — at the START of a press — is what keeps a flag set by an
    // edge that never arrived from leaking into the next gesture.
    justHeld.current = false;
    pressResolved.current = false;
    pressDrifted.current = false;
    holdOriginX.current = null;
    if (onVoicePressIn === undefined) {
      // Unwired: the notice is still the tap's job, so this press stays silent.
      pressOpenedCapture.current = false;
      return;
    }
    pressOpenedCapture.current = true;
    onVoicePressIn();
  }, [onVoicePressIn]);

  const handleVoiceHoldStart = useCallback(() => {
    if (onVoiceHoldStart === undefined) {
      setVoiceNotice(VOICE_UNAVAILABLE_NOTICE);
      return;
    }
    // The recording is already running — touch-down opened it. All this edge
    // does is claim the press for hold semantics, so the release sends or
    // discards instead of latching.
    justHeld.current = true;
    setHolding({ cancelling: false });
    onVoiceHoldStart();
  }, [onVoiceHoldStart]);

  const handleVoiceTouchMove = useCallback(
    (e: { nativeEvent: { pageX: number } }) => {
      const x = e.nativeEvent.pageX;
      if (holdOriginX.current === null) {
        holdOriginX.current = x;
        return;
      }
      // Travel in EITHER direction counts. The reference slides left, but a
      // one-handed thumb arcs, and a gesture that only cancels one way strands
      // whoever arcs the other.
      const cancelling = Math.abs(holdOriginX.current - x) > VOICE_CANCEL_SLIDE_PT;
      if (cancelling) pressDrifted.current = true;
      if (holding === null || cancelling === holding.cancelling) return;
      setHolding({ cancelling });
      onVoiceHoldMove?.({ cancelling });
    },
    [holding, onVoiceHoldMove],
  );

  const handleVoiceRelease = useCallback(() => {
    holdOriginX.current = null;
    const opened = pressOpenedCapture.current;
    pressOpenedCapture.current = false;
    if (holding !== null) {
      const intent = holding.cancelling ? 'cancel' : 'send';
      setHolding(null);
      onVoiceHoldEnd?.(intent);
      return;
    }
    // Not a hold, so this release is the whole of a SHORT press — and it has to
    // resolve here rather than waiting for `onPress`, which never comes when the
    // finger drifted off the control.
    if (!opened) return;
    pressResolved.current = true;
    if (pressDrifted.current) {
      // Wandered away and let go: the same verdict a hold's slide reaches, and
      // the recording touch-down opened is discarded with the microphone.
      onVoiceHoldEnd?.('cancel');
      return;
    }
    onVoiceTap?.();
  }, [holding, onVoiceHoldEnd, onVoiceTap]);

  const handleVoiceTap = useCallback(() => {
    // A hold that just ended has already been reported through
    // `onVoiceHoldEnd`; it must not also count as a tap.
    if (justHeld.current) {
      justHeld.current = false;
      return;
    }
    // Likewise a short press `handleVoiceRelease` already resolved.
    if (pressResolved.current) {
      pressResolved.current = false;
      return;
    }
    // What is left is an activation with no touch behind it — a screen reader
    // firing the button directly. Nothing started on touch-down, so the tap
    // opens the recording itself.
    if (onVoiceTap === undefined) {
      setVoiceNotice(VOICE_UNAVAILABLE_NOTICE);
      return;
    }
    onVoiceTap();
  }, [onVoiceTap]);

  // The notice is transient — it answers one press and then gets out of the way.
  useEffect(() => {
    if (voiceNotice === null) return undefined;
    const t = setTimeout(() => setVoiceNotice(null), 2600);
    return () => clearTimeout(t);
  }, [voiceNotice]);

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    const body = draft.trim();
    const ok = await onSend({ body, attachments: attachments.slice() });
    if (ok) {
      setDraft('');
      setAttachments([]);
    }
  }, [canSend, draft, attachments, onSend]);

  // Web keyboard: Cmd/Ctrl-Enter sends.
  useEffect(() => {
    if (!isWeb) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const target = e.target as HTMLElement | null;
        // Only fire when the composer (or its TextInput) has focus.
        if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') {
          e.preventDefault();
          void handleSend();
        }
      }
    };
    const win = globalThis as { addEventListener?: (e: string, h: (e: KeyboardEvent) => void) => void; removeEventListener?: (e: string, h: (e: KeyboardEvent) => void) => void };
    if (typeof win.addEventListener !== 'function') return undefined;
    win.addEventListener('keydown', onKey);
    return () => {
      if (typeof win.removeEventListener === 'function') {
        win.removeEventListener('keydown', onKey);
      }
    };
  }, [isWeb, handleSend]);

  const handleAttachPress = useCallback(async () => {
    if (disabled || sending) return;
    if (isWeb) {
      fileInputRef.current?.click();
      return;
    }
    // Argus r1 BLOCKING #3 — native must call the parent-supplied
    // picker. Pre-r1 this was a silent no-op when `pickAttachments`
    // wasn't wired (iOS/Android couldn't upload anything). We now warn
    // loudly so an unwired native call site is observable in dev rather
    // than silently dead.
    if (pickAttachments === undefined) {
      console.warn(
        '[composer] native attach pressed but pickAttachments prop is unwired — file picker cannot open',
      );
      return;
    }
    try {
      const picked = await pickAttachments();
      // Argus r1 IMPORTANT #4 — drop the inline-tile path for picked
      // files. The canonical handoff is the parent's upload-modal flow
      // (it owns the `send({attachments})` after the modal reports
      // complete). The native parent today returns [] and routes via
      // `onFilesPicked`; legacy callers that still return tiles continue
      // to work for backwards compat.
      if (picked.length > 0) setAttachments((prev) => prev.concat(picked).slice(0, 8));
    } catch (err) {
      console.warn('[composer] pickAttachments threw:', err);
    }
  }, [disabled, sending, isWeb, pickAttachments]);

  const handleWebFiles = useCallback(
    (files: FileList | null) => {
      if (files === null) return;
      const events: ComposerFileEvent[] = [];
      for (let i = 0; i < files.length && i < 8; i++) {
        const f = files.item(i);
        if (f === null) continue;
        const url = URL.createObjectURL(f);
        const mime = f.type ?? '';
        events.push({
          uri: url,
          name: f.name,
          mime_type: mime,
          size_bytes: f.size,
        });
      }
      // Argus r1 IMPORTANT #4 — route ALL file drops/picks/pastes through
      // the parent's upload-modal flow. Pre-r1 we ALSO mirrored image
      // MIMEs into the composer's inline attachments[] tile, so the
      // image got auto-sent by the modal AND parked in the composer
      // row, and the next user-pressed Send fired a second user_message
      // with an unresolvable blob: URL. Single source of truth now: the
      // parent classifies (image vs history-import zip) and dispatches.
      if (events.length > 0 && onFilesPicked !== undefined) {
        onFilesPicked(events);
      }
    },
    [onFilesPicked],
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // M2 chat-upload UX — web paste-file handler. Catches Cmd+V of a file
  // copied out of Finder / Files / Explorer (the clipboard carries a
  // File object on the `paste` event's `clipboardData.files`). The
  // browser default of pasting the filename string into the TextInput
  // is suppressed iff we actually find a file on the clipboard. Pure
  // text pastes pass through untouched.
  useEffect(() => {
    if (!isWeb) return undefined;
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target as HTMLElement | null;
      // Only react when the composer (or document body when nothing is
      // focused) is the paste target. Refuses to intercept pastes into
      // any other text input on the page.
      if (
        target !== null &&
        target.tagName !== 'TEXTAREA' &&
        target.tagName !== 'INPUT' &&
        target.tagName !== 'BODY'
      ) {
        return;
      }
      const dt = e.clipboardData;
      if (dt === null) return;
      if (dt.files === null || dt.files === undefined || dt.files.length === 0) return;
      // We got at least one file on the clipboard. Suppress the default
      // (filename-as-text) and feed it through the composer's file path.
      e.preventDefault();
      handleWebFiles(dt.files);
    };
    const doc = globalThis as {
      addEventListener?: (e: string, h: (e: ClipboardEvent) => void) => void;
      removeEventListener?: (e: string, h: (e: ClipboardEvent) => void) => void;
    };
    if (typeof doc.addEventListener !== 'function') return undefined;
    doc.addEventListener('paste', onPaste);
    return () => {
      if (typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('paste', onPaste);
      }
    };
  }, [isWeb, handleWebFiles]);

  return (
    <View
      style={[styles.wrap, { paddingBottom: bottom_inset ?? COMPOSER_RESTING_BOTTOM_PT }]}
      testID="composer-bar"
    >
      {attachments.length > 0 ? (
        <View style={styles.attachmentRow}>
          {attachments.map((att, i) => (
            <View key={`${att.uri}-${i}`} style={styles.attachmentTile}>
              <Image source={{ uri: att.uri }} style={styles.attachmentImage} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove attachment"
                onPress={() => removeAttachment(i)}
                style={styles.removeAttachment}
              >
                <Text style={styles.removeAttachmentText}>×</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        {/* THE LEADING CONTROL — iMessage's single app/plus button, OUTSIDE the
            field on the leading side. One control, not a stack: iMessage has no
            emoji button and no separate paperclip here.

            It opens the real attachment picker, which is the job iMessage's +
            does. Bottom-aligned with the row so it tracks the last line. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add attachment"
          onPress={handleAttachPress}
          disabled={disabled || sending}
          hitSlop={LEADING_HIT_SLOP_PT}
          style={({ pressed }) => [styles.leadingBtn, pressed && styles.pressed]}
          testID="composer-attach"
        >
          <PlusGlyph color={theme.text_secondary} />
        </Pressable>
        {/* THE FIELD — an OUTLINED pill: a hairline stroke over the bar's own
            background, not a filled grey capsule. The action control sits INSIDE
            it at the trailing edge, which is the arrangement that most separates
            iMessage from the WhatsApp pass this replaces. */}
        <View style={styles.field} testID="composer-field">
          <TextInput
            ref={inputRef}
            accessibilityLabel="Compose message"
            style={styles.input}
            placeholder={placeholder}
            placeholderTextColor={theme.text_muted}
            // The caret takes the app's own accent. `cursorColor` is the Android
            // property; `selectionColor` covers both platforms. NOT iMessage
            // blue — this app's accent is the tint everywhere else in it.
            selectionColor={theme.accent}
            cursorColor={theme.accent}
            value={draft}
            editable={!disabled && !sending}
            onChangeText={(t) => setDraft(t.slice(0, MAX_USER_MESSAGE_LEN_CLIENT))}
            multiline
            blurOnSubmit={false}
          />
          {/* THE IN-FIELD ACTION BUTTON. It SWAPS BY CONTENT — microphone while
              the field is empty, send arrow once there is something to send —
              which is the same slot iMessage swaps its own audio control and
              send button through. The slot is always occupied, so the pill never
              reflows mid-typing, and it is bottom-aligned so it stays pinned to
              the LAST line as the field grows upward. */}
          <View style={styles.actionSlot}>
            {showSend ? (
              <Animated.View
                style={[
                  styles.actionFill,
                  { opacity: sendReveal, transform: [{ scale: sendReveal }] },
                ]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send"
                  onPress={handleSend}
                  disabled={!canSend}
                  hitSlop={ACTION_HIT_SLOP_PT}
                  style={({ pressed }) => [styles.sendBtn, pressed && styles.pressed]}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={theme.background} />
                  ) : (
                    // The accessibility label stays "Send" — that is what a screen
                    // reader announces and what the device harness presses.
                    <SendArrow color={theme.background} />
                  )}
                </Pressable>
              </Animated.View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  holding === null
                    ? 'Record voice message'
                    : holding.cancelling
                      ? 'Release to discard voice message'
                      : 'Release to send voice message'
                }
                testID="composer-voice"
                onPressIn={handleVoicePressIn}
                onPress={handleVoiceTap}
                onLongPress={handleVoiceHoldStart}
                onPressOut={handleVoiceRelease}
                onTouchMove={handleVoiceTouchMove}
                // Without this the press dies before the slide can arm — see
                // VOICE_PRESS_RETENTION_PT.
                pressRetentionOffset={VOICE_PRESS_RETENTION_PT}
                delayLongPress={VOICE_LONG_PRESS_MS}
                disabled={disabled || sending}
                hitSlop={ACTION_HIT_SLOP_PT}
                style={({ pressed }) => [
                  styles.voiceBtn,
                  holding !== null && styles.voiceBtnHolding,
                  holding?.cancelling === true && styles.voiceBtnCancelling,
                  pressed && styles.pressed,
                ]}
              >
                <MicGlyph color={holding === null ? theme.text_muted : theme.background} />
              </Pressable>
            )}
          </View>
        </View>
      </View>
      {voiceNotice !== null ? (
        <Text style={styles.hint} testID="composer-voice-notice">
          {voiceNotice}
        </Text>
      ) : null}
      {showCounter ? (
        <Text style={[styles.counter, overLimit && styles.counterOver]}>
          {length} / {MAX_USER_MESSAGE_LEN_CLIENT}
        </Text>
      ) : null}
      {hint !== undefined && hint.length > 0 ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
      {isWeb
        ? React.createElement('input', {
            ref: (el: HTMLInputElement | null) => {
              fileInputRef.current = el;
            },
            type: 'file',
            // M2 chat-upload UX — accept both image attachments (the
            // existing P5.1 path) AND ChatGPT / Claude history-import
            // ZIPs. The composer surfaces every picked file through
            // `onFilesPicked`; the parent decides which endpoint each
            // file targets.
            accept: file_accept ?? 'image/*,application/zip,.zip',
            // Argus r2 BLOCKING #2 — single-file picks only. Pre-r2 the
            // web file input was `multiple` but `useUploadState.start()`
            // aborts any in-flight upload before launching the next, so
            // picking N files = N-1 silent aborts + 1 success. Native
            // `DocumentPicker.getDocumentAsync({multiple:false})` already
            // matches this; web now agrees. Single-file UX across web +
            // native; sequential queueing can come later if a real
            // multi-file workflow lands.
            multiple: false,
            onChange: (e: { target: { files: FileList | null; value: string } }) => {
              handleWebFiles(e.target.files);
              // Reset the input's value so the same filename twice in
              // a row still fires a `change` event.
              try {
                e.target.value = '';
              } catch {
                /* ignore — some test polyfills throw on assignment */
              }
            },
            style: { display: 'none' },
          })
        : null}
    </View>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    wrap: {
      paddingHorizontal: SPACING.sm,
      paddingTop: SPACING.sm,
      // `paddingBottom` is supplied per-render (`bottom_inset`) — it is the home
      // indicator when the keyboard is down and a bare gap when it is up, and a
      // fixed value here is what buried the send button under the home indicator.
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.hairline,
      backgroundColor: theme.background,
      gap: SPACING.xs,
    },
    attachmentRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: SPACING.xs + 2,
    },
    attachmentTile: {
      width: 64,
      height: 64,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.surface,
      overflow: 'hidden',
    },
    attachmentImage: {
      width: '100%',
      height: '100%',
    },
    removeAttachment: {
      position: 'absolute',
      top: 2,
      right: 2,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: 'rgba(10,10,10,0.7)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    removeAttachmentText: {
      ...TYPOGRAPHY.caption,
      color: theme.text_primary,
      fontWeight: '700',
    },
    row: {
      flexDirection: 'row',
      // BOTTOM-aligned, not centred. Once the field grows past one line the
      // leading control must track the LAST line; centring it against a grown
      // field is the tell that the pattern was copied from a single-line
      // screenshot.
      alignItems: 'flex-end',
      // Measured at ~12pt between the `+` circle and the field's leading edge.
      gap: SPACING.md,
    },
    /** iMessage's + — a filled grey circle OUTSIDE the field, on the leading side. */
    leadingBtn: {
      height: LEADING_BUTTON_SIZE_PT,
      width: LEADING_BUTTON_SIZE_PT,
      borderRadius: LEADING_BUTTON_SIZE_PT / 2,
      backgroundColor: theme.surface_raised,
      justifyContent: 'center',
      alignItems: 'center',
      // Centres it against a one-line field, and holds that offset from the last
      // line once the field grows.
      marginBottom: (FIELD_MIN_HEIGHT_PT - LEADING_BUTTON_SIZE_PT) / 2,
    },
    plusGlyph: {
      height: PLUS_BOX_PT,
      width: PLUS_BOX_PT,
    },
    plusBarH: {
      position: 'absolute',
      left: (PLUS_BOX_PT - PLUS_ARM_PT) / 2,
      top: (PLUS_BOX_PT - PLUS_STROKE_PT) / 2,
      width: PLUS_ARM_PT,
      height: PLUS_STROKE_PT,
      borderRadius: PLUS_STROKE_PT / 2,
    },
    plusBarV: {
      position: 'absolute',
      left: (PLUS_BOX_PT - PLUS_STROKE_PT) / 2,
      top: (PLUS_BOX_PT - PLUS_ARM_PT) / 2,
      width: PLUS_STROKE_PT,
      height: PLUS_ARM_PT,
      borderRadius: PLUS_STROKE_PT / 2,
    },
    field: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      // OUTLINED, not filled. The pill is the bar's own background with a hairline
      // stroke around it — the single most visible difference from the filled grey
      // capsule this replaces.
      backgroundColor: 'transparent',
      borderWidth: FIELD_BORDER_PT,
      borderColor: theme.hairline,
      // A PILL, not a rounded rectangle: half the RESTING height, so one line is
      // fully round and extra lines grow it into a rounded box.
      borderRadius: FIELD_MIN_HEIGHT_PT / 2,
      minHeight: FIELD_MIN_HEIGHT_PT,
    },
    input: {
      flex: 1,
      color: theme.text_primary,
      // Measured at ~15pt from the field's leading edge to the first glyph.
      paddingLeft: SPACING.lg,
      // Clears the in-field action button, which occupies the trailing end.
      paddingRight: SPACING.xs,
      paddingVertical: FIELD_PADDING_V_PT,
      ...TYPOGRAPHY.body,
      minHeight: FIELD_MIN_HEIGHT_PT - FIELD_BORDER_PT * 2,
      // THE GROWTH CAP. Past this the TextInput scrolls its own content and the
      // bar stops rising, which is the behaviour the field is supposed to have
      // and the one most often skipped.
      maxHeight: FIELD_MAX_HEIGHT_PT,
    },
    /** The in-field trailing slot: it fills the pill's inner height, sits just
     *  inside the stroke at the trailing end, and is bottom-aligned so it stays
     *  pinned to the LAST line as the field grows upward. */
    actionSlot: {
      height: ACTION_BUTTON_SIZE_PT,
      width: ACTION_BUTTON_SIZE_PT,
    },
    actionFill: {
      height: '100%',
      width: '100%',
    },
    // The resting mic is a BARE GLYPH — no circle behind it — which is how
    // iOS 17/18 renders the control in this slot, and what makes the swap read: a
    // quiet mark while empty, a filled accent circle the moment there is something
    // to send. A filled circle in both states would say nothing by changing.
    voiceBtn: {
      height: ACTION_BUTTON_SIZE_PT,
      width: ACTION_BUTTON_SIZE_PT,
      borderRadius: ACTION_BUTTON_SIZE_PT / 2,
      backgroundColor: 'transparent',
      justifyContent: 'center',
      alignItems: 'center',
    },
    /** Holding: the control fills, so the recording state is unmistakable. */
    voiceBtnHolding: { backgroundColor: theme.accent },
    /** Slid far enough that releasing discards. */
    voiceBtnCancelling: { backgroundColor: theme.danger },
    micGlyph: {
      height: MIC_BOX_PT,
      width: MIC_BOX_PT,
    },
    micHead: {
      position: 'absolute',
      left: 4.5,
      top: 0,
      width: 7,
      height: 10,
      borderRadius: 3.5,
    },
    // A U: a box with its top border removed and its bottom corners rounded.
    micCradle: {
      position: 'absolute',
      left: 1.5,
      top: 6,
      width: 13,
      height: 7,
      borderWidth: 2,
      borderBottomLeftRadius: 6.5,
      borderBottomRightRadius: 6.5,
    },
    micStem: {
      position: 'absolute',
      left: 7,
      top: 13,
      width: 2,
      height: 3,
    },
    sendBtn: {
      height: ACTION_BUTTON_SIZE_PT,
      width: ACTION_BUTTON_SIZE_PT,
      borderRadius: ACTION_BUTTON_SIZE_PT / 2,
      backgroundColor: theme.accent,
      justifyContent: 'center',
      alignItems: 'center',
      // The arrow's rotated arms extend past the glyph's layout box; this is the
      // ancestor that would otherwise clip them.
      overflow: 'visible',
    },
    arrowGlyph: {
      height: ARROW_BOX_PT,
      width: ARROW_BOX_PT,
      // A rotated bar's layout box legitimately extends past this one; nothing
      // here may clip it.
      overflow: 'visible',
    },
    // The shaft spans the glyph's full measured height, apex to tail.
    arrowShaft: {
      position: 'absolute',
      left: ARROW_APEX_X_PT - ARROW_STROKE_PT / 2,
      top: 0,
      width: ARROW_STROKE_PT,
      height: ARROW_BOX_PT,
      // Round caps, as the asset has — and what makes the apex join read as one
      // continuous mark rather than three sticks.
      borderRadius: ARROW_STROKE_PT / 2,
    },
    arrowArm: {
      position: 'absolute',
      width: ARROW_STROKE_PT,
      height: ARROW_ARM_PT,
      borderRadius: ARROW_STROKE_PT / 2,
    },
    // Each arm is the shaft's bar rotated ±ARROW_ANGLE_DEG about its own centre,
    // so it is POSITIONED by that centre: half its length down the diagonal from
    // the apex, which sits at the top of the shaft.
    arrowArmLeft: {
      left: ARROW_APEX_X_PT - ARROW_ARM_DX_PT - ARROW_STROKE_PT / 2,
      top: ARROW_ARM_DY_PT - ARROW_ARM_PT / 2,
      transform: [{ rotate: `${ARROW_ANGLE_DEG}deg` }],
    },
    arrowArmRight: {
      left: ARROW_APEX_X_PT + ARROW_ARM_DX_PT - ARROW_STROKE_PT / 2,
      top: ARROW_ARM_DY_PT - ARROW_ARM_PT / 2,
      transform: [{ rotate: `-${ARROW_ANGLE_DEG}deg` }],
    },
    pressed: { opacity: 0.7 },
    counter: {
      ...TYPOGRAPHY.caption,
      color: theme.text_muted,
      textAlign: 'right',
    },
    counterOver: {
      color: theme.danger,
    },
    hint: {
      ...TYPOGRAPHY.caption,
      color: theme.text_muted,
      fontStyle: 'italic',
    },
  });
