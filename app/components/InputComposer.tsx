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
 * Attach button: paperclip → image picker (web file input or native
 * pickAttachments hook).
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

import { MAX_USER_MESSAGE_LEN_CLIENT, SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';

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
   * The reference (WhatsApp on Android) supports two interactions, and both are
   * wired through:
   *   - HOLD: long-press to start, release to send, or slide away past
   *     {@link VOICE_CANCEL_SLIDE_PT} and release to discard. `onVoiceHoldEnd`
   *     receives which of the two happened.
   *   - TAP: tap to start, tap again to stop, then a preview the recorder owns.
   *
   * UNWIRED IS NOT SILENT. With no handlers passed, the button says so on press
   * rather than pretending to record — see {@link VOICE_UNAVAILABLE_NOTICE}.
   */
  onVoiceTap?: () => void;
  /** Long-press began. The recorder starts capturing. */
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
 * THE COMPOSER'S GEOMETRY — WhatsApp on Android (owner, 2026-07-30: *"In that
 * case we copy Whatsapp on Android"*, choosing the platform-native pattern over
 * iMessage's because he is on Android).
 *
 * THE STRUCTURE, and it is the part that distinguishes WhatsApp from iMessage:
 * the bar is TWO elements side by side — a filled capsule field, and a circular
 * action button OUTSIDE it to the right. iMessage puts its send button inside
 * the field; WhatsApp does not.
 *
 * The capsule's radius is always half its resting height, so one line is a true
 * pill and extra lines grow it into a rounded box. It grows with the text and
 * stops at {@link FIELD_MAX_LINES}, after which `maxHeight` makes the
 * `TextInput` scroll INTERNALLY and the bar stops moving.
 */
const FIELD_LINE_HEIGHT_PT = TYPOGRAPHY.body.lineHeight ?? 22;
const FIELD_PADDING_V_PT = 7;
/** One line of text plus its padding — the resting capsule height. */
const FIELD_MIN_HEIGHT_PT = FIELD_LINE_HEIGHT_PT + FIELD_PADDING_V_PT * 2;
/** WhatsApp grows to roughly six lines, then scrolls the field, not the bar. */
const FIELD_MAX_LINES = 6;
const FIELD_MAX_HEIGHT_PT = FIELD_LINE_HEIGHT_PT * FIELD_MAX_LINES + FIELD_PADDING_V_PT * 2;

/** The paperclip lives INSIDE the capsule at its trailing edge, as WhatsApp's does. */
const FIELD_ICON_SIZE_PT = 30;

/**
 * THE ACTION BUTTON. Deliberately LARGER than the resting capsule so it reads as
 * a separate control rather than part of the field, and bottom-aligned with it
 * so that it tracks the LAST line once the field grows. At this size,
 * bottom-aligned against a one-line field is also within 2pt of vertically
 * centred, which is the other half of how WhatsApp's looks at rest.
 */
const ACTION_BUTTON_SIZE_PT = 40;

/**
 * Android's Material minimum touch target. The visuals are smaller than this on
 * purpose, so the difference is made up with `hitSlop` rather than by inflating
 * the artwork.
 */
const MIN_TOUCH_TARGET_PT = 44;
const ACTION_HIT_SLOP_PT = (MIN_TOUCH_TARGET_PT - ACTION_BUTTON_SIZE_PT) / 2;
const ICON_HIT_SLOP_PT = (MIN_TOUCH_TARGET_PT - FIELD_ICON_SIZE_PT) / 2;

/**
 * THE SEND MARK — a paper plane, which is what the reference frame shows inside
 * the circle (not the up-arrow this used to render as a `Text` glyph).
 *
 * There is no icon set in this app's dependency tree — no `@expo/vector-icons`,
 * no `react-native-svg` (checked `app/package.json`) — and this has to ship
 * over-the-air, so adding a native font or SVG package was not an option. The
 * plane is therefore drawn with the zero-size-view border trick, which is the
 * one way to get a filled triangle out of react-native's box model: a view with
 * no width or height, a coloured left border and transparent top/bottom borders,
 * renders as a right-pointing triangle {@link PLANE_W_PT} wide and
 * {@link GLYPH_BOX_PT} tall. A second triangle in the BUTTON's fill colour is
 * painted over the left edge to cut the notch that makes it read as a plane
 * rather than a "play" arrow.
 *
 * OPTICAL CENTRING. A right-pointing triangle carries its ink centroid one
 * third of the way from base to apex — x ≈ 5.3 in a 16-wide box whose geometric
 * centre is 8 — so a naive centre parks it visibly left. {@link PLANE_NUDGE_PT}
 * shifts it back by the difference. Vertically it is symmetric and needs
 * nothing. This control is exactly why the glyph is drawn rather than typed: a
 * font glyph's position comes from the font's own metrics, which is what left
 * the old `↑` sitting low in its circle.
 */
const GLYPH_BOX_PT = 16;
const PLANE_W_PT = 16;
const PLANE_NUDGE_PT = 2;
/** The notch cut into the plane's trailing edge. */
const PLANE_NOTCH_W_PT = 6;
const PLANE_NOTCH_H_PT = 8;

function SendPlane({ color, fill }: { color: string; fill: string }): React.ReactElement {
  return (
    <View style={styles.sendGlyph} testID="composer-send-plane">
      <View style={[styles.sendPlaneBody, { borderLeftColor: color }]} />
      <View style={[styles.sendPlaneNotch, { borderLeftColor: fill }]} />
    </View>
  );
}

/**
 * THE MICROPHONE, drawn the same way and for the same reason (no icon set in the
 * dependency tree, and this has to ship over-the-air). Three parts in an 18×18
 * box: a capsule head, a U-shaped cradle made from a box with a transparent top
 * border and rounded bottom corners, and a short stem joining them to the chin.
 */
const MIC_BOX_PT = 18;

function MicGlyph({ color }: { color: string }): React.ReactElement {
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
 * DISCARDS instead of sends. The reference slides left toward a "cancel" label;
 * the distance is what makes the gesture forgiving enough to use one-handed.
 */
const VOICE_CANCEL_SLIDE_PT = 64;

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
  onVoiceHoldStart,
  onVoiceHoldMove,
  onVoiceHoldEnd,
}: InputComposerProps) {
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
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  const handleVoiceHoldStart = useCallback(() => {
    if (onVoiceHoldStart === undefined) {
      setVoiceNotice(VOICE_UNAVAILABLE_NOTICE);
      return;
    }
    justHeld.current = true;
    setHolding({ cancelling: false });
    onVoiceHoldStart();
  }, [onVoiceHoldStart]);

  const handleVoiceTouchMove = useCallback(
    (e: { nativeEvent: { pageX: number } }) => {
      if (holding === null) return;
      const x = e.nativeEvent.pageX;
      if (holdOriginX.current === null) {
        holdOriginX.current = x;
        return;
      }
      // Travel in EITHER direction counts. The reference slides left, but a
      // one-handed thumb arcs, and a gesture that only cancels one way strands
      // whoever arcs the other.
      const cancelling = Math.abs(holdOriginX.current - x) > VOICE_CANCEL_SLIDE_PT;
      if (cancelling === holding.cancelling) return;
      setHolding({ cancelling });
      onVoiceHoldMove?.({ cancelling });
    },
    [holding, onVoiceHoldMove],
  );

  const handleVoiceRelease = useCallback(() => {
    holdOriginX.current = null;
    if (holding === null) return;
    const intent = holding.cancelling ? 'cancel' : 'send';
    setHolding(null);
    onVoiceHoldEnd?.(intent);
  }, [holding, onVoiceHoldEnd]);

  const handleVoiceTap = useCallback(() => {
    // A hold that just ended has already been reported through
    // `onVoiceHoldEnd`; it must not also count as a tap.
    if (justHeld.current) {
      justHeld.current = false;
      return;
    }
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
        {/* THE CAPSULE. Filled a shade lighter than the bar, radius = half its
            resting height, and the attachment control lives INSIDE it at the
            trailing edge — the arrangement the reference frame shows.

            NOT PORTED: the emoji/sticker button the reference carries at the
            capsule's LEADING edge. This app has no emoji picker to open
            (searched: no picker component, no such dependency), and a button
            that opens nothing is the same defect as a microphone that records
            nothing. The leading edge is plain padding until there is a picker
            behind it. */}
        <View style={styles.field}>
          <TextInput
            ref={inputRef}
            accessibilityLabel="Compose message"
            style={styles.input}
            placeholder={placeholder}
            placeholderTextColor={THEME.text_muted}
            // The reference tints the caret with the app accent. `cursorColor`
            // is the Android property; `selectionColor` covers both platforms.
            selectionColor={THEME.accent}
            cursorColor={THEME.accent}
            value={draft}
            editable={!disabled && !sending}
            onChangeText={(t) => setDraft(t.slice(0, MAX_USER_MESSAGE_LEN_CLIENT))}
            multiline
            blurOnSubmit={false}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach image"
            onPress={handleAttachPress}
            disabled={disabled || sending}
            hitSlop={ICON_HIT_SLOP_PT}
            style={({ pressed }) => [styles.fieldIcon, pressed && styles.pressed]}
            testID="composer-attach"
          >
            <Text style={styles.attachIcon}>📎</Text>
          </Pressable>
        </View>
        {/* THE ACTION BUTTON — outside the capsule, to its right, and it SWAPS
            BY CONTENT: microphone while the field is empty, send once there is
            something to send. That swap is the affordance; the slot itself is
            always occupied, so the capsule never reflows mid-typing. */}
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
                  <ActivityIndicator size="small" color={THEME.background} />
                ) : (
                  // The accessibility label stays "Send" — that is what a screen
                  // reader announces and what the device harness presses.
                  <SendPlane color={THEME.background} fill={THEME.accent} />
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
              onPress={handleVoiceTap}
              onLongPress={handleVoiceHoldStart}
              onPressOut={handleVoiceRelease}
              onTouchMove={handleVoiceTouchMove}
              delayLongPress={250}
              disabled={disabled || sending}
              hitSlop={ACTION_HIT_SLOP_PT}
              style={({ pressed }) => [
                styles.voiceBtn,
                holding !== null && styles.voiceBtnHolding,
                holding?.cancelling === true && styles.voiceBtnCancelling,
                pressed && styles.pressed,
              ]}
            >
              <MicGlyph color={holding === null ? THEME.text_muted : THEME.background} />
            </Pressable>
          )}
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

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.sm,
    // `paddingBottom` is supplied per-render (`bottom_inset`) — it is the home
    // indicator when the keyboard is down and a bare gap when it is up, and a
    // fixed value here is what buried the send button under the home indicator.
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: THEME.hairline,
    backgroundColor: THEME.background,
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
    borderColor: THEME.hairline,
    backgroundColor: THEME.surface,
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
    color: THEME.text_primary,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    // BOTTOM-aligned, not centred. Once the field grows past one line the
    // action button must track the LAST line; centring it against a grown field
    // is the tell that the pattern was copied from a single-line screenshot.
    alignItems: 'flex-end',
    gap: SPACING.sm,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    // Filled, not outlined: a shade lighter than the bar behind it.
    backgroundColor: THEME.surface_raised,
    // A PILL, not a rounded rectangle: half the RESTING height, so one line is
    // fully round and extra lines grow it into a rounded box.
    borderRadius: FIELD_MIN_HEIGHT_PT / 2,
    minHeight: FIELD_MIN_HEIGHT_PT,
    paddingRight: SPACING.xs,
  },
  fieldIcon: {
    height: FIELD_ICON_SIZE_PT,
    width: FIELD_ICON_SIZE_PT,
    borderRadius: FIELD_ICON_SIZE_PT / 2,
    justifyContent: 'center',
    alignItems: 'center',
    // Keeps the icon level with the last line as the capsule grows.
    marginBottom: (FIELD_MIN_HEIGHT_PT - FIELD_ICON_SIZE_PT) / 2,
  },
  attachIcon: { fontSize: 17 },
  input: {
    flex: 1,
    color: THEME.text_primary,
    paddingLeft: SPACING.md,
    paddingRight: SPACING.xs,
    paddingVertical: FIELD_PADDING_V_PT,
    ...TYPOGRAPHY.body,
    minHeight: FIELD_MIN_HEIGHT_PT,
    // THE GROWTH CAP. Past this the TextInput scrolls its own content and the
    // bar stops rising, which is the behaviour the field is supposed to have
    // and the one most often skipped.
    maxHeight: FIELD_MAX_HEIGHT_PT,
  },
  actionSlot: {
    height: ACTION_BUTTON_SIZE_PT,
    width: ACTION_BUTTON_SIZE_PT,
  },
  actionFill: {
    height: '100%',
    width: '100%',
  },
  // The resting mic is quiet — an outlined circle, not a filled one, so the
  // filled accent circle means "send" and nothing else.
  voiceBtn: {
    height: ACTION_BUTTON_SIZE_PT,
    width: ACTION_BUTTON_SIZE_PT,
    borderRadius: ACTION_BUTTON_SIZE_PT / 2,
    backgroundColor: THEME.surface_raised,
    justifyContent: 'center',
    alignItems: 'center',
  },
  /** Holding: the control fills, the way the reference's does while recording. */
  voiceBtnHolding: { backgroundColor: THEME.accent },
  /** Slid far enough that releasing discards. */
  voiceBtnCancelling: { backgroundColor: THEME.danger },
  micGlyph: {
    height: MIC_BOX_PT,
    width: MIC_BOX_PT,
  },
  micHead: {
    position: 'absolute',
    left: 5,
    top: 0,
    width: 8,
    height: 11,
    borderRadius: 4,
  },
  // A U: a box with its top border removed and its bottom corners rounded.
  micCradle: {
    position: 'absolute',
    left: 2,
    top: 7,
    width: 14,
    height: 8,
    borderWidth: 2,
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
  },
  micStem: {
    position: 'absolute',
    left: 8,
    top: 15,
    width: 2,
    height: 3,
  },
  sendBtn: {
    height: ACTION_BUTTON_SIZE_PT,
    width: ACTION_BUTTON_SIZE_PT,
    borderRadius: ACTION_BUTTON_SIZE_PT / 2,
    backgroundColor: THEME.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendGlyph: {
    height: GLYPH_BOX_PT,
    width: PLANE_W_PT,
    // The optical-centring shift; see the SendPlane doc comment.
    marginLeft: PLANE_NUDGE_PT,
    justifyContent: 'center',
  },
  // A right-pointing filled triangle: zero-size box, coloured left border,
  // transparent top/bottom borders.
  sendPlaneBody: {
    width: 0,
    height: 0,
    borderStyle: 'solid',
    borderTopWidth: GLYPH_BOX_PT / 2,
    borderBottomWidth: GLYPH_BOX_PT / 2,
    borderLeftWidth: PLANE_W_PT,
    borderRightWidth: 0,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderRightColor: 'transparent',
  },
  // The same triangle in the BUTTON's fill colour, painted over the trailing
  // edge — that notch is the difference between a paper plane and a play arrow.
  sendPlaneNotch: {
    position: 'absolute',
    left: 0,
    top: (GLYPH_BOX_PT - PLANE_NOTCH_H_PT) / 2,
    width: 0,
    height: 0,
    borderStyle: 'solid',
    borderTopWidth: PLANE_NOTCH_H_PT / 2,
    borderBottomWidth: PLANE_NOTCH_H_PT / 2,
    borderLeftWidth: PLANE_NOTCH_W_PT,
    borderRightWidth: 0,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderRightColor: 'transparent',
  },
  pressed: { opacity: 0.7 },
  counter: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
    textAlign: 'right',
  },
  counterOver: {
    color: THEME.danger,
  },
  hint: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
    fontStyle: 'italic',
  },
});
