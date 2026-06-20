/**
 * @neutronai/connect — cross-instance `POST /messages` handler.
 *
 * Replaces the 501 `not_implemented` placeholder at
 * `connect/api/server.ts:130-138`. When a workspace instance's
 * agent fans out a reply to a member instance, the member's gateway
 * receives a stamped `IncomingMessage` here. This handler:
 *
 *   1. Writes an `inbound_messages` audit row BEFORE invoking the router.
 *      Per § 0a.1 risk row 3: a router-side throw must not silently
 *      swallow a delivered message — the audit row is the durable
 *      "we received this" record so an operator can replay.
 *   2. Synthesizes a channel-agnostic `IncomingEvent` and dispatches it
 *      via `channels/router.ts:ChannelRouter.receive()`. The router
 *      resolves-or-creates the topic and hands the event to the topic
 *      handler the gateway composed at boot.
 *   3. On router success, marks the audit row `routed_at` + `route_status='ok'`.
 *      On router failure, marks `route_status='error'` + `route_error=<msg>`
 *      and rethrows so the caller (cross-instance-api/server.ts) returns 500.
 *
 * The synthesized `IncomingEvent` carries the `origin_instance_slug` from the
 * JWT-validated auth context — the server-resolved member `local_slug` that
 * authored the turn (the author attribution, connect-spec §1.5). The JWT
 * context (not the body stamp) is authoritative because it is signed.
 *
 * Locked contract: see `docs/plans/P2-onboarding.md` § 0a.1 lines 283-313.
 */

import { randomUUID } from 'node:crypto'
import type { ChannelRouter } from '../../../channels/router.ts'
import type { Author, ChannelKind, IncomingEvent } from '../../../channels/types.ts'
import type { ProjectDb } from '../../../persistence/index.ts'
import type { ConnectAuthContext } from '../jwt-bearer-middleware.ts'
import type { IncomingMessage } from '../server.ts'
import type { TaggedContent } from '../origin-tag.ts'

export interface OnInboundMessageDeps {
  router: ChannelRouter
  db: ProjectDb
  receiving_instance_slug: string
  now?: () => number
}

export interface OnInboundMessageResult {
  delivered: boolean
  ack_id: string
  fanout_session_id?: string
}

/**
 * Build the handler bound to a specific receiving instance. The returned
 * function matches the `ConnectApiHandlers.on_inbound_message`
 * signature so it slots directly into the cross-instance API server.
 */
export function buildOnInboundMessageHandler(
  deps: OnInboundMessageDeps,
): (
  ctx: ConnectAuthContext,
  message: TaggedContent<IncomingMessage>,
) => Promise<{ ack_id: string }> {
  const now = deps.now ?? ((): number => Date.now())

  return async (ctx, taggedMessage): Promise<{ ack_id: string }> => {
    const result = await onInboundMessage(ctx, taggedMessage, {
      router: deps.router,
      db: deps.db,
      receiving_instance_slug: deps.receiving_instance_slug,
      now,
    })
    return { ack_id: result.ack_id }
  }
}

/**
 * Pure entry point — exported for tests + callers that want the full
 * `OnInboundMessageResult` (delivery flag, ack id, fanout session id). The
 * cross-instance API owns the receive + audit + route-into-the-host-session
 * path; the routed turn becomes part of the host's one memory exactly like
 * the owner's own (connect-spec §1.4).
 */
export async function onInboundMessage(
  ctx: ConnectAuthContext,
  taggedMessage: TaggedContent<IncomingMessage>,
  deps: Required<Pick<OnInboundMessageDeps, 'router' | 'db' | 'receiving_instance_slug'>> & {
    now?: () => number
  },
): Promise<OnInboundMessageResult> {
  const now = deps.now ?? ((): number => Date.now())
  const ackId = randomUUID()
  const message = taggedMessage.payload
  // Uniform author envelope (connect-spec §4) — stamped server-side in
  // `handlePostMessage` from the resolved member row. Fall back to the JWT
  // origin for any caller that reached here without a server author (non-connect
  // / legacy), so every persisted row + event carries a WHO.
  const author = resolveAuthor(message, ctx)

  // STEP 1 — audit row write FIRST (per risk row 3). Any router-side
  // throw after this point still leaves a durable record of the inbound
  // message + the failure reason. The author (§4.4) persists on this row so the
  // transcript / scribe / Core-activity layers can read WHO spoke.
  await deps.db.run(
    `INSERT INTO inbound_messages
       (ack_id, origin_instance_slug, origin_user_id, receiving_instance_slug,
        topic_id, speaker_user_id, channel_hint, body_json, received_at,
        routed_at, route_status, route_error, author_id, author_display)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [
      ackId,
      ctx.origin_instance_slug,
      ctx.origin_user_id,
      deps.receiving_instance_slug,
      message.topic_id,
      message.speaker_user_id,
      message.channel_hint ?? null,
      JSON.stringify(message.body ?? null),
      now(),
      author.id,
      author.display,
    ],
  )

  // STEP 2 — route into the channel router's ingress queue. The router
  // resolves-or-creates the topic, then dispatches via the topic handler
  // the gateway composed at boot.
  const event = synthesizeIncomingEvent(taggedMessage, ctx, ackId, now(), author)
  try {
    await deps.router.receive(event)
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err)
    await deps.db.run(
      `UPDATE inbound_messages SET route_status = ?, route_error = ?, routed_at = ? WHERE ack_id = ?`,
      ['error', errStr, now(), ackId],
    )
    throw err
  }

  await deps.db.run(
    `UPDATE inbound_messages SET route_status = ?, routed_at = ? WHERE ack_id = ?`,
    ['ok', now(), ackId],
  )

  return { delivered: true, ack_id: ackId }
}

/**
 * Map the cross-instance `IncomingMessage` shape into the channel-agnostic
 * `IncomingEvent` shape the router consumes. Fan-out always carries an
 * `app_socket` channel by default — the workspace-side reply has no
 * native Telegram thread on the receiver side. Callers that want a
 * different routing kind set `channel_hint`.
 *
 * The `origin_instance_slug` of the incoming TaggedContent is preserved on the
 * synthesized event — the server-resolved member `local_slug` that authored
 * the turn (the author attribution, connect-spec §1.5). The JWT-validated
 * `ctx.origin_instance_slug` is authoritative — we use it (not the body stamp)
 * so a forged stamp can never mis-attribute the author downstream.
 */
function synthesizeIncomingEvent(
  tagged: TaggedContent<IncomingMessage>,
  ctx: ConnectAuthContext,
  ackId: string,
  receivedAt: number,
  author: Author,
): IncomingEvent {
  const message = tagged.payload
  const channel = resolveChannel(message.channel_hint)
  const text = stringifyBody(message.body)
  return {
    channel_kind: channel,
    channel_topic_id: message.topic_id,
    user: {
      channel_user_id: ctx.origin_user_id,
      // The transcript speaker label (§4.3 layer 1) — the agent sees the
      // author's human display name, not the raw slug:userid handle.
      display_name: author.display,
    },
    body: { text },
    event_id: ackId,
    received_at: receivedAt,
    origin_instance_slug: ctx.origin_instance_slug,
    author,
  }
}

/**
 * The uniform author (connect-spec §4) for an inbound turn. The server stamps it
 * onto the payload in `handlePostMessage` from the resolved member row; this
 * reads it back. Any caller that reached here without a server author (a
 * non-connect / legacy fan-out) falls back to the JWT origin as author #0, so
 * every persisted row + routed event carries a WHO.
 */
function resolveAuthor(message: IncomingMessage, ctx: ConnectAuthContext): Author {
  if (
    message.author !== undefined &&
    typeof message.author.id === 'string' &&
    typeof message.author.display === 'string'
  ) {
    return message.author
  }
  return {
    id: ctx.origin_instance_slug,
    display: `${ctx.origin_instance_slug}:${ctx.origin_user_id.slice(0, 8)}`,
  }
}

function resolveChannel(hint: string | undefined): ChannelKind {
  if (hint === 'telegram' || hint === 'app_socket' || hint === 'webhook' || hint === 'cli') {
    return hint
  }
  return 'app_socket'
}

function stringifyBody(body: unknown): string {
  if (typeof body === 'string') return body
  if (body !== null && typeof body === 'object' && 'text' in body) {
    const t = (body as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}
