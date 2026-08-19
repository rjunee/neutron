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

import {
  groupReactions as groupReactionsCore,
  isTransientSystemNotice,
  systemNoticeText,
  type ReactionChip,
} from '@neutronai/chat-core';
import type { ChatMessage, ConnStatus } from '@neutronai/chat-core';

export type { ReactionChip };

/**
 * How long a freshly-attached scope may withhold its transcript behind the
 * hydrating spinner before the UI has to commit to what it actually holds.
 *
 * Long enough that a healthy connect + resume replay lands first (so the empty
 * state never flashes over history that is about to arrive — the whole point of
 * ISSUES #402), short enough that a wedged scope resolves while the owner is
 * still looking at it.
 */
export const HYDRATION_SETTLE_MS = 4000;

export interface HydrationInput {
  /** How many rows THIS scope's local store currently holds. */
  message_count: number;
  /** The transport's current status. */
  status: ConnStatus;
  /** Milliseconds since this view attached to this scope. */
  elapsed_ms: number;
}

/**
 * Has this scope's history SETTLED — i.e. may the UI now show the owner what it
 * actually has (a transcript, or an honest empty state) instead of a spinner?
 *
 * WHY THIS IS A FUNCTION AND NOT TWO `setHydrated(true)` CALLS. The gate used to
 * be exactly two positive signals, written inline: "the local store already had
 * rows" and "the socket reached `open`". Both are signals that can legitimately
 * NEVER ARRIVE — a project whose transcript has not synced to this device yet has
 * no local rows, and a session that never gets driven onto the wire never reaches
 * `open` — and there was no third rule, so the two of them together were also the
 * ONLY way out. A scope that hit neither sat on the hydrating spinner for the life
 * of the process.
 *
 * That is what Ryan hit on-device (2026-07-30): every project whose transcript was
 * a single seeded agent message — nothing in the local store, so signal one could
 * not fire — showed a permanent spinner, while the two scopes carrying a real
 * back-and-forth transcript (already on disk) rendered fine. The message-count
 * correlation was never about turn-pairing; it was about which scopes could
 * satisfy signal one.
 *
 * So the rule now has a FLOOR. Settled when ANY of:
 *   - the local store already holds this scope's history (nothing to wait for);
 *   - the socket reached `open` (the resume has been requested — a still-empty
 *     transcript is genuinely empty, not merely un-fetched);
 *   - the socket is `closed` (the attempt TERMINATED; a spinner over a dead
 *     transport is a lie, and the status strip already reports the connection);
 *   - {@link HYDRATION_SETTLE_MS} has elapsed — the floor. Nothing may hold the
 *     spinner open forever, whatever the cause.
 *
 * An empty or minimal transcript renders an empty chat. Never an infinite spinner.
 */
export function hydrationSettled(input: HydrationInput): boolean {
  if (input.message_count > 0) return true;
  if (input.status === 'open') return true;
  if (input.status === 'closed') return true;
  return input.elapsed_ms >= HYDRATION_SETTLE_MS;
}

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
 *   - `agent_typing` (start/end) → the TURN-ACTIVITY signal; typing on/off.
 *   - `agent_message_partial` → append `body_delta` to the buffer, typing on.
 *   - `agent_message` (final)  → clear that buffer (the durable message now
 *     owns the row); typing off when no other stream remains.
 *   - anything else            → unchanged.
 *
 * WHY `agent_typing` IS HANDLED FIRST, AND WHY IT WAS MISSING FOR SO LONG.
 * The owner reported twice that a live turn shows no typing indicator on mobile
 * ("if the chat turn is active, why am I not seeing a typing indicator? This is
 * the most urgent problem"). The server was never the problem: `emitAppWsTyping`
 * in `open/wiring/app-ws.ts` brackets every live-agent turn with
 * `agent_typing` start/end at six call sites, and the web client consumes it
 * (`landing/chat-react/controller.ts`). Mobile received the frame — its own
 * rail and work-board tests deliver it — and never fed it into THIS reducer,
 * so the dots were driven solely by `agent_message_partial`. A turn that spends
 * thirty minutes in tool calls streams no text, so it looked identical to a dead
 * one.
 *
 * And there was a second, quieter reason a handler added naively would still
 * have failed: the `message_id` guard below rejects any frame without one, and
 * an `agent_typing` envelope has NO `message_id` (it is
 * `{v, type, state, ts, project_id?}`). So the branch MUST sit above that
 * guard — which is exactly the kind of detail that makes "the frame arrives and
 * is parsed elsewhere" not the same thing as "the feature works".
 *
 * SCOPE FILTERING IS THE CALLER'S JOB, deliberately. This fold is pure and sees
 * whatever it is handed; the web controller guards separately against a stray
 * typing frame flipping the wrong project's indicator. Feeding this reducer
 * another project's frames would light the wrong dots, so the caller must filter
 * before calling — the same contract the partial/final frames already rely on.
 */
export function foldStreamFrame(state: StreamState, frame: unknown): StreamState {
  if (typeof frame !== 'object' || frame === null) return state;
  const f = frame as Record<string, unknown>;
  const type = f['type'];

  // ABOVE the message_id guard: an `agent_typing` envelope carries no
  // message_id, so anything below this point cannot see it.
  if (type === 'agent_typing') {
    const turnState = f['state'];
    if (turnState === 'start') return state.typing ? state : { ...state, typing: true };
    if (turnState === 'end') {
      // An explicit end clears the dots UNLESS a stream is still buffered — a
      // partial that outlives its turn-end must keep them lit rather than
      // stranding a half-rendered bubble with no indicator.
      const stillStreaming = Object.keys(state.buffers).length > 0;
      return state.typing === stillStreaming ? state : { ...state, typing: stillStreaming };
    }
    return state;
  }

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
 * The TRANSIENT system-notice channel — the native mirror of the web
 * controller's `systemNotice` view-model field (`landing/chat-react/
 * controller.ts`). Same mechanism, same clearing rules; the frame predicate
 * itself is the shared `isTransientSystemNotice` from `@neutronai/chat-core`,
 * so there is exactly one definition of "this is a pill, not a message".
 */
export interface SystemNoticeState {
  /** What the pill says right now. `null` = no pill. */
  text: string | null;
  /**
   * Has the real reply for THIS turn already begun? A cold-start ack is a
   * DELAYED `setTimeout` on the gateway, so on a slow-then-fast turn it can land
   * just after the answer; re-arming the pill then leaves a "Waking up…" hanging
   * below the reply (web FIX #347). Latched here for the same reason.
   */
  replyStarted: boolean;
}

export function emptySystemNoticeState(): SystemNoticeState {
  return { text: null, replyStarted: false };
}

/**
 * Re-arm for a new turn. Called when the owner sends: the next ack belongs to
 * the turn that is starting now, not to the one that already answered.
 */
export function armSystemNoticeTurn(state: SystemNoticeState): SystemNoticeState {
  if (state.text === null && !state.replyStarted) return state;
  return emptySystemNoticeState();
}

/**
 * Fold one raw inbound frame into the notice state. Pure; returns the SAME
 * reference when nothing changed so the caller can skip a re-render.
 *
 *   - a transient notice frame → show the pill, unless the reply already began;
 *   - a real streaming token or a real final `agent_message` → clear the pill
 *     and latch `replyStarted`;
 *   - anything else → unchanged.
 */
export function foldSystemNoticeFrame(
  state: SystemNoticeState,
  frame: unknown,
): SystemNoticeState {
  if (typeof frame !== 'object' || frame === null) return state;
  const f = frame as Record<string, unknown>;
  const type = f['type'];

  if (isTransientSystemNotice(frame)) {
    // Drop a LATE ack: never show the pill once this turn's reply has started.
    if (state.replyStarted) return state;
    const text = systemNoticeText(frame);
    if (text === null || text === state.text) return state;
    return { text, replyStarted: false };
  }

  if (type === 'agent_message_partial') {
    // A ZERO-LENGTH opening delta is not a token (web BUG 7) — the stream has
    // not really begun, so it must not clear a pill that is doing its job.
    const delta = f['body_delta'];
    if (typeof delta !== 'string' || delta.length === 0) return state;
  } else if (type !== 'agent_message') {
    return state;
  }

  if (state.text === null && state.replyStarted) return state;
  return { text: null, replyStarted: true };
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
 * FlashList recycling class for a transcript row.
 *
 * WHY THIS EXISTS. The owner reported the scroll track "jumps around, changes
 * size … not consistent". FlashList v2 measures rows rather than taking an
 * `estimatedItemSize`, and with no `getItemType` every row shares ONE recycling
 * pool — so a recycled view that last held a one-line user bubble is
 * re-measured as a tall agent markdown block, `contentSize` is revised, and the
 * scroll track resizes under the thumb. Same-shaped pools make each measurement a
 * much smaller correction.
 *
 * Keyed on SPEAKER, because that is the dominant structural difference: a user
 * bubble is short, right-aligned and rarely wraps; an agent row is full-width
 * markdown and routinely taller than the screen. A streaming row is its own class
 * again — it grows token by token, so recycling it as either settled kind
 * guarantees a re-measure on every chunk.
 *
 * Deliberately NOT keyed on the run-grouping inputs (`gapTop`, `hasTail`): those
 * shift a row's height by a few points, and splitting the pools that finely would
 * trade measurement churn for recycling misses.
 */
export function chatItemType(row: RenderRow): string {
  if (row.kind === 'streaming') return 'streaming'
  return row.message.role === 'user' ? 'user' : 'agent'
}

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

/**
 * Telegram-style delivery ladder for an outbound (user) message. Track B
 * Phase 4 adds `read` (blue double-tick): the message has been read by a
 * device other than the sender — the agent loop (which marks every inbound
 * user message read once it picks it up) or a second device on the account.
 */
export type DeliveryState = 'pending' | 'sent' | 'failed' | 'delivered' | 'read';

/**
 * Map a message's send status + receipt aggregate to its ladder state.
 * `selfDeviceId` (when known) is excluded from the read set so the sender's
 * own device can't light its own read tick; a `read_by` entry from any OTHER
 * device — including the synthetic `agent` reader — advances it to `read`.
 */
export function deliveryState(
  message: ChatMessage,
  selfDeviceId?: string,
): DeliveryState | null {
  if (message.role !== 'user') return null; // only outbound messages show ticks
  switch (message.status) {
    case 'queued':
      return 'pending'; // 🕓 — written locally, not yet on the wire (offline)
    case 'sent':
      return 'sent'; // ✓ — handed to the socket, awaiting the server echo
    case 'failed':
      // W5 GAP-4 — handed to the socket but the ack never arrived within the
      // ack-timeout, so the socket was silently lost. NOT a stuck 🕓 clock: the
      // UI shows a retry affordance; the send is re-driven on the next reconnect.
      return 'failed';
    case 'acked':
      // ✓✓ delivered; promotes to read once another device/agent has read it.
      return isReadByOther(message.read_by, selfDeviceId) ? 'read' : 'delivered';
  }
}

/** True when `read_by` holds at least one device id other than the sender's
 *  own. Tolerant of null/undefined (a message with no receipts). */
function isReadByOther(
  readBy: readonly string[] | null | undefined,
  selfDeviceId?: string,
): boolean {
  if (readBy === null || readBy === undefined) return false;
  for (const id of readBy) {
    if (id.length > 0 && id !== selfDeviceId) return true;
  }
  return false;
}

/**
 * Track B Phase 4 (reactions) — group a message's reaction set into the
 * per-emoji chips the FlashList UI renders. Thin wrapper over chat-core's
 * framework-free {@link groupReactionsCore} so the RN surface keeps importing
 * grouping from the render model alongside the delivery helpers.
 */
export function groupReactions(
  message: Pick<ChatMessage, 'reactions'>,
  selfDeviceId?: string,
): ReactionChip[] {
  return groupReactionsCore(message.reactions, selfDeviceId);
}

/** The glyph the UI renders for a delivery state. `delivered` and `read` share
 *  the ✓✓ double-tick; the UI distinguishes `read` by COLOUR (blue), matching
 *  the Telegram ladder — so the glyph is identical and the state drives the
 *  style. */
export function deliveryGlyph(state: DeliveryState): string {
  switch (state) {
    case 'pending':
      return '🕓';
    case 'sent':
      return '✓';
    case 'failed':
      return '⚠️'; // W5 GAP-4 — retry affordance, not a stuck clock
    case 'delivered':
      return '✓✓';
    case 'read':
      return '✓✓';
  }
}
