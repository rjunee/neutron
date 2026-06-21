/**
 * @neutronai/app — `activeTabFromSegments` mapping tests.
 *
 * Locks the Argus IMPORTANT fix (PR #11): the `chat-sync` sub-route must NOT
 * highlight the Chat tab, because the tab bar treats `key === activeTab` as a
 * no-op — a shadowed Chat tab would be un-tappable, stranding the user on
 * chat-sync with no way back to legacy Chat.
 */

import { describe, expect, it } from 'bun:test';

import { activeTabFromSegments } from '../lib/active-tab';

const base = ['projects', '[id]'] as const;

describe('activeTabFromSegments', () => {
  it('highlights a legal tab leaf', () => {
    expect(activeTabFromSegments([...base, 'chat'])).toBe('chat');
    expect(activeTabFromSegments([...base, 'launcher'])).toBe('launcher');
    expect(activeTabFromSegments([...base, 'tasks'])).toBe('tasks');
    expect(activeTabFromSegments([...base, 'reminders'])).toBe('reminders');
    expect(activeTabFromSegments([...base, 'docs'])).toBe('docs');
  });

  it('defaults the bare project route to the chat tab', () => {
    expect(activeTabFromSegments([...base])).toBe('chat');
  });

  it('does NOT shadow/lock the Chat tab on the chat-sync route', () => {
    // The regression: returning 'chat' here highlights Chat AND makes tapping
    // Chat a no-op (key === activeTab) → user cannot return to legacy Chat.
    expect(activeTabFromSegments([...base, 'chat-sync'])).toBeNull();
  });

  it('highlights nothing on the other non-tab sub-routes', () => {
    expect(activeTabFromSegments([...base, 'notes'])).toBeNull();
    expect(activeTabFromSegments([...base, 'cores'])).toBeNull();
    expect(activeTabFromSegments([...base, 'backups'])).toBeNull();
  });

  it('falls back to chat for an unknown deep leaf (no crash on empty)', () => {
    expect(activeTabFromSegments([])).toBe('chat');
  });
});
