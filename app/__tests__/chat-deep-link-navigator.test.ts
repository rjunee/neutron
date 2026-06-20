/**
 * @neutronai/app — ChatDeepLinkNavigator unit tests (ISSUE #18).
 *
 * The navigator component is a thin wrapper around the pure helper
 * `dispatchUnseenDeepLinks(messages, seen, push)`. RN components do not
 * mount under bun-test in this repo (see the comment in
 * `citation-chip-row.test.ts`); we exercise the helper directly and
 * pin the source file to assert the wrapper uses the helper + Expo
 * Router's `useRouter` (not a hand-rolled `router.push` fallback).
 *
 * The test deliberately does NOT import `expo-router` — the helper is
 * router-agnostic (takes a plain `push` callback), so the unit test
 * doesn't pull Expo Router into the bun-test runtime as a hard
 * dependency.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dispatchUnseenDeepLinks } from '../lib/chat-deep-link-dispatch';
import type { ChatMessage } from '../lib/chat-streaming';

function agentMsg(id: string, deep_link?: string): ChatMessage {
  const m: ChatMessage = {
    id,
    kind: 'agent',
    body: `body-${id}`,
    ts: 1,
  };
  if (deep_link !== undefined) m.deep_link = deep_link;
  return m;
}

function userMsg(id: string, deep_link?: string): ChatMessage {
  // user_messages should NEVER drive navigation, even if a stray
  // deep_link is on them (the envelope shape doesn't allow it, but
  // the ChatMessage union is broader).
  const m: ChatMessage = {
    id,
    kind: 'user',
    body: 'hi',
    ts: 1,
  };
  if (deep_link !== undefined) m.deep_link = deep_link;
  return m;
}

describe('dispatchUnseenDeepLinks', () => {
  it('fires exactly one push for a new agent message with deep_link', () => {
    const pushes: string[] = [];
    const seen = new Set<string>();
    const fired = dispatchUnseenDeepLinks(
      [agentMsg('m1', '/projects/p1/tasks/t1')],
      seen,
      (href) => pushes.push(href),
    );
    expect(fired).toBe(1);
    expect(pushes).toEqual(['/projects/p1/tasks/t1']);
    expect(seen.has('m1')).toBe(true);
  });

  it('de-dups across calls with the same seen set (no double-fire on re-render)', () => {
    const pushes: string[] = [];
    const seen = new Set<string>();
    const messages = [agentMsg('m1', '/projects/p1/tasks/t1')];
    dispatchUnseenDeepLinks(messages, seen, (h) => pushes.push(h));
    // Simulate a React re-render: same messages array, same seen ref.
    dispatchUnseenDeepLinks(messages, seen, (h) => pushes.push(h));
    expect(pushes).toEqual(['/projects/p1/tasks/t1']);
  });

  it('fires only the new message when a second deep-link arrives', () => {
    const pushes: string[] = [];
    const seen = new Set<string>();
    dispatchUnseenDeepLinks(
      [agentMsg('m1', '/projects/p1/tasks/t1')],
      seen,
      (h) => pushes.push(h),
    );
    dispatchUnseenDeepLinks(
      [
        agentMsg('m1', '/projects/p1/tasks/t1'),
        agentMsg('m2', '/projects/p1/notes#abc'),
      ],
      seen,
      (h) => pushes.push(h),
    );
    expect(pushes).toEqual(['/projects/p1/tasks/t1', '/projects/p1/notes#abc']);
  });

  it('skips agent messages without deep_link', () => {
    const pushes: string[] = [];
    const seen = new Set<string>();
    const fired = dispatchUnseenDeepLinks(
      [agentMsg('m1'), agentMsg('m2', '/projects/p/x'), agentMsg('m3')],
      seen,
      (h) => pushes.push(h),
    );
    expect(fired).toBe(1);
    expect(pushes).toEqual(['/projects/p/x']);
    expect(seen.has('m1')).toBe(false);
    expect(seen.has('m3')).toBe(false);
  });

  it('ignores deep_link on user / system messages (only agent kind navigates)', () => {
    const pushes: string[] = [];
    const seen = new Set<string>();
    const fired = dispatchUnseenDeepLinks(
      [userMsg('u1', '/projects/p/should-not-fire')],
      seen,
      (h) => pushes.push(h),
    );
    expect(fired).toBe(0);
    expect(pushes).toEqual([]);
  });

  it('fires multiple distinct deep-links in a single call', () => {
    const pushes: string[] = [];
    const seen = new Set<string>();
    const fired = dispatchUnseenDeepLinks(
      [
        agentMsg('m1', '/projects/p/a'),
        agentMsg('m2', '/projects/p/b'),
        agentMsg('m3', '/projects/p/c'),
      ],
      seen,
      (h) => pushes.push(h),
    );
    expect(fired).toBe(3);
    expect(pushes).toEqual(['/projects/p/a', '/projects/p/b', '/projects/p/c']);
  });
});

describe('ChatDeepLinkNavigator component wiring', () => {
  const SRC = readFileSync(
    join(import.meta.dir, '..', 'lib', 'chat-deep-link-navigator.tsx'),
    'utf8',
  );

  it('uses expo-router useRouter (not a hand-rolled navigation primitive)', () => {
    expect(SRC).toMatch(/from\s+['"]expo-router['"]/);
    expect(SRC).toMatch(/useRouter\(\)/);
  });

  it('delegates to dispatchUnseenDeepLinks (the pure helper)', () => {
    expect(SRC).toMatch(/dispatchUnseenDeepLinks\(/);
  });

  it('uses a useRef-backed Set<string> for de-dup', () => {
    expect(SRC).toMatch(/useRef<Set<string>>/);
    expect(SRC).toMatch(/new Set\(\)/);
  });

  it('mounts via useChatState — sources messages from the provider', () => {
    expect(SRC).toMatch(/useChatState\(\)/);
  });
});
