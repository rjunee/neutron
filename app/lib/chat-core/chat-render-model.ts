/**
 * @neutronai/app — pure render-model helpers for the FlashList chat UI.
 *
 * chat-core persists only FINALIZED messages (`normalizeInbound` drops
 * `agent_message_partial` streaming chunks). The Telegram-grade UI still has
 * to render the streaming "…typing" bubble and a per-message delivery ladder,
 * so this module owns that derivation as pure functions — no React, no RN —
 * which keeps it unit-testable and keeps the hook thin.
 *
 *   - {@link StreamTracker}: folds raw inbound frames into the in-flight
 *     streaming buffers + a typing flag.
 *   - {@link buildRenderRows}: merges the durable transcript with the live
 *     streaming bubbles into the final ordered list the list renders.
 *   - {@link deliveryState}: maps a user message's send status to its
 *     checkmark ladder (queued → sent → delivered), Telegram-style.
 */

import type { ChatMessage } from '@neutron/chat-core';

/** One in-flight agent stream (a sequence of `agent_message_partial`s). */
export interface StreamingBuffer {
  message_id: string;
  body: string;
  /** First-seen timestamp, for stable ordering of concurrent streams. */
  started_at: number;
}

export interface StreamState {
  /** message_id → assembled streaming body. */
  buffers: Record<string, StreamingBuffer>;
  /** True while any agent stream is mid-flight (drives the typing dots). */
  typing: boolean;
}

export function emptyStreamState(): StreamState {
  return { buffers: {}, typing: false };
}

/**
 * Fold one raw inbound frame into the streaming state. Pure: returns a NEW
 * state (or the same reference when the frame is irrelevant, so callers can
 * skip a re-render).
 *
 *   - `agent_message_partial` → append `body_delta` to the buffer, typing on.
 *   - `agent_message` (final)  → clear that buffer (the durable message now
 *     owns the row); typing off when no other stream remains.
 *   - anything else            → unchanged.
 */
export function foldStreamFrame(state: StreamState, frame: unknown): StreamState {
  if (typeof frame !== 'object' || frame === null) return state;
  const f = frame as Record<string, unknown>;
  const type = f['type'];
  const message_id = typeof f['message_id'] === 'string' ? f['message_id'] : null;
  if (message_id === null || message_id.length === 0) return state;

  if (type === 'agent_message_partial') {
    const delta = typeof f['body_delta'] === 'string' ? f['body_delta'] : '';
    const ts = typeof f['ts'] === 'number' && Number.isFinite(f['ts']) ? f['ts'] : 0;
    const prev = state.buffers[message_id];
    const buffer: StreamingBuffer = {
      message_id,
      body: (prev?.body ?? '') + delta,
      started_at: prev?.started_at ?? ts,
    };
    return { buffers: { ...state.buffers, [message_id]: buffer }, typing: true };
  }

  if (type === 'agent_message') {
    if (state.buffers[message_id] === undefined) return state;
    const next = { ...state.buffers };
    delete next[message_id];
    return { buffers: next, typing: Object.keys(next).length > 0 };
  }

  return state;
}

/**
 * Does this raw frame belong to the given project view? Streaming frames
 * (`agent_message_partial` / `agent_message`) carry an optional `project_id`,
 * but the app WS topic is per-USER — every project's stream arrives on the
 * same socket. A project-scoped view must therefore drop a sibling project's
 * stream the same way the durable transcript is filtered (`matchesProject` in
 * the hook), else another project's partial renders in this chat until its
 * final message lands and is filtered out (Codex P2). Semantics mirror the
 * durable filter: the global (empty-`projectId`) view shows only untagged
 * streams; a project view shows only its own. Non-stream frames (no
 * `project_id`) are unaffected — `foldStreamFrame` ignores them regardless.
 */
export function frameMatchesProject(frame: unknown, projectId: string): boolean {
  if (typeof frame !== 'object' || frame === null) return true;
  const raw = (frame as Record<string, unknown>)['project_id'];
  const framePid = typeof raw === 'string' && raw.length > 0 ? raw : null;
  if (projectId.length === 0) return framePid === null;
  return framePid === projectId;
}

/** A renderable row: either a durable message or a live streaming bubble. */
export type RenderRow =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'streaming'; key: string; message_id: string; body: string };

/**
 * Merge the durable transcript (already ordered by the engine) with the live
 * streaming buffers. A streaming buffer whose final `agent_message` has
 * already landed in `messages` is dropped (the durable row wins). Remaining
 * streams append after the transcript, oldest-started first — i.e. the
 * optimistic/live tail.
 */
export function buildRenderRows(
  messages: readonly ChatMessage[],
  stream: StreamState,
): RenderRow[] {
  const persistedIds = new Set<string>();
  for (const m of messages) {
    if (m.message_id !== null) persistedIds.add(m.message_id);
  }

  const rows: RenderRow[] = messages.map((message) => ({
    kind: 'message',
    key: rowKey(message),
    message,
  }));

  const live = Object.values(stream.buffers)
    .filter((b) => !persistedIds.has(b.message_id) && b.body.length > 0)
    .sort((a, b) => a.started_at - b.started_at);
  for (const b of live) {
    rows.push({ kind: 'streaming', key: `stream:${b.message_id}`, message_id: b.message_id, body: b.body });
  }
  return rows;
}

/** Stable React key for a durable message row. */
export function rowKey(message: ChatMessage): string {
  if (message.client_msg_id.length > 0) return `c:${message.client_msg_id}`;
  if (message.message_id !== null) return `m:${message.message_id}`;
  return `t:${message.created_at}`;
}

/** Telegram-style delivery ladder for an outbound (user) message. */
export type DeliveryState = 'pending' | 'sent' | 'delivered';

export function deliveryState(message: ChatMessage): DeliveryState | null {
  if (message.role !== 'user') return null; // only outbound messages show ticks
  switch (message.status) {
    case 'queued':
      return 'pending'; // ⧖ — written locally, not yet on the wire (offline)
    case 'sent':
      return 'sent'; // ✓ — handed to the socket, awaiting the server echo
    case 'acked':
      return 'delivered'; // ✓✓ — persisted server-side with a seq
  }
}

/** The glyph the UI renders for a delivery state. */
export function deliveryGlyph(state: DeliveryState): string {
  switch (state) {
    case 'pending':
      return '🕓';
    case 'sent':
      return '✓';
    case 'delivered':
      return '✓✓';
  }
}
