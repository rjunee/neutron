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

import type { ChatMessage, ConnStatus } from '@neutron/chat-core';

import { httpToWs, loadAppConfig } from '../config';
import { useAuthSession } from '../session';
import {
  buildRenderRows,
  emptyStreamState,
  foldStreamFrame,
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
}

/** Build the native chat WS URL for this user + project. */
function buildWsUrl(baseUrl: string, token: string, projectId: string): string {
  const wsBase = httpToWs(baseUrl).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('token', token);
  if (projectId.length > 0) params.set('project_id', projectId);
  params.set('platform', 'native');
  return `${wsBase}/ws/app/chat?${params.toString()}`;
}

export function useMobileChat(projectId: string): UseMobileChatResult {
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);

  const sessionRef = useRef<MobileChatSession | null>(null);
  const streamRef = useRef<StreamState>(emptyStreamState());

  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [stream, setStream] = useState<StreamState>(emptyStreamState());
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [pendingCount, setPendingCount] = useState(0);
  const [ready, setReady] = useState(false);

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
        url: buildWsUrl(config.base_url, user.token, projectId),
        topic_id: `app:${user.id}`,
        store,
        onChange: () => refresh(session as MobileChatSession),
        onStatus: (s) => {
          if (!disposed) setStatus(s);
        },
        onFrame: (frame) => {
          const next = foldStreamFrame(streamRef.current, frame);
          if (next !== streamRef.current) {
            streamRef.current = next;
            if (!disposed) setStream(next);
          }
        },
      });
      sessionRef.current = session;
      setReady(true);
      refresh(session); // instant cold-open from the durable store
      session.start();
    })();

    return (): void => {
      disposed = true;
      streamRef.current = emptyStreamState();
      sessionRef.current = null;
      session?.stop();
      setReady(false);
      setMessages([]);
      setStream(emptyStreamState());
    };
  }, [user, projectId, config.base_url]);

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

  const rows = useMemo(() => buildRenderRows(messages, stream), [messages, stream]);

  return { rows, status, typing: stream.typing, pendingCount, ready, send };
}

/** A message belongs to this project view when its project_id matches, or
 *  when both are unset (the global/untagged transcript). */
function matchesProject(message: ChatMessage, projectId: string): boolean {
  if (projectId.length === 0) return message.project_id === null;
  return message.project_id === projectId;
}
