/**
 * @neutronai/app — the project shell's chrome SURVIVES a project switch (mobile
 * defect, 2026-07-29).
 *
 * Ryan on device: switching projects "flickers and feels laggy, should feel
 * instant." It was not slow rendering. `app/projects/[id]/_layout.tsx` gated the
 * WHOLE shell on the settings fetch, so for the frames between a rail tap and the
 * new scope's doc landing it returned nothing but a centred spinner — tearing down
 * the rail, the header and the tab bar and rebuilding all three on every tap.
 *
 * WHAT THIS SUITE PINS, AND WHY IN TWO FORMS:
 *
 *   1. The DECISION, as the pure `projectShellContent` — which state the content
 *      pane shows, including the two traps: the synthetic General scope is never
 *      loading and never missing, and a genuinely absent project must still reach
 *      the not-found pane instead of spinning forever.
 *   2. The STRUCTURE, read from the layout's source — that no early `return`
 *      stands between the top of `ProjectShell` and the chrome. A snapshot test
 *      misses this exactly: the broken build's snapshot is a perfectly valid
 *      spinner. The regression IS the early return, so that is what gets asserted.
 *      (This suite has no RN mount harness — see `project-card-interactivity.test.ts`.)
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectShellContent } from '../lib/project-shell-content';
import {
  EMPTY_PROJECT_STATE,
  projectStateReducer,
  scopedProjectState,
} from '../lib/project-state-reducer';
import type { ProjectSettings } from '../lib/projects-client';

const LAYOUT_SRC = readFileSync(
  join(import.meta.dir, '..', 'app', 'projects', '[id]', '_layout.tsx'),
  'utf8',
);

/** The body of `ProjectShell` only — the function the defect lived in. */
function projectShellBody(src: string): string {
  const start = src.indexOf('function ProjectShell(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const doc = (id: string): ProjectSettings => ({
  id,
  name: `${id} project`,
  description: '',
  persona: '',
  emoji: '📁',
  privacy_mode: 'private',
  billing_mode: 'personal',
  agent_engagement_mode: 'all_messages',
  members: [],
});

describe('project shell — the content pane decision', () => {
  it('is ready the instant a project doc is in hand', () => {
    expect(projectShellContent({ is_general: false, has_project: true, error: null })).toEqual({
      kind: 'ready',
    });
  });

  it('is LOADING (not not-found) while the new scope is in flight', () => {
    // The frames right after a rail tap: the fetch effect has not run yet, so
    // nothing is known and no error exists. The old gate read `loading` here and
    // rendered "Project not found" in this gap.
    expect(projectShellContent({ is_general: false, has_project: false, error: null })).toEqual({
      kind: 'loading',
    });
  });

  it('reaches not-found — with the reason — for a genuinely absent project', () => {
    // The trap on the other side: never hang on a spinner forever.
    expect(
      projectShellContent({
        is_general: false,
        has_project: false,
        error: { message: 'no such project' },
      }),
    ).toEqual({ kind: 'not_found', message: 'no such project' });
  });

  it('never shows General as loading or missing, even with an error present', () => {
    // General is the NO-PROJECT scope: nothing is ever fetched for it, so a
    // leftover error must not 404 the one scope that cannot 404.
    expect(projectShellContent({ is_general: true, has_project: false, error: null })).toEqual({
      kind: 'ready',
    });
    expect(
      projectShellContent({
        is_general: true,
        has_project: false,
        error: { message: 'not found' },
      }),
    ).toEqual({ kind: 'ready' });
  });
});

describe('project shell — one scope never renders another scope\'s data', () => {
  it('hides a doc still belonging to the PREVIOUS project', () => {
    // `LOAD_START` deliberately keeps `project` so a refresh does not blank the
    // UI — which meant a switch rendered project B's shell under project A's name.
    const loaded = projectStateReducer(EMPTY_PROJECT_STATE, {
      type: 'LOAD_OK',
      project: doc('willow'),
    });
    const scoped = scopedProjectState(loaded, 'tabs', 'willow');
    expect(scoped.project).toBeNull();
    expect(scoped.loading).toBe(true);
  });

  it('hides an error collected for the PREVIOUS scope', () => {
    // General → a real project used to flash "Project not found", because the 404
    // from `getSettings('general')` was still sitting in `error`.
    const failed = projectStateReducer(EMPTY_PROJECT_STATE, {
      type: 'LOAD_FAIL',
      error: { code: 'not_found', message: 'no such project' },
    });
    expect(scopedProjectState(failed, 'willow', '~general').error).toBeNull();
    expect(projectShellContent({
      is_general: false,
      has_project: false,
      error: scopedProjectState(failed, 'willow', '~general').error,
    })).toEqual({ kind: 'loading' });
  });

  it('passes data through untouched once the scopes agree', () => {
    const loaded = projectStateReducer(EMPTY_PROJECT_STATE, {
      type: 'LOAD_OK',
      project: doc('willow'),
    });
    expect(scopedProjectState(loaded, 'willow', 'willow')).toBe(loaded);
  });

  it('treats the very first render (nothing loaded yet) as in flight', () => {
    expect(scopedProjectState(EMPTY_PROJECT_STATE, 'willow', null).loading).toBe(true);
  });
});

describe('project shell — the chrome is structurally unconditional', () => {
  const body = projectShellBody(LAYOUT_SRC);

  it('mounts the rail, header and tab bar', () => {
    expect(body).toContain('<ProjectRail');
    expect(body).toContain('<ProjectHeader');
    expect(body).toContain('<ProjectTabBar');
  });

  it('returns UI from exactly ONE place, and that place has the chrome', () => {
    // THIS IS THE REGRESSION. The shipped bug had THREE UI returns — a bare
    // spinner, the not-found pane, and the chrome — so the two early ones
    // unmounted the rail, header and tab bar on every project switch. One UI
    // return means the chrome is structurally unconditional: there is no
    // reachable path through this component that renders without it.
    //
    // The pattern matches `return <`, `return (<` and `return (\n  <`. It does
    // NOT match an effect's cleanup (`return () => …`) or a plain value return,
    // both of which are legitimate and plentiful in this body.
    const uiReturns = [...body.matchAll(/\breturn\s*\(?\s*</g)];
    expect(uiReturns).toHaveLength(1);

    const theReturn = body.slice(uiReturns[0]?.index ?? 0);
    expect(theReturn).toContain('<ProjectHeader');
    expect(theReturn).toContain('<ProjectRail');
    expect(theReturn).toContain('<ProjectTabBar');
  });

  it('renders the loading + not-found panes INSIDE the chrome', () => {
    // Both live in `contentPane`, which is placed in the content region after
    // the header/rail/tab bar — so a missing project still leaves the rail
    // available to tap out of the dead end.
    expect(body).toContain('testID="project-content-loading"');
    expect(body).toContain('<ProjectNotFoundFallback');
    expect(body.indexOf('{contentPane}')).toBeGreaterThan(body.indexOf('<ProjectHeader'));
  });

  it('actually calls the content resolver (exists != wired)', () => {
    expect(body).toContain('projectShellContent({');
    expect(LAYOUT_SRC).toContain("from '../../../lib/project-shell-content'");
  });

  it('does not re-dip the tab fade on a project switch', () => {
    // A rail tap moves through `/projects/<id>` → `/projects/<id>/chat`, so the
    // route leaf changes twice; keying the fade on the leaf alone fired two
    // opacity dips per switch on top of the content pane's own spinner.
    expect(body).toContain('scopeId={project_id}');
    expect(LAYOUT_SRC).toContain('lastScope');
  });
});
