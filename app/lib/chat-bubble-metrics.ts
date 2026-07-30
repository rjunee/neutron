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
