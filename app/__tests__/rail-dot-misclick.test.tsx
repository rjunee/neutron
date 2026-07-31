/**
 * @neutronai/app — the activity dot must not eat a project switch
 * (device defect, 2026-07-30).
 *
 * Ryan on device, 2026-07-30: "The indicator light being tappable is too easy to
 * misclick when trying to switch to another project. One idea is to make it only
 * work if the project is currently active."
 *
 * The dot is 10px inside a ~44px rail row and carried `hitSlop={10}`, so its
 * responder covered roughly a third of every row — and React Native resolves a
 * touch to the DEEPEST responder, so a thumb aimed at a project opened the
 * Activity Inspector for it instead of switching to it. The fix is not a smaller
 * target (that just makes the inspector unreachable); it is that only the row the
 * owner is ALREADY on carries a responder at all. Nothing can be mis-navigated to
 * from the row you are standing in, so the active dot keeps its generous slop.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { ProjectRail } = await import('../components/ProjectRail');
const { GENERAL_PROJECT_ID } = await import('../lib/project-rail-view');

const PROJECTS = [
  { id: GENERAL_PROJECT_ID, name: 'General', emoji: '💬', unread_count: 0, origin_instance: 'local' as const },
  { id: 'willow', name: 'Willow', emoji: '🔷', unread_count: 0, origin_instance: 'local' as const },
  { id: 'acme', name: 'Acme', emoji: '🔶', unread_count: 0, origin_instance: 'local' as const },
];

let selected: string[] = [];
let opened: string[] = [];

beforeEach(() => {
  selected = [];
  opened = [];
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

async function mountRail(activeProjectId: string) {
  return mountScreen(
    createElement(ProjectRail, {
      projects: PROJECTS,
      overlay: new Map([
        ['willow', { activity: 'working' as const, live_runs: 0 }],
        ['acme', { activity: 'attention' as const, live_runs: 0 }],
      ]),
      activeProjectId,
      onSelect: (id: string) => {
        selected.push(id);
      },
      onCreate: () => undefined,
      onOpenActivity: (id: string) => {
        opened.push(id);
      },
      reduceMotionOverride: true,
    }),
  );
}

describe('the rail activity dot', () => {
  it('is a touch target ONLY on the currently-active project', async () => {
    const screen = await mountRail('willow');

    expect(screen.byTestId('rail-dot-press-willow')).not.toBeNull();
    expect(screen.byTestId('rail-dot-press-acme')).toBeNull();
    expect(screen.byTestId(`rail-dot-press-${GENERAL_PROJECT_ID}`)).toBeNull();

    screen.unmount();
  });

  it('still PAINTS the dot on inactive rows — inert, not removed', async () => {
    const screen = await mountRail('willow');
    // `acme` is inactive and carries `attention`; its dot must still be visible,
    // it simply must not be tappable. (Losing the dot would lose the at-a-glance
    // rail state this whole affordance is attached to.) Note the deliberate
    // choice of an ACTIVE state here: a row at REST paints nothing at all as of
    // 2026-07-31 — see `rail-idle-dot-not-painted.test.tsx` — so "inert, not
    // removed" is a claim about a dot that has something to say, and only that.
    expect(screen.byTestId('rail-dot-attention')).not.toBeNull();
    expect(screen.byTestId('rail-dot-press-acme')).toBeNull();
    screen.unmount();
  });

  it('opens the inspector from the ACTIVE row, without also switching project', async () => {
    const screen = await mountRail('willow');

    await screen.press('Show activity for Willow');

    expect(opened).toEqual(['willow']);
    expect(selected).toEqual([]);
    screen.unmount();
  });

  it('an inactive row has no activity control to misfire on', async () => {
    const screen = await mountRail('willow');

    await expect(screen.press('Show activity for Acme')).rejects.toThrow(
      /no control labelled "Show activity for Acme"/,
    );
    screen.unmount();
  });

  it('tapping an inactive row switches project', async () => {
    const screen = await mountRail('willow');

    await screen.press('Open Acme');

    expect(selected).toEqual(['acme']);
    expect(opened).toEqual([]);
    screen.unmount();
  });

  it('moves the affordance with the selection', async () => {
    const screen = await mountRail('acme');

    expect(screen.byTestId('rail-dot-press-acme')).not.toBeNull();
    expect(screen.byTestId('rail-dot-press-willow')).toBeNull();
    screen.unmount();
  });
});
