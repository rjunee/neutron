/**
 * @neutronai/app — registry tab mapping + active-tab resolution tests
 * (WAVE 3 PR-3).
 *
 * Covers the three PR-3 acceptance cases for the MOBILE tabs wiring:
 *   1. the bar renders the engine-RESOLVED tab set (descriptor → route + key);
 *   2. the PRE-FETCH loading default (legacy 5-tab `PROJECT_TABS`);
 *   3. the Core WEBVIEW tab (descriptor → generic `cores/<slug>` route).
 *
 * Plus the ported `active-tab` regression (chat-sync / notes / backups / bare
 * cores must highlight NO tab — Argus IMPORTANT PR #11) and the Core-URL
 * scheme guard. Pure logic, no RN render — matching the app's bun:test
 * convention (`react-native` is not loaded in the test runtime).
 */

import { describe, expect, it } from 'bun:test';

import type { TabDescriptor } from '../lib/tabs-client';
import {
  activeTabKeyFromSegments,
  descriptorsToResolvedTabs,
  lastTabValueForLeaf,
  loadingTabsForProject,
  PROJECT_TABS,
  resolveTabRoute,
  sanitizeCoreTabUrl,
} from '../lib/project-tabs';

const PID = 'proj_1';
const base = ['projects', '[id]'] as const;

function builtin(key: string, label: string, target: string, order: number): TabDescriptor {
  return { key, label, scope: 'project', source: 'builtin', order, mount: { kind: 'builtin', target } };
}

function core(slug: string, label: string, url: string, order: number): TabDescriptor {
  return {
    key: `core:${slug}`,
    label,
    scope: 'project',
    source: 'core',
    core_slug: slug,
    order,
    mount: { kind: 'webview', target: url },
  };
}

/** The engine's current project-scope builtin set: Chat / Documents / Tasks. */
const REGISTRY_BUILTINS: TabDescriptor[] = [
  builtin('chat', 'Chat', 'chat', 0),
  builtin('documents', 'Documents', 'docs', 10),
  builtin('tasks', 'Tasks', 'tasks', 20),
];

describe('resolveTabRoute', () => {
  it('maps a builtin descriptor to its native route leaf', () => {
    expect(resolveTabRoute(builtin('chat', 'Chat', 'chat', 0), PID)).toBe('/projects/proj_1/chat');
    // `documents` descriptor key but `docs` native route target.
    expect(resolveTabRoute(builtin('documents', 'Documents', 'docs', 10), PID)).toBe(
      '/projects/proj_1/docs',
    );
    expect(resolveTabRoute(builtin('tasks', 'Tasks', 'tasks', 20), PID)).toBe(
      '/projects/proj_1/tasks',
    );
  });

  it('maps a Core webview descriptor to the generic cores/<slug> route w/ url+label', () => {
    const route = resolveTabRoute(
      core('research', 'Research', 'https://core.example/app?project=proj_1', 100),
      PID,
    );
    expect(route.startsWith('/projects/proj_1/cores/research?')).toBe(true);
    const qs = new URLSearchParams(route.split('?')[1]);
    expect(qs.get('url')).toBe('https://core.example/app?project=proj_1');
    expect(qs.get('label')).toBe('Research');
  });
});

describe('descriptorsToResolvedTabs', () => {
  it('preserves order + label and resolves every route (builtins + core)', () => {
    const tabs = descriptorsToResolvedTabs(
      [...REGISTRY_BUILTINS, core('research', 'Research', 'https://core.example/r', 100)],
      PID,
    );
    expect(tabs.map((t) => t.key)).toEqual(['chat', 'documents', 'tasks', 'core:research']);
    expect(tabs.map((t) => t.label)).toEqual(['Chat', 'Documents', 'Tasks', 'Research']);
    expect(tabs[1]?.route).toBe('/projects/proj_1/docs');
    expect(tabs[3]?.route.startsWith('/projects/proj_1/cores/research?')).toBe(true);
  });
});

describe('loadingTabsForProject (pre-fetch default)', () => {
  it('returns the legacy tab set (+ Settings) resolved to native routes', () => {
    const tabs = loadingTabsForProject(PID);
    expect(tabs.map((t) => t.key)).toEqual(['chat', 'launcher', 'tasks', 'reminders', 'docs', 'settings']);
    expect(tabs.map((t) => t.route)).toEqual([
      '/projects/proj_1/chat',
      '/projects/proj_1/launcher',
      '/projects/proj_1/tasks',
      '/projects/proj_1/reminders',
      '/projects/proj_1/docs',
      '/projects/proj_1/settings',
    ]);
  });

  it('mirrors the canonical PROJECT_TABS labels exactly', () => {
    expect(loadingTabsForProject(PID).map((t) => t.label)).toEqual(
      PROJECT_TABS.map((t) => t.label),
    );
  });
});

describe('activeTabKeyFromSegments — registry set', () => {
  const tabs = descriptorsToResolvedTabs(
    [...REGISTRY_BUILTINS, core('research', 'Research', 'https://core.example/r', 100)],
    PID,
  );

  it('highlights builtin leaves (chat/docs→documents/tasks)', () => {
    expect(activeTabKeyFromSegments([...base, 'chat'], tabs)).toBe('chat');
    expect(activeTabKeyFromSegments([...base, 'docs'], tabs)).toBe('documents');
    expect(activeTabKeyFromSegments([...base, 'tasks'], tabs)).toBe('tasks');
  });

  it('highlights the matching Core webview tab on a cores/<slug> route', () => {
    expect(activeTabKeyFromSegments([...base, 'cores', 'research'], tabs)).toBe('core:research');
  });

  it('highlights nothing for an unknown Core slug', () => {
    expect(activeTabKeyFromSegments([...base, 'cores', 'nope'], tabs)).toBeNull();
  });

  it('defaults the bare project route to the chat tab', () => {
    expect(activeTabKeyFromSegments([...base], tabs)).toBe('chat');
  });

  it('highlights NOTHING on a legacy leaf no longer in the registry set', () => {
    // `launcher` / `reminders` dropped out of the registry builtins. Default-
    // highlighting Chat here would lock the user out of the obsolete route
    // (the bar suppresses taps on the active tab) — PR #11 shadow-and-lock.
    expect(activeTabKeyFromSegments([...base, 'launcher'], tabs)).toBeNull();
    expect(activeTabKeyFromSegments([...base, 'reminders'], tabs)).toBeNull();
    expect(activeTabKeyFromSegments([...base, 'totally-unknown'], tabs)).toBeNull();
  });

  it('matches the Core tab by its CONCRETE slug, not the [slug] token', () => {
    // Drives home the usePathname (concrete) vs useSegments ([slug]) contract.
    expect(activeTabKeyFromSegments(['projects', 'p_real', 'cores', 'research'], tabs)).toBe(
      'core:research',
    );
    expect(activeTabKeyFromSegments(['projects', 'p_real', 'cores', '[slug]'], tabs)).toBeNull();
  });
});

describe('activeTabKeyFromSegments — loading default set', () => {
  const tabs = loadingTabsForProject(PID);

  it('highlights every legacy native leaf', () => {
    for (const leaf of ['chat', 'launcher', 'tasks', 'reminders', 'docs']) {
      expect(activeTabKeyFromSegments([...base, leaf], tabs)).toBe(leaf);
    }
  });

  it('does NOT shadow/lock the Chat tab on an unknown sub-route (PR #11 regression)', () => {
    // `chat-sync` was the legacy second chat surface; the 2026-06-29 chat-collapse
    // removed it (single Chat tab now). An unknown leaf must still highlight
    // NOTHING — never default-highlight Chat, which would suppress the escape tap.
    expect(activeTabKeyFromSegments([...base, 'chat-sync'], tabs)).toBeNull();
    expect(activeTabKeyFromSegments([...base, 'some-removed-route'], tabs)).toBeNull();
  });

  it('highlights nothing on the other non-tab sub-routes', () => {
    expect(activeTabKeyFromSegments([...base, 'notes'], tabs)).toBeNull();
    expect(activeTabKeyFromSegments([...base, 'cores'], tabs)).toBeNull();
    expect(activeTabKeyFromSegments([...base, 'backups'], tabs)).toBeNull();
  });
});

describe('sanitizeCoreTabUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(sanitizeCoreTabUrl('https://core.example/app')).toBe('https://core.example/app');
    expect(sanitizeCoreTabUrl('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(sanitizeCoreTabUrl('  https://core.example/y  ')).toBe('https://core.example/y');
  });

  it('rejects non-http schemes, malformed, and empty', () => {
    expect(sanitizeCoreTabUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeCoreTabUrl('data:text/html,<script>')).toBeNull();
    expect(sanitizeCoreTabUrl('file:///etc/passwd')).toBeNull();
    expect(sanitizeCoreTabUrl('not a url')).toBeNull();
    expect(sanitizeCoreTabUrl('')).toBeNull();
    expect(sanitizeCoreTabUrl(undefined)).toBeNull();
    expect(sanitizeCoreTabUrl(42)).toBeNull();
  });
});

describe('lastTabValueForLeaf', () => {
  it('returns the leaf for a legal native tab, null otherwise', () => {
    expect(lastTabValueForLeaf('docs')).toBe('docs');
    expect(lastTabValueForLeaf('chat')).toBe('chat');
    // `documents` is a registry descriptor key, not a persistable route leaf.
    expect(lastTabValueForLeaf('documents')).toBeNull();
    expect(lastTabValueForLeaf('cores')).toBeNull();
    expect(lastTabValueForLeaf('proj_1')).toBeNull();
  });
});
