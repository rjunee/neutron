/**
 * @neutronai/app — mobile project-rail view helper tests (M1 UX REDESIGN PR-6).
 *
 * Convention note (matching `project-card-interactivity.test.ts`): the app's
 * bun:test suite does NOT mount React Native. This pins the PURE decisions that
 * drive the rail's activity dot + the Work-tab live-run badge — the logic
 * `ProjectRail` / `ProjectTabBar` render from — so component + test can't drift.
 */

import { describe, expect, test } from 'bun:test';

import { railDotKind, workTabBadgeCount } from '../lib/project-rail-view';

describe('railDotKind', () => {
  test('working → the pulsing work dot', () => {
    expect(railDotKind('working', false)).toBe('work');
  });

  test('attention → the static attention dot (wins over working semantics)', () => {
    expect(railDotKind('attention', false)).toBe('attention');
  });

  test('idle / absent → no dot', () => {
    expect(railDotKind('idle', false)).toBeNull();
    expect(railDotKind(undefined, false)).toBeNull();
  });

  test('General never shows a dot, whatever the activity', () => {
    expect(railDotKind('working', true)).toBeNull();
    expect(railDotKind('attention', true)).toBeNull();
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
