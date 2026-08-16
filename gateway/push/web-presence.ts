/**
 * @neutronai/gateway/push — don't buzz his phone about something he is already
 * reading on the web app.
 *
 * THE OWNER'S REPORT (2026-08-15): *"can you also check if I'm actively using
 * the web app, and if so dont send push notifications to my phone."*
 *
 * ── WHY THIS IS A NEW SIGNAL AND NOT A NEW INFERENCE ───────────────────────
 *
 * The obvious implementation is to skip the push when a socket is open, and it
 * is wrong. The comment above the notify in `gateway/http/deliver.ts:429` had
 * already argued the mobile half of it: Android keeps the app-ws socket open
 * while the app sits in the background, so gating on `delivered_live` would
 * silence exactly the case a notification exists for. A browser tab holds its
 * socket the same way — minimised, behind another window, on a sleeping laptop.
 * "Connected" has never meant "looking".
 *
 * Nor did the client know. `chat-core/ws-client.ts:175-195` `setActive` reacts to
 * the very signal we want (`document.visibilityState`, wired at
 * `landing/chat-react/useNeutronChat.ts:65`) and does nothing with it but start
 * and stop its own heartbeat — it has never sent a byte to the server. So the
 * gateway genuinely did not have this information, and the fix is a client that
 * says so out loud (`AppWsInboundPresence`), not a cleverer reading of what it
 * already had.
 *
 * ── THE FAILURE MODE THIS MODULE IS SHAPED AROUND ──────────────────────────
 *
 * Getting this wrong in one direction produces a redundant buzz: annoying, and
 * the owner notices within seconds. Getting it wrong in the OTHER direction
 * produces SILENCE — no push, no error, no log anyone reads, and nothing on any
 * screen to notice. A browser killed by a crash, a `kill -9`, or a laptop lid
 * closing hard sends no close frame, so a naive tracker would hold that tab
 * "foreground" for the life of the process and the owner's phone would simply
 * stop notifying him, permanently, with every test still green.
 *
 * Hence three properties, each of which biases toward NOTIFYING:
 *
 *   1. **Presence EXPIRES.** A `foreground` declaration is believed for
 *      {@link WEB_PRESENCE_TTL_MS} and no longer. The client re-declares on a
 *      timer; if it stops — for any reason, known or not — the owner is notified
 *      again within a minute. This is the only property that makes the module
 *      safe against failures nobody enumerated.
 *   2. **Absence of information means NOTIFY.** An unknown owner, an empty
 *      tracker, a connection that never declared anything: all read as
 *      not-present. Suppression requires a positive, fresh, explicit claim.
 *   3. **A THROW means NOTIFY.** {@link suppressPushWhileWebForeground} treats an
 *      exception from the presence check as "not present" rather than letting it
 *      propagate, because the alternative to a redundant notification is not a
 *      clean failure — the sink is invoked fire-and-forget from
 *      `open/composer.ts`, so a throw would vanish into a rejected promise and
 *      the owner would be told nothing at all.
 *
 * ── WHY IT IS A MODULE ─────────────────────────────────────────────────────
 *
 * Because a decision only reachable by booting the 6000-line composer is a
 * decision nothing tests. Same reason `app/lib/push-foreground-policy.ts` and
 * `open/wiring/app-ws-marker.ts` exist. And because there are TWO push call
 * sites — `gateway/http/deliver.ts` for out-of-turn posts and the `ownsNotify`
 * branch of `open/composer.ts`'s app-ws send path for ordinary replies — which
 * must not answer this question differently. They can't: both consume the ONE
 * sink built at `open/composer.ts:2575`, and the wrapper goes on at that single
 * construction, above both.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is not the mobile foreground policy (`app/lib/push-foreground-policy.ts`,
 * shipped in #298), and it does not replace or weaken it. That one runs ON the
 * phone and declines to draw a banner for the conversation already on screen; a
 * push was still sent, and the row still lands. This one decides whether the push
 * is SENT AT ALL, on the server, on the strength of a different device being in
 * front of the owner. A push never sent and a push sent-but-not-shown are
 * different things, and the two policies compose without either knowing about the
 * other.
 */

import { WEB_PRESENCE_TTL_MS } from '@neutronai/wire-types/web-presence.ts'
import type { ChatMessagePushSink } from './chat-message-push.ts'

export { WEB_PRESENCE_TTL_MS }

/**
 * The narrow write-side the app-ws surface holds.
 *
 * Narrow on purpose: a surface that could also ASK whether the owner is present
 * would grow a second reason to care, and the only question a socket can answer
 * is what its own client just told it.
 */
export interface WebPresenceReporter {
  /** This web connection's client says the owner is looking at it right now. */
  foreground(user_id: string, connection_id: string): void
  /** …and now he isn't. Same effect as {@link drop}; kept distinct so the call
   *  site reads as the client's report rather than as a teardown. */
  background(connection_id: string): void
  /** The connection is gone (socket close). Forget it. */
  drop(connection_id: string): void
}

/** The read-side the push decision holds, plus the write-side above. */
export interface WebPresenceTracker extends WebPresenceReporter {
  /**
   * Is at least one web client for this owner CURRENTLY foregrounded?
   *
   * "Currently" is load-bearing: a declaration older than
   * {@link WEB_PRESENCE_TTL_MS} is not evidence about now, and reads as absent.
   */
  isForeground(user_id: string): boolean
  /** Live (unexpired) foreground connections — diagnostics and tests only. */
  size(): number
}

export interface CreateWebPresenceTrackerInput {
  /** Believe a declaration this long. Default {@link WEB_PRESENCE_TTL_MS}. */
  ttl_ms?: number
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
}

/**
 * An in-memory, per-connection record of which web clients are foregrounded.
 *
 * IN-MEMORY IS CORRECT, not a shortcut deferred to later. The fact being stored
 * is "a socket held by this process has a human in front of it", which is
 * meaningless the moment the process ends — a restart that resurrected it would
 * be restoring a claim about a browser that is no longer connected, i.e.
 * manufacturing exactly the stale silence the TTL exists to prevent.
 *
 * KEYED BY CONNECTION, NOT BY DEVICE. Two tabs are two connections and each
 * speaks only for itself: closing one must not mark the owner absent while the
 * other is still in front of him. `device_id` would not do — it is client-minted
 * and stable across reconnects, so two tabs of the same browser can share one,
 * and a socket close would then wrongly forget the survivor.
 *
 * ONLY FOREGROUND ENTRIES ARE STORED. A `background` report deletes rather than
 * writing a `false`, so the map's size is the number of screens the owner could
 * be looking at, and "no entry" has exactly one meaning everywhere: not present.
 */
export function createWebPresenceTracker(
  input: CreateWebPresenceTrackerInput = {},
): WebPresenceTracker {
  const now = input.now ?? ((): number => Date.now())
  // A non-finite or non-positive TTL would mean "believe forever" or "believe
  // nothing"; the first is the permanent-silence bug this module is built to
  // avoid, so a nonsense value falls back to the shared default rather than
  // being honoured.
  const ttl_ms =
    typeof input.ttl_ms === 'number' && Number.isFinite(input.ttl_ms) && input.ttl_ms > 0
      ? input.ttl_ms
      : WEB_PRESENCE_TTL_MS
  const live = new Map<string, { user_id: string; at: number }>()

  /** Drop every declaration older than the TTL. Runs on read — no timer to leak,
   *  and the map is bounded by concurrent sockets in the meantime. */
  const prune = (at: number): void => {
    for (const [connection_id, entry] of live) {
      if (at - entry.at >= ttl_ms) live.delete(connection_id)
    }
  }

  return {
    foreground(user_id, connection_id): void {
      // An empty id on either side cannot be matched by a later read, so it
      // could only ever suppress nothing or (worse) collide with another empty
      // id. Refuse it: the owner gets notified, which is the safe direction.
      if (user_id.length === 0 || connection_id.length === 0) return
      live.set(connection_id, { user_id, at: now() })
    },
    background(connection_id): void {
      live.delete(connection_id)
    },
    drop(connection_id): void {
      live.delete(connection_id)
    },
    isForeground(user_id): boolean {
      if (user_id.length === 0) return false
      const at = now()
      prune(at)
      for (const entry of live.values()) {
        if (entry.user_id === user_id) return true
      }
      return false
    },
    size(): number {
      prune(now())
      return live.size
    },
  }
}

export interface SuppressPushWhileWebForegroundInput {
  /** The real push sink — `buildChatMessagePushSink`'s result. */
  sink: ChatMessagePushSink
  /** Answers "is the owner in front of a web client right now?" */
  isWebForeground: () => boolean
  log?: (msg: string) => void
}

/**
 * Wrap a push sink so it stays quiet while the owner is reading on the web.
 *
 * RETURNS `false` WHEN IT SUPPRESSES, and that is a deliberate contract choice
 * rather than a detail. `deliver` stamps the durable row's `delivered_at` on a
 * `true` (`gateway/http/deliver.ts`), and that stamp is what tells a later
 * idempotent re-emit "he already got this" rather than "the row exists but never
 * reached him". Suppression reached no device, so answering `true` would silence
 * the re-emit forever for a notification that was never sent — the phone would
 * stay quiet even after the owner shut the laptop. `false` is simply the truth,
 * and it is the same answer the underlying sink already gives for a body it
 * declined to send.
 *
 * THE SUPPRESSION IS ABOUT THE PUSH, NOT ABOUT THE MESSAGE. The durable chat row
 * is written and fanned by the caller before this ever runs; nothing here can
 * lose a message. The worst case is a buzz the owner didn't get for a message
 * sitting on the screen in front of him.
 */
export function suppressPushWhileWebForeground(
  input: SuppressPushWhileWebForegroundInput,
): ChatMessagePushSink {
  return async (msg): Promise<boolean> => {
    let present: boolean
    try {
      present = input.isWebForeground()
    } catch (err) {
      // See property 3 in the module docblock: an unanswerable question is not a
      // reason to withhold a notification.
      input.log?.(
        `[push] web-presence check failed, notifying anyway: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      present = false
    }
    if (present) {
      input.log?.('[push] skipped: the owner is foregrounded on the web app (the chat row is already on his screen)')
      return false
    }
    return await input.sink(msg)
  }
}
