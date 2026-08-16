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
 * Hence four properties, each of which biases toward NOTIFYING:
 *
 *   1. **Presence EXPIRES, on a MONOTONIC clock.** A `foreground` declaration is
 *      believed for {@link WEB_PRESENCE_TTL_MS} and no longer. The client
 *      re-declares on a timer; if it stops — for any reason, known or not — the
 *      owner is notified again within a minute. This is the only property that
 *      makes the module safe against failures nobody enumerated. The clock is
 *      `performance.now()` rather than `Date.now()` BECAUSE the expiry is a
 *      subtraction: an NTP correction or a suspend/resume that steps the wall
 *      clock BACKWARD makes `now - entry.at` negative, no entry ever satisfies
 *      `>= ttl`, and "expires" silently becomes "believed forever" — the exact
 *      permanent silence property 1 exists to prevent, reintroduced by the
 *      clock. A backward delta is ALSO treated as expiry, so an injected or
 *      exotic clock cannot resurrect the bug.
 *   2. **Absence of information means NOTIFY.** An unknown owner, an empty
 *      tracker, a connection that never declared anything: all read as
 *      not-present. Suppression requires a positive, fresh, explicit claim.
 *   3. **A THROW means NOTIFY.** {@link suppressPushWhileWebForeground} treats an
 *      exception from the presence check as "not present" rather than letting it
 *      propagate, because the alternative to a redundant notification is not a
 *      clean failure — the sink is invoked fire-and-forget from
 *      `open/composer.ts`, so a throw would vanish into a rejected promise and
 *      the owner would be told nothing at all.
 *   4. **Presence is SCOPED to the conversation, so it can only silence the chat
 *      it is evidence about.** A foregrounded tab reading project A is not a
 *      reason to withhold a notification about project B — he cannot see B, and a
 *      global suppression would mean one open tab silenced every other
 *      conversation for as long as it stayed open. This is the same distinction
 *      `app/lib/push-foreground-policy.ts` draws on the device ("is he looking at
 *      THIS conversation?"), which is what lets the two policies compose instead
 *      of merely coexist.
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
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'
import type { ChatMessagePushInput, ChatMessagePushSink } from './chat-message-push.ts'

export { WEB_PRESENCE_TTL_MS }

/**
 * Collapse every spelling of a chat scope to ONE comparable value.
 *
 * Lifted deliberately from `app/lib/push-foreground-policy.ts`, which carries the
 * incident: General answers to `null`, `''` and `GENERAL_RAIL_ID` depending on
 * which side of the wire you are standing on, and the two sides of THIS
 * comparison disagree too. The push input's `project_id` comes from
 * `chatMessagePushScope`, which yields `null` for General; the socket's comes off
 * the upgrade query string, which yields `undefined` when absent and can carry
 * `''`. Comparing those raw makes a General message look like a different
 * conversation from the General tab on screen — a buzz while he reads it — and,
 * far worse in the other direction, makes an empty-string project look like
 * General and silence it.
 */
function scopeKey(value: string | null | undefined): string {
  if (value === null || value === undefined) return GENERAL_RAIL_ID
  if (value.length === 0) return GENERAL_RAIL_ID
  return value
}

/**
 * The narrow write-side the app-ws surface holds.
 *
 * Narrow on purpose: a surface that could also ASK whether the owner is present
 * would grow a second reason to care, and the only question a socket can answer
 * is what its own client just told it.
 */
export interface WebPresenceReporter {
  /**
   * This web connection's client says the owner is looking at it right now.
   *
   * `project_id` is the conversation THIS socket is bound to — `null` for
   * General. It is not decoration: it is the whole of property 4, and the socket
   * is the only place it can come from honestly. A web client holds one topic per
   * connection and reconnects to switch projects
   * (`gateway/http/app-ws-surface.ts` `channel_topic_id`), so the socket's scope
   * IS the conversation on the owner's screen.
   */
  foreground(user_id: string, connection_id: string, project_id: string | null): void
  /** …and now he isn't. Same effect as {@link drop}; kept distinct so the call
   *  site reads as the client's report rather than as a teardown. */
  background(connection_id: string): void
  /** The connection is gone (socket close). Forget it. */
  drop(connection_id: string): void
}

/** The read-side the push decision holds, plus the write-side above. */
export interface WebPresenceTracker extends WebPresenceReporter {
  /**
   * Is at least one web client for this owner CURRENTLY foregrounded ON THIS
   * CONVERSATION?
   *
   * "Currently" is load-bearing: a declaration older than
   * {@link WEB_PRESENCE_TTL_MS} is not evidence about now, and reads as absent.
   *
   * So is the conversation. A tab foregrounded on project A answers `false` for
   * project B, because the owner cannot see B and a notification about it is
   * exactly what he still needs.
   */
  isForeground(user_id: string, project_id: string | null): boolean
  /** Live (unexpired) foreground connections — diagnostics and tests only. */
  size(): number
}

export interface CreateWebPresenceTrackerInput {
  /** Believe a declaration this long. Default {@link WEB_PRESENCE_TTL_MS}. */
  ttl_ms?: number
  /**
   * Injectable clock (tests). Default: `performance.now()`, which is MONOTONIC.
   *
   * Not `Date.now`. See property 1 in the module docblock — the wall clock can
   * step backward, and a backward step turns this module's expiry into
   * "believed forever", which is the permanent-silence failure it exists to
   * prevent. A test that injects a hand-cranked counter gets the same monotonic
   * guarantee for free.
   */
  now?: () => number
}

/**
 * The default clock: monotonic, immune to NTP corrections and suspend/resume.
 *
 * `performance.now()` counts from process start, which is exactly the lifetime of
 * this map — presence is in-memory per-process, so there is nothing here that
 * outlives the epoch and nothing that needs a wall-clock reading.
 */
function monotonicNow(): number {
  return performance.now()
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
  const now = input.now ?? monotonicNow
  // A non-finite or non-positive TTL would mean "believe forever" or "believe
  // nothing"; the first is the permanent-silence bug this module is built to
  // avoid, so a nonsense value falls back to the shared default rather than
  // being honoured.
  const ttl_ms =
    typeof input.ttl_ms === 'number' && Number.isFinite(input.ttl_ms) && input.ttl_ms > 0
      ? input.ttl_ms
      : WEB_PRESENCE_TTL_MS
  const live = new Map<string, { user_id: string; scope: string; at: number }>()

  /**
   * Drop every declaration that is no longer evidence about NOW.
   *
   * Runs on WRITE as well as on read, and the write half is the one that makes
   * "the map cannot grow without bound" a property of the map rather than of
   * whoever happens to call `size()`. Pruning only on read means the bound holds
   * exactly as long as somebody keeps asking — and the read here is a push
   * decision, so a box with no notifications flowing is precisely the box that
   * would accumulate.
   *
   * A NEGATIVE DELTA EXPIRES TOO. `at < entry.at` means the clock moved backward
   * under us, so the entry's timestamp is from a future that will not arrive and
   * the `>= ttl` test can never fire for it again. Deleting is the safe reading:
   * a browser we can no longer age out is a browser that could silence the owner
   * forever, and the cost of being wrong is one redundant buzz. The default clock
   * is monotonic so this cannot happen; the branch exists for injected clocks and
   * for whatever `performance.now()` does on a platform nobody has tried yet.
   */
  const prune = (at: number): void => {
    for (const [connection_id, entry] of live) {
      const elapsed = at - entry.at
      if (elapsed < 0 || elapsed >= ttl_ms) live.delete(connection_id)
    }
  }

  return {
    foreground(user_id, connection_id, project_id): void {
      // An empty id on either side cannot be matched by a later read, so it
      // could only ever suppress nothing or (worse) collide with another empty
      // id. Refuse it: the owner gets notified, which is the safe direction.
      if (user_id.length === 0 || connection_id.length === 0) return
      const at = now()
      prune(at)
      live.set(connection_id, { user_id, scope: scopeKey(project_id), at })
    },
    background(connection_id): void {
      live.delete(connection_id)
    },
    drop(connection_id): void {
      live.delete(connection_id)
    },
    isForeground(user_id, project_id): boolean {
      if (user_id.length === 0) return false
      const at = now()
      prune(at)
      const scope = scopeKey(project_id)
      for (const entry of live.values()) {
        if (entry.user_id === user_id && entry.scope === scope) return true
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
  /**
   * Answers "is the owner in front of a web client showing THIS conversation?"
   *
   * Takes the message rather than closing over nothing, because the question is
   * per-conversation (property 4) and the conversation is a property of the
   * message. A predicate that ignored its argument would be the global
   * suppression this signature exists to make impossible to write by accident.
   */
  isWebForeground: (msg: ChatMessagePushInput) => boolean
  log?: (msg: string) => void
}

/**
 * Wrap a push sink so it stays quiet while the owner is reading THAT chat on the
 * web.
 *
 * RETURNS `false` WHEN IT SUPPRESSES. That is the honest answer — no device was
 * reached — and it is the same answer the underlying sink gives for a body it
 * declined to send.
 *
 * ── WHAT THAT `false` DOES AND DOES NOT PROTECT ────────────────────────────
 *
 * It does NOT, on its own, keep the durable row unstamped, and an earlier draft
 * of this docblock claimed it did. The condition is
 * `if (durability === 'reply' && (notified || delivered)) await stampDelivered(...)`
 * (`gateway/http/deliver.ts`) — `notified` is THIS sink's answer, but `delivered`
 * is the live socket fan-out, and either arm stamps. So a suppressed push whose
 * message went out over a live socket still stamps `delivered_at`, and the next
 * re-emit of that `idempotency_key` reads `was_delivered: true` and returns early
 * without notifying. Stating otherwise was rule 3a in miniature: a docblock
 * describing an intended mode, sitting above code that never entered it.
 *
 * WHAT ACTUALLY MAKES THE STAMP CORRECT IS PROPERTY 4, the conversation scope.
 * Suppression now requires a web client foregrounded ON THE MESSAGE'S OWN
 * conversation — the same socket the live fan-out just delivered to — so
 * `delivered: true` and "he is looking at it" are two readings of one fact, and
 * stamping records that he was reached rather than guessing it. The dangerous
 * shape is the OTHER one: suppressed AND not delivered live, which is what a
 * GLOBAL presence check produced for every other conversation. There
 * `notified || delivered` is `false || false`, nothing stamps, and the re-emit
 * still buzzes — so even that case degrades to a delayed alert rather than a lost
 * one. Scoping is what stops it arising at all.
 *
 * `gateway/http/__tests__/deliver-web-presence.test.ts` drives `deliver` and this
 * wrapper TOGETHER over a real ButtonStore and asserts the re-emit still reaches
 * the phone, because neither half's own suite can see this seam.
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
      present = input.isWebForeground(msg)
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
      input.log?.(
        `[push] skipped: the owner is foregrounded on the web app for this chat (scope=${
          msg.project_id ?? GENERAL_RAIL_ID
        }; the row is already on his screen)`,
      )
      return false
    }
    return await input.sink(msg)
  }
}
