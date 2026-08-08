/**
 * @neutronai/app — the ONE header menu still reaches BOTH settings scopes.
 *
 * WHY THIS FILE EXISTS, AND WHY THE EXISTING GUARD WAS NOT ENOUGH.
 *
 * Consolidating the two header hamburgers into one top-right menu moved the
 * app-settings entry from a top-level button into a menu row. `/settings` is the
 * only signed-in route to the server editor, sign-out and Admin — ISSUES #385 is
 * exactly the defect of that entry becoming unreachable — and it is guarded by
 * `server-editor-reachability.test.ts`.
 *
 * That guard reads the header's SOURCE and asserts the strings
 * `project-header-app-settings` and `onOpenAppSettings` appear in it. After this
 * change both strings are still present, so the guard passes. **It would also pass
 * if the menu never opened**, because a source-string check cannot tell a rendered
 * control from a dead one. The consolidation made a static guard weaker without
 * changing a single character of it.
 *
 * So this file asserts the thing the other one structurally cannot: drive the real
 * component, open the menu, press the row, and see the handler fire. A menu that
 * does not open, a row that is not wired, or a scrim that swallows the press all
 * fail here and none of them fail there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { ProjectHeader } = await import('../components/ProjectHeader');

let appSettings = 0;
let projectSettings = 0;

beforeEach(() => {
  appSettings = 0;
  projectSettings = 0;
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

async function mountHeader() {
  return mountScreen(
    createElement(ProjectHeader, {
      name: 'Willow',
      onOpenAppSettings: () => {
        appSettings += 1;
      },
      onOpenSettings: () => {
        projectSettings += 1;
      },
    }),
  );
}

/**
 * Query the whole DOCUMENT, not the mount container.
 *
 * The menu is a `Modal`, which renders into its own portal OUTSIDE the mounted
 * subtree — and that is precisely the property that fixes the Android clipping bug
 * it was introduced for. So a container-scoped query cannot see it. Same fact,
 * two consequences: the sheet escapes the header's box on device, and it escapes
 * `screen.host` here.
 */
function find(host: HTMLElement, testID: string): HTMLElement | null {
  const doc = host.ownerDocument;
  return doc.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
}

function press(host: HTMLElement, testID: string): void {
  const el = find(host, testID);
  if (el === null) throw new Error(`no element with testID ${testID}`);
  act(() => {
    el.dispatchEvent(new host.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
  });
}

describe('one control, both scopes', () => {
  it('there is exactly ONE header menu button — not two hamburgers', async () => {
    const screen = await mountHeader();
    // The owner's complaint, as an assertion: "Why are there two hamburger menus,
    // top left and top right?" A regression that re-adds a left ☰ fails here.
    expect(
      screen.host.ownerDocument.querySelectorAll('[data-testid="project-header-menu"]'),
    ).toHaveLength(1);
    // And nothing is reachable before it is opened, so the count above is the whole
    // header's chrome.
    expect(find(screen.host, 'project-header-menu-sheet')).toBeNull();
    screen.unmount();
  });

  it('opening the menu and pressing App settings fires the handler', async () => {
    // THE ASSERTION THE SOURCE-STRING GUARD CANNOT MAKE.
    const screen = await mountHeader();
    press(screen.host, 'project-header-menu');
    expect(find(screen.host, 'project-header-menu-sheet')).not.toBeNull();
    press(screen.host, 'project-header-app-settings');
    expect(appSettings).toBe(1);
    screen.unmount();
  });

  it('project settings is reachable from the same menu', async () => {
    const screen = await mountHeader();
    press(screen.host, 'project-header-menu');
    press(screen.host, 'project-header-settings');
    expect(projectSettings).toBe(1);
    // Two scopes, one control, and choosing one must not fire the other.
    expect(appSettings).toBe(0);
    screen.unmount();
  });

  it('closes after a choice, so the menu does not outlive its own navigation', async () => {
    const screen = await mountHeader();
    press(screen.host, 'project-header-menu');
    press(screen.host, 'project-header-settings');
    expect(find(screen.host, 'project-header-menu-sheet')).toBeNull();
    screen.unmount();
  });

  it('a tap outside dismisses it without choosing anything', async () => {
    // A menu whose only exit is its own button is a trap on a phone.
    const screen = await mountHeader();
    press(screen.host, 'project-header-menu');
    press(screen.host, 'project-header-menu-scrim');
    expect(find(screen.host, 'project-header-menu-sheet')).toBeNull();
    expect(appSettings).toBe(0);
    expect(projectSettings).toBe(0);
    screen.unmount();
  });
});

describe('the header no longer spends a line saying PROJECT', () => {
  it('renders the name and not the overline', async () => {
    const screen = await mountHeader();
    const text = screen.host.textContent ?? '';
    expect(text).toContain('Willow');
    // The owner: "Remove the word 'project' from the top of the screen." Case-
    // sensitive on the overline's own spelling, so a future menu row legitimately
    // containing the word "project" (there is one — "Project settings") does not
    // make this assertion vacuous.
    expect(text).not.toContain('PROJECT');
    screen.unmount();
  });
});

describe('the mark leads the bar', () => {
  it('renders the logo BEFORE the project name, and it is not a button', async () => {
    // Owner: "put the neutron logo in the top left corner of the app, before the
    // project name in the title rail."
    const screen = await mountHeader();
    const logo = find(screen.host, 'project-header-logo');
    expect(logo).not.toBeNull();

    // ORDER, not mere presence: "before the project name" is the ask, and a logo
    // rendered after the title would satisfy a presence-only assertion.
    const title = Array.from(screen.host.querySelectorAll('*')).find(
      (el) => (el.textContent ?? '') === 'Willow' && el.children.length === 0,
    ) as HTMLElement;
    expect(title).toBeDefined();
    // Node.DOCUMENT_POSITION_FOLLOWING (4) ⇒ the title comes after the logo.
    expect(logo!.compareDocumentPosition(title) & 4).toBe(4);

    // NOT tappable. The rail's General tile is already the way home; a tappable logo
    // would put a second ambiguous navigation affordance in a bar that just had one
    // control removed for exactly that reason.
    expect(logo!.getAttribute('role')).not.toBe('button');
    screen.unmount();
  });
});
