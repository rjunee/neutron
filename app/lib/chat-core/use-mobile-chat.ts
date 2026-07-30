/**
 * @neutronai/app — `useMobileChat`: the React seam between the chat-core
 * `MobileChatSession` and the FlashList UI (research doc §6/§7).
 *
 * Responsibilities (all wiring, no chat logic — that lives in chat-core +
 * `chat-render-model`):
 *   - construct the durable op-sqlite Store (`createMobileStore`) + the
 *     session once per (user, project), tearing them down on change;
 *   - re-read the transcript from the local store on every `onChange` and
 *     expose the merged render rows (durable + live streaming bubbles);
 *   - bridge RN `AppState` → `session.setActive` so the socket pauses in the
 *     background and catches up on foreground (the §6 reconnect pattern) —
 *     this is the gap-fill after any backgrounded period;
 *   - bridge a notification that arrives WHILE FOREGROUNDED → `session.catchUp()`
 *     so a push during an active session triggers an immediate `resume
 *     after_seq` without waiting for an AppState transition.
 *
 * Catch-up is FOREGROUND-ONLY by design (see the note on the notification
 * effect below): `addNotificationReceivedListener` runs JS only while the app
 * is foregrounded, so a push that lands while backgrounded does not sync in
 * the background — the gap is filled the next time AppState returns to active.
 *
 * The view is dumb: it renders `rows`, shows `status` + `typing`, and calls
 * `send`. Everything else is the session's job.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';

import {
  prefixedRandomId,
  type ChatMessage,
  type ConnStatus,
  type ReactionAction,
} from '@neutronai/chat-core';

import { loadAppConfig } from '../config';
import { appWsProjectTopicId, appWsTopicId } from '@neutronai/wire-types/topic-id.ts';
import { railIdToScope } from '../project-rail-view';
import { buildWsUrl } from './ws-url';
import { useAuthSession } from '../session';
import {
  buildRenderRows,
  emptyStreamState,
  foldStreamFrame,
  frameMatchesProject,
  type RenderRow,
  type StreamState,
} from './chat-render-model';
import { createMobileStore } from './op-sqlite-store';
import { MobileChatSession } from './mobile-session';
import { acquireSession, releaseSession, sessionCacheKeys, setCacheActive } from './session-cache';

export interface UseMobileChatResult {
  /** The merged render list (durable transcript + live streaming bubbles). */
  rows: RenderRow[];
  /** Connection status, for the banner. */
  status: ConnStatus;
  /** True while the agent is streaming a reply (typing dots). */
  typing: boolean;
  /** Count of sends still awaiting delivery (offline queue depth). */
  pendingCount: number;
  /** True until the store + session have finished constructing. */
  ready: boolean;
  /**
   * True once this scope's history has actually been SETTLED — either the
   * local store already held messages, or the socket reached `open` (so the
   * resume replay has been requested and applied).
   *
   * ISSUES #402 — distinct from {@link ready} on purpose. `ready` flips as soon
   * as the session OBJECT exists, which is before `start()` and long before any
   * replay lands. Gating the empty state on `ready` therefore rendered
   * "No messages yet" during every project switch, a moment before the history
   * arrived. "Not fetched yet" and "there is nothing here" must never look the
   * same — that is the whole complaint.
   */
  hydrated: boolean;
  /**
   * Send a user message (optimistic + offline-safe). Resolves `true` once the
   * message is durably QUEUED locally — which is the point at which the owner can
   * see it and it can no longer be lost — and `false` when it could not be
   * queued at all.
   *
   * The boolean is load-bearing: the composer only clears its draft on `true`, so
   * a send that fails leaves the typed text where the owner can retry it instead
   * of destroying it silently.
   */
  send: (body: string, attachments?: readonly string[]) => Promise<boolean>;
  /**
   * Non-null when the LAST send could not even be queued locally — i.e. it
   * produced no bubble, no frame and no row anywhere.
   *
   * WHY THIS EXISTS. `send` used to be `void session?.send(...)`: a null session
   * was a silent no-op, and a rejected `enqueue` was an unobserved promise
   * rejection. Both outcomes looked EXACTLY like a working app to the owner —
   * which is how a `crypto.randomUUID()` that throws on the device runtime
   * destroyed every mobile send for the life of the surface without producing
   * one diagnosable symptom. A send that fails must be visible.
   */
  sendError: string | null;
  /** Report messages the user has viewed (Track B Phase 4 read receipts). */
  markRead: (messageIds: readonly string[]) => void;
  /** Add or remove an emoji reaction on a message (Track B Phase 4). */
  react: (messageId: string, emoji: string, action: ReactionAction) => void;
  /** Edit a message's body (Track B Phase 4 — author-only). */
  editMessage: (messageId: string, body: string) => void;
  /** Delete (tombstone) a message (Track B Phase 4 — author-only). */
  deleteMessage: (messageId: string) => void;
  /** P1b — answer an agent prompt by tapping an option (or a freeform reply). */
  chooseOption: (promptId: string, choiceValue: string, freeform?: string) => void;
  /** W5 GAP-4 — retry a failed send (the ⚠️ affordance). Per-message: re-drives
   *  ONLY this `client_msg_id`, idempotently. */
  retry: (clientMsgId: string) => void;
  /** This device's id — passed to `deliveryState` so a message's read tick
   *  excludes the sender's own device. Empty until the session constructs. */
  selfDeviceId: string;
}

// ISSUES #40 — `buildWsUrl` + `detectClientTimezone` now live in the pure,
// unit-tested `./ws-url` module (extracted so the timezone-capture path is
// testable without react-native/expo in the bun runtime).

/** A per-session device id. Stability across launches isn't required for
 *  correctness here — the mobile UI only reports reads for AGENT messages
 *  (never the user's own sends), so a freshly-minted id can never light a
 *  sender's own read tick. Uses the ONE shared generator, which does not assume
 *  a `crypto` global exists (it does not, on this runtime). */
function makeDeviceId(): string {
  return prefixedRandomId('dev');
}

/**
 * What the owner is told when a send could not even be QUEUED. Deliberately
 * blunt: the failure it reports used to be completely invisible (see
 * {@link UseMobileChatResult.sendError}).
 */
export const SEND_FAILED_MESSAGE = 'Message not sent — your text is still in the box; try again';
/** Shown when the composer is used before the chat session finished attaching. */
export const SEND_NOT_READY_MESSAGE = 'Still connecting — message not sent';

export function useMobileChat(railId: string): UseMobileChatResult {
  // The router hands us a RAIL id, which for General is a sentinel that only
  // looks like a project id. Collapse it once, here, and use the scope
  // everywhere below — topic derivation, the socket URL, and the transcript
  // filter must all agree or the view shows the wrong conversation.
  const projectId = railIdToScope(railId);
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const deviceId = useMemo(() => makeDeviceId(), []);

  const sessionRef = useRef<MobileChatSession | null>(null);
  const streamRef = useRef<StreamState>(emptyStreamState());

  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [stream, setStream] = useState<StreamState>(emptyStreamState());
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [pendingCount, setPendingCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [selfDeviceId, setSelfDeviceId] = useState('');

  // Construct the store + session for this (user, project). Re-runs when the
  // identity or project changes; fully torn down on cleanup.
  useEffect(() => {
    if (user === null || user.token.length === 0) return;
    let disposed = false;
    let session: MobileChatSession | null = null;

    const refresh = (s: MobileChatSession): void => {
      void s.messages().then((all) => {
        if (disposed) return;
        // The local store holds the whole per-user topic; render only this
        // project's transcript (project_id-tagged or untagged-global).
        const mine = all.filter((m) => matchesProject(m, projectId));
        setMessages(mine);
        // ISSUES #402 — the store already had this scope's history, so there is
        // nothing to wait for and the empty state must not flash.
        if (mine.length > 0) setHydrated(true);
      });
      void s.pendingCount().then((n) => {
        if (!disposed) setPendingCount(n);
      });
    };

    let acquiredKey: string | null = null;
    let unsubscribe: (() => void) | null = null;

    void (async (): Promise<void> => {
      // ISSUES #399 — the SHARED topic derivation, identical to the web client.
      // General is the user-scoped topic; a project scope gets
      // `app:<user>:<project>`. Uses the shared `wire-types` helpers rather
      // than a third hand-rolled `app:${...}` template — a duplicated key
      // derivation is exactly how #395/#398 recurred.
      const topicId =
        projectId.length > 0 ? appWsProjectTopicId(user.id, projectId) : appWsTopicId(user.id);
      // ISSUES #402 — a warm session is REUSED rather than rebuilt. Switching
      // projects used to open a store, open a socket, handshake and resume every
      // time; now a recently-visited scope re-attaches to a live connection.
      const isNew = !sessionCacheKeys().includes(topicId);
      session = await acquireSession(topicId, async () => {
        const store = await createMobileStore();
        return new MobileChatSession({
          url: buildWsUrl(config.base_url, user.token, projectId, deviceId),
          topic_id: topicId,
          ...(projectId.length > 0 ? { project_id: projectId } : {}),
          store,
          device_id: deviceId,
        });
      });
      acquiredKey = topicId;
      if (disposed) return;

      const active = session;
      unsubscribe = active.subscribe({
        onChange: () => refresh(active),
        onStatus: (s) => {
          // ISSUES #402 — once the socket is open the resume has been sent and
          // its replay applied, so an still-empty transcript is genuinely
          // empty rather than merely un-fetched.
          if (s === 'open') setHydrated(true);
          if (!disposed) setStatus(s);
        },
        onFrame: (frame) => {
          // The app WS topic is per-user, so streams for OTHER projects arrive
          // on this socket too. Drop a sibling project's stream before folding
          // so it never renders in this project's view (mirrors the durable
          // `matchesProject` filter above; Codex P2).
          if (!frameMatchesProject(frame, projectId)) return;
          const next = foldStreamFrame(streamRef.current, frame);
          if (next !== streamRef.current) {
            streamRef.current = next;
            if (!disposed) setStream(next);
          }
        },
      });

      sessionRef.current = active;
      setReady(true);
      setSelfDeviceId(active.device_id);
      // A warm session is ALREADY open, so `onStatus` will not fire 'open'
      // again — seed both from the live snapshot or the view would sit in
      // 'idle' showing a hydrating spinner over a fully-loaded transcript.
      const live = active.status();
      setStatus(live);
      if (live === 'open') setHydrated(true);
      refresh(active); // instant paint from the durable store
      if (isNew) active.start();
    })();

    return (): void => {
      disposed = true;
      streamRef.current = emptyStreamState();
      sessionRef.current = null;
      setHydrated(false);
      // Detach this view, but do NOT stop the session — the cache keeps it warm
      // so coming back is instant. Eviction (and the actual `stop()`) is the
      // cache's decision, bounded by MAX_WARM_SESSIONS.
      unsubscribe?.();
      if (acquiredKey !== null) releaseSession(acquiredKey);
      setReady(false);
      setSelfDeviceId('');
      setMessages([]);
      setStream(emptyStreamState());
    };
  }, [user, projectId, config.base_url, deviceId]);

  // AppState → socket activity. Background severs the socket cheaply;
  // foreground reconnects + resumes (research doc §6).
  useEffect(() => {
    const onChange = (next: AppStateStatus): void => {
      // Activity applies to every cached session, not just the visible one —
      // warm sockets must go quiet on background too (see `setCacheActive`).
      setCacheActive(next === 'active');
      const session = sessionRef.current;
      if (session === null) return;
      // Only the VISIBLE session needs an immediate gap-fill; the warm ones
      // catch up when the user navigates back to them.
      if (next === 'active') void session.catchUp();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  // Foreground push → immediate catch-up. `addNotificationReceivedListener`
  // fires ONLY while the app is foregrounded, so this covers a push that
  // arrives mid-session (when no AppState 'active' transition occurs) — it
  // triggers a `resume after_seq` gap-fill right away. It is deliberately NOT
  // a background-wake path: true background data-push sync would require a
  // headless `expo-task-manager` task that reconstructs the session outside
  // React (impractical/unverifiable in this Expo setup), so background gaps
  // are instead filled by the AppState→active catch-up above on next
  // foreground. Honest scope: foreground catch-up, not background gap-fill.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      void sessionRef.current?.catchUp();
    });
    return () => sub.remove();
  }, []);

  const send = useCallback(
    async (body: string, attachments?: readonly string[]): Promise<boolean> => {
      const trimmed = body.trim();
      const hasAttachments = attachments !== undefined && attachments.length > 0;
      // An image attachment send carries an empty body (the attachment URL is the
      // payload), so only bail when there's neither text NOR an attachment.
      if (trimmed.length === 0 && !hasAttachments) return false;
      const opts: { project_id?: string; attachments?: readonly string[] } = {};
      if (projectId.length > 0) opts.project_id = projectId;
      if (hasAttachments) opts.attachments = attachments;
      const session = sessionRef.current;
      // NOT `session?.send(...)`. An absent session means the tap did nothing at
      // all, and the owner has to be told — an optional chain here is a silent
      // drop wearing the costume of a working app.
      if (session === null) {
        setSendError(SEND_NOT_READY_MESSAGE);
        return false;
      }
      setSendError(null);
      // NOT `void`. `send` awaits `queue.enqueue`, which writes the optimistic
      // row; if that rejects there is no bubble, no frame and nothing in the log
      // unless it is caught here. This is the exact hole a `crypto.randomUUID()`
      // that throws on the device fell through for the life of the surface.
      try {
        await session.send(trimmed, opts);
        return true;
      } catch (err) {
        console.error('[chat] send failed before the message could be queued:', err);
        setSendError(SEND_FAILED_MESSAGE);
        return false;
      }
    },
    [projectId],
  );

  const markRead = useCallback((messageIds: readonly string[]): void => {
    if (messageIds.length === 0) return;
    sessionRef.current?.markRead(messageIds);
  }, []);

  const react = useCallback(
    (messageId: string, emoji: string, action: ReactionAction): void => {
      if (messageId.length === 0 || emoji.length === 0) return;
      sessionRef.current?.react(messageId, emoji, action);
    },
    [],
  );

  const editMessage = useCallback((messageId: string, body: string): void => {
    if (messageId.length === 0 || body.trim().length === 0) return;
    sessionRef.current?.editMessage(messageId, body.trim());
  }, []);

  const deleteMessage = useCallback((messageId: string): void => {
    if (messageId.length === 0) return;
    sessionRef.current?.deleteMessage(messageId);
  }, []);

  const chooseOption = useCallback(
    (promptId: string, choiceValue: string, freeform?: string): void => {
      if (promptId.length === 0 || choiceValue.length === 0) return;
      sessionRef.current?.chooseOption(promptId, choiceValue, freeform);
    },
    [],
  );

  const retry = useCallback((clientMsgId: string): void => {
    if (clientMsgId.length === 0) return;
    void sessionRef.current?.retry(clientMsgId);
  }, []);

  const rows = useMemo(() => buildRenderRows(messages, stream), [messages, stream]);

  return {
    rows,
    status,
    typing: stream.typing,
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
  };
}

/** A message belongs to this project view when its project_id matches, or
 *  when both are unset (the global/untagged transcript). */
function matchesProject(message: ChatMessage, projectId: string): boolean {
  if (projectId.length === 0) return message.project_id === null;
  return message.project_id === projectId;
}
