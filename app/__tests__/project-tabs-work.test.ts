/**
 * @neutronai/app — Work-tab injection tests (M1 UX REDESIGN PR-6).
 *
 * The tab registry does not emit a Work descriptor, so the mobile shell injects
 * a Work tab (after Chat) over BOTH the loading default and the fetched set.
 * These pin `ensureWorkTab` — placement, route, and idempotence — the logic the
 * layout uses to seat the live-run-badge tab.
 */

import { describe, expect, test } from 'bun:test';

import {
  ensureWorkTab,
  loadingTabsForProject,
  WORK_TAB_KEY,
  WORK_TAB_ROUTE_LEAF,
  type ResolvedTab,
} from '../lib/project-tabs';

const tab = (key: string, label = key): ResolvedTab => ({
  key,
  label,
  route: `/projects/p/${key}`,
});

describe('ensureWorkTab', () => {
  test('inserts the Work tab directly after Chat', () => {
    const out = ensureWorkTab([tab('chat', 'Chat'), tab('docs', 'Docs')], 'p');
    expect(out.map((t) => t.key)).toEqual(['chat', WORK_TAB_KEY, 'docs']);
    const work = out.find((t) => t.key === WORK_TAB_KEY)!;
    expect(work.label).toBe('Work');
    expect(work.route).toBe('/projects/p/workboard');
  });

  test('appends when there is no Chat tab', () => {
    const out = ensureWorkTab([tab('docs')], 'p');
    expect(out.map((t) => t.key)).toEqual(['docs', WORK_TAB_KEY]);
  });

  test('is idempotent — never double-inserts', () => {
    const once = ensureWorkTab([tab('chat')], 'p');
    const twice = ensureWorkTab(once, 'p');
    expect(twice.filter((t) => t.key === WORK_TAB_KEY)).toHaveLength(1);
    expect(twice.map((t) => t.key)).toEqual(once.map((t) => t.key));
  });

  test('encodes the project id into the Work route', () => {
    const out = ensureWorkTab([tab('chat')], 'a/b');
    expect(out.find((t) => t.key === WORK_TAB_KEY)!.route).toBe('/projects/a%2Fb/workboard');
  });

  test('the loading default gains exactly one Work tab, after Chat', () => {
    const out = ensureWorkTab(loadingTabsForProject('p'), 'p');
    expect(out.filter((t) => t.key === WORK_TAB_KEY)).toHaveLength(1);
    expect(out[0]!.key).toBe('chat');
    expect(out[1]!.key).toBe(WORK_TAB_KEY);
  });
});

describe('ISSUES #404 — the registry key and the route leaf are different strings', () => {
  test('the tab the GATEWAY sends is recognised, so no duplicate is injected', () => {
    // The exact live payload, captured from GET /api/app/projects/willow/tabs
    // on the running instance: four tabs, and the Work one is keyed `work_board`.
    // Before the fix `WORK_TAB_KEY` was `'workboard'` (the ROUTE LEAF), so this
    // comparison failed and a second Work tab was appended — the device showed
    // `Chat | Work | Work | Documents`.
    const fromGateway: ResolvedTab[] = [
      { key: 'chat', label: 'Chat', route: '/projects/willow/chat' },
      { key: 'work_board', label: 'Work', route: '/projects/willow/workboard' },
      { key: 'documents', label: 'Documents', route: '/projects/willow/docs' },
      { key: 'settings', label: 'Settings', route: '/projects/willow/settings' },
    ];
    const out = ensureWorkTab(fromGateway, 'willow');
    expect(out.filter((t) => t.label === 'Work')).toHaveLength(1);
    expect(out.map((t) => t.key)).toEqual(['chat', 'work_board', 'documents', 'settings']);
  });

  test('the KEY matches the gateway registry, not the route leaf', () => {
    expect(WORK_TAB_KEY).toBe('work_board');
    expect(WORK_TAB_ROUTE_LEAF).toBe('workboard');
    expect(WORK_TAB_KEY).not.toBe(WORK_TAB_ROUTE_LEAF);
  });

  test('an injected tab still ROUTES to the leaf file route', () => {
    // The key changed; the navigable route must not. `workboard.tsx` is the file.
    const out = ensureWorkTab([{ key: 'chat', label: 'Chat', route: '/projects/p/chat' }], 'p');
    const work = out.find((t) => t.key === WORK_TAB_KEY)!;
    expect(work.route).toBe('/projects/p/workboard');
  });

  test('the live-run badge is keyed so it lands on the REAL tab', () => {
    // `tabBadges` is built with WORK_TAB_KEY and ProjectTabBar looks up by
    // tab.key, so a mismatch here silently attaches the badge to nothing.
    const out = ensureWorkTab(
      [
        { key: 'chat', label: 'Chat', route: '/projects/p/chat' },
        { key: 'work_board', label: 'Work', route: '/projects/p/workboard' },
      ],
      'p',
    );
    const badges = new Map([[WORK_TAB_KEY, 3]]);
    const work = out.find((t) => t.key === 'work_board')!;
    expect(badges.get(work.key)).toBe(3);
  });
});
