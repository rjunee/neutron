/**
 * @neutronai/app — a rail project AT REST paints nothing (device defect,
 * 2026-07-31).
 *
 * WAVE 3.5 made the corner dot the Activity Inspector's entry point, and to keep
 * it reachable it gave `idle` a visible resting state: a hollow muted ring. On a
 * 72px rail with every project stacked in a column, that is a grey circle on
 * every single row, permanently — the rail read as a wall of state at exactly the
 * moment nothing was happening. Ryan on device: "remove that ugly grey hollow
 * circle on every project in the rail. the pulsing dot should only show up if
 * there's activity, otherwise nothing shows. that area can still be tappable for
 * the inspector even if nothing visible. its an 'advanced' feature."
 *
 * The trap this file guards is that the obvious implementation of "show nothing"
 * — return null from the dot — ALSO deletes the box the inspector's touch target
 * is sized from, silently unshipping a working feature that, being invisible by
 * design, nobody would notice was gone. So the contract has three halves and all
 * three are asserted here: nothing is painted, the box is still there, and the
 * tap still opens the inspector while nothing is painted.
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
  {
    id: GENERAL_PROJECT_ID,
    name: 'General',
    emoji: '💬',
    unread_count: 0,
    origin_instance: 'local' as const,
  },
  { id: 'willow', name: 'Willow', emoji: '🔷', unread_count: 0, origin_instance: 'local' as const },
  { id: 'acme', name: 'Acme', emoji: '🔶', unread_count: 0, origin_instance: 'local' as const },
  { id: 'birch', name: 'Birch', emoji: '🟣', unread_count: 0, origin_instance: 'local' as const },
];

let opened: string[] = [];
let selected: string[] = [];

beforeEach(() => {
  opened = [];
  selected = [];
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

/** `willow` is working, `acme` needs attention; General + `birch` are at rest. */
async function mountRail(
  activeProjectId: string,
  overlay: readonly [string, 'idle' | 'working' | 'attention'][] = [
    ['willow', 'working'],
    ['acme', 'attention'],
    ['birch', 'idle'],
  ],
) {
  return mountScreen(
    createElement(ProjectRail, {
      projects: PROJECTS,
      overlay: new Map(overlay.map(([id, activity]) => [id, { activity, live_runs: 0 }])),
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

describe('a rail row with no activity', () => {
  it('draws no dot at all — the hollow resting ring is gone', async () => {
    const screen = await mountRail('willow');

    // The removed thing, named: nothing in the tree renders the old idle ring.
    expect(screen.byTestId('rail-dot-idle')).toBeNull();
    // And nothing is painted in its place either. Four rows, two of them busy ⇒
    // exactly two painted dots in the whole rail.
    expect(paintedDots(screen.host)).toEqual(['rail-dot-work', 'rail-dot-attention']);

    // Not by testID alone: the box that holds the corner open must carry no
    // paint whatsoever. "Make it very subtle instead" is the likeliest way this
    // comes back, and a dimmed ring would still satisfy every assertion above.
    for (const slot of Array.from(
      screen.host.querySelectorAll('[data-testid="rail-dot-none"]'),
    )) {
      const paint = paintOf(slot as HTMLElement);
      expect(isUnpainted(paint.background)).toBe(true);
      expect(paint.borderWidth).toBe('0px');
    }

    screen.unmount();
  });

  it('still paints the dot the moment there IS activity', async () => {
    const screen = await mountRail('willow');

    const work = screen.byTestId('rail-dot-work');
    const attention = screen.byTestId('rail-dot-attention');
    expect(work).not.toBeNull();
    expect(attention).not.toBeNull();
    // Proves the emptiness check above is not vacuous: read through the same
    // helper, a real dot comes back painted.
    expect(isUnpainted(paintOf(work!).background)).toBe(false);
    expect(isUnpainted(paintOf(attention!).background)).toBe(false);

    screen.unmount();
  });

  it('keeps the corner box open, so rows do not shift when a dot lights up', async () => {
    // Two mounts of the SAME rail, differing only in whether `birch` is working.
    // If the invisible state collapsed the layout, these would not agree.
    const resting = await mountRail('willow');
    const restingBox = resting.byTestId('rail-dot-none');
    expect(restingBox).not.toBeNull();
    const restingGeometry = boxOf(restingBox!);
    resting.unmount();

    const busy = await mountRail('willow', [
      ['willow', 'working'],
      ['acme', 'attention'],
      ['birch', 'working'],
    ]);
    const painted = busy.host.querySelectorAll('[data-testid="rail-dot-work"]')[0] as HTMLElement;
    expect(painted).toBeDefined();
    expect(boxOf(painted)).toEqual(restingGeometry);
    busy.unmount();
  });

  it('is EVERY resting row, not just some', async () => {
    const screen = await mountRail('willow', []);

    // No overlay at all ⇒ every project is idle ⇒ four invisible slots, no paint.
    expect(screen.host.querySelectorAll('[data-testid="rail-dot-none"]').length).toBe(
      PROJECTS.length,
    );
    expect(screen.byTestId('rail-dot-work')).toBeNull();
    expect(screen.byTestId('rail-dot-attention')).toBeNull();

    screen.unmount();
  });
});

describe('the invisible corner is still the Activity Inspector', () => {
  it('opens the inspector from an active row that is painting nothing', async () => {
    // `birch` is idle AND active: nothing is drawn in its corner, and that corner
    // still has to work. This is the whole "advanced affordance" the owner asked
    // for — invisible, deliberately undiscoverable, and functional.
    const screen = await mountRail('birch');

    expect(screen.byTestId('rail-dot-none')).not.toBeNull();
    expect(screen.byTestId('rail-dot-press-birch')).not.toBeNull();

    await screen.press('Show activity for Birch');

    expect(opened).toEqual(['birch']);
    // ...and it did NOT double as a project switch.
    expect(selected).toEqual([]);

    screen.unmount();
  });

  it('leaves the inactive rows inert, painted or not (the misclick fix holds)', async () => {
    const screen = await mountRail('birch');

    expect(screen.byTestId('rail-dot-press-willow')).toBeNull();
    expect(screen.byTestId(`rail-dot-press-${GENERAL_PROJECT_ID}`)).toBeNull();

    // An idle inactive row is now invisible; tapping it must still switch, and
    // must not have quietly become a dead zone.
    await screen.press('Open General');
    expect(selected).toEqual([GENERAL_PROJECT_ID]);
    expect(opened).toEqual([]);

    screen.unmount();
  });
});

/**
 * Every dot the rail actually PAINTS, in tree order — the invisible resting slot
 * and the (unpainted) press wrapper are not dots, they are geometry.
 */
function paintedDots(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('[data-testid^="rail-dot-"]'))
    .map((el) => el.getAttribute('data-testid') ?? '')
    .filter((id) => id !== 'rail-dot-none' && !id.startsWith('rail-dot-press-'));
}

/**
 * The rendered box of a node, as react-native-web expresses it. The harness is
 * DOM-backed with no layout engine, so this reads the style the component asked
 * for rather than a measured rect — enough to catch a collapsed corner, and
 * honest about not being a device measurement.
 */
function boxOf(el: HTMLElement): { width: string; height: string } {
  const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
  return { width: computed.width, height: computed.height };
}

/** What a node actually puts on screen: its fill and its ring. */
function paintOf(el: HTMLElement): { background: string; borderWidth: string } {
  const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
  return { background: computed.backgroundColor, borderWidth: computed.borderTopWidth };
}

/** Fully transparent, however the style engine happens to spell it. */
function isUnpainted(background: string): boolean {
  if (background === '' || background === 'transparent') return true;
  const alpha = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(background);
  return alpha !== null && Number(alpha[1]) === 0;
}
