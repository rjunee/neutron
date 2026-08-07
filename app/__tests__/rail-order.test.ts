/**
 * The rail's order, and the badge label.
 *
 * The properties worth pinning are the ones where a plausible implementation is
 * wrong in a way the owner would feel but not be able to name:
 *
 *   - unread floats, but WITHOUT reshuffling anything else. A recency sort passes
 *     "unread is first" and still fails the owner, because his read projects wander
 *     for reasons he cannot see.
 *   - the ACTIVE row does not move. It is the row under his thumb.
 *   - a count is a number, so a NaN must not float a row he cannot act on.
 */
import { describe, expect, test } from 'bun:test';

import { orderRailProjects, railBadgeLabel, RAIL_BADGE_CAP } from '../lib/rail-order';

interface P {
  id: string;
  unread_count: number;
}

const p = (id: string, unread_count = 0): P => ({ id, unread_count });
const ids = (list: readonly P[]): string[] => list.map((x) => x.id);

describe('orderRailProjects', () => {
  test('an unread project floats above the read ones', () => {
    const out = orderRailProjects([p('general'), p('alpha'), p('beta', 3)], 'nothing-open');
    expect(ids(out)).toEqual(['beta', 'general', 'alpha']);
  });

  test('READ projects keep their relative order — the anti-reshuffle property', () => {
    // A recency sort would also put 'd' first and would ALSO scramble a/b/c, which is
    // the failure this asserts against: nothing moves except by displacement.
    const out = orderRailProjects([p('a'), p('b'), p('c'), p('d', 1)], 'nothing-open');
    expect(ids(out)).toEqual(['d', 'a', 'b', 'c']);
  });

  test('several unread keep their relative order too', () => {
    const out = orderRailProjects([p('a', 2), p('b'), p('c', 9), p('d')], 'nothing-open');
    expect(ids(out)).toEqual(['a', 'c', 'b', 'd']);
  });

  test('the ACTIVE project holds its EXACT slot, not roughly the top', () => {
    // 'c' is active at index 2. Two unread rows float, and 'c' must come back to
    // index 2 — a row that slid to the top while being read is just as disorienting
    // as one that slid down.
    const out = orderRailProjects([p('a'), p('b', 1), p('c'), p('d', 1)], 'c');
    expect(out[2]?.id).toBe('c');
    expect(ids(out)).toEqual(['b', 'd', 'c', 'a']);
  });

  test('an active project that is somehow unread still does not move', () => {
    // Defensive: opening a project clears its count, so this state is transient at
    // most. It must not be the one case where the row under the thumb jumps.
    const out = orderRailProjects([p('a'), p('b', 4)], 'b');
    expect(out[1]?.id).toBe('b');
  });

  test('an unknown active id is not invented into the list', () => {
    const out = orderRailProjects([p('a'), p('b', 1)], 'deleted-project');
    expect(ids(out)).toEqual(['b', 'a']);
    expect(out).toHaveLength(2);
  });

  test('a NaN count sorts as READ, never floated', () => {
    const out = orderRailProjects([p('a'), { id: 'bad', unread_count: NaN }], 'nothing-open');
    expect(ids(out)).toEqual(['a', 'bad']);
  });

  test('the input array is never mutated', () => {
    const input = [p('a'), p('b', 1)];
    const snapshot = ids(input);
    orderRailProjects(input, 'a');
    expect(ids(input)).toEqual(snapshot);
  });

  test('an empty rail is an empty rail', () => {
    expect(orderRailProjects([], 'general')).toEqual([]);
  });
});

describe('railBadgeLabel', () => {
  test('nothing unread renders NO badge, not a zero', () => {
    expect(railBadgeLabel(0)).toBeNull();
    expect(railBadgeLabel(NaN)).toBeNull();
    expect(railBadgeLabel(-1)).toBeNull();
  });

  test('a small count is the number itself', () => {
    expect(railBadgeLabel(1)).toBe('1');
    expect(railBadgeLabel(42)).toBe('42');
  });

  test('the cap is inclusive, and above it reads as more', () => {
    expect(railBadgeLabel(RAIL_BADGE_CAP)).toBe('99');
    expect(railBadgeLabel(RAIL_BADGE_CAP + 1)).toBe('99+');
    expect(railBadgeLabel(5000)).toBe('99+');
  });
});
