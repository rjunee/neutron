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
