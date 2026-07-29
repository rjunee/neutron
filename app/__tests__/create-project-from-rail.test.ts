/**
 * CREATE-PROJECT SURVIVED THE LIST SCREEN'S DELETION.
 *
 * "+ Create Project" was a bottom-pinned bar on `app/app/projects/index.tsx`, and
 * the rail's `+` simply navigated to that screen. Deleting the screen (SPEC §
 * Decisions Log 2026-07-27) without moving the affordance would have left mobile
 * with NO way to create a project and a dead rail button — a silent capability
 * loss that no existing test would have noticed.
 *
 * So: the rail's `+` opens `<CreateProjectSheet>` over the chat. The name rule
 * lives in `lib/create-project-helpers.ts` (asserted behaviourally below) and the
 * wiring is source-pinned, since the app suite cannot mount React Native.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CREATE_FAILED_ERROR,
  EMPTY_NAME_ERROR,
  checkProjectName,
  createProjectErrorCopy,
} from '../lib/create-project-helpers';

const APP_ROOT = join(__dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(APP_ROOT, ...parts), 'utf8');

describe('the project-name rule', () => {
  it('trims and accepts a real name', () => {
    expect(checkProjectName('  Willow  ')).toEqual({ ok: true, name: 'Willow' });
  });

  it('rejects empty and whitespace-only — a nameless rail entry has no label', () => {
    expect(checkProjectName('')).toEqual({ ok: false, error: EMPTY_NAME_ERROR });
    expect(checkProjectName('   ')).toEqual({ ok: false, error: EMPTY_NAME_ERROR });
    expect(checkProjectName('\n\t')).toEqual({ ok: false, error: EMPTY_NAME_ERROR });
  });

  it('keeps interior whitespace (a two-word project name is legal)', () => {
    expect(checkProjectName(' my new project ')).toEqual({
      ok: true,
      name: 'my new project',
    });
  });
});

describe('create failure copy', () => {
  it('surfaces the server reason when there is one', () => {
    expect(createProjectErrorCopy(new Error('name_taken'))).toBe('name_taken');
  });

  it('falls back for a non-Error / empty rejection rather than showing ""', () => {
    expect(createProjectErrorCopy(null)).toBe(CREATE_FAILED_ERROR);
    expect(createProjectErrorCopy(new Error(''))).toBe(CREATE_FAILED_ERROR);
    expect(createProjectErrorCopy('nope')).toBe(CREATE_FAILED_ERROR);
  });
});

describe('create-project is REACHABLE from the rail (wired, not merely written)', () => {
  const layout = read('app', 'projects', '[id]', '_layout.tsx');

  it('the rail `+` opens the sheet instead of navigating', () => {
    expect(layout).toContain('const onRailCreate');
    expect(layout).toContain('setCreateOpen(true)');
    // The dead path: `+` used to push the (now deleted) list screen.
    expect(layout).not.toContain("router.push('/projects')");
  });

  it('the sheet is RENDERED by the shell and fed by the rail handler', () => {
    expect(layout).toContain('<CreateProjectSheet');
    expect(layout).toContain('onCreate={onRailCreate}');
    expect(layout).toContain('onSubmit={submitCreate}');
  });

  it('submit calls the real createProject and lands in the new project CHAT', () => {
    expect(layout).toContain('createProject({ base_url: config.base_url');
    expect(layout).toContain('chatRouteForProject(created.id)');
  });

  it('the sheet routes its input through the shared name rule', () => {
    const sheet = read('components', 'CreateProjectSheet.tsx');
    expect(sheet).toContain('checkProjectName');
    expect(sheet).toContain('create-project-input');
    expect(sheet).toContain('create-project-confirm');
  });
});
