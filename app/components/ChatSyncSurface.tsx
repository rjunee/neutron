/**
 * @neutronai/app — THE native chat surface. One Telegram-grade screen on
 * FlashList v2 + the chat-core durable local store ({@link useMobileChat}).
 * This is the single Chat tab; there is no second surface (the legacy
 * `chat.tsx` streaming surface + its `chat-state`/`ws-client` transport were
 * deleted in the 2026-06-29 chat-collapse).
 *
 * Transport (chat-core, durable): optimistic + offline-safe send, gap-free
 * reconnect/resume, instant cold-open from op-sqlite (InMemory fallback on
 * web), foreground push catch-up. Per-message delivery ladder (🕓→✓→✓✓→read),
 * read receipts, reactions, edit/delete, a live streaming/typing bubble.
 *
 * Rich rendering (ported from the legacy MessageItem so the single surface is
 * at full parity): agent markdown bodies, inline + attached images, source
 * citations, doc-reference deep-link chips, onboarding option buttons /
 * image-gallery, and the top-level `deep_link` navigation.
 *
 * Input + upload (ported from the legacy chat route): the full InputComposer
 * (📎 picker, paste, web file-input, hint, char-counter, Cmd-Enter), the
 * history-import ZIP + image upload pipeline (UploadModal progress), web
 * drag-drop (DropZoneOverlay), and phase-aware upload-affordance gating.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';

import { spentChoiceValue } from '@neutronai/chat-core';
import type { ChatMessage, ChatMessageDocRef, ConnStatus } from '@neutronai/chat-core';

import {
  deliveryGlyph,
  deliveryState,
  groupReactions,
  type RenderRow,
} from '../lib/chat-core/chat-render-model';
import { dispatchUnseenDeepLinks } from '../lib/chat-core/deep-link-dispatch';
import { useMobileChat } from '../lib/chat-core/use-mobile-chat';
import { SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import { useAuthSession } from '../lib/session';
import { loadAppConfig } from '../lib/config';
import { RenderMarkdown } from '../lib/markdown-render';
import { AuthedAttachmentImage } from './AuthedAttachmentImage';
import type { AttachmentAuthCtx } from '../lib/attachment-url';
import { ButtonOptionRow, ImageGalleryRow } from '../lib/button-primitives';
import { CitationChipRow } from '../lib/citation-chip-row';
import { docLinkToRouterPath, parseDocLink } from '../lib/doc-links';
import { InputComposer, type ComposerAttachment, type ComposerFileEvent } from './InputComposer';
import { UploadModal } from './UploadModal';
import { DropZoneOverlay } from './DropZoneOverlay';
import { useUploadState } from '../lib/use-upload-state';
import { classifyUploadKind } from '../lib/upload-client';
import { selectDropFiles, shouldGateUpload } from '../lib/upload-gate';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BUBBLE_MAX_WIDTH,
  BUBBLE_PADDING_H_PT,
  BUBBLE_PADDING_V_PT,
  BUBBLE_RADIUS_PT,
  BUBBLE_TAIL_RADIUS_PT,
  bubbleGapPt,
  bubbleHasTail,
  type BubbleSpeaker,
} from '../lib/chat-bubble-metrics';
import { composerBottomInset } from '../lib/keyboard-inset';
import { useKeyboardInset } from '../lib/use-keyboard-inset';

/** Quick-reaction palette the long-press tray offers (Track B Phase 4). */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '🔥'] as const;
/** Multi-file drop hint TTL. */
const MULTI_FILE_HINT_TTL_MS = 6000;

export interface ChatSyncSurfaceProps {
  /** The project this chat is scoped to (empty string = global transcript). */
  projectId: string;
  /** ISSUE #17 — launcher long-press `chat_send_prefix` seed for the composer. */
  initialPrefill?: string;
  /** ISSUE #17 — launcher long-press `chat_send` one-shot autosend text. */
  initialAutosend?: string;
}

/** FlashList viewable-items payload (loosely typed — FlashList v2's callback
 *  hands us `{ viewableItems: { item }[] }`). */
interface ViewableItemsChange {
  viewableItems: ReadonlyArray<{ item?: RenderRow }>;
}

export function ChatSyncSurface({
  projectId,
  initialPrefill,
  initialAutosend,
}: ChatSyncSurfaceProps): React.JSX.Element {
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const router = useRouter();
  const isWeb = Platform.OS === 'web';

  const {
    rows,
    status,
    typing,
    systemNotice,
    pendingCount,
    ready,
    hydrated,
    send,
    sendError,
    markRead,
    react,
    editMessage,
    deleteMessage,
    chooseOption,
    retry,
    selfDeviceId,
  } = useMobileChat(projectId);

  // Bearer + gateway origin so agent attachments (`/api/app/upload/…`) render.
  const attachmentAuth = useMemo<AttachmentAuthCtx | null>(
    () => (user !== null ? { base_url: config.base_url, token: user.token } : null),
    [user, config.base_url],
  );
  // The per-user app-ws topic — used as the `X-Neutron-Topic-Id` for ZIP imports.
  const topicId = user !== null ? `app:${user.id}` : null;

  // Durable transcript (drop the live streaming bubbles) for affordance + deep-link.
  const messages = useMemo<ChatMessage[]>(
    () => rows.filter((r): r is Extract<RenderRow, { kind: 'message' }> => r.kind === 'message').map((r) => r.message),
    [rows],
  );
  const uploadAffordance = useLatestUploadAffordance(messages);

  const hasPromptWithFreeform = useMemo(
    () => messages.some((m) => m.role === 'agent' && m.allow_freeform === true),
    [messages],
  );

  // ISSUE #18 — single client-side consumer of the top-level `deep_link`.
  const seenDeepLinks = useRef<Set<string>>(new Set());
  useEffect(() => {
    dispatchUnseenDeepLinks(messages, seenDeepLinks.current, (href) => {
      router.push(href as Parameters<typeof router.push>[0]);
    });
  }, [messages, router]);

  // ISSUE #17 — one-shot autosend once the socket is open.
  const autosendDispatched = useRef(false);
  useEffect(() => {
    if (autosendDispatched.current) return;
    if (initialAutosend === undefined || initialAutosend.length === 0) return;
    if (status !== 'open') return;
    autosendDispatched.current = true;
    void send(initialAutosend);
  }, [initialAutosend, status, send]);

  const onToggleReaction = useCallback(
    (messageId: string, emoji: string, reactedBySelf: boolean): void => {
      react(messageId, emoji, reactedBySelf ? 'remove' : 'add');
    },
    [react],
  );

  // ISSUES #419 — the OPTIMISTIC half of spent-ness only. It collapses the row
  // on the same frame as the tap, before the server round-trip; it is session-
  // scoped and a remount throws it away. That used to be the ONLY guard, and its
  // comment claimed "the server advances the prompt after a choice, so a fresh
  // cold-open never shows an answered-but-still-open prompt" — which was simply
  // not true: nothing marked the prompt answered anywhere the client could see,
  // and a reply row lives for TEN YEARS, so every remount redrew a live Retry
  // button on an already-answered prompt. The durable half now rides on the
  // message itself (`chosen_value`, stamped server-side); `spentChoiceValue`
  // combines the two and is THE rule both chat surfaces share.
  const [chosenByPrompt, setChosenByPrompt] = useState<Record<string, string>>({});
  const onChoose = useCallback(
    (value: string, promptId?: string): void => {
      if (promptId === undefined || promptId.length === 0) return;
      if (chosenByPrompt[promptId] !== undefined) return; // already answered
      setChosenByPrompt((prev) => ({ ...prev, [promptId]: value }));
      chooseOption(promptId, value);
    },
    [chooseOption, chosenByPrompt],
  );

  const onDocRef = useCallback(
    (ref: ChatMessageDocRef): void => {
      const parsed = parseDocLink(ref.url);
      if (parsed !== null) {
        const target = docLinkToRouterPath(parsed);
        if (target !== null) {
          router.push(target as Parameters<typeof router.push>[0]);
          return;
        }
      }
      void Linking.openURL(ref.url).catch(() => undefined);
    },
    [router],
  );

  // ── Upload pipeline (images + history-import ZIPs) ────────────────────────
  const upload = useUploadState({
    base_url: config.base_url,
    token: user?.token ?? null,
    topic_id: topicId,
    onImageUploaded: async (url: string) => {
      // Canonical image handoff: a user message whose body is empty and whose
      // attachments[] carries the uploaded URL (the gateway echo reconciles).
      await send('', [url]);
    },
  });

  const handleFilesPicked = useCallback(
    (files: ReadonlyArray<ComposerFileEvent>) => {
      if (files.length === 0) return;
      for (const f of files) {
        const kind = classifyUploadKind({ name: f.name, mime_type: f.mime_type });
        // Phase-gate ZIPs (history import only fires in import phases); images
        // upload any time the composer is enabled.
        if (shouldGateUpload(kind, uploadAffordance)) continue;
        upload.start({
          uri: f.uri,
          name: f.name,
          mime_type: f.mime_type,
          ...(f.size_bytes !== undefined ? { size_bytes: f.size_bytes } : {}),
          kind,
        });
      }
    },
    [upload, uploadAffordance],
  );

  const handleNativePickAttachments = useCallback(async (): Promise<ComposerAttachment[]> => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        // Argus r2 #7 — mirror the server whitelist (images + PDF + history-
        // import ZIP) so the OS picker greys out unsupported files up front,
        // instead of letting a pick sail through to a raw 415 from the upload
        // surface. Kept in sync with `mimeToExt` (`app/lib/upload-client.ts`).
        type: [
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'application/pdf',
          // M2 task 5 — audio voice notes. iOS reports the `x-` forms, so list
          // both canonical + alias MIMEs (the server canonicalizes on sniff).
          'audio/mpeg',
          'audio/mp3',
          'audio/mp4',
          'audio/m4a',
          'audio/x-m4a',
          'audio/wav',
          'audio/x-wav',
          'application/zip',
        ],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return [];
      const events: ComposerFileEvent[] = res.assets.map((a) => {
        const evt: ComposerFileEvent = { uri: a.uri, name: a.name, mime_type: a.mimeType ?? '' };
        if (typeof a.size === 'number') evt.size_bytes = a.size;
        return evt;
      });
      if (events.length > 0) handleFilesPicked(events);
    } catch (err) {
      console.warn('[chat] DocumentPicker.getDocumentAsync threw:', err);
    }
    return [];
  }, [handleFilesPicked]);

  const handleSend = useCallback(
    async ({ body }: { body: string; attachments: ComposerAttachment[] }): Promise<boolean> => {
      // Inline composer attachments are routed through the upload modal
      // (`onFilesPicked`), so the send path only carries text here.
      //
      // The RESULT IS RETURNED, not discarded: `InputComposer` clears its draft
      // only on `true`, so a send that could not be queued leaves the owner's
      // text in the box. Returning a hardcoded `true` (what this used to do) meant
      // a dropped message ALSO destroyed what he typed.
      return await send(body);
    },
    [send],
  );

  // ── Web drag-drop (mirrors the legacy chat surface) ───────────────────────
  const [dragging, setDragging] = useState(false);
  const [dropMultiFileHint, setDropMultiFileHint] = useState<string | null>(null);
  useEffect(() => {
    if (dropMultiFileHint === null) return undefined;
    const t = setTimeout(() => setDropMultiFileHint(null), MULTI_FILE_HINT_TTL_MS);
    return () => clearTimeout(t);
  }, [dropMultiFileHint]);
  const dragDepth = useRef(0);
  useEffect(() => {
    if (!isWeb) return undefined;
    const doc = globalThis as {
      addEventListener?: (e: string, h: (e: DragEvent) => void) => void;
      removeEventListener?: (e: string, h: (e: DragEvent) => void) => void;
    };
    if (typeof doc.addEventListener !== 'function') return undefined;
    const onEnter = (e: DragEvent): void => {
      if (!hasFileInDataTransfer(e.dataTransfer)) return;
      dragDepth.current += 1;
      if (uploadAffordance !== null) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const onOver = (e: DragEvent): void => {
      if (!hasFileInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent): void => {
      if (!hasFileInDataTransfer(e.dataTransfer)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFileInDataTransfer(e.dataTransfer)) return;
      dragDepth.current = 0;
      setDragging(false);
      e.preventDefault();
      const dt = e.dataTransfer;
      if (dt === null || dt.files === null || dt.files.length === 0) return;
      const raw: Array<{ file: File; name: string; mime_type: string; size_bytes: number }> = [];
      for (let i = 0; i < dt.files.length; i++) {
        const file = dt.files.item(i);
        if (file === null) continue;
        raw.push({ file, name: file.name, mime_type: file.type ?? '', size_bytes: file.size });
      }
      const outcome = selectDropFiles(raw);
      if (outcome.hint !== null) setDropMultiFileHint(outcome.hint);
      if (outcome.files.length === 0) return;
      const first = outcome.files[0] as (typeof raw)[number] | undefined;
      if (first === undefined) return;
      const uri = URL.createObjectURL(first.file);
      handleFilesPicked([
        {
          uri,
          name: first.name,
          mime_type: first.mime_type,
          ...(first.size_bytes !== undefined ? { size_bytes: first.size_bytes } : {}),
        },
      ]);
    };
    doc.addEventListener('dragenter', onEnter);
    doc.addEventListener('dragover', onOver);
    doc.addEventListener('dragleave', onLeave);
    doc.addEventListener('drop', onDrop);
    return () => {
      if (typeof doc.removeEventListener !== 'function') return;
      doc.removeEventListener('dragenter', onEnter);
      doc.removeEventListener('dragover', onOver);
      doc.removeEventListener('dragleave', onLeave);
      doc.removeEventListener('drop', onDrop);
    };
  }, [isWeb, uploadAffordance, handleFilesPicked]);

  // NO HINT FOR THE FREEFORM PROMPT. It used to read "Or type a response to the
  // prompt above." — the same sentence the placeholder already shows (see the
  // `placeholder` prop below), rendered as a permanent extra line directly above
  // the keyboard, in the region that has the least room to spare. Owner,
  // 2026-07-30: *"what is that text at the bottom about typing a response to the
  // prompt? Unnecessary"*. The prop survives for the upload affordance, which
  // says something the placeholder does not.
  const composerHint = useMemo<string | undefined>(() => {
    if (uploadAffordance !== null) {
      const label = sourceLabel(uploadAffordance.source);
      return `Drag your ${label} export ZIP here, paste it, or tap 📎 to pick it.`;
    }
    return undefined;
  }, [uploadAffordance]);

  // iMessage shows ONE delivery status in the whole thread — under the newest
  // outgoing message — not a tick on every bubble. Anything else is a Telegram
  // ladder, and rendering it inside every user bubble is most of the "too much
  // padding at the bottom of each message bubble" Ryan is looking at. A FAILED
  // send is exempt: its glyph is the retry affordance and must never be hidden.
  const lastUserRowKey = useMemo<string | null>(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r !== undefined && r.kind === 'message' && r.message.role === 'user') return r.key;
    }
    return null;
  }, [rows]);

  const renderItem = useCallback(
    ({ item, index }: { item: RenderRow; index: number }) => {
      const promptId = item.kind === 'message' ? item.message.prompt_id : null;
      // ISSUES #419 — server state first, this session's optimistic tap second.
      const chosenValue =
        item.kind === 'message'
          ? (spentChoiceValue(
              item.message,
              promptId !== null && promptId !== undefined ? chosenByPrompt[promptId] : null,
            ) ?? undefined)
          : undefined;
      // Sender-run grouping: the neighbours decide the gap above this bubble and
      // whether it wears the tail. Derived here rather than baked into the row
      // so `buildRenderRows` stays a pure transcript merge.
      const previous = speakerOf(rows[index - 1]);
      const next = speakerOf(rows[index + 1]);
      const speaker = speakerOf(item) ?? 'agent';
      return (
        <ChatRow
          row={item}
          gapTop={bubbleGapPt(previous, speaker)}
          hasTail={bubbleHasTail(speaker, next)}
          showDelivery={item.key === lastUserRowKey}
          selfDeviceId={selfDeviceId}
          auth={attachmentAuth}
          {...(chosenValue !== undefined ? { chosenValue } : {})}
          onToggleReaction={onToggleReaction}
          onEdit={editMessage}
          onDelete={deleteMessage}
          onChoose={onChoose}
          onRetry={retry}
          onDocRef={onDocRef}
        />
      );
    },
    [rows, lastUserRowKey, selfDeviceId, attachmentAuth, chosenByPrompt, onToggleReaction, editMessage, deleteMessage, onChoose, retry, onDocRef],
  );

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: ViewableItemsChange): void => {
      const ids: string[] = [];
      for (const v of viewableItems) {
        const item = v.item;
        if (
          item !== undefined &&
          item.kind === 'message' &&
          item.message.role === 'agent' &&
          item.message.message_id !== null
        ) {
          ids.push(item.message.message_id);
        }
      }
      if (ids.length > 0) markRead(ids);
    },
    [markRead],
  );

  // KEYBOARD AVOIDANCE. `KeyboardAvoidingView` cannot do this job here: it
  // measures itself PARENT-relative, and this surface is nested under the shell's
  // status-bar padding + the project header + the tab bar, so it under-padded by
  // exactly that chrome and the keyboard covered the composer outright. The
  // window-space measurement below is depth-independent. See
  // `lib/keyboard-inset.ts` for the arithmetic and the incident.
  // THE OTHER HALF OF "the composer is not fully visible". With the keyboard
  // DOWN the surface runs to the physical bottom of the screen — the shell
  // applies no bottom inset anywhere — so the send button sat under the home
  // indicator. `composerBottomInset` adds the safe area only while the keyboard
  // is down, so the two lifts can never double-offset each other.
  const safeArea = useSafeAreaInsets();
  // The same inset is ALSO an input to the Android lift: RN reports the Android
  // keyboard net of the navigation bar it draws over, so the bar has to be added
  // back to reach the window's bottom edge. See `lib/keyboard-inset.ts`.
  const { inset: keyboardInset, containerRef } = useKeyboardInset({
    safeAreaBottom: safeArea.bottom,
  });
  const composerBottom = composerBottomInset({
    keyboardInset,
    safeAreaBottom: safeArea.bottom,
  });
  const listRef = useRef<FlashListRef<RenderRow> | null>(null);
  // Rising keyboard → stay on the newest message. `maintainVisibleContentPosition`
  // holds position through content changes, which is NOT the same as following
  // the bottom when the viewport itself shrinks.
  const prevInset = useRef(0);
  useEffect(() => {
    const grew = keyboardInset > prevInset.current;
    prevInset.current = keyboardInset;
    if (grew) listRef.current?.scrollToEnd?.({ animated: true });
  }, [keyboardInset]);

  return (
    // OUTER view: measured, and deliberately NEVER padded — padding it would move
    // the very edge whose position produced the padding.
    <View style={styles.fill} ref={containerRef} collapsable={false}>
      <View
        style={[styles.fill, keyboardInset > 0 ? { paddingBottom: keyboardInset } : null]}
        testID="chat-keyboard-inset"
      >
      <StatusStrip status={status} pendingCount={pendingCount} sendError={sendError} />
      {dropMultiFileHint !== null ? (
        <View style={styles.dropMultiFileHint} testID="chat-drop-multi-file-hint">
          <Text style={styles.dropMultiFileHintText}>{dropMultiFileHint}</Text>
        </View>
      ) : null}
      {!ready ? (
        <View style={styles.center} testID="chat-attaching">
          <ActivityIndicator color={THEME.accent} />
        </View>
      ) : (
        <FlashList
          ref={listRef}
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyForRow}
          contentContainerStyle={styles.listContent}
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.2,
          }}
          onViewableItemsChanged={onViewableItemsChanged}
          ListFooterComponent={<TranscriptFooter typing={typing} notice={systemNotice} />}
          // ISSUES #402 — only claim emptiness once history has SETTLED.
          // `ready` flips when the session object is constructed, before the
          // resume replay lands, so gating on it flashed "No messages yet" on
          // every project switch a moment before the transcript arrived.
          ListEmptyComponent={hydrated ? <EmptyState /> : <HydratingState />}
        />
      )}
      <InputComposer
        onSend={handleSend}
        bottom_inset={composerBottom}
        placeholder={hasPromptWithFreeform ? 'Or type a response…' : 'Message'}
        {...(composerHint !== undefined ? { hint: composerHint } : {})}
        {...(initialPrefill !== undefined && initialPrefill.length > 0
          ? { initial_draft: initialPrefill }
          : {})}
        onFilesPicked={handleFilesPicked}
        pickAttachments={handleNativePickAttachments}
      />
      <DropZoneOverlay
        visible={dragging && uploadAffordance !== null}
        {...(uploadAffordance !== null ? { source_label: sourceLabel(uploadAffordance.source) } : {})}
      />
      <UploadModal
        visible={upload.visible}
        phase={upload.phase}
        filename={upload.filename}
        kind={upload.kind}
        {...(upload.mime_type !== undefined ? { mime_type: upload.mime_type } : {})}
        {...(upload.bytes_sent !== undefined ? { bytes_sent: upload.bytes_sent } : {})}
        {...(upload.bytes_total !== undefined ? { bytes_total: upload.bytes_total } : {})}
        {...(upload.error_message !== undefined ? { error_message: upload.error_message } : {})}
        onCancel={upload.cancel}
        onRetry={upload.retry}
        onDismiss={upload.dismiss}
      />
      </View>
    </View>
  );
}

function keyForRow(row: RenderRow): string {
  return row.key;
}

function sourceLabel(source: 'chatgpt' | 'claude'): string {
  return source === 'claude' ? 'Claude' : 'ChatGPT';
}

function hasFileInDataTransfer(dt: DataTransfer | null): boolean {
  if (dt === null) return false;
  const types = dt.types;
  if (types === undefined || types === null) return false;
  const list = Array.from(types);
  return list.includes('Files') || list.includes('application/x-moz-file');
}

/** Walk the transcript backwards for the most recent agent message's
 *  `upload_affordance` (cleared by the engine's next advance → null). */
function useLatestUploadAffordance(
  messages: ReadonlyArray<ChatMessage>,
): { source: 'chatgpt' | 'claude' } | null {
  return useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m === undefined || m.role !== 'agent') continue;
      return m.upload_affordance ?? null;
    }
    return null;
  }, [messages]);
}

/** Which side of the transcript a row is on. `null` when there is no row. */
function speakerOf(row: RenderRow | undefined): BubbleSpeaker | null {
  if (row === undefined) return null;
  if (row.kind === 'streaming') return 'agent';
  return row.message.role === 'user' ? 'user' : 'agent';
}

/** One message or streaming bubble. */
function ChatRow({
  row,
  gapTop,
  hasTail,
  showDelivery,
  selfDeviceId,
  auth,
  chosenValue,
  onToggleReaction,
  onEdit,
  onDelete,
  onChoose,
  onRetry,
  onDocRef,
}: {
  row: RenderRow;
  /** Space above this bubble — 2pt inside a sender run, 8pt at a sender change. */
  gapTop: number;
  /** Tail corner: only the LAST bubble of a same-sender run gets one. */
  hasTail: boolean;
  /** Is this the newest outgoing message (the only one that shows a tick)? */
  showDelivery: boolean;
  selfDeviceId: string;
  auth: AttachmentAuthCtx | null;
  chosenValue?: string;
  onToggleReaction: (messageId: string, emoji: string, reactedBySelf: boolean) => void;
  onEdit: (messageId: string, body: string) => void;
  onDelete: (messageId: string) => void;
  onChoose: (value: string, promptId?: string) => void;
  onRetry: (clientMsgId: string) => void;
  onDocRef: (ref: ChatMessageDocRef) => void;
}): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  // The ONE place the run geometry is turned into styles, so every early-return
  // branch below (streaming / tombstone / edit / settled) gets the same rhythm.
  const rowGap = { marginTop: gapTop };

  if (row.kind === 'streaming') {
    return (
      <View style={[styles.bubbleWrap, styles.agentWrap, rowGap]} testID="chat-bubble-row">
        {/* Through `bubbleColumn` like every other row: this bubble BECOMES a
            settled one, so rendering it outside the capped column made it snap
            narrower the moment the stream finished. */}
        <View style={styles.bubbleColumn}>
          <View style={[styles.bubble, styles.agentBubble, hasTail ? styles.agentTail : null]}>
            <Text style={styles.agentText}>{row.body}</Text>
          </View>
        </View>
      </View>
    );
  }

  const { message } = row;
  const isUser = message.role === 'user';
  const delivery = deliveryState(message, selfDeviceId);
  const chips = groupReactions(message, selfDeviceId);
  const canReact = message.message_id !== null;
  const canMutate = isUser && canReact && message.deleted !== true;
  const isDeleted = message.deleted === true;
  const wasEdited = !isDeleted && message.edited_at !== null && message.edited_at !== undefined;
  // iMessage's single status line: only the newest outgoing message reports its
  // delivery. A FAILED send always reports, wherever it sits in the thread —
  // that glyph is the retry button, and hiding it would hide the failure.
  const showMeta = delivery !== null && (showDelivery || delivery === 'failed');

  const toggleReact = (emoji: string, reactedBySelf: boolean): void => {
    if (message.message_id === null) return;
    onToggleReaction(message.message_id, emoji, reactedBySelf);
    setPickerOpen(false);
  };
  const beginEdit = (): void => {
    setPickerOpen(false);
    setDraft(message.body);
  };
  const submitEdit = (): void => {
    if (message.message_id === null || draft === null) return;
    const next = draft.trim();
    if (next.length > 0 && next !== message.body) onEdit(message.message_id, next);
    setDraft(null);
  };
  const remove = (): void => {
    setPickerOpen(false);
    if (message.message_id !== null) onDelete(message.message_id);
  };

  if (isDeleted) {
    return (
      <View style={[styles.bubbleWrap, isUser ? styles.userWrap : styles.agentWrap, rowGap]} testID="chat-bubble-row">
        <View style={styles.bubbleColumn}>
          <View style={[styles.bubble, styles.tombstoneBubble]}>
            <Text style={styles.tombstoneText}>🚫 This message was deleted</Text>
          </View>
        </View>
      </View>
    );
  }

  if (draft !== null) {
    return (
      <View style={[styles.bubbleWrap, isUser ? styles.userWrap : styles.agentWrap, rowGap]} testID="chat-bubble-row">
        <View style={styles.bubbleColumn}>
          <View style={[styles.bubble, isUser ? styles.userBubble : styles.agentBubble]}>
            <TextInput
              style={[styles.editInput, isUser ? styles.userText : styles.agentText]}
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              accessibilityLabel="Edit message"
            />
          </View>
          <View style={[styles.reactionRow, isUser ? styles.trayUser : styles.trayAgent]}>
            <Pressable onPress={() => setDraft(null)} accessibilityRole="button" accessibilityLabel="Cancel edit" style={styles.chip}>
              <Text style={styles.chipText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={submitEdit} accessibilityRole="button" accessibilityLabel="Save edit" style={[styles.chip, styles.chipSelf]}>
              <Text style={styles.chipText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const attachmentUrls = [
    ...(message.attachments ?? []),
    ...(message.image_urls ?? []),
  ];

  return (
    <View style={[styles.bubbleWrap, isUser ? styles.userWrap : styles.agentWrap, rowGap]} testID="chat-bubble-row">
      <View style={styles.bubbleColumn}>
        <Pressable
          onLongPress={canReact ? () => setPickerOpen((v) => !v) : undefined}
          delayLongPress={250}
          accessibilityLabel={canReact ? 'Long-press for actions' : undefined}
        >
          <View
            style={[
              styles.bubble,
              isUser ? styles.userBubble : styles.agentBubble,
              hasTail ? (isUser ? styles.userTail : styles.agentTail) : null,
            ]}
          >
            {isUser ? (
              message.body.length > 0 ? <Text style={styles.userText}>{message.body}</Text> : null
            ) : (
              <RenderMarkdown source={message.body} textColor={THEME.text_primary} />
            )}
            {attachmentUrls.length > 0 ? (
              <View style={styles.attachments}>
                {attachmentUrls.map((url) => (
                  <AuthedAttachmentImage key={url} url={url} auth={auth} style={styles.attachment} />
                ))}
              </View>
            ) : null}
            {!isUser && message.citations !== null && message.citations !== undefined && message.citations.length > 0 ? (
              <CitationChipRow citations={message.citations} />
            ) : null}
            {!isUser && message.doc_refs !== null && message.doc_refs !== undefined && message.doc_refs.length > 0 ? (
              <View style={styles.docRefs} testID="msg-doc-refs">
                <Text style={styles.docRefsHeading}>Linked docs</Text>
                {message.doc_refs.map((ref) => (
                  <Pressable
                    key={ref.url}
                    accessibilityRole="link"
                    accessibilityLabel={ref.label}
                    testID={`doc-ref-${ref.path}`}
                    onPress={() => onDocRef(ref)}
                    style={({ pressed }) => [styles.docRefBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.docRefIcon}>📄</Text>
                    <View style={styles.docRefTextCol}>
                      <Text style={styles.docRefLabel} numberOfLines={1}>{ref.label}</Text>
                      <Text style={styles.docRefPath} numberOfLines={1}>
                        {ref.project_id === null ? `vault: ${ref.path}` : `${ref.project_id} · ${ref.path}`}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {!isUser && message.options !== null && message.options !== undefined && message.options.length > 0 ? (
              message.kind === 'image-gallery' ? (
                <ImageGalleryRow
                  options={message.options}
                  {...(message.prompt_id !== null && message.prompt_id !== undefined ? { prompt_id: message.prompt_id } : {})}
                  {...(chosenValue !== undefined ? { chosen_value: chosenValue } : {})}
                  onChoose={onChoose}
                />
              ) : (
                <ButtonOptionRow
                  options={message.options}
                  {...(message.prompt_id !== null && message.prompt_id !== undefined ? { prompt_id: message.prompt_id } : {})}
                  {...(chosenValue !== undefined ? { chosen_value: chosenValue } : {})}
                  onChoose={onChoose}
                />
              )
            ) : null}
          </View>
        </Pressable>
        {/* THE META LINE LIVES OUTSIDE THE BUBBLE, iMessage-style. It used to be
            the bubble's last child, so every outgoing message carried an extra
            text row INSIDE its own padded box — the bottom space Ryan kept
            pointing at. Rendered at all only when it has something to say. */}
        {wasEdited || showMeta ? (
          <View style={[styles.metaRow, isUser ? styles.trayUser : styles.trayAgent]}>
            {wasEdited ? (
              <Text style={styles.editedLabel} accessibilityLabel="edited">
                edited
              </Text>
            ) : null}
            {showMeta && delivery === 'failed' ? (
              // W5 GAP-4 — a failed send: the ⚠️ glyph is a tappable retry
              // affordance (per-message, idempotent), not a dead warning.
              // Parity with the web ⚠️ "Failed — retry" button.
              <Pressable
                onPress={() => onRetry(message.client_msg_id)}
                accessibilityRole="button"
                accessibilityLabel="Message failed to send — retry"
                hitSlop={8}
              >
                <Text style={[styles.delivery, styles.deliveryFailed]}>
                  {deliveryGlyph(delivery)} retry
                </Text>
              </Pressable>
            ) : showMeta && delivery !== null ? (
              <Text
                style={[styles.delivery, delivery === 'read' ? styles.deliveryRead : null]}
                accessibilityLabel={`delivery: ${delivery}`}
              >
                {deliveryGlyph(delivery)}
              </Text>
            ) : null}
          </View>
        ) : null}
        {pickerOpen ? (
          <View style={[styles.reactionTray, isUser ? styles.trayUser : styles.trayAgent]}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => {
                  const existing = chips.find((c) => c.emoji === emoji);
                  toggleReact(emoji, existing?.reactedBySelf ?? false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`React ${emoji}`}
                style={styles.trayEmojiBtn}
              >
                <Text style={styles.trayEmoji}>{emoji}</Text>
              </Pressable>
            ))}
            {canMutate ? (
              <>
                <Pressable onPress={beginEdit} accessibilityRole="button" accessibilityLabel="Edit message" style={styles.trayEmojiBtn}>
                  <Text style={styles.trayAction}>Edit</Text>
                </Pressable>
                <Pressable onPress={remove} accessibilityRole="button" accessibilityLabel="Delete message" style={styles.trayEmojiBtn}>
                  <Text style={[styles.trayAction, styles.trayActionDanger]}>Delete</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : null}
        {chips.length > 0 ? (
          <View style={[styles.reactionRow, isUser ? styles.trayUser : styles.trayAgent]}>
            {chips.map((chip) => (
              <Pressable
                key={chip.emoji}
                onPress={() => toggleReact(chip.emoji, chip.reactedBySelf)}
                accessibilityRole="button"
                accessibilityLabel={`${chip.emoji} ${chip.count}${chip.reactedBySelf ? ', reacted' : ''}`}
                style={[styles.chip, chip.reactedBySelf ? styles.chipSelf : null]}
              >
                <Text style={styles.chipText}>
                  {chip.emoji} {chip.count}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The live tail of the transcript: the typing bubble and the TRANSIENT system
 * pill. Both are ephemeral, neither is a row in `rows`, and the pill is
 * explicitly NOT a chat bubble — see {@link SystemNoticePill}.
 */
function TranscriptFooter({
  typing,
  notice,
}: {
  typing: boolean;
  notice: string | null;
}): React.JSX.Element | null {
  if (!typing && notice === null) return null;
  return (
    <View>
      {typing ? <TypingIndicator /> : null}
      <SystemNoticePill text={notice} />
    </View>
  );
}

/**
 * The cold-start "⏳ Waking up, one moment…" ack, as a quiet centered pill.
 *
 * WHY IT IS NOT A BUBBLE. The gateway sends this as a live-only `agent_message`
 * carrying `system_notice: true` and NO `seq` — it is never written to the
 * durable chat_log (`AppWsAdapter.send`). The web client has always routed it to
 * a separate `systemNotice` channel; the native client had no such channel, so
 * `normalizeInbound` turned it into an ordinary agent message and the local
 * store kept it forever. Ryan saw "Waking up…" sitting in his transcript as a
 * thing the agent had apparently said. This is the same mechanism as web, down
 * to the shared `isTransientSystemNotice` predicate, not a second one.
 */
function SystemNoticePill({ text }: { text: string | null }): React.JSX.Element | null {
  if (text === null) return null;
  return (
    <View style={styles.systemNoticeRow} testID="chat-system-notice">
      <View style={styles.systemNoticePill}>
        <ActivityIndicator size="small" color={THEME.text_muted} />
        <Text style={styles.systemNoticeText} accessibilityRole="text">
          {text}
        </Text>
      </View>
    </View>
  );
}

function TypingIndicator(): React.JSX.Element {
  return (
    <View style={[styles.bubbleWrap, styles.agentWrap, styles.footerGap]}>
      <View style={styles.bubbleColumn}>
        <View style={[styles.bubble, styles.agentBubble, styles.agentTail, styles.typingBubble]}>
          <Text style={styles.typingText}>•••</Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Shown while this scope's history is still settling. Deliberately NOT the
 * empty state: "we have not fetched yet" and "there is nothing here" are
 * different facts, and showing the second for the first is what made switching
 * projects feel broken (ISSUES #402).
 */
function HydratingState(): React.JSX.Element {
  return (
    <View style={styles.center} testID="chat-hydrating">
      <ActivityIndicator color={THEME.accent} />
    </View>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <View style={styles.center} testID="chat-empty">
      <Text style={styles.emptyText}>No messages yet. Say hello 👋</Text>
    </View>
  );
}

/**
 * Connection + offline-queue strip. Hidden when fully connected + flushed.
 *
 * `sendError` OUTRANKS the connection label. A message that could not even be
 * queued locally produced no bubble at all, so this strip is the ONLY place the
 * owner can learn it happened — and a cheerful (or absent) connection line over
 * a silently-dropped message is exactly the lie that let mobile chat ship broken.
 */
function StatusStrip({
  status,
  pendingCount,
  sendError,
}: {
  status: ConnStatus;
  pendingCount: number;
  sendError: string | null;
}): React.JSX.Element | null {
  if (sendError !== null) {
    return (
      <View style={styles.statusStrip} testID="chat-send-error">
        <Text style={[styles.statusText, { color: THEME.danger }]} accessibilityRole="alert">
          {sendError}
        </Text>
      </View>
    );
  }
  const label = statusLabel(status, pendingCount);
  if (label === null) return null;
  const tone = status === 'open' ? THEME.text_muted : THEME.warning;
  return (
    <View style={styles.statusStrip}>
      <Text style={[styles.statusText, { color: tone }]}>{label}</Text>
    </View>
  );
}

function statusLabel(status: ConnStatus, pendingCount: number): string | null {
  if (status === 'open') {
    return pendingCount > 0 ? `Sending ${pendingCount}…` : null;
  }
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return pendingCount > 0 ? `Offline — ${pendingCount} queued` : 'Reconnecting…';
    case 'closed':
      return 'Disconnected';
    case 'idle':
      return null;
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: THEME.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  listContent: { paddingVertical: SPACING.md, paddingHorizontal: SPACING.md },
  // NO `marginVertical` HERE. A uniform margin puts identical space between every
  // pair of bubbles, which is precisely what does NOT happen in iMessage — the
  // gap is a function of whether the SENDER CHANGED, and it is applied per row as
  // `marginTop` from `bubbleGapPt` (see `lib/chat-bubble-metrics.ts`).
  bubbleWrap: { flexDirection: 'row' },
  userWrap: { justifyContent: 'flex-end' },
  agentWrap: { justifyContent: 'flex-start' },
  bubble: {
    // NO maxWidth HERE. `bubbleColumn` owns the ONE cap; a second percentage cap
    // in this chain multiplies with it (see `lib/chat-bubble-metrics.ts`).
    paddingHorizontal: BUBBLE_PADDING_H_PT,
    paddingVertical: BUBBLE_PADDING_V_PT,
    borderRadius: BUBBLE_RADIUS_PT,
  },
  userBubble: { backgroundColor: THEME.accent },
  agentBubble: {
    backgroundColor: THEME.surface_raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: THEME.hairline,
  },
  // The tail corner, applied ONLY to the last bubble of a same-sender run —
  // iMessage draws one tail per run, not one per bubble.
  userTail: { borderBottomRightRadius: BUBBLE_TAIL_RADIUS_PT },
  agentTail: { borderBottomLeftRadius: BUBBLE_TAIL_RADIUS_PT },
  userText: { ...TYPOGRAPHY.body, color: THEME.background },
  agentText: { ...TYPOGRAPHY.body, color: THEME.text_primary },
  attachments: {
    marginTop: SPACING.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs + 2,
  },
  attachment: {
    width: 96,
    height: 96,
    borderRadius: 8,
    backgroundColor: THEME.surface_raised,
  },
  docRefs: { marginTop: SPACING.sm + 2, gap: SPACING.xs + 2 },
  docRefsHeading: {
    ...TYPOGRAPHY.caption,
    color: THEME.text_muted,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  docRefBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    backgroundColor: THEME.background,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  docRefIcon: { fontSize: 16 },
  docRefTextCol: { flex: 1, gap: 1 },
  docRefLabel: { ...TYPOGRAPHY.body_small, color: THEME.text_secondary, fontWeight: '600' },
  docRefPath: { ...TYPOGRAPHY.caption, color: THEME.text_muted },
  pressed: { opacity: 0.6 },
  // OUTSIDE the bubble now, so it reads as a status line under the thread rather
  // than as extra padding inside the message.
  delivery: { ...TYPOGRAPHY.caption, color: THEME.text_muted },
  deliveryRead: { color: THEME.accent },
  deliveryFailed: { color: THEME.warning },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: 2 },
  editedLabel: { ...TYPOGRAPHY.caption, color: THEME.text_muted },
  tombstoneBubble: {
    backgroundColor: THEME.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: THEME.hairline,
    borderBottomLeftRadius: BUBBLE_TAIL_RADIUS_PT,
  },
  tombstoneText: { ...TYPOGRAPHY.body, color: THEME.text_muted, fontStyle: 'italic' },
  editInput: { padding: 0, margin: 0, minWidth: 160 },
  trayAction: { ...TYPOGRAPHY.caption, color: THEME.text_primary, fontWeight: '600' },
  trayActionDanger: { color: THEME.warning },
  // THE single bubble width cap for every row on this surface. See
  // `lib/chat-bubble-metrics.ts` for why it is 90% and why it lives in one place.
  bubbleColumn: { maxWidth: BUBBLE_MAX_WIDTH },
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginTop: SPACING.xs },
  reactionTray: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
    padding: SPACING.xs,
    borderRadius: 16,
    backgroundColor: THEME.surface_raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: THEME.hairline,
  },
  trayUser: { justifyContent: 'flex-end' },
  trayAgent: { justifyContent: 'flex-start' },
  trayEmojiBtn: { paddingHorizontal: SPACING.xs, paddingVertical: 2 },
  trayEmoji: { ...TYPOGRAPHY.h3 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: 12,
    backgroundColor: THEME.surface_raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: THEME.hairline,
  },
  chipSelf: { borderColor: THEME.accent, backgroundColor: THEME.surface },
  chipText: { ...TYPOGRAPHY.caption, color: THEME.text_primary },
  typingBubble: { paddingVertical: SPACING.xs },
  typingText: { ...TYPOGRAPHY.h2, color: THEME.text_muted, letterSpacing: 2 },
  emptyText: { ...TYPOGRAPHY.body, color: THEME.text_muted },
  // Footer rows sit at a sender-change distance from the last bubble — they are
  // the agent about to speak, so they read as a new turn.
  footerGap: { marginTop: SPACING.sm },
  // The transient system pill: CENTERED, muted, unmistakably not a bubble.
  systemNoticeRow: { alignItems: 'center', paddingVertical: SPACING.sm },
  systemNoticePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
    borderRadius: 999,
    backgroundColor: THEME.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: THEME.hairline,
  },
  systemNoticeText: { ...TYPOGRAPHY.body_small, color: THEME.text_muted },
  dropMultiFileHint: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    backgroundColor: THEME.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: THEME.hairline,
  },
  dropMultiFileHintText: { ...TYPOGRAPHY.body_small, color: THEME.text_secondary },
  statusStrip: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    backgroundColor: THEME.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: THEME.hairline,
  },
  statusText: { ...TYPOGRAPHY.caption },
});
