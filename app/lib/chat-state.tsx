/**
 * @neutronai/app — chat-state Context provider (P5.1).
 *
 * Glues the WS client + the pure `chat-streaming` reducer + the React
 * tree. The route file (`app/app/projects/[id]/chat.tsx`) mounts a
 * `<ChatStateProvider>` once per `project_id`; child components
 * (`<MessageItem>`, `<InputComposer>`, `<ConnectionBanner>`) consume
 * the state via `useChatState()`.
 *
 * The provider owns four side effects:
 *   1. Constructing / tearing down the `AppWsClient` on `project_id`
 *      changes (the same drop+reconnect pattern P5.2 already uses).
 *   2. Subscribing to WS events and dispatching reducer actions.
 *   3. Tracking the WS state for the banner.
 *   4. Watchdog for optimistic-send failure: if the echo doesn't
 *      arrive within `ECHO_TIMEOUT_MS` AND the WS reports connected,
 *      flip the bubble to failed so the user can retry.
 *
 * The reducer itself stays pure (`./chat-streaming.ts`); this file is
 * the React-side wiring.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { httpToWs, loadAppConfig } from './config';
import { useAuthSession } from './session';
import { AppWsClient, type AppWsClientState } from './ws-client';
import type {
  AppWsOutboundAgentMessage,
  AppWsOutboundAgentMessagePartial,
  AppWsOutboundUserMessageEcho,
} from './ws-envelope';
import { isAlreadyUploadedAttachmentUrl } from './attachment-url';
import { chatReducer, EMPTY_CHAT_STATE, type ChatMessage, type ChatState } from './chat-streaming';
import { uploadAttachment, type UploadProgress } from './upload-client';

/** Timeout after which an un-echoed pending bubble is marked failed. */
export const ECHO_TIMEOUT_MS = 10_000;

export interface SendOptions {
  /** Body text. May be empty when attachments-only sends are allowed. */
  body: string;
  /** Local URIs to upload. Each becomes one attachment URL on the wire. */
  attachments?: ReadonlyArray<{ uri: string; mime_type?: string }>;
}

export interface ChatStateValue {
  state: ChatState;
  messages: ReadonlyArray<ChatMessage>;
  wsState: AppWsClientState;
  topicInfo: { topic_id: string; project_slug: string } | null;
  /** Send a user message (with optional uploads). Returns true on transport success. */
  send: (opts: SendOptions) => Promise<boolean>;
  /** Retry a previously-failed user send by its `client_msg_id`. */
  retry: (client_msg_id: string) => Promise<boolean>;
  /** Tap an option in a button-primitive prompt. Sends `value` as the user-message body. */
  chooseOption: (input: { message_id: string; value: string; prompt_id?: string }) => Promise<boolean>;
  /** Sign-out hook used by the auth-failed banner. */
  signOut: () => void;
  /** Reset the message buffer (used on project_id change). */
  reset: () => void;
}

const ChatStateContext = createContext<ChatStateValue | null>(null);

export function useChatState(): ChatStateValue {
  const ctx = useContext(ChatStateContext);
  if (ctx === null) {
    throw new Error('useChatState must be used inside <ChatStateProvider>');
  }
  return ctx;
}

export interface ChatStateProviderProps {
  /** Active project. Drives the WS upgrade query string + transcript filter. */
  project_id: string;
  /** React children — the chat surface UI tree. */
  children: React.ReactNode;
}

/**
 * Mount-once provider. Subscribes to the WS client and the auth
 * session; clears the message buffer when `project_id` changes (the
 * underlying WS is also dropped + reconnected with the new
 * upgrade-time query string).
 */
export function ChatStateProvider({ project_id, children }: ChatStateProviderProps) {
  const { user, clear: signOut } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const [state, dispatch] = useReducer(chatReducer, EMPTY_CHAT_STATE);
  const [wsState, setWsState] = useState<AppWsClientState>('disconnected');
  const [topicInfo, setTopicInfo] = useState<{
    topic_id: string;
    project_slug: string;
  } | null>(null);
  const clientRef = useRef<AppWsClient | null>(null);
  const echoTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const armEchoTimer = useCallback((client_msg_id: string) => {
    const prior = echoTimers.current.get(client_msg_id);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      echoTimers.current.delete(client_msg_id);
      dispatch({ type: 'mark_send_failed', client_msg_id });
    }, ECHO_TIMEOUT_MS);
    echoTimers.current.set(client_msg_id, timer);
  }, []);

  const clearEchoTimer = useCallback((client_msg_id: string) => {
    const prior = echoTimers.current.get(client_msg_id);
    if (prior !== undefined) {
      clearTimeout(prior);
      echoTimers.current.delete(client_msg_id);
    }
  }, []);

  useEffect(() => {
    if (user === null || project_id.length === 0) return undefined;
    dispatch({ type: 'reset' });
    setTopicInfo(null);
    const wsBase = httpToWs(config.base_url);
    const wsPlatform: 'web' | 'native' = Platform.OS === 'web' ? 'web' : 'native';
    const client = new AppWsClient({
      base_url: wsBase,
      token: user.token,
      project_id,
      platform: wsPlatform,
    });
    clientRef.current = client;

    const offState = client.on('state', (next, detail) => {
      setWsState(next);
      if (next === 'auth_failed' && detail !== undefined) {
        dispatch({
          type: 'append_system',
          body: `Auth failed: ${detail.code ?? 'unknown'} — ${detail.message ?? ''}`,
          ts: Date.now(),
        });
      }
    });
    const offReady = client.on('session_ready', (ready) => {
      setTopicInfo({ topic_id: ready.topic_id, project_slug: ready.project_slug });
    });
    const offEcho = client.on('user_message', (echo: AppWsOutboundUserMessageEcho) => {
      if (echo.project_id !== undefined && echo.project_id !== project_id) return;
      if (echo.client_msg_id !== undefined) {
        clearEchoTimer(echo.client_msg_id);
      }
      dispatch({ type: 'apply_user_echo', echo });
    });
    const offAgent = client.on('agent_message', (msg: AppWsOutboundAgentMessage) => {
      if (msg.project_id !== undefined && msg.project_id !== project_id) return;
      dispatch({ type: 'apply_agent_message', agent: msg });
    });
    const offPartial = client.on(
      'agent_message_partial',
      (partial: AppWsOutboundAgentMessagePartial) => {
        if (partial.project_id !== undefined && partial.project_id !== project_id) return;
        dispatch({ type: 'apply_partial', partial });
      },
    );
    const offError = client.on('error', (err) => {
      dispatch({
        type: 'append_system',
        body: `Error: ${err.code} — ${err.message}`,
        ts: Date.now(),
      });
    });

    client.connect();
    return () => {
      offState();
      offReady();
      offEcho();
      offAgent();
      offPartial();
      offError();
      client.close();
      clientRef.current = null;
      for (const t of echoTimers.current.values()) clearTimeout(t);
      echoTimers.current.clear();
    };
  }, [user, config.base_url, project_id, armEchoTimer, clearEchoTimer]);

  const generateClientMsgId = useCallback((): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `cmid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }, []);

  const performUpload = useCallback(
    async (attachments: ReadonlyArray<{ uri: string; mime_type?: string }>): Promise<string[]> => {
      if (user === null) throw new Error('no auth session');
      const urls: string[] = [];
      for (const att of attachments) {
        // Argus r1 BLOCKING #1 — when the chat surface's upload modal
        // completes an image upload it calls `send()` with the returned
        // server URL on `attachments[]`. Without this guard we would
        // pipe the `/api/app/upload/<user>/<hash>.<ext>` URL back into
        // `uploadAttachment` → `buildMultipartBody`, which only fetches
        // `blob:`/`data:`/`http(s):` URIs and otherwise falls into the
        // native-FormData branch — shipping a garbage multipart and
        // breaking the attach flow. Detect already-uploaded URLs (both
        // relative `/api/app/upload/...` and absolute
        // `http(s)://<host>/api/app/upload/...`) and short-circuit.
        if (isAlreadyUploadedAttachmentUrl(att.uri)) {
          urls.push(att.uri);
          continue;
        }
        const noop = (_p: UploadProgress) => undefined;
        const result = await uploadAttachment({
          uri: att.uri,
          ...(att.mime_type !== undefined ? { mime_type: att.mime_type } : {}),
          token: user.token,
          base_url: config.base_url,
          onProgress: noop,
        });
        if (result === null) throw new Error('upload failed');
        urls.push(result.url);
      }
      return urls;
    },
    [user, config.base_url],
  );

  const dispatchSend = useCallback(
    async (input: {
      client_msg_id: string;
      body: string;
      attachments?: ReadonlyArray<string>;
    }): Promise<boolean> => {
      if (user === null) return false;
      const ws = clientRef.current;
      let sent = false;
      if (ws !== null) {
        sent = ws.sendUserMessage({
          body: input.body,
          client_msg_id: input.client_msg_id,
          project_id,
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        });
      }
      if (sent) {
        armEchoTimer(input.client_msg_id);
        return true;
      }
      try {
        const res = await fetch(`${config.base_url}/api/app/chat/send`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({
            body: input.body,
            client_msg_id: input.client_msg_id,
            project_id,
            ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          }),
        });
        if (!res.ok) return false;
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; echo?: AppWsOutboundUserMessageEcho }
          | null;
        if (json?.echo !== undefined) {
          clearEchoTimer(input.client_msg_id);
          dispatch({ type: 'apply_user_echo', echo: json.echo });
        }
        return true;
      } catch (err) {
        console.warn('[chat-state] HTTP send threw:', err);
        return false;
      }
    },
    [user, project_id, config.base_url, armEchoTimer, clearEchoTimer],
  );

  const send = useCallback(
    async (opts: SendOptions): Promise<boolean> => {
      if (user === null) return false;
      const body = opts.body.trim();
      const attachments = opts.attachments ?? [];
      if (body.length === 0 && attachments.length === 0) return false;

      const client_msg_id = generateClientMsgId();
      let attachmentUrls: string[] = [];
      // Stage the optimistic bubble immediately so the user sees their
      // message even if the upload takes a beat.
      dispatch({
        type: 'add_optimistic_user',
        id: client_msg_id,
        body,
        ts: Date.now(),
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.uri) } : {}),
      });

      if (attachments.length > 0) {
        try {
          attachmentUrls = await performUpload(attachments);
        } catch (err) {
          console.warn('[chat-state] upload failed:', err);
          dispatch({ type: 'mark_send_failed', client_msg_id });
          return false;
        }
      }

      const sendOk = await dispatchSend({
        client_msg_id,
        body,
        ...(attachmentUrls.length > 0 ? { attachments: attachmentUrls } : {}),
      });
      if (!sendOk) {
        dispatch({ type: 'mark_send_failed', client_msg_id });
      }
      return sendOk;
    },
    [user, generateClientMsgId, performUpload, dispatchSend],
  );

  const retry = useCallback(
    async (client_msg_id: string): Promise<boolean> => {
      const target = state.messages.find(
        (m) => m.kind === 'user' && m.client_msg_id === client_msg_id,
      );
      if (target === undefined) return false;
      dispatch({ type: 'mark_send_retrying', client_msg_id });
      const sendOk = await dispatchSend({
        client_msg_id,
        body: target.body,
        ...(target.attachments !== undefined && target.attachments.length > 0
          ? { attachments: target.attachments }
          : {}),
      });
      if (!sendOk) dispatch({ type: 'mark_send_failed', client_msg_id });
      return sendOk;
    },
    [state.messages, dispatchSend],
  );

  const chooseOption = useCallback(
    async (input: { message_id: string; value: string; prompt_id?: string }): Promise<boolean> => {
      // Stamp the choice locally so the option row collapses immediately.
      dispatch({ type: 'record_choice', message_id: input.message_id, value: input.value });
      const client_msg_id = generateClientMsgId();
      dispatch({
        type: 'add_optimistic_user',
        id: client_msg_id,
        body: input.value,
        ts: Date.now(),
      });
      const sendOk = await dispatchSend({ client_msg_id, body: input.value });
      if (!sendOk) dispatch({ type: 'mark_send_failed', client_msg_id });
      return sendOk;
    },
    [generateClientMsgId, dispatchSend],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const value = useMemo<ChatStateValue>(
    () => ({
      state,
      messages: state.messages,
      wsState,
      topicInfo,
      send,
      retry,
      chooseOption,
      signOut,
      reset,
    }),
    [state, wsState, topicInfo, send, retry, chooseOption, signOut, reset],
  );

  return <ChatStateContext.Provider value={value}>{children}</ChatStateContext.Provider>;
}

// Argus r1 BLOCKING #1 — see `./attachment-url.ts:isAlreadyUploadedAttachmentUrl`.
// Re-exported here so existing callers / tests that import from
// `chat-state` keep working without churn.
export { isAlreadyUploadedAttachmentUrl } from './attachment-url';
