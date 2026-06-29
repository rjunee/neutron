/**
 * @neutronai/app — pure chat-state helpers (P5.1).
 *
 * Owns the message-list reducer + supporting helpers. No React. Every
 * function is a pure transform from `(state, action) → state` so the
 * unit tests can exercise the full lifecycle (partial stream → final
 * agent_message → user-send → echo → retry) without mounting any
 * components.
 *
 * Message shape:
 *   - `id` is the canonical `message_id` when the gateway has echoed
 *     the message, OR a client UUID for un-echoed optimistic sends.
 *   - `streaming === true` while partials are arriving; flipped to
 *     `false` when the final `agent_message` lands (or when the
 *     message was emitted atomically with no partials).
 *   - `pending === true` for optimistic user-sends waiting for echo;
 *     `failed === true` when the send couldn't reach the gateway.
 *
 * Reducer actions are a typed discriminated union; the `ChatStateProvider`
 * dispatches them in response to WS events + user composer events.
 */

import type {
  AppWsOutboundAgentMessage,
  AppWsOutboundAgentMessageDocRef,
  AppWsOutboundAgentMessageOption,
  AppWsOutboundAgentMessagePartial,
  AppWsOutboundAgentMessageUploadAffordance,
  AppWsOutboundUserMessageEcho,
} from './ws-envelope';

/**
 * Derive the visible body for a `chat_command_result` — used by BOTH the live
 * WS frame handler and the HTTP-fallback response path in chat-state.tsx (a
 * matched slash command answered over `POST /api/app/chat/send` when the socket
 * is down carries the same result in the JSON body). Returns the result `text`,
 * or the error message when text is empty, or a generic line. Lives in this
 * RN-free module so it's unit-testable without the react-native runtime.
 */
export function commandResultBody(res: { text?: string; error?: { message?: string } }): string {
  if (typeof res.text === 'string' && res.text.length > 0) return res.text;
  const em = res.error?.message;
  if (typeof em === 'string' && em.length > 0) return em;
  return 'Command completed.';
}

export type ChatMessageKind = 'user' | 'agent' | 'system';

export interface ChatMessage {
  id: string;
  kind: ChatMessageKind;
  body: string;
  ts: number;
  /** P5.1 — true while partial chunks are arriving for this message. */
  streaming?: boolean;
  /** P5.1 — true for optimistic user sends waiting for the canonical echo. */
  pending?: boolean;
  /** P5.1 — true when the optimistic send couldn't be delivered. */
  failed?: boolean;
  /** Client-generated id used to correlate the gateway echo. */
  client_msg_id?: string;
  /** Agent-message metadata (canonical body — never on user messages). */
  options?: ReadonlyArray<AppWsOutboundAgentMessageOption>;
  prompt_id?: string;
  allow_freeform?: boolean;
  prompt_kind?: 'buttons' | 'image-gallery';
  image_urls?: ReadonlyArray<string>;
  citations?: ReadonlyArray<{ title: string; url: string }>;
  doc_refs?: ReadonlyArray<AppWsOutboundAgentMessageDocRef>;
  /** P5.1 — user-message attachments echoed by the gateway. */
  attachments?: ReadonlyArray<string>;
  /**
   * ISSUE #18 — top-level deep-link the client should consider navigating
   * to after rendering this agent message. Mirrored from
   * `AppWsOutboundAgentMessage.deep_link`. The chat surface's
   * `<ChatDeepLinkNavigator>` consumes this once per message_id via
   * `router.push(deep_link)` so every Core (Tasks / Notes / Calendar /
   * Email-Managed / Reminders / Code-Gen / Research) drives in-app
   * navigation through a single uniform code path.
   */
  deep_link?: string;
  /** Set when the user has tapped an option on this message. */
  chosen_value?: string;
  /**
   * M2 chat-upload UX — set on agent messages whose phase carries the
   * `upload_affordance` metadata. Drives the chat surface's phase-aware
   * hint + drag-drop overlay. Absence on subsequent agent_messages
   * clears the affordance.
   */
  upload_affordance?: AppWsOutboundAgentMessageUploadAffordance;
}

export interface ChatState {
  messages: ChatMessage[];
  /**
   * Server-authoritative typing indicator. Driven by the gateway's
   * `agent_typing` frame (`start` → true, `end` → false) and ALWAYS cleared
   * when an `agent_message` is applied, so a dropped `end` frame can't wedge
   * the indicator on.
   */
  typing: boolean;
}

export const EMPTY_CHAT_STATE: ChatState = { messages: [], typing: false };

export type ChatAction =
  | { type: 'reset' }
  | { type: 'append_system'; body: string; ts: number }
  | { type: 'add_optimistic_user'; id: string; body: string; ts: number; attachments?: ReadonlyArray<string> }
  | { type: 'apply_partial'; partial: AppWsOutboundAgentMessagePartial }
  | { type: 'apply_agent_message'; agent: AppWsOutboundAgentMessage }
  | { type: 'apply_user_echo'; echo: AppWsOutboundUserMessageEcho }
  | { type: 'mark_send_failed'; client_msg_id: string }
  | { type: 'mark_send_retrying'; client_msg_id: string }
  | { type: 'record_choice'; message_id: string; value: string }
  | { type: 'set_typing'; typing: boolean };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return EMPTY_CHAT_STATE;
    case 'append_system':
      return {
        ...state,
        messages: state.messages.concat({
          id: `sys-${state.messages.length}-${action.ts}`,
          kind: 'system',
          body: action.body,
          ts: action.ts,
        }),
      };
    case 'add_optimistic_user':
      return addOptimisticUserMessage(state, action);
    case 'apply_partial':
      return appendPartial(state, action.partial);
    case 'apply_agent_message':
      // ALWAYS clear typing when an agent_message lands — a dropped server
      // `agent_typing` `end` frame can't wedge the indicator on.
      return { ...finalizeMessage(state, action.agent), typing: false };
    case 'apply_user_echo':
      return reconcileEcho(state, action.echo);
    case 'mark_send_failed':
      return markSendFailed(state, action.client_msg_id);
    case 'mark_send_retrying':
      return markSendRetrying(state, action.client_msg_id);
    case 'record_choice':
      return recordChoice(state, action.message_id, action.value);
    case 'set_typing':
      return state.typing === action.typing ? state : { ...state, typing: action.typing };
    default: {
      // exhaustiveness — any new action MUST be handled above.
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Append a streaming chunk to the agent-message buffer keyed by
 * `message_id`. Creates the buffer when this is the first partial.
 * Idempotent on a partial with no `body_delta` (treats it as a
 * keep-alive — the buffer's `streaming` flag stays true).
 */
export function appendPartial(
  state: ChatState,
  partial: AppWsOutboundAgentMessagePartial,
): ChatState {
  const idx = state.messages.findIndex((m) => m.id === partial.message_id);
  if (idx === -1) {
    return {
      ...state,
      messages: state.messages.concat({
        id: partial.message_id,
        kind: 'agent',
        body: partial.body_delta,
        ts: partial.ts,
        streaming: true,
      }),
    };
  }
  const next = state.messages.slice();
  const existing = next[idx]!;
  next[idx] = {
    ...existing,
    body: existing.body + partial.body_delta,
    streaming: true,
  };
  return { ...state, messages: next };
}

/**
 * Finalize an in-progress agent message (or render it atomically if no
 * partials arrived first). Replaces the buffered body with the
 * canonical full body + attaches metadata (options / citations /
 * image_urls / doc_refs). Clears the `streaming` flag.
 */
export function finalizeMessage(
  state: ChatState,
  agent: AppWsOutboundAgentMessage,
): ChatState {
  const idx = state.messages.findIndex((m) => m.id === agent.message_id);
  const meta = pickAgentMetadata(agent);
  if (idx === -1) {
    return {
      ...state,
      messages: state.messages.concat({
        id: agent.message_id,
        kind: 'agent',
        body: agent.body,
        ts: agent.ts,
        streaming: false,
        ...meta,
      }),
    };
  }
  const next = state.messages.slice();
  next[idx] = {
    ...next[idx]!,
    body: agent.body,
    ts: agent.ts,
    streaming: false,
    ...meta,
  };
  return { ...state, messages: next };
}

/**
 * Reconcile a `user_message` echo from the gateway against a pending
 * optimistic bubble. When the echo carries a `client_msg_id` matching
 * a pending bubble, flip `pending → false` and replace `id` with the
 * canonical `message_id`. When no match, add the message as-is (the
 * user-message came from another tab / device).
 */
export function reconcileEcho(
  state: ChatState,
  echo: AppWsOutboundUserMessageEcho,
): ChatState {
  if (echo.client_msg_id !== undefined && echo.client_msg_id.length > 0) {
    const idx = state.messages.findIndex(
      (m) => m.kind === 'user' && m.client_msg_id === echo.client_msg_id,
    );
    if (idx !== -1) {
      const next = state.messages.slice();
      const existing = next[idx]!;
      next[idx] = {
        ...existing,
        id: echo.message_id,
        body: echo.body,
        ts: echo.ts,
        pending: false,
        failed: false,
        ...(echo.attachments !== undefined ? { attachments: echo.attachments } : {}),
      };
      return { ...state, messages: next };
    }
  }
  // No matching pending bubble — back-fill. Deduplicate on id so a
  // double-echo from a stale socket (or a resume replay) can't push two
  // bubbles.
  if (state.messages.some((m) => m.id === echo.message_id)) return state;
  return {
    ...state,
    messages: state.messages.concat({
      id: echo.message_id,
      kind: 'user',
      body: echo.body,
      ts: echo.ts,
      pending: false,
      ...(echo.client_msg_id !== undefined ? { client_msg_id: echo.client_msg_id } : {}),
      ...(echo.attachments !== undefined ? { attachments: echo.attachments } : {}),
    }),
  };
}

/**
 * Stage an optimistic user bubble immediately on send. The bubble's
 * `id` is the client UUID; `pending: true`. When the gateway echo
 * arrives, `reconcileEcho` flips the id to the canonical `message_id`
 * and clears `pending`.
 */
export function addOptimisticUserMessage(
  state: ChatState,
  input: {
    id: string;
    body: string;
    ts: number;
    attachments?: ReadonlyArray<string>;
  },
): ChatState {
  return {
    ...state,
    messages: state.messages.concat({
      id: input.id,
      kind: 'user',
      body: input.body,
      ts: input.ts,
      pending: true,
      client_msg_id: input.id,
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
  };
}

/**
 * Mark an in-flight optimistic send as failed. Used when the gateway
 * doesn't echo within the timeout AND the WS reports connected (the
 * envelope went out but no echo confirmed). The user can tap the
 * failed bubble's retry affordance to re-send.
 */
export function markSendFailed(state: ChatState, client_msg_id: string): ChatState {
  const idx = state.messages.findIndex(
    (m) => m.kind === 'user' && m.client_msg_id === client_msg_id && m.pending !== false,
  );
  if (idx === -1) return state;
  const next = state.messages.slice();
  next[idx] = { ...next[idx]!, pending: false, failed: true };
  return { ...state, messages: next };
}

/**
 * Mark a failed bubble as retrying (clear `failed`, set `pending`
 * back to true). Companion to `markSendFailed` for the retry path.
 */
export function markSendRetrying(state: ChatState, client_msg_id: string): ChatState {
  const idx = state.messages.findIndex(
    (m) => m.kind === 'user' && m.client_msg_id === client_msg_id,
  );
  if (idx === -1) return state;
  const next = state.messages.slice();
  next[idx] = { ...next[idx]!, pending: true, failed: false };
  return { ...state, messages: next };
}

/**
 * Stamp a tapped option onto an agent message so the UI can collapse
 * the option row into a single "→ {chosen.label}" line + render the
 * other options as disabled.
 */
export function recordChoice(
  state: ChatState,
  message_id: string,
  value: string,
): ChatState {
  const idx = state.messages.findIndex((m) => m.id === message_id);
  if (idx === -1) return state;
  const next = state.messages.slice();
  next[idx] = { ...next[idx]!, chosen_value: value };
  return { ...state, messages: next };
}

function pickAgentMetadata(
  agent: AppWsOutboundAgentMessage,
): Pick<
  ChatMessage,
  | 'options'
  | 'prompt_id'
  | 'allow_freeform'
  | 'prompt_kind'
  | 'image_urls'
  | 'citations'
  | 'doc_refs'
  | 'deep_link'
  | 'upload_affordance'
> {
  const out: Pick<
    ChatMessage,
    | 'options'
    | 'prompt_id'
    | 'allow_freeform'
    | 'prompt_kind'
    | 'image_urls'
    | 'citations'
    | 'doc_refs'
    | 'deep_link'
    | 'upload_affordance'
  > = {};
  if (agent.options !== undefined) out.options = agent.options;
  if (agent.prompt_id !== undefined) out.prompt_id = agent.prompt_id;
  if (agent.allow_freeform !== undefined) out.allow_freeform = agent.allow_freeform;
  if (agent.kind !== undefined) out.prompt_kind = agent.kind;
  if (agent.upload_affordance !== undefined) out.upload_affordance = agent.upload_affordance;
  if (agent.image_urls !== undefined) out.image_urls = agent.image_urls;
  if (agent.citations !== undefined) out.citations = agent.citations;
  if (agent.doc_refs !== undefined) out.doc_refs = agent.doc_refs;
  if (agent.deep_link !== undefined) out.deep_link = agent.deep_link;
  return out;
}
