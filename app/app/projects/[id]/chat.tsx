/**
 * @neutronai/app — per-project chat route shell (P5.1 refactor; M2 chat-
 * upload UX extension).
 *
 * Composition only. Wires the `<ChatStateProvider>` around the children:
 *   - `<ConnectionBanner />`  (sticky)
 *   - `<DropZoneOverlay />`   (web — visible during drag of a file)
 *   - `<MessageList />`        (FlatList of `<MessageItem>`)
 *   - `<InputComposer />`      (multiline + attach + send)
 *   - `<UploadModal />`        (progress overlay while a ZIP / image uploads)
 *
 * No state lives in this file except the upload-modal lifecycle (which
 * is intentionally local — see comments by `useUploadState` below).
 * Every other behaviour is owned by a module factored out per § 4.9 of
 * the P5.1 brief.
 *
 * M2 chat-upload UX additions (this file):
 *   - Page-level dragover / dragleave listeners on web fire the overlay
 *     when a drag enters the surface. The overlay is GATED by the active
 *     phase's `upload_affordance` so a drag during a non-import phase is
 *     a no-op (the drop falls back to the browser default).
 *   - On drop / paste / file-picker pick (surfaced via the composer's
 *     `onFilesPicked` hook), files are classified: images → existing
 *     `attachments[]` send; ZIPs → upload modal + `/api/upload/<source>`.
 *   - Phase-aware hint flows through the composer as `hint`; clears
 *     when the engine advances out of the import phases.
 */

import * as DocumentPicker from 'expo-document-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { DropZoneOverlay } from '../../../components/DropZoneOverlay';
import { InputComposer, type ComposerFileEvent } from '../../../components/InputComposer';
import { MessageItem } from '../../../components/MessageItem';
import { UploadModal, type UploadModalPhase } from '../../../components/UploadModal';
import { ChatStateProvider, useChatState } from '../../../lib/chat-state';
import { ChatDeepLinkNavigator } from '../../../lib/chat-deep-link-navigator';
import { docLinkToRouterPath, parseDocLink } from '../../../lib/doc-links';
import { loadAppConfig } from '../../../lib/config';
import { useAuthSession } from '../../../lib/session';
import { SPACING, THEME, TYPOGRAPHY } from '../../../lib/theme';
import {
  classifyUploadKind,
  inferHistoryImportSource,
  uploadAttachment,
  type UploadKind,
  type UploadProgress,
} from '../../../lib/upload-client';
import { selectDropFiles, shouldGateUpload } from '../../../lib/upload-gate';
import type { ChatMessage } from '../../../lib/chat-streaming';
import type {
  AppWsOutboundAgentMessageDocRef,
  AppWsOutboundAgentMessageUploadAffordance,
} from '../../../lib/ws-envelope';

export default function ProjectChatTab() {
  // ISSUE #17 — `prefill` / `autosend` carry the launcher long-press
  // dispatch payload: `chat_send_prefix` → `?prefill=<prefix>` so the
  // composer mounts pre-populated; `chat_send` → `?autosend=<text>`
  // so the chat fires a one-shot `send()` after the WS connects.
  const params = useLocalSearchParams<{
    id: string;
    prefill?: string;
    autosend?: string;
  }>();
  const project_id = typeof params.id === 'string' ? params.id : '';
  const initialPrefill = typeof params.prefill === 'string' ? params.prefill : '';
  const initialAutosend = typeof params.autosend === 'string' ? params.autosend : '';
  const { user } = useAuthSession();

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ChatStateProvider project_id={project_id}>
      {/* ISSUE #18 — single client-side consumer of envelope `deep_link`.
          Mount inside the provider (uses `useChatState()`) and exactly
          once per provider (the navigator's de-dup `seen` set is
          component-instance-scoped). */}
      <ChatDeepLinkNavigator />
      <ChatBody
        project_id={project_id}
        initial_prefill={initialPrefill}
        initial_autosend={initialAutosend}
      />
    </ChatStateProvider>
  );
}

function ChatBody({
  project_id,
  initial_prefill,
  initial_autosend,
}: {
  project_id: string;
  initial_prefill?: string;
  initial_autosend?: string;
}) {
  const router = useRouter();
  const { messages, wsState, send, retry, chooseOption, signOut, topicInfo } = useChatState();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  const uploadAffordance = useLatestUploadAffordance(messages);
  const isWeb = Platform.OS === 'web';

  // Auto-scroll on new messages / streaming updates.
  useEffect(() => {
    if (messages.length === 0) return undefined;
    const t = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(t);
  }, [messages]);

  // ISSUE #17 — one-shot autosend: when navigated here from a
  // launcher long-press `chat_send` dispatch (`?autosend=<text>`),
  // fire a single `send()` once the WS connects. The ref-guard
  // prevents re-fire on prop / state changes after the first
  // dispatch (the chat route can re-render many times during the
  // session).
  const autosendDispatched = useRef(false);
  useEffect(() => {
    if (autosendDispatched.current) return;
    if (initial_autosend === undefined || initial_autosend.length === 0) return;
    // Wait until the WS is connected — sending into a disconnected
    // socket queues into the optimistic-fail watchdog.
    if (wsState !== 'connected') return;
    autosendDispatched.current = true;
    void send({ body: initial_autosend });
  }, [initial_autosend, wsState, send]);

  const handleDocRef = useCallback(
    (ref: AppWsOutboundAgentMessageDocRef) => {
      const parsed = parseDocLink(ref.url);
      if (parsed !== null) {
        const target = docLinkToRouterPath(parsed);
        if (target !== null) {
          router.push(target as unknown as Parameters<typeof router.push>[0]);
          return;
        }
      }
      void Linking.openURL(ref.url).catch(() => undefined);
    },
    [router],
  );

  const handleSend = useCallback(
    async ({
      body,
      attachments,
    }: {
      body: string;
      attachments: { uri: string; mime_type?: string }[];
    }): Promise<boolean> => {
      return send({ body, attachments });
    },
    [send],
  );

  // Sticky bubble row maker — we don't lift message_id into onChoose
  // from the row, so we use a closure factory per message.
  const makeChoose = useCallback(
    (message_id: string) =>
      (value: string, prompt_id?: string) => {
        void chooseOption({
          message_id,
          value,
          ...(prompt_id !== undefined ? { prompt_id } : {}),
        });
      },
    [chooseOption],
  );

  const hasPromptWithFreeform = messages.some(
    (m) => m.kind === 'agent' && m.allow_freeform === true && m.chosen_value === undefined,
  );

  // ─────────────────────────────────────────────────────────────────────
  // Upload-modal lifecycle (local to this surface so the modal state
  // doesn't pollute the chat reducer; on the engine side, the canonical
  // result is either a user_message echo (images) or a server-side
  // engine.notifyImportUpload advance (ZIPs)).
  // ─────────────────────────────────────────────────────────────────────
  const upload = useUploadState({
    base_url: config.base_url,
    token: user?.token ?? null,
    topic_id: topicInfo?.topic_id ?? null,
    onImageUploaded: async (url: string, mime: string) => {
      // Wire to send() — chat-state assigns a client_msg_id + stages
      // the optimistic bubble; the gateway echo reconciles on arrival.
      // Body deliberately empty per the brief — the attachments[] field
      // is the canonical handoff. The local filename never ships as
      // user text.
      await send({ body: '', attachments: [{ uri: url, mime_type: mime }] });
    },
  });

  const handleFilesPicked = useCallback(
    (files: ReadonlyArray<ComposerFileEvent>) => {
      if (files.length === 0) return;
      // For the M2 walkthrough we only ever surface one file at a time
      // (drag/drop/picker/paste of an export ZIP), but the composer can
      // hand us several at once. Route each file individually.
      for (const f of files) {
        const kind = classifyUploadKind({ name: f.name, mime_type: f.mime_type });
        // Argus r2 BLOCKING #1 — phase-gate ZIPs on picker/paste paths
        // the same way the drop path is gated (line 276). Without this,
        // a user picking/pasting a .zip outside import_upload_pending
        // hits POST /api/upload/<source>, the engine no-ops
        // (noop_no_state / noop_wrong_phase), but the modal still walks
        // uploading → analyzing → auto-dismiss — silent-success with
        // no advance. Images stay un-gated (P5.1 attachments[] can fire
        // any time the composer is enabled).
        if (shouldGateUpload(kind, uploadAffordance)) continue;
        upload.start({
          uri: f.uri,
          name: f.name,
          mime_type: f.mime_type,
          size_bytes: f.size_bytes,
          kind,
        });
      }
    },
    [upload, uploadAffordance],
  );

  // Argus r1 BLOCKING #3 — native attach picker. The composer's 📎
  // button calls this on iOS/Android (web uses its own hidden
  // <input type="file">). Routes all picks through the same upload-modal
  // flow `handleFilesPicked` drives so native uploads of ChatGPT/Claude
  // ZIPs (and any future image attachments) follow the uniform path
  // (IMPORTANT #4 — single source of truth for file-routing). Returns
  // `[]` because the canonical handoff is the modal flow's
  // `send({attachments: [<server url>]})`, not the composer's inline
  // attachment row.
  const handleNativePickAttachments = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return [];
      const events: ComposerFileEvent[] = res.assets.map((a) => {
        const evt: ComposerFileEvent = {
          uri: a.uri,
          name: a.name,
          mime_type: a.mimeType ?? '',
        };
        if (typeof a.size === 'number') evt.size_bytes = a.size;
        return evt;
      });
      if (events.length > 0) handleFilesPicked(events);
    } catch (err) {
      console.warn('[chat] DocumentPicker.getDocumentAsync threw:', err);
    }
    return [];
  }, [handleFilesPicked]);

  // ─────────────────────────────────────────────────────────────────────
  // Web drag-drop listeners. Mounted at document level so dragging from
  // any direction (over the message list, over the composer, anywhere
  // in the viewport) flips the overlay on. Gated by `uploadAffordance`
  // so a drag during a non-import phase is a no-op.
  // ─────────────────────────────────────────────────────────────────────
  const [dragging, setDragging] = useState(false);
  // ISSUES #15 — transient banner shown when the user drops multiple
  // files at once. The drop handler accepts the first and surfaces this
  // hint so the (N-1) abandoned files don't silently disappear. Auto-
  // clears after MULTI_FILE_HINT_TTL_MS so it doesn't stick around the
  // next phase.
  const [dropMultiFileHint, setDropMultiFileHint] = useState<string | null>(null);
  useEffect(() => {
    if (dropMultiFileHint === null) return undefined;
    const t = setTimeout(() => setDropMultiFileHint(null), 6000);
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
      // Ignore drags that don't carry a file (text drag, link drag).
      if (!hasFileInDataTransfer(e.dataTransfer)) return;
      dragDepth.current += 1;
      if (uploadAffordance !== null) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const onOver = (e: DragEvent): void => {
      if (!hasFileInDataTransfer(e.dataTransfer)) return;
      // ISSUES #14 — preventDefault unconditionally for file drags so
      // the browser fires `drop` and we can let the per-file
      // classification + `shouldGateUpload(...)` predicate decide
      // whether the file is acceptable. The prior `uploadAffordance ===
      // null` guard here suppressed the drop event entirely, blocking
      // P5.1 image drops outside import phases despite the helper
      // explicitly allowing any-phase images.
      e.preventDefault();
      if (e.dataTransfer !== null) {
        e.dataTransfer.dropEffect = 'copy';
      }
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
      // ISSUES #14 — the previous early-return here gated the entire
      // FileList on `uploadAffordance === null`, which blocked image
      // drops outside `ai_substrate_offered`/`import_upload_pending`
      // phases even though the shared `shouldGateUpload(kind,
      // uploadAffordance)` predicate allows P5.1 images in any phase.
      // The outer guard is gone; per-file classification + the shared
      // predicate live below so picker/paste/drop all consult the
      // same single source of truth.
      e.preventDefault();
      const dt = e.dataTransfer;
      if (dt === null || dt.files === null || dt.files.length === 0) return;
      // Materialise the FileList into the shape `selectDropFiles`
      // understands so the multi-file decision is a pure function the
      // test suite can pin without simulating browser drag events. We
      // defer `URL.createObjectURL(...)` until AFTER the selection so
      // the abandoned siblings never allocate an object URL — pre-fix
      // every dropped File got an unrevoked blob URL and a multi-drop
      // of large files leaked Blobs until page unload (Codex P3 r1).
      const raw: Array<{
        file: File;
        name: string;
        mime_type: string;
        size_bytes: number;
      }> = [];
      for (let i = 0; i < dt.files.length; i++) {
        const file = dt.files.item(i);
        if (file === null) continue;
        raw.push({
          file,
          name: file.name,
          mime_type: file.type ?? '',
          size_bytes: file.size,
        });
      }
      // ISSUES #15 — accept the first file, surface a banner when N>1.
      // selectDropFiles returns the same DropFileLike refs we passed in
      // (the first element in the multi-drop case; passthrough on a
      // single-file drop) so we can keep the `File` handle on each
      // entry to allocate the object URL lazily — only the file we're
      // about to upload allocates a blob URL.
      const outcome = selectDropFiles(raw);
      if (outcome.hint !== null) setDropMultiFileHint(outcome.hint);
      if (outcome.files.length === 0) return;
      const first = outcome.files[0] as (typeof raw)[number] | undefined;
      if (first === undefined) return;
      const uri = URL.createObjectURL(first.file);
      const fileEvent: ComposerFileEvent = {
        uri,
        name: first.name,
        mime_type: first.mime_type,
        ...(first.size_bytes !== undefined ? { size_bytes: first.size_bytes } : {}),
      };
      // Route the single file through the shared picker pipeline so
      // `shouldGateUpload(kind, uploadAffordance)` decides per-kind
      // whether to block (history-import ZIPs outside import phases —
      // ISSUES #14 closure) or pass (P5.1 images any phase).
      handleFilesPicked([fileEvent]);
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

  const composerHint = useMemo<string | undefined>(() => {
    if (hasPromptWithFreeform) return 'Or type a response to the prompt above.';
    if (uploadAffordance !== null) {
      const label = sourceLabel(uploadAffordance.source);
      return `Drag your ${label} export ZIP here, paste it, or tap 📎 to pick it.`;
    }
    return undefined;
  }, [hasPromptWithFreeform, uploadAffordance]);

  const composerPlaceholder = hasPromptWithFreeform
    ? 'Or type a response…'
    : 'Send a message';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ConnectionBanner wsState={wsState} onSignOut={signOut} />
      {dropMultiFileHint !== null ? (
        <View
          style={styles.dropMultiFileHint}
          testID="chat-drop-multi-file-hint"
        >
          <Text style={styles.dropMultiFileHintText}>{dropMultiFileHint}</Text>
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <MessageItem
            msg={item}
            onChoose={makeChoose(item.id)}
            onDocRef={handleDocRef}
            onRetry={retry}
          />
        )}
        maintainVisibleContentPosition={{
          minIndexForVisible: 0,
          autoscrollToTopThreshold: 10,
        }}
        removeClippedSubviews={Platform.OS !== 'web'}
        windowSize={10}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Chat is live.</Text>
            <Text style={styles.emptyBody}>
              Send a message and the canonical stream echoes it back through the gateway, scoped to
              project `{project_id || '-'}`.
            </Text>
          </View>
        }
      />
      <InputComposer
        onSend={handleSend}
        disabled={wsState === 'auth_failed'}
        placeholder={composerPlaceholder}
        {...(composerHint !== undefined ? { hint: composerHint } : {})}
        {...(initial_prefill !== undefined && initial_prefill.length > 0
          ? { initial_draft: initial_prefill }
          : {})}
        onFilesPicked={handleFilesPicked}
        pickAttachments={handleNativePickAttachments}
      />
      <DropZoneOverlay
        visible={dragging && uploadAffordance !== null}
        {...(uploadAffordance !== null
          ? { source_label: sourceLabel(uploadAffordance.source) }
          : {})}
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
    </KeyboardAvoidingView>
  );
}

function sourceLabel(source: 'chatgpt' | 'claude'): string {
  if (source === 'claude') return 'Claude';
  return 'ChatGPT';
}

function hasFileInDataTransfer(dt: DataTransfer | null): boolean {
  if (dt === null) return false;
  const types = dt.types;
  if (types === undefined || types === null) return false;
  // DataTransferItemList.includes is the lookup that matters across
  // browsers; `Array.from` keeps Firefox happy.
  const list = Array.from(types);
  return list.includes('Files') || list.includes('application/x-moz-file');
}

/**
 * Walk the messages list backwards and return the most recent
 * agent_message's `upload_affordance` field. Absence (the affordance
 * was cleared by the engine's next advance) returns null.
 */
function useLatestUploadAffordance(
  messages: ReadonlyArray<ChatMessage>,
): AppWsOutboundAgentMessageUploadAffordance | null {
  return useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m === undefined) continue;
      if (m.kind !== 'agent') continue;
      if (m.streaming === true) continue;
      return m.upload_affordance ?? null;
    }
    return null;
  }, [messages]);
}

interface UploadStartArgs {
  uri: string;
  name: string;
  mime_type: string;
  size_bytes?: number;
  kind: UploadKind;
}

interface UseUploadStateInput {
  base_url: string;
  token: string | null;
  topic_id: string | null;
  onImageUploaded: (url: string, mime: string) => Promise<void>;
}

interface UploadStateValue {
  visible: boolean;
  phase: UploadModalPhase;
  filename: string;
  kind: 'history-import-zip' | 'image';
  mime_type?: string;
  bytes_sent?: number;
  bytes_total?: number;
  error_message?: string;
  start: (args: UploadStartArgs) => void;
  cancel: () => void;
  retry: () => void;
  dismiss: () => void;
}

/**
 * Upload lifecycle hook. Owns the modal-visibility flag, the latest
 * progress snapshot, the AbortController, and the auto-dismiss timer.
 *
 * State transitions:
 *   start()  → visible, phase=uploading
 *   progress → bytes_sent updated; phase stays 'uploading' until 100% then
 *              flips to 'processing' (the server is sniffing magic bytes +
 *              writing to disk; that gap is short but noticeable for big
 *              ZIPs)
 *   complete  → phase='analyzing' for ZIPs (the engine kicks off the
 *               importJobRunner — the user sees the modal until the next
 *               agent_message lands) or phase='complete' then auto-dismiss
 *               after MOTION.slow for images.
 *   error    → phase='error', sticky, retry/dismiss buttons.
 */
function useUploadState(input: UseUploadStateInput): UploadStateValue {
  const [snapshot, setSnapshot] = useState<{
    visible: boolean;
    phase: UploadModalPhase;
    filename: string;
    kind: 'history-import-zip' | 'image';
    mime_type?: string;
    bytes_sent?: number;
    bytes_total?: number;
    error_message?: string;
  }>({
    visible: false,
    phase: 'uploading',
    filename: '',
    kind: 'image',
  });

  const abortRef = useRef<AbortController | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStartRef = useRef<UploadStartArgs | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const performUpload = useCallback(
    async (args: UploadStartArgs) => {
      if (input.token === null) {
        setSnapshot((s) => ({ ...s, phase: 'error', error_message: 'Not signed in.' }));
        return;
      }
      const abort = new AbortController();
      abortRef.current = abort;
      const onProgress = (p: UploadProgress): void => {
        if (p.phase === 'started') {
          setSnapshot((s) => ({
            ...s,
            visible: true,
            phase: 'uploading',
            ...(p.bytes_total !== undefined ? { bytes_total: p.bytes_total } : {}),
          }));
          return;
        }
        if (p.phase === 'progress') {
          setSnapshot((s) => {
            const fraction =
              typeof p.bytes_total === 'number' && p.bytes_total > 0
                ? p.bytes_sent / p.bytes_total
                : undefined;
            const next_phase: UploadModalPhase =
              fraction !== undefined && fraction >= 1 ? 'processing' : 'uploading';
            return {
              ...s,
              phase: next_phase,
              bytes_sent: p.bytes_sent,
              ...(p.bytes_total !== undefined ? { bytes_total: p.bytes_total } : {}),
            };
          });
          return;
        }
        if (p.phase === 'complete') {
          if (args.kind === 'history-import-zip') {
            // The engine.notifyImportUpload path takes over server-side
            // — keep the modal up showing "analyzing" until the user
            // sees the next agent_message and dismisses (or auto-fade).
            setSnapshot((s) => ({
              ...s,
              phase: 'analyzing',
              bytes_sent: s.bytes_total,
            }));
            // Auto-dismiss after a beat so the user sees the analyzing
            // chip but isn't stuck on the modal forever — the next
            // agent_message landing is the real success signal.
            dismissTimerRef.current = setTimeout(() => {
              setSnapshot((s) => ({ ...s, visible: false }));
            }, 2500);
          } else {
            setSnapshot((s) => ({
              ...s,
              phase: 'complete',
              bytes_sent: s.bytes_total,
            }));
            // For images, the canonical handoff is a user_message
            // envelope with attachments[]. Fire that after the modal
            // shows 'complete' so the user sees the check.
            void input
              .onImageUploaded(p.url, snapshot.mime_type ?? args.mime_type)
              .catch(() => undefined);
            dismissTimerRef.current = setTimeout(() => {
              setSnapshot((s) => ({ ...s, visible: false }));
            }, 1000);
          }
          return;
        }
        if (p.phase === 'error') {
          setSnapshot((s) => ({
            ...s,
            phase: 'error',
            error_message: `${p.code}: ${p.message}`,
          }));
        }
      };
      const result = await uploadAttachment({
        uri: args.uri,
        name: args.name,
        mime_type: args.mime_type,
        token: input.token,
        base_url: input.base_url,
        ...(input.topic_id !== null ? { topic_id: input.topic_id } : {}),
        abort_signal: abort.signal,
        onProgress,
      });
      if (result === null && !abort.signal.aborted) {
        // The onProgress error callback already set `phase=error`.
        return;
      }
    },
    [input, snapshot.mime_type],
  );

  const start = useCallback(
    (args: UploadStartArgs) => {
      clearDismissTimer();
      // Cancel any in-flight upload before starting the new one.
      abortRef.current?.abort();
      lastStartRef.current = args;
      setSnapshot({
        visible: true,
        phase: 'uploading',
        filename: args.name,
        mime_type: args.mime_type,
        kind: args.kind,
        ...(args.size_bytes !== undefined ? { bytes_total: args.size_bytes } : {}),
        bytes_sent: 0,
      });
      void performUpload(args);
    },
    [performUpload, clearDismissTimer],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    clearDismissTimer();
    setSnapshot((s) => ({ ...s, visible: false }));
  }, [clearDismissTimer]);

  const retry = useCallback(() => {
    const last = lastStartRef.current;
    if (last === null) return;
    start(last);
  }, [start]);

  const dismiss = useCallback(() => {
    clearDismissTimer();
    setSnapshot((s) => ({ ...s, visible: false }));
  }, [clearDismissTimer]);

  useEffect(
    () => () => {
      clearDismissTimer();
      abortRef.current?.abort();
    },
    [clearDismissTimer],
  );

  return {
    visible: snapshot.visible,
    phase: snapshot.phase,
    filename: snapshot.filename,
    kind: snapshot.kind,
    ...(snapshot.mime_type !== undefined ? { mime_type: snapshot.mime_type } : {}),
    ...(snapshot.bytes_sent !== undefined ? { bytes_sent: snapshot.bytes_sent } : {}),
    ...(snapshot.bytes_total !== undefined ? { bytes_total: snapshot.bytes_total } : {}),
    ...(snapshot.error_message !== undefined ? { error_message: snapshot.error_message } : {}),
    start,
    cancel,
    retry,
    dismiss,
  };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background },
  centered: { alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.lg,
    gap: SPACING.sm,
  },
  emptyState: { paddingTop: 48, paddingHorizontal: SPACING.lg, alignItems: 'center', gap: SPACING.sm },
  emptyTitle: { ...TYPOGRAPHY.h3, color: THEME.text_secondary },
  emptyBody: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_muted,
    textAlign: 'center',
  },
  // ISSUES #15 — transient banner for multi-file drops (we accept the
  // first file and surface this to the user so the abandoned siblings
  // don't disappear into the void).
  dropMultiFileHint: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    backgroundColor: THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  dropMultiFileHintText: {
    ...TYPOGRAPHY.body_small,
    color: THEME.text_secondary,
  },
});

// Re-export so consumers can wire a custom upload classifier in tests.
export { classifyUploadKind, inferHistoryImportSource };
