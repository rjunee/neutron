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

import type { ChatMessage, ConnStatus, ReactionAction } from '@neutron/chat-core';

import { httpToWs, loadAppConfig } from '../config';
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
  /** Send a user message (optimistic + offline-safe). */
  send: (body: string, attachments?: readonly string[]) => void;
  /** Report messages the user has viewed (Track B Phase 4 read receipts). */
  markRead: (messageIds: readonly string[]) => void;
  /** Add or remove an emoji reaction on a message (Track B Phase 4). */
  react: (messageId: string, emoji: string, action: ReactionAction) => void;
  /** Edit a message's body (Track B Phase 4 — author-only). */
  editMessage: (messageId: string, body: string) => void;
  /** Delete (tombstone) a message (Track B Phase 4 — author-only). */
  deleteMessage: (messageId: string) => void;
  /** This device's id — passed to `deliveryState` so a message's read tick
   *  excludes the sender's own device. Empty until the session constructs. */
  selfDeviceId: string;
}

/** Build the native chat WS URL for this user + project. The `device_id` is
 *  carried so the gateway attributes this device's read receipts (Track B
 *  Phase 4); the same id is handed to the session for read-tick self-exclusion. */
function buildWsUrl(
  baseUrl: string,
  token: string,
  projectId: string,
  deviceId: string,
): string {
  const wsBase = httpToWs(baseUrl).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('token', token);
  if (projectId.length > 0) params.set('project_id', projectId);
  params.set('platform', 'native');
  params.set('device_id', deviceId);
  return `${wsBase}/ws/app/chat?${params.toString()}`;
}

/** A per-session device id. Stability across launches isn't required for
 *  correctness here — the mobile UI only reports reads for AGENT messages
 *  (never the user's own sends), so a freshly-minted id can never light a
 *  sender's own read tick. */
function makeDeviceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return `dev-${c.randomUUID()}`;
  return `dev-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function useMobileChat(projectId: string): UseMobileChatResult {
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
        setMessages(all.filter((m) => matchesProject(m, projectId)));
      });
      void s.pendingCount().then((n) => {
        if (!disposed) setPendingCount(n);
      });
    };

    void (async (): Promise<void> => {
      const store = await createMobileStore();
      if (disposed) return;
      session = new MobileChatSession({
        url: buildWsUrl(config.base_url, user.token, projectId, deviceId),
        topic_id: `app:${user.id}`,
        store,
        device_id: deviceId,
        onChange: () => refresh(session as MobileChatSession),
        onStatus: (s) => {
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
      sessionRef.current = session;
      setReady(true);
      setSelfDeviceId(session.device_id);
      refresh(session); // instant cold-open from the durable store
      session.start();
    })();

    return (): void => {
      disposed = true;
      streamRef.current = emptyStreamState();
      sessionRef.current = null;
      session?.stop();
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
      const session = sessionRef.current;
      if (session === null) return;
      if (next === 'active') {
        session.setActive(true);
        void session.catchUp();
      } else {
        session.setActive(false);
      }
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

  const send = useCallback((body: string, attachments?: readonly string[]): void => {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    const opts: { project_id?: string; attachments?: readonly string[] } = {};
    if (projectId.length > 0) opts.project_id = projectId;
    if (attachments !== undefined && attachments.length > 0) opts.attachments = attachments;
    void sessionRef.current?.send(trimmed, opts);
  }, [projectId]);

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

  const rows = useMemo(() => buildRenderRows(messages, stream), [messages, stream]);

  return {
    rows,
    status,
    typing: stream.typing,
    pendingCount,
    ready,
    send,
    markRead,
    react,
    editMessage,
    deleteMessage,
    selfDeviceId,
  };
}

/** A message belongs to this project view when its project_id matches, or
 *  when both are unset (the global/untagged transcript). */
function matchesProject(message: ChatMessage, projectId: string): boolean {
  if (projectId.length === 0) return message.project_id === null;
  return message.project_id === projectId;
}
