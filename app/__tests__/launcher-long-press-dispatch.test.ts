/**
 * @neutronai/app — launcher long-press dispatch unit tests (ISSUE #17).
 *
 * Pure-function coverage of `resolveLongPressDispatch(...)` — the
 * router-target resolver the launcher route hands each tapped
 * long-press menu row. Asserts:
 *
 *   1. `open_app_tab` substitutes `<project_id>` in the parent's
 *      `app_tab_path` (the manifest token is intentionally chosen so
 *      a Core author writes `/projects/<project_id>/tasks` at the
 *      LAUNCHER_ICON source and the app substitutes at navigation
 *      time).
 *   2. `open_app_tab` falls back to slug-derived inference when the
 *      parent has no `app_tab_path` (legacy / forward-compat).
 *   3. `chat_send_prefix` builds the chat URL with `?prefill=`
 *      URL-encoded.
 *   4. `chat_send` builds the chat URL with `?autosend=` URL-encoded.
 *   5. The smoke assertion: every long-press entry on Tasks Core's
 *      LAUNCHER_ICON declaration resolves to a non-null dispatch.
 *      Same for Reminders Core.
 */

import { describe, expect, it } from 'bun:test';

import type {
  LauncherEntry,
  LauncherEntryLongPressEntry,
} from '../lib/launcher-client';
import { resolveLongPressDispatch } from '../lib/launcher-long-press-dispatch';

function makeEntry(overrides: Partial<LauncherEntry> = {}): LauncherEntry {
  return {
    slug: 'tasks_core',
    display_name: 'Tasks',
    launcher_icon: { kind: 'emoji', value: '✅' },
    reorder_index: 0,
    primary_action: 'open_app_tab',
    app_tab_path: '/projects/<project_id>/tasks',
    long_press_menu: [],
    ...overrides,
  };
}

describe('resolveLongPressDispatch — open_app_tab', () => {
  it('substitutes <project_id> in the parent app_tab_path', () => {
    const parent = makeEntry({ app_tab_path: '/projects/<project_id>/tasks' });
    const item: LauncherEntryLongPressEntry = {
      id: 'browse',
      label: 'Open task list',
      action: 'open_app_tab',
    };
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out).toEqual({ path: '/projects/p1/tasks' });
  });

  it('falls back to slug-derived route when parent has no app_tab_path', () => {
    const parent = makeEntry({ app_tab_path: undefined, slug: 'notes' });
    const item: LauncherEntryLongPressEntry = {
      id: 'open',
      label: 'Open',
      action: 'open_app_tab',
    };
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out).toEqual({ path: '/projects/p1/notes' });
  });

  it('strips _core suffix in slug fallback', () => {
    const parent = makeEntry({ app_tab_path: undefined, slug: 'reminders_core' });
    const item: LauncherEntryLongPressEntry = {
      id: 'open',
      label: 'Open',
      action: 'open_app_tab',
    };
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out).toEqual({ path: '/projects/p1/reminders' });
  });
});

describe('resolveLongPressDispatch — chat_send_prefix', () => {
  it('builds /projects/<id>/chat?prefill=<URI-encoded prefix>', () => {
    const parent = makeEntry();
    const item: LauncherEntryLongPressEntry = {
      id: 'capture',
      label: 'Capture a task',
      action: 'chat_send_prefix',
      prefix: '/task ',
    };
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out).toEqual({ path: '/projects/p1/chat?prefill=%2Ftask%20' });
  });

  it('URL-encodes special characters in the prefix', () => {
    const parent = makeEntry();
    const item: LauncherEntryLongPressEntry = {
      id: 'smart',
      label: 'Smart reminder',
      action: 'chat_send_prefix',
      prefix: '/remind smart & ',
    };
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out?.path).toContain('%2Fremind%20smart%20%26%20');
  });

  it('handles missing prefix (empty string fallback)', () => {
    const parent = makeEntry();
    const item = {
      id: 'capture',
      label: 'Capture',
      action: 'chat_send_prefix',
    } as LauncherEntryLongPressEntry;
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out).toEqual({ path: '/projects/p1/chat?prefill=' });
  });
});

describe('resolveLongPressDispatch — chat_send', () => {
  it('builds /projects/<id>/chat?autosend=<URI-encoded text>', () => {
    const parent = makeEntry();
    const item: LauncherEntryLongPressEntry = {
      id: 'pick_next',
      label: 'What should I focus on?',
      action: 'chat_send',
      text: '/task focus',
    };
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out).toEqual({ path: '/projects/p1/chat?autosend=%2Ftask%20focus' });
  });
});

describe('resolveLongPressDispatch — manifest smoke tests', () => {
  it('Tasks Core 3-entry long_press_menu — every entry dispatches', () => {
    // Mirrors `cores/free/tasks/src/ui/launcher-icon.ts:LAUNCHER_ICON`.
    const parent = makeEntry({
      slug: 'tasks_core',
      app_tab_path: '/projects/<project_id>/tasks',
      long_press_menu: [
        { id: 'capture', label: 'Capture a task', action: 'chat_send_prefix', prefix: '/task ' },
        { id: 'browse', label: 'Open task list', action: 'open_app_tab' },
        { id: 'pick_next', label: 'What should I focus on?', action: 'chat_send', text: '/task focus' },
      ],
    });
    expect(parent.long_press_menu).toHaveLength(3);
    for (const item of parent.long_press_menu ?? []) {
      const out = resolveLongPressDispatch(parent, item, 'p1');
      expect(out).not.toBeNull();
      expect(typeof out?.path).toBe('string');
      expect(out?.path.startsWith('/projects/p1/')).toBe(true);
    }
  });

  it('Reminders Core 3-entry long_press_menu — every entry dispatches', () => {
    // Mirrors `cores/free/reminders/src/ui/launcher-icon.ts`.
    const parent = makeEntry({
      slug: 'reminders_core',
      app_tab_path: '/projects/<project_id>/reminders',
      long_press_menu: [
        { id: 'capture', label: 'Schedule a reminder', action: 'chat_send_prefix', prefix: '/remind ' },
        { id: 'browse', label: 'Open reminders list', action: 'open_app_tab' },
        { id: 'smart_capture', label: 'Smart reminder', action: 'chat_send_prefix', prefix: '/remind smart ' },
      ],
    });
    expect(parent.long_press_menu).toHaveLength(3);
    for (const item of parent.long_press_menu ?? []) {
      const out = resolveLongPressDispatch(parent, item, 'demo');
      expect(out).not.toBeNull();
      expect(typeof out?.path).toBe('string');
      expect(out?.path.startsWith('/projects/demo/')).toBe(true);
    }
  });

  it('unknown action returns null (forward-compat)', () => {
    const parent = makeEntry();
    const item = {
      id: 'future',
      label: 'Future action',
      action: 'never_heard_of_this' as 'open_app_tab',
    } satisfies LauncherEntryLongPressEntry;
    const out = resolveLongPressDispatch(parent, item, 'p1');
    expect(out).toBeNull();
  });
});
