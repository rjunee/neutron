/**
 * @neutronai/app — the ONE chat-bubble width cap (mobile defect, 2026-07-29).
 *
 * WHY A MODULE FOR ONE NUMBER. `ChatSyncSurface` had TWO percentage `maxWidth`
 * declarations in a single ancestor chain — `bubbleColumn: { maxWidth: '82%' }`
 * wrapping `bubble: { maxWidth: '82%' }` — and Yoga MULTIPLIES them. Yoga clamps
 * a node's `availableInnerWidth` by its own resolved `maxWidth`
 * (`react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:519-527`)
 * and then passes that clamped value down as the child's `ownerWidth` for
 * percentage resolution (`CalculateLayout.cpp:1397-1404`, `:595-598`). So the
 * effective cap was 0.82 x 0.82 = 67% of the row, not 82%, and on device a
 * bubble wrapped after roughly five words. The tell was already visible in the
 * file: the streaming bubble and the typing indicator render `styles.bubble`
 * WITHOUT `bubbleColumn`, so they were visibly WIDER than the settled bubble a
 * streaming row turns into.
 *
 * Owning the number here means there is exactly one place to read it from and a
 * test can pin both the value and the sizing rationale. Every bubble-bearing row
 * now goes through `bubbleColumn`, and `bubbleColumn` is the only node in the
 * chain that carries a cap.
 *
 * WHY 90% AND NOT THE PHONE-CHAT-TYPICAL ~78%. The usual iMessage/Telegram cap
 * is a fraction of the FULL screen. This app is not that shape: `ProjectRail` is
 * a PERMANENT 72pt column and the transcript adds a `SPACING.md` gutter on each
 * side, so a percentage here applies to what is left over, which is already
 * narrower than an iMessage bubble is allowed to be:
 *
 *   iPhone 15 (393pt)  ->  393 - 72 (rail) - 24 (list gutters) = 297pt row
 *   iMessage's ~78% of 393pt                                   = 307pt
 *
 * The row is narrower than the bubble cap we would be imitating, so scaling it
 * down again is the wrong move. What still has to survive is the SPEAKER
 * ASYMMETRY: a user bubble must visibly not reach the left edge and an agent
 * bubble must visibly not reach the right, otherwise both sides read as
 * full-width blocks and the left/right distinction is gone. That needs a
 * reliably visible gutter, not a small percentage. 90% leaves ~30pt on a 393pt
 * phone (~= SPACING.xxl, and never below ~26pt on the smallest supported phone),
 * which is unmistakable, while giving the bubble 267pt instead of the 200pt the
 * doubled cap produced.
 */

import { THEME } from './theme';

/**
 * The ONE cap, as a number, for arithmetic + assertions.
 *
 * Applied to `bubbleColumn` ONLY. Adding a second percentage `maxWidth` anywhere
 * between `bubbleWrap` and the bubble's text re-creates the multiply bug — the
 * structural half of `__tests__/chat-bubble-width.test.ts` fails if you do.
 */
export const BUBBLE_MAX_WIDTH_PCT = 90;

/** The same cap in the form a React Native style needs. */
export const BUBBLE_MAX_WIDTH: `${number}%` = `${BUBBLE_MAX_WIDTH_PCT}%`;

/**
 * The permanent project rail's width, mirrored from `components/ProjectRail.tsx`
 * (`RAIL_WIDTH`). NOT imported from there on purpose: that module pulls in
 * `react-native`, and this one has to stay a dependency-free leaf so the width
 * arithmetic is unit-testable. The test cross-checks this against the rail's
 * source so the two cannot drift.
 */
export const RAIL_WIDTH_PT = 72;

/**
 * The width available to a bubble ROW: the screen minus the permanent rail and
 * the transcript's horizontal gutters (`listContent.paddingHorizontal`, both
 * sides). This is what `BUBBLE_MAX_WIDTH` is a percentage OF.
 */
export function bubbleRowWidthPt(opts: {
  screen_width: number;
  /** `listContent.paddingHorizontal` — counted on both sides. */
  list_gutter: number;
  /** Pass 0 for a surface with no rail (web wide layout). */
  rail_width?: number;
}): number {
  const rail = opts.rail_width ?? RAIL_WIDTH_PT;
  return Math.max(0, opts.screen_width - rail - opts.list_gutter * 2);
}

/** The widest a bubble may render, in points, for a given row width. */
export function bubbleMaxWidthPt(row_width: number): number {
  return (row_width * BUBBLE_MAX_WIDTH_PCT) / 100;
}

/**
 * The gutter left on the far side of a full-width bubble — the gap that carries
 * the left/right speaker distinction. If this ever goes small the two sides stop
 * reading as different speakers.
 */
export function bubbleOppositeGutterPt(row_width: number): number {
  return row_width - bubbleMaxWidthPt(row_width);
}

/* ────────────────────────────────────────────────────────────────────────────
 * iMessage BUBBLE GEOMETRY (mobile defect 2026-07-30).
 *
 * Ryan, three times: *"make the UX of the chat screen look EXACTLY the same as
 * imessage"*, and specifically *"too much padding at the bottom of each message
 * bubble"*. The surface was on a uniform `marginVertical: 4` (so 8pt between
 * EVERY pair of bubbles, whoever sent them) plus an 8pt vertical bubble padding
 * plus a delivery-tick row rendered INSIDE the bubble on every single outgoing
 * message. Three separate sources of bottom space, none of them iMessage's.
 *
 * iMessage's actual rhythm: bubbles from the same sender are all but touching,
 * and the visible break in the transcript is the SENDER CHANGE. Everything below
 * is the geometry that produces that rhythm, owned here for the same reason the
 * width cap is — one place to read it from, one place a test can pin.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Who a row is from. `null` = there is no previous row (top of the list). */
export type BubbleSpeaker = 'user' | 'agent';

/**
 * Vertical space above a bubble when the PREVIOUS bubble was from the same
 * sender. iMessage stacks a run this tightly — the bubbles read as one utterance
 * broken across lines, not as separate turns.
 */
export const BUBBLE_GAP_SAME_SENDER_PT = 2;

/**
 * Vertical space above a bubble when the speaker CHANGED. This is the only gap
 * in an iMessage transcript that the eye actually registers, so it has to be
 * several times the same-sender gap or the conversation turns into a wall.
 */
export const BUBBLE_GAP_SENDER_CHANGE_PT = 8;

/** Horizontal text inset inside a bubble. */
export const BUBBLE_PADDING_H_PT = 12;

/**
 * Vertical text inset inside a bubble. iMessage is TIGHT here: the bubble hugs
 * the line box. This was 8 (`SPACING.sm`), which with a 22pt line height read as
 * a visibly padded box rather than a speech bubble.
 */
export const BUBBLE_PADDING_V_PT = 6;

/** Bubble corner radius on the three non-tail corners. */
export const BUBBLE_RADIUS_PT = 18;

/**
 * The TAIL corner's radius — the bottom corner on the speaker's own side. In
 * iMessage only the LAST bubble of a same-sender run has a tail; the ones above
 * it are fully rounded. {@link bubbleHasTail} decides which.
 */
export const BUBBLE_TAIL_RADIUS_PT = 4;

/**
 * The gap above a bubble, given who sent the one before it.
 *
 * `null` previous = the first row: no leading gap at all (the list's own
 * `paddingVertical` already provides the breathing room at the very top, and
 * adding a sender-change gap there double-spaces the transcript's head).
 */
export function bubbleGapPt(previous: BubbleSpeaker | null, current: BubbleSpeaker): number {
  if (previous === null) return 0;
  return previous === current ? BUBBLE_GAP_SAME_SENDER_PT : BUBBLE_GAP_SENDER_CHANGE_PT;
}

/**
 * Does this bubble get the tail corner? Only the LAST bubble of a same-sender
 * run does, exactly as iMessage draws it. `null` next = the newest row, which is
 * always the end of its run.
 */
export function bubbleHasTail(current: BubbleSpeaker, next: BubbleSpeaker | null): boolean {
  return next === null || next !== current;
}

/**
 * A bubble's two colours: the fill it is painted with, and the colour its own
 * content is drawn in.
 *
 * WHY THIS PAIR HAS TO BE NAMED. Most bubble content only needs the foreground —
 * `userText` sets a colour and stops. A voice note needs BOTH, because iMessage
 * draws its play control as the bubble's foreground colour with the triangle
 * KNOCKED OUT of it in the bubble's own fill (measured off Apple's asset; see
 * `components/VoiceNoteBubble.tsx`). A control that only knows the foreground
 * has to invent the other half, and the way it used to invent it was by drawing
 * its own opaque panel — the nested box the owner asked to be rid of.
 *
 * It lives here rather than in the component because this module is already the
 * one place a bubble's facts are stated, and `ChatSyncSurface` paints its
 * bubbles FROM these constants, so the player's idea of what it is sitting on
 * cannot drift from what was actually drawn.
 */
export interface BubbleTone {
  /** The bubble's fill. Content knocked out of the foreground reads in this. */
  ground: string;
  /** The colour the bubble's own content is drawn in. */
  ink: string;
}

/** The owner's own bubble: a filled accent capsule with dark content. */
export const USER_BUBBLE_TONE: BubbleTone = Object.freeze({
  ground: THEME.accent,
  ink: THEME.background,
});

/** The agent's bubble: a raised dark surface with light content. */
export const AGENT_BUBBLE_TONE: BubbleTone = Object.freeze({
  ground: THEME.surface_raised,
  ink: THEME.text_primary,
});
