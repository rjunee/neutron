/**
 * @neutronai/app — the rail's ORDER.
 *
 * Owner request, on device: *"Make sure projects with new messages move to the top
 * of the rail, and have some kind of notification dot with unread message count."*
 *
 * The list is a column of ~44px rows and the rail scrolls, so anything unread that
 * sorts below the fold is a message the owner never learns about — which is the
 * whole reason a count exists. Every chat app he uses (Telegram, iMessage, Slack)
 * floats the thing with something new in it, so this is the expected idiom rather
 * than a novel one.
 *
 * ── WHY A STABLE PARTITION AND NOT A SORT BY RECENCY ─────────────────────────
 *
 * The obvious implementation ranks by `last_activity_at`, which would reshuffle the
 * whole rail every time any project ticks — including the READ ones, where nothing
 * changed for the owner. Rows he has learned the position of would wander for
 * reasons invisible to him.
 *
 * So this is a stable two-way partition: everything unread, in its existing relative
 * order, then everything read, in its existing relative order. A project moves for
 * exactly one reason — it went from read to unread, or back — and nothing else in the
 * column moves except by displacement. That keeps the rail's spatial memory intact,
 * which matters more here than on a full-width chat list because the rail is the
 * app's primary navigation.
 *
 * ── THE ACTIVE PROJECT IS PINNED WHERE IT IS ──────────────────────────────────
 *
 * A row cannot move out from under the thumb that is pressing it. The rail already
 * carries a regression test for taps landing on the tapped project
 * (`rail-tap-lands-on-the-tapped-project.test.tsx`) because that class of bug is
 * both easy to introduce and infuriating. Reordering is a new way to cause it: a
 * message arriving in another project between the touch-down and the touch-up would
 * slide rows under a finger already in motion.
 *
 * The narrow, honest mitigation: the ACTIVE project holds its slot. Its unread is
 * zero by definition (opening it clears it), so under the partition it would sit
 * with the read group anyway — pinning it means the row the owner is standing on is
 * the one row guaranteed not to move. Everything else may float, which is what he
 * asked for.
 */

/** The ordering only needs these two fields — deliberately narrower than the view. */
export interface RailOrderable {
  id: string;
  unread_count: number;
}

/**
 * Order the rail: unread first, then read, each group keeping its incoming relative
 * order, with the active project held in its original slot.
 *
 * Returns a NEW array; the input is never mutated (it comes from a store and a
 * mutation would be an invisible write to shared state).
 */
export function orderRailProjects<T extends RailOrderable>(
  projects: readonly T[],
  activeProjectId: string,
): T[] {
  // The active row's slot is reserved by index, so it is restored to the exact
  // position it held rather than to "roughly the top" — a project at index 5 that
  // slid to 0 while the owner was reading it would be just as disorienting.
  const activeIndex = projects.findIndex((p) => p.id === activeProjectId);
  const movable = projects.filter((p) => p.id !== activeProjectId);

  const unread: T[] = [];
  const read: T[] = [];
  for (const p of movable) {
    // `> 0` rather than truthiness: a count is a number and a NaN from a bad payload
    // must land in `read`, not float a row the owner cannot act on to the top.
    if (p.unread_count > 0) unread.push(p);
    else read.push(p);
  }

  const ordered = [...unread, ...read];
  if (activeIndex === -1) return ordered;
  const active = projects[activeIndex];
  if (active === undefined) return ordered;
  ordered.splice(activeIndex, 0, active);
  return ordered;
}

/**
 * What the badge shows. Capped, because the glyph is ~24px wide and a four-digit
 * count would either overflow the row or shrink the type below legibility — and
 * past a couple of dozen the exact number stops informing a decision anyway.
 */
export const RAIL_BADGE_CAP = 99;

/** `null` when there is nothing to show, so the caller renders no badge at all. */
export function railBadgeLabel(unread_count: number): string | null {
  if (!(unread_count > 0)) return null;
  return unread_count > RAIL_BADGE_CAP ? `${RAIL_BADGE_CAP}+` : String(unread_count);
}
