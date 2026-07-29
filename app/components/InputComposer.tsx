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
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { MAX_USER_MESSAGE_LEN_CLIENT, DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';

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
  /** Hint shown under the composer (e.g. "Or type a response…" for freeform prompts). */
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
}

const COUNTER_WARN_THRESHOLD = Math.floor(MAX_USER_MESSAGE_LEN_CLIENT * 0.9);

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
    <View style={styles.wrap}>
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach image"
          onPress={handleAttachPress}
          disabled={disabled || sending}
          style={({ pressed }) => [styles.attachBtn, pressed && styles.pressed]}
          testID="composer-attach"
        >
          <Text style={styles.attachIcon}>📎</Text>
        </Pressable>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Compose message"
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={THEME.text_muted}
          value={draft}
          editable={!disabled && !sending}
          onChangeText={(t) => setDraft(t.slice(0, MAX_USER_MESSAGE_LEN_CLIENT))}
          multiline
          blurOnSubmit={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.sendBtn,
            !canSend && styles.sendBtnDisabled,
            pressed && styles.pressed,
          ]}
        >
          {sending ? (
            <ActivityIndicator color={THEME.background} />
          ) : (
            <Text style={styles.sendBtnText}>Send</Text>
          )}
        </Pressable>
      </View>
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
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.lg,
    borderTopWidth: 1,
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
    alignItems: 'flex-end',
    gap: SPACING.sm,
  },
  attachBtn: {
    height: 40,
    width: 40,
    borderRadius: 10,
    backgroundColor: THEME.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  attachIcon: { fontSize: 18 },
  input: {
    flex: 1,
    color: THEME.text_primary,
    backgroundColor: THEME.surface,
    borderRadius: DENSITY.composer_radius,
    paddingHorizontal: SPACING.md + 2,
    paddingVertical: SPACING.sm + 2,
    ...TYPOGRAPHY.body,
    minHeight: 40,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  sendBtn: {
    height: 40,
    paddingHorizontal: SPACING.lg + 2,
    borderRadius: DENSITY.composer_radius,
    backgroundColor: THEME.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: { backgroundColor: THEME.surface_raised },
  sendBtnText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.background,
    fontWeight: '700',
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
