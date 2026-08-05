/**
 * @neutronai/app — WHERE A TRANSCRIPT OPENS (ISSUES #505).
 *
 * The reported defect: opening a project landed at the TOP of the last message
 * instead of at the bottom of the transcript, which only shows up when that
 * message is taller than the screen — i.e. on most agent replies. The owner's
 * rule is finer than "always scroll to the bottom", and this module is that rule:
 *
 *   - unread messages exist → anchor the TOP of the FIRST unread one, so the
 *     unread run is read from its beginning;
 *   - everything is read → anchor the BOTTOM of the transcript, the resting
 *     position.
 *
 * WHAT WAS ACTUALLY WRONG, because it was not "the unread anchor fired
 * unconditionally" — there was no unread anchor at all. The surface passed
 * FlashList `maintainVisibleContentPosition.startRenderingFromBottom: true`, and
 * that prop's ONLY positioning effect on a transcript taller than the screen is
 * `initialScrollIndex = dataLength - 1`
 * (`@shopify/flash-list/src/recyclerview/RecyclerViewManager.ts:332-339`), whose
 * scroll offset is `getLayout(lastIndex).y` — the last item's TOP EDGE
 * (`recyclerview/hooks/useRecyclerViewController.tsx:596-600`). The prop is
 * documented for "chat-like interfaces when there are only few messages"
 * (`FlashListProps.ts:406-408`) and its other half — a top margin that pushes a
 * SHORT transcript down to hug the composer (`RecyclerView.tsx:597-608`) — is
 * still wanted, which is why the fix supplies an explicit `initialScrollIndex`
 * rather than dropping the prop.
 *
 * WHY THE BUG WAS HEIGHT-DEPENDENT, which is the same reason the fix works.
 * `top of last item` is only a REACHABLE scroll offset when the last item is
 * taller than the viewport; otherwise it exceeds the maximum offset and the
 * native scroll view clamps it back to the content bottom, which is why a short
 * final message has always looked correct. That clamp is verified, not assumed —
 * `react-native/React/Views/ScrollView/RCTScrollView.m:571-593` (Paper) and
 * `React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm:858-876`
 * (Fabric) both clamp a programmatic offset into the content rect unless
 * `scrollToOverflowEnabled` is set, which this surface does not set.
 *
 * READ STATE IS NOT INVENTED HERE. `ChatMessage.read_by` already exists as the
 * server-assigned set of device ids that have read a message
 * (`chat-core/types.ts:164-170`), it is merged by set-union
 * (`chat-core/store.ts:114`), patched from the server's `receipt_update`
 * (`chat-core/sync-engine.ts:125`) and PERSISTED in the mobile store
 * (`app/lib/chat-core/sqlite-store.ts:85,405,444`) — so it survives the cold open
 * a project switch performs. This module only reads it.
 */

import type { RenderRow } from './chat-render-model';

/**
 * Where the list should be positioned the first time a transcript paints.
 *
 * `unread` carries the row INDEX whose top edge goes to the top of the viewport.
 * `bottom` means the bottom of the CONTENT — not "the last row", which is the
 * distinction the whole defect lived in.
 */
export type ChatInitialAnchor =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'unread'; readonly index: number };

/**
 * How far PAST the last message's top edge the bottom anchor aims, in points.
 *
 * The bottom anchor cannot be expressed as an exact offset at mount: it is
 * `contentHeight - viewportHeight`, and neither term is known before layout has
 * measured the final message. So it is expressed as a deliberate overscroll and
 * the native clamp cited in this file's header turns it into exactly the content
 * bottom. Relying on that clamp is not a new dependency — `startRenderingFromBottom`
 * has always relied on it for the short-final-message case, which is the only
 * reason that case looked right.
 *
 * Feeding it through FlashList's own `initialScrollIndexParams.viewOffset` is
 * what makes it a SINGLE mechanism rather than a correction fighting the library:
 * `applyInitialScrollIndex` scrolls to `getLayout(index).y + viewOffset` and then
 * RE-APPLIES that same offset on a `setTimeout(…, 0)`
 * (`useRecyclerViewController.tsx:596-613`), so a `scrollToEnd` issued from a
 * layout effect would simply be undone a macrotask later. Changing the offset the
 * library itself targets means both of its applications land on the content
 * bottom, so there is nothing to fight and nothing to re-correct after paint.
 *
 * It is also why the render window stays correct: the window is seeded from
 * `getLayout(index).y` WITHOUT this offset
 * (`RecyclerViewManager.ts:381-393`), so FlashList still renders the final
 * message, and the clamped scroll position lands inside it.
 */
export const CHAT_BOTTOM_ANCHOR_OVERSCROLL_PT = 1_000_000;

/**
 * The message id a read receipt would be reported for, or `null` when the row is
 * not something this device reads.
 *
 * THE ANCHOR AND THE MARKER MUST AGREE, which is why this predicate is exported
 * and used by both. If the surface reported receipts for a narrower set of rows
 * than {@link chatInitialAnchor} treats as unread-able, the excluded rows could
 * never become read and would pin the unread anchor to the same place forever.
 * Only inbound (`agent`) rows count — a user's own message is not something they
 * read — and only once the server has assigned a `message_id`, because that is
 * the key a receipt is addressed by.
 */
export function receiptEligibleMessageId(row: RenderRow): string | null {
  if (row.kind !== 'message') return null;
  if (row.message.role !== 'agent') return null;
  return row.message.message_id;
}

/** True when `read_by` names this device. */
function isReadBySelf(read_by: readonly string[] | null | undefined, selfDeviceId: string): boolean {
  if (read_by === null || read_by === undefined) return false;
  for (const id of read_by) {
    if (id === selfDeviceId) return true;
  }
  return false;
}

/**
 * Resolve the opening position for a transcript.
 *
 * Falls back to `bottom` — the owner's stated default — whenever the read signal
 * cannot be TRUSTED, rather than guessing at an unread run. Three ways it can't:
 *
 *   1. there are no rows;
 *   2. this device's id is not known yet (`useMobileChat` seeds `selfDeviceId`
 *      as `''` until the session attaches), so nothing can be attributed to it;
 *   3. not one receipt-eligible row is read by this device.
 *
 * (3) is the load-bearing one. `read_by` is optional and additive — absent is
 * "the empty set" (`chat-core/types.ts:156-163`) — so a transcript synced before
 * receipts existed, or one whose receipts have never round-tripped to this
 * device, presents as ENTIRELY unread. Anchoring on that would open a long
 * history at its very first message: strictly worse than the bug being fixed.
 * Requiring evidence that receipts do arrive here makes the degradation land on
 * `bottom`, and `bottom` is what the owner asked for by default.
 */
export function chatInitialAnchor(
  rows: readonly RenderRow[],
  selfDeviceId: string,
): ChatInitialAnchor {
  if (rows.length === 0) return { kind: 'bottom' };
  if (selfDeviceId.length === 0) return { kind: 'bottom' };

  let firstUnread = -1;
  let sawReadBySelf = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    if (receiptEligibleMessageId(row) === null) continue;
    // Narrowed by `receiptEligibleMessageId`, but TypeScript cannot see through
    // a function boundary, so re-check the discriminant.
    if (row.kind !== 'message') continue;
    if (isReadBySelf(row.message.read_by, selfDeviceId)) {
      sawReadBySelf = true;
      continue;
    }
    if (firstUnread === -1) firstUnread = i;
  }

  if (!sawReadBySelf) return { kind: 'bottom' };
  if (firstUnread === -1) return { kind: 'bottom' };
  return { kind: 'unread', index: firstUnread };
}

/**
 * The `initialScrollIndex` / `initialScrollIndexParams` pair an anchor becomes.
 *
 * Kept next to the rule so the translation from "what the owner asked for" to
 * "what FlashList is told" is one readable step with one place to change.
 */
export function anchorScrollProps(
  anchor: ChatInitialAnchor,
  rowCount: number,
): { initialScrollIndex: number; initialScrollIndexParams?: { viewOffset: number } } {
  if (anchor.kind === 'unread') {
    // Top of the first unread row IS `getLayout(index).y`, so no offset.
    return { initialScrollIndex: anchor.index };
  }
  return {
    initialScrollIndex: Math.max(0, rowCount - 1),
    initialScrollIndexParams: { viewOffset: CHAT_BOTTOM_ANCHOR_OVERSCROLL_PT },
  };
}
