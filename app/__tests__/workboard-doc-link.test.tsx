/**
 * MOBILE — a work card's spec-doc chip opens that doc.
 *
 * THE GAP THIS CLOSES. `WorkBoardRow` has declared an optional `onOpenDoc` since
 * it was written, and it keys THREE things off whether that prop is present: the
 * accessibility role (`button` vs `text`), `disabled`, and the press handler. No
 * screen ever passed it. So on every phone, every card with a plan document
 * rendered its ▸ chip as inert text — not broken-looking, just permanently
 * unreachable. The web had the same hole for a different reason.
 *
 * A control on the same file establishes that a screen CAN pass a row callback
 * and that the surrounding wiring works: the sibling `onPlay` is passed at the
 * same call site. `onOpenDoc` simply never was. That is why this is a wiring
 * test, not a component test — `WorkBoardRow` was always correct.
 *
 * WHY THE ROUTE USES THE RAIL ID. The board client is SCOPE-addressed (General ⇒
 * `''`) but the route is RAIL-addressed (General ⇒ `~general`). Building the
 * push from the scope yields `/projects//docs`, which resolves to nothing — on
 * General specifically, the one board where the owner hit this. The two ids are
 * carried separately for exactly this reason, and the General case is asserted
 * below rather than left to the named-project case to imply.
 */

import { describe, expect, it } from 'bun:test';

import { docPathFromDesignRef } from '../lib/work-board-client';

/**
 * The screen's callback factory, mirrored. Kept in step with the real one by the
 * source assertion at the bottom, which fails if the screen stops using it.
 */
function openDoc(
  push: (href: string) => void,
  railId: string,
): (ref: string | null) => (() => void) | undefined {
  return (ref: string | null) => {
    const path = docPathFromDesignRef(ref);
    if (path === null) return undefined;
    return () => {
      push(`/projects/${encodeURIComponent(railId)}/docs?path=${encodeURIComponent(path)}`);
    };
  };
}

describe('work board → doc link (mobile)', () => {
  it('returns undefined — NOT a no-op handler — for a card with no doc', () => {
    // This distinction is load-bearing rather than stylistic. `WorkBoardRow`
    // reads `onOpenDoc === undefined` to decide the a11y role and `disabled`, so
    // a do-nothing function would announce a button to a screen reader and hand
    // a sighted owner a chip that silently eats taps.
    const make = openDoc(() => {}, 'acme');
    expect(make(null)).toBeUndefined();
    expect(make('')).toBeUndefined();
    expect(make('https://example.com/some/external/thing')).toBeUndefined();
  });

  it('pushes the docs route for an in-app doc ref', () => {
    const pushed: string[] = [];
    const handler = openDoc((h) => pushed.push(h), 'acme')('neutron-docs:plans/rollout.md');
    expect(handler).toBeDefined();
    handler?.();
    expect(pushed).toEqual(['/projects/acme/docs?path=plans%2Frollout.md']);
  });

  it('routes GENERAL by its RAIL id, never by its empty scope', () => {
    const pushed: string[] = [];
    const handler = openDoc((h) => pushed.push(h), '~general')('neutron-docs:plans/rollout.md');
    handler?.();
    // The failing form is named explicitly: an empty segment is a dead route.
    expect(pushed[0]).not.toContain('/projects//docs');
    expect(pushed[0]).toBe('/projects/~general/docs?path=plans%2Frollout.md');
  });

  it('encodes a path with spaces so the query survives', () => {
    const pushed: string[] = [];
    openDoc((h) => pushed.push(h), 'acme')('neutron-docs:plans/my plan.md')?.();
    expect(pushed[0]).toContain('path=plans%2Fmy%20plan.md');
  });
});

describe('the screen actually passes it', () => {
  it('wires onOpenDoc into the row, alongside the sibling that always worked', async () => {
    const src = await Bun.file(
      new URL('../app/projects/[id]/workboard.tsx', import.meta.url),
    ).text();
    // `includes`, not `toContain`: a failing `toContain` on a whole file prints
    // the whole file.
    expect(src.includes('onOpenDoc={openDoc(it.design_doc_ref)}')).toBe(true);
    // The CONTROL. `onPlay` was already passed here, which is what proves the
    // call site was reachable all along and the miss was specific to this prop.
    expect(src.includes('onPlay={')).toBe(true);
    // The route must be built from the rail id. Asserting the scope name is
    // ABSENT from the push would be the weaker check — this pins the right one.
    expect(src.includes('`/projects/${encodeURIComponent(railId)}/docs?path=')).toBe(true);
  });
});
