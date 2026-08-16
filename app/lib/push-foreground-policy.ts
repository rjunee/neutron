/**
 * @neutronai/app — whether a notification that arrived WHILE THE APP IS OPEN
 * should surface, kept free of `react-native` and `expo-notifications`.
 *
 * Same reason `push-observability.ts` and `push-registration-sync.ts` live
 * here: the app suite cannot import `lib/push.ts` (it pulls in
 * `expo-notifications` / `react-native`, neither of which loads under bun
 * test), so a decision made inside that module is untestable — and
 * "untestable" is how a notification rule quietly stops matching what the
 * owner asked for.
 *
 * ── WHAT THE OWNER ASKED FOR (2026-08-15) ────────────────────────────────────
 *   "Everything should be a chat message, and I get notified for any and all
 *    chat messages if I'm not actively in the app. Same way notifications work
 *    for every single other chat app in existence."
 *
 * THE SERVER HALF AND THIS HALF ONLY WORK TOGETHER. The server now notifies for
 * every agent chat message, including a reply to something he just sent — which
 * was previously excluded ON PURPOSE (`open/composer.ts`: *"a STEADY-STATE
 * live-agent reply … is deliberate: the owner sent the message that caused it,
 * so it is in-turn"*). That exclusion was the only thing stopping his phone
 * buzzing while he was typing in it. Removing it is only safe because the
 * DEVICE now declines to interrupt him — so if this file is ever weakened, the
 * server rule has to be revisited in the same change, not separately.
 *
 * ── WHY "IS THE APP OPEN" IS NOT THE WHOLE QUESTION ──────────────────────────
 * Expo consults a notification handler ONLY for a notification that arrives
 * while the app is in the foreground; a backgrounded app never reaches this
 * code, because the OS posts the notification itself. So the question this
 * module answers is narrower than it first looks: *the app is open — is he
 * looking at THIS conversation?*
 *
 * And that is exactly the distinction every other chat app draws, which is what
 * he asked for. Reading a message in project A while a message lands in project
 * B should still tell him; a message landing in the conversation already on
 * screen should not, because he is reading it as it arrives. The previous
 * behaviour ignored the distinction and always showed the banner — including
 * over the conversation that produced it.
 */

import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'

/**
 * Collapse every spelling of a chat scope to ONE comparable value.
 *
 * General answers to three names on this client — the rail id `'~general'`, the
 * chat scope `''`, and `null` for "no project" — and the two sides of this
 * comparison do NOT agree on which they use. The push payload always carries
 * `GENERAL_RAIL_ID` (`gateway/push/chat-message-push.ts` sends it explicitly,
 * never omits it); the screen registers whatever its route segment gave it.
 *
 * THIS WAS A REAL BUG FOR THE LENGTH OF ONE DRAFT: the policy modelled General
 * as `null` and the payload sends `'~general'`, so a General message would have
 * compared unequal to the General conversation on screen and buzzed him while
 * he read it — the exact interruption this module exists to prevent, arriving
 * only in the one scope that has more than one name. `app/lib/general-scope.ts`
 * already warns that the rail id reaching a comparison raw is how `~general` /
 * `general` / `''` confusion (ISSUES #410/#411) happens; this is that hazard
 * one layer further out, so it gets normalised rather than assumed.
 */
function scopeKey(value: string | null | undefined): string {
  if (value === null || value === undefined) return GENERAL_RAIL_ID
  if (value.length === 0) return GENERAL_RAIL_ID
  return value
}

/** The conversation currently on screen, or `null` when none is. */
export interface OpenConversation {
  /** The project whose chat is on screen; `null` is the General scope. */
  project_id: string | null
}

/** What a notification says about where it belongs. */
export interface IncomingNotification {
  /**
   * The project the message landed in, as carried by the push payload. `null`
   * is General. `undefined` means the payload did not say — an older or
   * malformed notification.
   */
  project_id?: string | null
}

/** What the OS should do with a notification that arrived in the foreground. */
export interface ForegroundPresentation {
  shouldShowBanner: boolean
  shouldShowList: boolean
  shouldPlaySound: boolean
  shouldSetBadge: boolean
}

/** Interrupt him: banner, sound, list, badge. */
const PRESENT: ForegroundPresentation = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: true,
}

/**
 * Do not interrupt — but STILL LIST AND BADGE.
 *
 * The suppression is only of the interruption. The notification stays in the
 * shade and the badge still moves, because "he is looking at this conversation"
 * justifies not talking over him; it does not justify destroying the record. A
 * `shouldShowList: false` here would mean a message he scrolled past while it
 * arrived leaves no trace anywhere but the transcript.
 */
const SILENT: ForegroundPresentation = {
  shouldShowBanner: false,
  shouldShowList: true,
  shouldPlaySound: false,
  shouldSetBadge: true,
}

/**
 * Decide how a foreground-received notification should present.
 *
 * `open` is the conversation on screen, or `null` when the app is foregrounded
 * but not sitting in a chat (a settings screen, the project list, a Work tab).
 * In that case he is IN the app but not reading the conversation, so the
 * notification presents — the same as any other chat app showing you an in-app
 * banner while you are on a different screen.
 *
 * A notification whose payload does not name a project PRESENTS. It is the
 * conservative direction: the cost of a redundant banner is a moment's
 * annoyance, and the cost of the other mistake is a message he never learns
 * about. An unreadable payload must never be the reason he misses something.
 */
export function decideForegroundPresentation(
  notification: IncomingNotification,
  open: OpenConversation | null,
): ForegroundPresentation {
  if (open === null) return PRESENT
  if (notification.project_id === undefined) return PRESENT
  return scopeKey(notification.project_id) === scopeKey(open.project_id) ? SILENT : PRESENT
}

/**
 * The conversation currently on screen.
 *
 * Module-level rather than React state on purpose: the notification handler is
 * installed once, outside the tree, and fires on an OS callback that has no
 * component to read context from. The chat screen sets this on focus and clears
 * it on blur.
 *
 * FAILING OPEN IS THE DEFAULT AND IT IS DELIBERATE: if the screen ever forgets
 * to set it, this stays `null`, `decideForegroundPresentation` returns PRESENT,
 * and he gets a banner he did not strictly need. The opposite default — assume
 * he is looking — would silence real messages whenever the wiring broke, and
 * silence is the failure nobody notices.
 */
let openConversation: OpenConversation | null = null

/** Record that a conversation is on screen. */
export function setOpenConversation(conversation: OpenConversation): void {
  openConversation = conversation
}

/** Record that no conversation is on screen (blur, background, unmount). */
export function clearOpenConversation(): void {
  openConversation = null
}

/** The conversation on screen, for the handler and for tests. */
export function getOpenConversation(): OpenConversation | null {
  return openConversation
}

/**
 * Read the project id out of a raw push payload.
 *
 * The payload is whatever crossed the wire, so every field is `unknown` until
 * proven otherwise. `null` is MEANINGFUL here (the General scope) and must not
 * collapse into "absent", which is why the return distinguishes the two.
 */
export function readNotificationProject(data: unknown): IncomingNotification {
  if (data === null || typeof data !== 'object') return {}
  const raw = (data as Record<string, unknown>)['project_id']
  if (raw === null) return { project_id: null }
  if (typeof raw === 'string') return { project_id: raw }
  return {}
}
