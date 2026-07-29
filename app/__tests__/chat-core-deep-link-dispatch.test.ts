/**
 * @neutronai/app — deep-link dispatch over the chat-core transcript (ISSUE #18,
 * ported to the collapsed Telegram-grade surface). Replaces the legacy
 * `chat-deep-link-navigator` test; the helper now keys on chat-core's
 * `message_id` / `role` / `deep_link` fields instead of the deleted
 * `chat-streaming` shape.
 */

import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '@neutronai/chat-core';

import { dispatchUnseenDeepLinks } from '../lib/chat-core/deep-link-dispatch';

function m(p: Partial<ChatMessage> & { message_id: string | null }): ChatMessage {
  return {
    topic_id: 'app:u',
    client_msg_id: p.message_id ?? 'c',
    seq: 1,
    role: 'agent',
    body: 'hi',
    project_id: null,
    attachments: null,
    created_at: 0,
    status: 'acked',
    ...p,
  };
}

describe('dispatchUnseenDeepLinks (chat-core)', () => {
  it('fires each agent deep_link exactly once and records it in `seen`', () => {
    const seen = new Set<string>();
    const fired: string[] = [];
    const messages = [
      m({ message_id: 'a', deep_link: 'neutron://docs/a' }),
      m({ message_id: 'b' }), // no deep_link → ignored
      m({ message_id: 'c', role: 'user', deep_link: 'neutron://x' }), // user → ignored
      m({ message_id: 'd', deep_link: 'neutron://docs/d' }),
    ];
    expect(dispatchUnseenDeepLinks(messages, seen, (h) => fired.push(h))).toBe(2);
    expect(fired).toEqual(['neutron://docs/a', 'neutron://docs/d']);
    // Idempotent: a re-render with the same (messages, seen) fires nothing new.
    expect(dispatchUnseenDeepLinks(messages, seen, (h) => fired.push(h))).toBe(0);
    expect(fired).toEqual(['neutron://docs/a', 'neutron://docs/d']);
  });

  it('ignores an agent deep_link with no server message_id (un-acked / optimistic)', () => {
    const seen = new Set<string>();
    const fired: string[] = [];
    dispatchUnseenDeepLinks([m({ message_id: null, deep_link: 'neutron://x' })], seen, (h) => fired.push(h));
    expect(fired).toEqual([]);
  });
});
