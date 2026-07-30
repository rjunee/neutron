/**
 * @neutronai/app — mobile project-rail view helper tests (M1 UX REDESIGN PR-6).
 *
 * Convention note (matching `project-card-interactivity.test.ts`): the app's
 * bun:test suite does NOT mount React Native. This pins the PURE decisions that
 * drive the rail's activity dot + the Work-tab live-run badge — the logic
 * `ProjectRail` / `ProjectTabBar` render from — so component + test can't drift.
 */

import { describe, expect, test } from 'bun:test';

import { railDotKind, workTabBadgeCount, type ProjectActivity } from '../lib/project-rail-view';

describe('railDotKind', () => {
  test('working → the pulsing work dot', () => {
    expect(railDotKind('working', false)).toBe('work');
  });

  test('attention → the static attention dot (wins over working semantics)', () => {
    expect(railDotKind('attention', false)).toBe('attention');
  });

  // BEHAVIOUR CHANGE, not a relaxed assertion (SPEC § WAVE 3.5). These two cases
  // previously asserted `null` — no dot for an idle scope, and no dot for General.
  // The dot is now the ACTIVITY INSPECTOR's entry point and the acceptance is
  // explicit that it stays tappable when idle, because an idle session must be
  // distinguishable from a wedged one. A dot that vanishes at rest cannot be tapped
  // to learn which of the two you are looking at. So `railDotKind` is now total, and
  // the assertions below pin the NEW contract, including the part of the old one that
  // still holds (General never shows ATTENTION — it has no bound runs).
  test('idle / absent → the quiet idle dot (present so it stays tappable)', () => {
    expect(railDotKind('idle', false)).toBe('idle');
    expect(railDotKind(undefined, false)).toBe('idle');
  });

  test('General gets a dot too — it is a real chat scope with its own session', () => {
    expect(railDotKind('working', true)).toBe('work');
    expect(railDotKind('idle', true)).toBe('idle');
  });

  test('General still never shows ATTENTION (no bound runs) — it degrades to idle', () => {
    expect(railDotKind('attention', true)).toBe('idle');
  });

  test('is TOTAL — never null, so every rail row has a tappable entry point', () => {
    for (const a of ['idle', 'working', 'attention', undefined] as const) {
      for (const g of [true, false]) {
        expect(railDotKind(a, g)).not.toBeNull();
      }
    }
  });

  // PARITY with web `railDotClass` (`landing/chat-react/ChatApp.tsx`). The two are
  // deliberate mirrors, but the layering gate forbids importing across the app →
  // landing package boundary, so parity is pinned by asserting the SAME truth table
  // on both sides. The identical table lives in
  // `landing/chat-react/__tests__/component.test.tsx` ("matches the shared rail-dot
  // truth table"); change one and you must change the other, which is exactly the
  // drift this makes visible.
  test('matches the shared rail-dot truth table (web asserts the same one)', () => {
    const TABLE: Array<
      [ProjectActivity | undefined, boolean, 'work' | 'attention' | 'idle']
    > = [
      ['working', false, 'work'],
      ['working', true, 'work'],
      ['attention', false, 'attention'],
      ['attention', true, 'idle'],
      ['idle', false, 'idle'],
      ['idle', true, 'idle'],
      [undefined, false, 'idle'],
      [undefined, true, 'idle'],
    ];
    for (const [activity, isGeneral, expected] of TABLE) {
      expect(railDotKind(activity, isGeneral)).toBe(expected);
    }
  });
});

describe('workTabBadgeCount', () => {
  test('a positive live-run count renders', () => {
    expect(workTabBadgeCount(2)).toBe(2);
  });

  test('0 / absent / non-finite → no badge (never a fabricated 0)', () => {
    expect(workTabBadgeCount(0)).toBeNull();
    expect(workTabBadgeCount(undefined)).toBeNull();
    expect(workTabBadgeCount(Number.NaN)).toBeNull();
  });

  test('a fractional / negative wire value is coerced to a clean count', () => {
    expect(workTabBadgeCount(3.9)).toBe(3);
    expect(workTabBadgeCount(-1)).toBeNull();
  });
});
