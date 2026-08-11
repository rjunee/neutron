/**
 * @neutronai/gateway/push — a chat message's push notification.
 *
 * THE OWNER'S REPORT (2026-08-09): *"the notification that comes in on Android
 * says 'ritual:kaizen'. I don't need a special case notification for rituals. I
 * should just get notifications of chat messages, and a ritual posting is just a
 * chat message. And the notification should include at least the first part of
 * the chat message in the notification itself."*
 *
 * ONE ROOT CAUSE UNDER BOTH HALVES OF THAT: the push was composed from the
 * reminder ROW instead of from the message the fire actually posted. The row's
 * `message` for a ritual is the dispatch token `ritual:<id>`
 * (`reminders/ritual-registration.ts:982`), so the body could only ever be a
 * routing token; and the payload's `project_slug` was the OWNER slug, not a
 * project id, so the tap had nothing it could resolve.
 *
 * So this module composes a push FROM A DELIVERED MESSAGE and nothing else:
 * the text that was posted, and the durable row id it was posted as. There is no
 * ritual shape, no reminder shape — a ritual post and an ordinary agent post
 * produce the same notification, because they are the same thing.
 *
 * The `project_id` it carries is the ROUTE the tap resolves
 * (`app/lib/push-deep-link-dispatch.ts` → `/projects/<id>/chat?message_id=<id>`),
 * and it is ALWAYS PRESENT — including for the no-project General scope, which
 * names itself with the shared `GENERAL_RAIL_ID` sentinel.
 *
 * That was the other way round for one round of review, on the argument that the
 * client should own General's route spelling and a second copy of the sentinel is
 * what caused the `~general` / `#general` / `general` confusion of ISSUES
 * #410/#411. The argument is right about the hazard and wrong about the fix. A
 * payload that omits the field is MALFORMED to every app bundle already installed
 * (`resolvePushRoute` on the released client warns and returns null when
 * `agent_message` carries no project) — and a store artifact cannot be upgraded in
 * lockstep with a self-hosted gateway, so "the owner taps and the app opens
 * nowhere" would have survived the fix that was supposed to end it. The real
 * answer to #410/#411 is ONE definition, not silence: the sentinel lives in
 * `wire-types/topic-id.ts`, above both sides, and `app/__tests__/general-scope.test.ts`
 * pins the client's copy to it.
 */

import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'
import { PUSH_KIND_AGENT_MESSAGE } from '@neutronai/wire-types/push-kind.ts'

/**
 * How much of the message body rides in the notification.
 *
 * Sized for the shade, not for the transport: Android collapses a notification to
 * roughly two lines and iOS to about four, so a longer body is truncated by the OS
 * anyway — but truncated MID-WORD, and with no ellipsis to say it happened. Cutting
 * it here on a word boundary is the difference between "Kaizen review: three
 * things landed today, and one…" and "Kaizen review: three things landed today,
 * and o".
 */
export const CHAT_PUSH_BODY_MAX = 160

/** The title a General-scope (no-project) chat message wears. */
export const CHAT_PUSH_GENERAL_TITLE = 'General'

/**
 * Characters that occupy no visible width in a notification shade.
 *
 * `\s` does NOT match any of these, so neither does `trim()` — a body of nothing
 * but zero-width spaces used to arrive here, survive normalization at full length,
 * clear the sink's `length === 0` check and buzz the owner's phone with a
 * notification containing no visible characters at all (measured: a U+200B + U+2060
 * body produced a length-2 excerpt and a real push).
 *
 * U+200D (ZERO WIDTH JOINER) is deliberately ABSENT: it welds emoji sequences
 * together (👨‍👩‍👦), and stripping it would shatter a family emoji into three
 * separate glyphs. It needs no entry here anyway — a ZWJ-only body has no visible
 * content and is caught by {@link hasVisibleContent}.
 *
 * WRITTEN AS ESCAPES ON PURPOSE. The first version of this line held the literal
 * characters, which made the character class itself invisible in the source: a
 * reviewer could not tell which codepoints were in it or count them, and any tool
 * that trims or re-encodes the file could drop one silently. A guard whose contents
 * cannot be read is the same shape of hazard as the fail-open number this module was
 * fixed for — so each entry is spelled out and named, and a diff can be reviewed.
 */
const INVISIBLE_CHARS = new RegExp(
  '[' +
    '\\u200B' + // ZERO WIDTH SPACE
    '\\u200C' + // ZERO WIDTH NON-JOINER
    '\\u2060' + // WORD JOINER
    '\\uFEFF' + // ZERO WIDTH NO-BREAK SPACE (BOM)
    '\\u00AD' + // SOFT HYPHEN
    '\\u200E' + // LEFT-TO-RIGHT MARK
    '\\u200F' + // RIGHT-TO-LEFT MARK
    ']',
  'g',
)

/**
 * Does this string contain anything a human would SEE and read as content?
 *
 * Letters and digits in ANY script (`\p{L}`/`\p{N}`, so a CJK- or Cyrillic-only
 * message counts, which `\w` would have wrongly rejected), a pictograph (an
 * emoji-only post is terse but it is real information the owner sent himself), or
 * a REGIONAL INDICATOR — `\p{Extended_Pictographic}` does not cover those, so
 * `🇺🇸` alone read as an empty body until this class named them. A flag is an emoji
 * like any other, and this predicate decides whether the owner gets a buzz at all.
 *
 * WHAT IS DELIBERATELY STILL NOT CONTENT, stated because the boundary is not
 * self-evident and a reader will otherwise assume the omissions are the same bug:
 * whitespace, zero-width formatting, punctuation, and BARE SYMBOLS that are not
 * pictographs — `→`, `✓`, `★`, `•`. Unicode does not classify those as emoji, and a
 * notification whose whole body is one arrow tells the owner only that something
 * happened, which is exactly the buzz {@link chatPushExcerpt} exists to withhold.
 * (`✅` and `❤️` ARE pictographs and do count; that asymmetry is Unicode's, not
 * ours.)
 */
function hasVisibleContent(s: string): boolean {
  return /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(s)
}

/**
 * The first part of a posted message, fit for a notification body.
 *
 * Collapses every run of whitespace to one space FIRST — a composed reminder or a
 * ritual digest is routinely multi-line markdown, and a raw newline in a
 * notification body renders as a blank half-line on Android that eats the two
 * lines the shade gives you. Then truncates on the last word boundary at or before
 * the budget and appends a single-character ellipsis.
 *
 * NEVER THROWS, AND NEVER RETURNS SOMETHING WITH NO WORDS IN IT. A body that is
 * empty, blank, invisible (zero-width only) or punctuation-only comes back as the
 * EMPTY STRING, and the caller decides what that means — the sink skips the push,
 * because a buzz carrying no readable characters tells the owner only that
 * something happened, which the durable chat row already does better.
 *
 * That promise is checked on the OUTPUT, not just the input, because clipping can
 * manufacture a wordless string out of a perfectly good message (a budget that
 * lands inside a leading run of punctuation). Both ends are guarded below.
 */
export function chatPushExcerpt(body: string, max: number = CHAT_PUSH_BODY_MAX): string {
  // A budget of 0 / a negative / NaN would make every branch below return the
  // bare ellipsis — a buzz with no words, which is the one output this function
  // promises never to produce. Unreachable from the single call site today; the
  // clamp is here so the invariant holds for the second one.
  const budget = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : CHAT_PUSH_BODY_MAX
  const flat = body.replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim()
  // Nothing readable in the SOURCE — an all-whitespace, all-zero-width or
  // punctuation-only post. There is no excerpt to take, so say so plainly rather
  // than handing the sink a string whose only property is a non-zero length.
  if (!hasVisibleContent(flat)) return ''
  if (flat.length <= budget) return flat
  const clipped = dropDanglingSurrogate(flat.slice(0, budget))
  const lastSpace = clipped.lastIndexOf(' ')
  // A single word longer than the whole budget has no boundary to cut on — take
  // the hard clip rather than returning nothing.
  const head = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped
  const trimmed = head.replace(/[\s,;:.!?-]+$/, '')
  // A head that is ENTIRELY trailing punctuation strips to nothing, and `…` alone
  // is a buzz with no words. It also survives the sink's `length === 0` check, so
  // the guard has to be here rather than there. Fall back to the untrimmed clip.
  //
  // THAT FALLBACK CAN ITSELF BE EMPTY, and this line used to claim it could not
  // ("`flat.length > budget >= 1`"). It can: at budget 1 a leading emoji clips to a
  // LONE HIGH SURROGATE, which `dropDanglingSurrogate` strips, leaving `clipped`
  // empty — `chatPushExcerpt('😀 hello', 1)` walks straight through here. Nothing is
  // wrong with the output, because the invariant is not held by this line at all: it
  // is held by the `hasVisibleContent(kept)` check below, which is the only thing
  // between an empty `kept` and a bare `…` on the owner's lock screen. Recorded
  // because a reader trusting the old claim would think that check was redundant and
  // could delete it.
  const kept = trimmed.length > 0 ? trimmed : clipped
  // THE OUTPUT CHECK. The source had words, but the budget may have landed before
  // the first one (`"... hello"` at budget 3 clips to `"..."`), and `"...…"` is the
  // same wordless buzz by a different route. Silence beats a shade full of dots.
  if (!hasVisibleContent(kept)) return ''
  return `${kept}…`
}

/**
 * Drop a LONE high surrogate left at the end by a mid-codepoint clip.
 *
 * `slice` counts UTF-16 units, so cutting at a fixed budget can land between the
 * halves of an emoji. The orphan renders as `�` in the shade — the first
 * visible character of a notification being a replacement glyph reads as a
 * corrupted message rather than a truncated one.
 */
function dropDanglingSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s
}

/** The scope a delivered chat message belongs to, as the tap must route it. */
export interface ChatMessagePushScope {
  /** The project the chat lives in, or `null` for the General (no-project) scope. */
  project_id: string | null
}

/**
 * Recover the delivery scope from the app-ws topic the message was delivered to.
 *
 * `app:<user_id>` is General; `app:<user_id>:<project_id>` is that project
 * (`wire-types/topic-id.ts` — `appWsTopicId` / `appWsProjectTopicId`). Anything
 * else (a `web:` topic, a Telegram topic, a malformed string) yields General,
 * because the mobile client only ever binds and hydrates an `app:` topic, so
 * there is no other chat a tap could open.
 *
 * WHAT THAT MEANS TODAY, stated plainly so nobody reads the project branch as a
 * live mode it is not: EVERY out-of-turn producer in the Open composer delivers to
 * the owner's BARE `app:<user>` topic — fired reminders and rituals
 * (`open/composer.ts` `reminderGeneralTopic`), the proactive brief + idle nudge
 * (`proactiveGeneralTopic`), the overnight report (`overnightBriefTopic`) — because
 * that is the one topic the mobile client binds and hydrates, and suffixing it is
 * the PR #105 deliver-to-nobody bug. So every notification the owner receives right
 * now is General-scoped, and that is CORRECT: the message really did land in his
 * General chat, which is where he asked the tap to take him.
 *
 * The project branch is not speculative either — `app:<user>:<project>` is a real
 * topic the mobile client binds when a project chat is open
 * (`app/lib/chat-core/use-mobile-chat.ts:300`). It is the answer for the first
 * producer that posts into one. It is covered by unit tests over this parser, and
 * deliberately NOT by an integration test, because there is nothing yet to
 * integrate — a test that claimed otherwise would be asserting a mode no call site
 * can reach.
 */
export function chatMessagePushScope(topic_id: string): ChatMessagePushScope {
  if (!topic_id.startsWith('app:')) return { project_id: null }
  const rest = topic_id.slice('app:'.length)
  const sep = rest.indexOf(':')
  if (sep < 0) return { project_id: null }
  const project_id = rest.slice(sep + 1)
  return { project_id: project_id.length > 0 ? project_id : null }
}

export interface ChatMessagePushInput {
  /** The project the message landed in, or `null` for General. */
  project_id: string | null
  /** The durable row id the tap anchors the transcript on. */
  message_id: string
  /** The message text as posted — excerpted here, never pre-truncated. */
  body: string
}

/** The Expo message shape `PushDispatcher.pushAll` takes. */
export interface ChatMessagePush {
  title: string
  body: string
  data: Record<string, unknown>
}

/**
 * Compose the notification for one delivered chat message.
 *
 * The TITLE names where the message is, so a glance at the shade answers "which
 * conversation is this?" without opening anything. The BODY is the message. The
 * DATA is only what the tap resolver needs — no owner slug, no reminder id, no
 * ritual id: an internal token in a notification payload is how `ritual:kaizen`
 * ended up on the owner's lock screen.
 *
 * KNOWN AND DELIBERATE: for a project-scoped message the title is the project ID,
 * not its display NAME. The id is all that exists at this layer — `deliver` recovers
 * the scope from the app-ws TOPIC (`chatMessagePushScope`), and resolving a name
 * would mean a project-store read inside the notification path, which is a lookup on
 * the fire path of a best-effort buzz. It is also unreachable today: every
 * out-of-turn producer in the Open composer delivers to the owner's BARE `app:<user>`
 * topic, so every notification is General-scoped and titled `General`. Worth doing
 * properly when the first producer actually posts into a project chat — at which
 * point the name belongs in the `ChatMessagePushInput` the caller builds, not in a
 * lookup here.
 */
export function buildChatMessagePush(input: ChatMessagePushInput): ChatMessagePush {
  return {
    title: input.project_id === null ? CHAT_PUSH_GENERAL_TITLE : input.project_id,
    body: chatPushExcerpt(input.body),
    data: {
      kind: PUSH_KIND_AGENT_MESSAGE,
      message_id: input.message_id,
      // ALWAYS a string, never omitted and never null — General names itself with
      // the shared sentinel. See the module docblock for why absence was the wrong
      // encoding: an already-installed app bundle treats a missing project as a
      // malformed payload and refuses to route at all.
      project_id: input.project_id ?? GENERAL_RAIL_ID,
    },
  }
}

/** The slice of `PushDispatcher` this sink needs. Narrow on purpose: a sink that
 *  could also prune tokens or fan per-user would be a second delivery policy.
 *
 *  TWO FIELDS ARE READ, AND `ok` ALONE IS NOT ENOUGH.
 *
 *  `PushDispatcher.pushAll` does NOT throw on an Expo outage — it catches the
 *  network failure and resolves with `ok: false` (`gateway/push/dispatcher.ts`
 *  `PushResult`), so a sink that only watched for a throw would report an outage as
 *  a successful notification.
 *
 *  But `ok` means only "no HTTP/network exception", and it is `true` in two cases
 *  where NOBODY WAS REACHED:
 *    * zero registered devices — `dispatch` returns early with
 *      `{ attempted: 0, delivered: 0, ok: true }` and never calls Expo at all,
 *      which is the normal state of a fresh install;
 *    * every ticket came back `error` (e.g. all tokens `DeviceNotRegistered`) —
 *      `{ delivered: 0, errored: N, ok: true }`, because the gateway did receive
 *      the tickets.
 *  In both, an `ok`-only sink answers `true`, `deliver` stamps `delivered_at`, and
 *  the idempotent re-emit is silenced FOREVER for a message the owner never got.
 *  So `delivered` is the field that decides, and it must be a number ≥ 1.
 *
 *  IT FAILS CLOSED. A result that does not expose a numeric `delivered` has not
 *  proven that anything was accepted, so it reads as NOT delivered. (This inverts
 *  an earlier contract here which said "anything without an explicit `ok: false`
 *  counts as accepted, so a fake that resolves `undefined` reads as success" — that
 *  permissive default is precisely what let the zero-delivery stamp through, and a
 *  test double that wants to model a delivery now has to say so.)
 *
 *  `delivered ≥ 1` means Expo ACCEPTED the message for at least one device. It is
 *  not proof the device displayed it — no available signal is — but it is the
 *  difference between "handed to a transport with a recipient" and "sent nowhere". */
export interface ChatMessagePushFanOut {
  pushAll(
    project_slug: string,
    message: { title?: string; body: string; data?: Record<string, unknown> },
  ): Promise<{ ok?: boolean; delivered?: number } | unknown>
}

/**
 * A best-effort "notify the owner's devices that this landed in chat" sink.
 *
 * Best-effort in the same sense the live socket push is: the durable chat row is
 * the guarantee, and a failed notification must never turn into a failed
 * delivery — so every throw is swallowed here rather than at the producer, where
 * forgetting the try/catch once would make a fired reminder retry forever over an
 * Expo outage.
 *
 * RESOLVES TO WHETHER A DEVICE WAS ACTUALLY REACHED — `true` only when the fan-out
 * reports at least one accepted ticket; `false` when it was skipped (nothing to
 * say), when no device was reached (no tokens registered, or every ticket errored),
 * or when the transport threw. This is not decoration: `deliver` stamps the durable
 * row `delivered_at` on a `true` and leaves it NULL on a `false`, and that stamp is
 * the ONLY thing that lets a later idempotent re-emit tell "he already got this"
 * from "the row exists but never reached him". A sink that answered `true` for a
 * send with zero recipients would suppress the notification for a message the owner
 * never saw — see the `ChatMessagePushFanOut` docblock for the two `ok: true`
 * cases where exactly that happens.
 */
export type ChatMessagePushSink = (input: ChatMessagePushInput) => Promise<boolean>

export interface BuildChatMessagePushSinkInput {
  fanOut: ChatMessagePushFanOut
  /** The instance slug the device-token rows are keyed by. */
  project_slug: string
  log?: (msg: string) => void
}

export function buildChatMessagePushSink(
  input: BuildChatMessagePushSinkInput,
): ChatMessagePushSink {
  return async (msg): Promise<boolean> => {
    const push = buildChatMessagePush(msg)
    // A body that excerpts to nothing carries no information — a buzz with no
    // words is worse than silence, and the durable row is already in chat. Report
    // `false`: nothing was sent, so nothing should be recorded as delivered.
    //
    // A LENGTH TEST IS ONLY SUFFICIENT BECAUSE `chatPushExcerpt` GUARANTEES IT.
    // Zero-width and punctuation-only bodies are non-empty strings that render as
    // an empty shade, and they used to pass right through this line; the excerpt now
    // collapses every wordless body to `''` so this stays the one check the sink
    // needs. Do not weaken that guarantee without moving the guard here.
    if (push.body.length === 0) return false
    try {
      const result = await input.fanOut.pushAll(input.project_slug, push)
      const tally =
        typeof result === 'object' && result !== null
          ? (result as { ok?: boolean; delivered?: number })
          : {}
      // An Expo outage resolves with `ok: false` rather than throwing — see the
      // `ChatMessagePushFanOut` docblock. Treat it as not-sent so the row stays
      // unstamped and the next re-emit tries again.
      if (tally.ok === false) {
        input.log?.('[push] chat-message push not accepted by the transport (the chat row is the guarantee)')
        return false
      }
      // `ok: true` with nothing delivered is the dangerous case, not an edge case:
      // zero registered devices short-circuits before Expo is called, and a
      // fully-errored batch still returns ok. Both must read as not-delivered or
      // the stamp silences the re-emit for a message nobody received. A result that
      // does not report a count has proven nothing — fail closed.
      if (typeof tally.delivered !== 'number' || !(tally.delivered >= 1)) {
        input.log?.(
          `[push] chat-message push reached no device (delivered=${
            typeof tally.delivered === 'number' ? tally.delivered : 'unreported'
          }); leaving the row unstamped so the next re-emit retries`,
        )
        return false
      }
      return true
    } catch (err) {
      input.log?.(
        `[push] chat-message push failed (the chat row is the guarantee): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return false
    }
  }
}
