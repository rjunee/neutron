/**
 * The project shell's chrome must follow the rail selection.
 *
 * Observed on a running emulator: tapping General swapped the transcript to
 * General's messages (so the child chat screen saw the new id) but left the
 * header reading "Willow" and the rail highlight on Willow. Inside the
 * `[id]` layout, `useLocalSearchParams` is sticky — the layout stays mounted
 * across willow → general, so it kept reporting the old id. The pathname
 * always reflects where we actually are.
 */
import { describe, expect, test } from 'bun:test';
import { GENERAL_PROJECT_ID, projectIdFromPathname } from '../lib/project-rail-view';

describe('projectIdFromPathname', () => {
  test('reads the id from a project route, with or without a tab leaf', () => {
    expect(projectIdFromPathname('/projects/willow')).toBe('willow');
    expect(projectIdFromPathname('/projects/willow/chat')).toBe('willow');
    expect(projectIdFromPathname('/projects/willow/cores/dtc-analytics')).toBe('willow');
  });

  test('THE BUG: navigating to General reports General, not the previous project', () => {
    // The router percent-encodes the id (`onRailSelect` uses
    // `encodeURIComponent`), so `#general` reaches the path as `%23general`.
    // That encoding is the whole reason the sentinel is collision-proof — see
    // ISSUES #410 — so assert the form the app actually produces.
    // The sentinel needs no percent-encoding at all (#411), so the path is
    // literally this — there is no encoded/decoded ambiguity to tolerate.
    expect(projectIdFromPathname('/projects/~general/chat')).toBe(GENERAL_PROJECT_ID);
  });

  test('a REAL project called "general" is distinct from the General scope (#410)', () => {
    // The regression this pair exists to prevent: before #410 both of these
    // produced the same id, so a project literally named "general" was
    // swallowed by the scope sentinel and became unreachable.
    expect(projectIdFromPathname('/projects/general/chat')).toBe('general');
    expect(projectIdFromPathname('/projects/general/chat')).not.toBe(GENERAL_PROJECT_ID);
  });

  test('ignores a query string', () => {
    expect(projectIdFromPathname('/projects/willow/chat?start=abc')).toBe('willow');
  });

  test('decodes a percent-encoded id (the router encodes on the way out)', () => {
    expect(projectIdFromPathname('/projects/my%20project/chat')).toBe('my project');
  });

  test('returns null for anything that is not a project route, so the caller can fall back', () => {
    // `/projects` is no longer a ROUTE (the list screen is deleted — SPEC §
    // Decisions Log 2026-07-27), but the parser's contract for a bare/short path
    // still matters: the shell falls back to the `[id]` param when this returns
    // null, and a two-segment path must not yield a phantom project id.
    expect(projectIdFromPathname('/projects')).toBeNull();
    expect(projectIdFromPathname('/projects/')).toBeNull();
    expect(projectIdFromPathname('/login')).toBeNull();
    // These are the ones the `projects` guard actually earns its keep on: a
    // two-segment path under a DIFFERENT root would otherwise yield its second
    // segment as a project id. (A mutation test caught this gap — without these
    // the guard could be deleted with every assertion still green.)
    expect(projectIdFromPathname('/settings/notifications')).toBeNull();
    expect(projectIdFromPathname('/cores/dtc-analytics')).toBeNull();
    expect(projectIdFromPathname('/')).toBeNull();
    expect(projectIdFromPathname('')).toBeNull();
  });
});
