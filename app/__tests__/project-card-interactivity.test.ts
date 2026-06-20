/**
 * @neutronai/app — project-card interactivity unit tests (M2.3 / Argus r2).
 *
 * Convention note (matching `comments-side-pane.test.tsx`): the Neutron
 * app's bun:test suite does NOT mount React Native components. Render-
 * level coverage is provided by the agent-browser smoke pass. This file
 * pins the PURE decision that drives the shared-card disabled state —
 * `projectCardInteractivity(project)` — which the screen
 * (`app/app/projects/index.tsx`) consumes for BOTH the card render
 * (`disabled` / `accessibilityState` / `accessibilityRole` / hint) AND
 * the `handleOpen` navigation guard, so the two can never drift.
 *
 * Argus r2 MINOR #5: the backend timeout regression was tested but the
 * frontend non-navigable shared-card behavior was not. This closes it.
 */

import { describe, expect, test } from 'bun:test';
import {
  SHARED_CARD_COMING_SOON_HINT,
  projectCardInteractivity,
} from '../lib/projects';

describe('projectCardInteractivity', () => {
  test('a shared (cross-instance) card is non-navigable + disabled + a11y-flagged', () => {
    const a11y = projectCardInteractivity({
      kind: 'shared',
      name: 'Acme',
    });
    expect(a11y.navigable).toBe(false);
    expect(a11y.disabled).toBe(true);
    // Disabled state surfaces to assistive tech, not just visually.
    expect(a11y.accessibilityState).toEqual({ disabled: true });
    // A disabled, non-interactive row reads as static text, not a button.
    expect(a11y.accessibilityRole).toBe('text');
    expect(a11y.accessibilityLabel).toContain('Acme');
    expect(a11y.accessibilityLabel).toContain('coming soon');
    // The quiet "coming soon" hint renders below the card.
    expect(a11y.hint).toBe(SHARED_CARD_COMING_SOON_HINT);
  });

  test('a solo (local) card stays a navigable, enabled button with no hint', () => {
    const a11y = projectCardInteractivity({ kind: 'solo', name: 'Neutron' });
    expect(a11y.navigable).toBe(true);
    expect(a11y.disabled).toBe(false);
    // No disabled accessibilityState on an interactive row.
    expect(a11y.accessibilityState).toBeUndefined();
    expect(a11y.accessibilityRole).toBe('button');
    expect(a11y.accessibilityLabel).toBe('Open project Neutron');
    expect(a11y.hint).toBeNull();
  });

  test('navigable is the single source of truth for the handleOpen guard', () => {
    // handleOpen early-returns on `!navigable`; assert the contract the
    // screen relies on rather than re-implementing the predicate there.
    expect(projectCardInteractivity({ kind: 'shared', name: 'x' }).navigable).toBe(
      false,
    );
    expect(projectCardInteractivity({ kind: 'solo', name: 'x' }).navigable).toBe(
      true,
    );
  });
});
