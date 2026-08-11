/**
 * @neutronai/app — the PRODUCTION rail floats unread rows and paints the count.
 *
 * `rail-order.test.ts` pins the pure function. This file exists because a pure
 * function nobody calls is the repo's signature defect: the ordering could be
 * perfect and the rail could still render `projects` in the order it was handed.
 * So every assertion here reads the rendered tree of the real `ProjectRail`.
 *
 * The three owner asks it covers, from his on-device report:
 *
 *   1. *"Make sure projects with new messages move to the top of the rail"*
 *   2. *"have some kind of notification dot with unread message count"*
 *   3. *"Make the highlight color of the currently selected project much more
 *      obvious. it's VERY hard to see what project is selected"*
 *
 * (3) is the one worth being careful about, because "more obvious" is not a thing
 * a test can assert directly. What IS assertable is the mechanism the change
 * relies on: selection is carried by HUE now, not by another neutral elevation
 * step, so the selected fill must NOT equal `surface_raised` — the value that made
 * it invisible. A future edit that reverts to a neutral passes a naive
 * "has a background" check and fails this one.
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
// Mounted without a ThemeProvider, so these render with the context's dark
// fallback — the palette to assert against is DARK_THEME by name.
const { DARK_THEME: THEME } = await import('../lib/theme');

interface Fixture {
  id: string;
  name: string;
  emoji: string;
  unread_count: number;
  origin_instance: 'local';
}

const project = (id: string, name: string, unread_count = 0): Fixture => ({
  id,
  name,
  emoji: '🔷',
  unread_count,
  origin_instance: 'local',
});

let selected: string[] = [];

beforeEach(() => {
  selected = [];
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

async function mountRail(projects: readonly Fixture[], activeProjectId: string) {
  return mountScreen(
    createElement(ProjectRail, {
      projects,
      overlay: new Map(),
      activeProjectId,
      onSelect: (id: string) => {
        selected.push(id);
      },
      onCreate: () => undefined,
      onOpenActivity: () => undefined,
      reduceMotionOverride: true,
    }),
  );
}

/**
 * Paint, read through `getComputedStyle` rather than `el.style`.
 * react-native-web resolves a StyleSheet into CSS CLASSES, so an inline-style read
 * returns '' for a colour that is in fact applied — a false negative that would make
 * these assertions pass for the wrong reason. Same helper shape as
 * `rail-idle-dot-not-painted.test.tsx`.
 */
function paintOf(el: HTMLElement): { background: string; borderWidth: string } {
  const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
  return { background: computed.backgroundColor, borderWidth: computed.borderTopWidth };
}

/**
 * '#1b3557', 'rgb(27, 53, 87)' and 'rgba(27, 53, 87, 1.00)' are the same paint. The
 * style engine picks its own spelling, so compare the TRIPLE and never the string —
 * a string compare here fails on a correct colour, which is the kind of red that
 * gets a real assertion deleted.
 */
function triple(color: string): string {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color);
  return m === null ? color : `${Number(m[1])},${Number(m[2])},${Number(m[3])}`;
}

/** The rail's project rows, top to bottom, as ids — read off the rendered tree. */
function renderedOrder(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('[data-testid^="rail-item-"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('rail-item-', ''),
  );
}

describe('unread rows float, in the rendered rail', () => {
  it('puts a project with unread above the read ones', async () => {
    const screen = await mountRail(
      [
        project(GENERAL_PROJECT_ID, 'General'),
        project('willow', 'Willow'),
        project('acme', 'Acme', 4),
      ],
      'nothing-open',
    );

    expect(renderedOrder(screen.host)).toEqual([
      'acme',
      GENERAL_PROJECT_ID,
      'willow',
    ]);

    screen.unmount();
  });

  it('does NOT reshuffle the read rows around it', async () => {
    // The failure this guards: a recency sort would also float `d` and would
    // scramble a/b/c, which the owner would experience as the rail moving for no
    // reason he can see.
    const screen = await mountRail(
      [project('a', 'A'), project('b', 'B'), project('c', 'C'), project('d', 'D', 1)],
      'nothing-open',
    );
    expect(renderedOrder(screen.host)).toEqual(['d', 'a', 'b', 'c']);
    screen.unmount();
  });

  it('holds the ACTIVE row in its slot — the row under the thumb never moves', async () => {
    const screen = await mountRail(
      [project('a', 'A'), project('b', 'B', 1), project('c', 'C'), project('d', 'D', 1)],
      'c',
    );
    expect(renderedOrder(screen.host)[2]).toBe('c');
    screen.unmount();
  });
});

describe('the unread count is painted', () => {
  it('renders the number, and nothing at all when there is none', async () => {
    const screen = await mountRail(
      [project('a', 'A'), project('b', 'B', 7)],
      'nothing-open',
    );

    const badge = screen.host.querySelector('[data-testid="rail-unread-b"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('7');
    // A zero badge would be worse than none: it draws the eye to a row with
    // nothing in it.
    expect(screen.host.querySelector('[data-testid="rail-unread-a"]')).toBeNull();

    screen.unmount();
  });

  it('caps a large count instead of clipping it', async () => {
    const screen = await mountRail([project('b', 'B', 4123)], 'nothing-open');
    expect(screen.host.querySelector('[data-testid="rail-unread-b"]')!.textContent).toContain(
      '99+',
    );
    screen.unmount();
  });

  it('says "unread" in the accessible label, so the count is not colour-only', async () => {
    const screen = await mountRail([project('b', 'B', 2)], 'nothing-open');
    const row = screen.host.querySelector('[data-testid="rail-item-b"]');
    expect(row!.getAttribute('aria-label')).toContain('unread');
    screen.unmount();
  });
});

describe('the selected row is carried by hue, not another neutral step', () => {
  it('does not paint selection with surface_raised — the value that was invisible', async () => {
    const screen = await mountRail([project('a', 'A'), project('b', 'B')], 'a');
    const active = screen.host.querySelector('[data-testid="rail-item-a"]') as HTMLElement;
    const inactive = screen.host.querySelector('[data-testid="rail-item-b"]') as HTMLElement;

    const activeBg = triple(paintOf(active).background);
    // The regression, named: `surface_raised` is used by every raised panel in the
    // app, so it says "raised" and not "you are here".
    expect(activeBg).not.toBe(triple(THEME.surface_raised));
    expect(activeBg).not.toBe('');
    // Positive too, so the negative above cannot pass on an unpainted row: it IS the
    // hue token.
    expect(activeBg).toBe(triple(THEME.rail_selected));
    // And it differs from an unselected row, which is the point.
    expect(activeBg).not.toBe(triple(paintOf(inactive).background));

    screen.unmount();
  });

  it('paints NO border — the fill carries selection alone', async () => {
    // The owner rejected the border outright: "I did NOT ask for that ugly ass blue
    // border on the active project. I just wanted the highlight color to be more
    // prominent." So this asserts its ABSENCE, which also means the row's box is
    // identical selected or not — selection cannot shift the column.
    const screen = await mountRail([project('a', 'A'), project('b', 'B')], 'a');
    const active = screen.host.querySelector('[data-testid="rail-item-a"]') as HTMLElement;
    const inactive = screen.host.querySelector('[data-testid="rail-item-b"]') as HTMLElement;
    for (const row of [active, inactive]) {
      const w = paintOf(row).borderWidth;
      expect(w === '' || w === '0px').toBe(true);
    }
    // …and the box really is the same, which is the property the old reserved-border
    // trick existed to protect. Now it holds for free.
    expect(paintOf(active).borderWidth).toBe(paintOf(inactive).borderWidth);
    screen.unmount();
  });
});

/**
 * react-native-web compiles styles to ATOMIC classes, so `numberOfLines` is not
 * readable as a prop or as a computed style — it shows up as a class trio. The
 * discriminator, confirmed by rendering both cases in one tree:
 *
 *   multi-line (numberOfLines > 1) → `r-WebkitBoxOrient-*`, and NO nowrap class
 *   single-line (numberOfLines = 1) → `r-whiteSpace-*` (nowrap), and NO box-orient
 *
 * The rail's own create label is `numberOfLines={1}`, so it is an IN-TREE CONTROL:
 * it proves these assertions can tell the two cases apart, which is the thing a
 * class-name assertion most needs to prove about itself.
 */
const classesOf = (el: HTMLElement): string => el.className;
const isMultiline = (c: string): boolean =>
  c.includes('r-WebkitBoxOrient-') && !c.includes('r-whiteSpace-');
const isSingleLine = (c: string): boolean =>
  c.includes('r-whiteSpace-') && !c.includes('r-WebkitBoxOrient-');

/** The leaf element rendering exactly this text. */
function labelWithText(host: HTMLElement, text: string): HTMLElement {
  const el = Array.from(host.querySelectorAll('*')).find(
    (x) => (x.textContent ?? '') === text && x.children.length === 0,
  ) as HTMLElement | undefined;
  if (el === undefined) throw new Error(`no leaf element rendering "${text}"`);
  return el;
}

describe('project names wrap instead of truncating', () => {
  it('the name is MULTI-line, while the create label beside it stays single', async () => {
    // Owner, on device: "Make project names in the rail wrap instead of truncate.
    // They are not readable when they truncate." The rail is 72pt wide, so at caption
    // size one line held roughly eight characters — an ellipsis and a guess for most
    // real names.
    const screen = await mountRail([project('a', 'Infrastructure Planning')], 'a');
    const name = classesOf(labelWithText(screen.host, 'Infrastructure Planning'));
    expect(isMultiline(name)).toBe(true);

    // THE CONTROL. Same tree, same render, a label that is deliberately still one
    // line. Without this the assertion above could be passing on a class list that
    // happens to contain the substring for unrelated reasons.
    const create = classesOf(labelWithText(screen.host, 'New'));
    expect(isSingleLine(create)).toBe(true);
    expect(isMultiline(create)).toBe(false);

    screen.unmount();
  });

  it('reserves both lines on a SHORT name too, so rows keep a uniform height', async () => {
    // Without reserved height the rail is a ragged column whose row heights depend on
    // name length — and a RENAME would change a row's height, moving every target
    // beneath it.
    const short = await mountRail([project('a', 'Ops')], 'a');
    const long = await mountRail([project('a', 'Infrastructure Planning')], 'a');
    const minHeightClass = (host: HTMLElement, text: string): string => {
      const c = classesOf(labelWithText(host, text));
      const m = /r-minHeight-\S+/.exec(c);
      return m === null ? '' : m[0];
    };
    const a = minHeightClass(short.host, 'Ops');
    const b = minHeightClass(long.host, 'Infrastructure Planning');
    // A reserved height at all…
    expect(a).not.toBe('');
    // …and the SAME one regardless of name length, which is the property that keeps
    // the column uniform.
    expect(a).toBe(b);
    // The control again: the create label reserves no such height, so the class above
    // is genuinely coming from the name style and not from something every label has.
    expect(minHeightClass(short.host, 'New')).toBe('');
    short.unmount();
    long.unmount();
  });
});
