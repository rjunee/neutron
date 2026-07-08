/**
 * @neutronai/app — render-model unit tests (the UI's non-React logic).
 *
 * Covers the streaming-fold state machine, the durable↔streaming merge, and
 * the delivery ladder — the bits that make the FlashList surface feel
 * Telegram-grade (live typing bubble + send checkmarks) without a real
 * render.
 */

import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '@neutronai/chat-core';

import {
  buildRenderRows,
  deliveryGlyph,
  deliveryState,
  emptyStreamState,
  foldStreamFrame,
  frameMatchesProject,
  groupReactions,
} from '../lib/chat-core/chat-render-model';

function userMsg(p: Partial<ChatMessage> & { client_msg_id: string }): ChatMessage {
  return {
    topic_id: 'app:sam',
    message_id: null,
    seq: null,
    role: 'user',
    body: 'hi',
    project_id: null,
    attachments: null,
    created_at: 1,
    status: 'queued',
    ...p,
  };
}
function agentMsg(p: Partial<ChatMessage> & { message_id: string }): ChatMessage {
  return {
    topic_id: 'app:sam',
    client_msg_id: '',
    seq: 1,
    role: 'agent',
    body: 'reply',
    project_id: null,
    attachments: null,
    created_at: 2,
    status: 'acked',
    ...p,
  };
}

describe('foldStreamFrame', () => {
  it('assembles successive partials into one growing buffer + sets typing', () => {
    let s = emptyStreamState();
    s = foldStreamFrame(s, { type: 'agent_message_partial', message_id: 'a1', body_delta: 'Hel', ts: 1 });
    s = foldStreamFrame(s, { type: 'agent_message_partial', message_id: 'a1', body_delta: 'lo', ts: 2 });
    expect(s.typing).toBe(true);
    expect(s.buffers['a1']?.body).toBe('Hello');
    expect(s.buffers['a1']?.started_at).toBe(1); // first-seen ts preserved
  });

  it('clears the buffer + drops typing when the final agent_message lands', () => {
    let s = emptyStreamState();
    s = foldStreamFrame(s, { type: 'agent_message_partial', message_id: 'a1', body_delta: 'Hi', ts: 1 });
    s = foldStreamFrame(s, { type: 'agent_message', message_id: 'a1', body: 'Hi there', ts: 3 });
    expect(s.typing).toBe(false);
    expect(s.buffers['a1']).toBeUndefined();
  });

  it('keeps typing while a second stream is still in flight', () => {
    let s = emptyStreamState();
    s = foldStreamFrame(s, { type: 'agent_message_partial', message_id: 'a1', body_delta: 'one', ts: 1 });
    s = foldStreamFrame(s, { type: 'agent_message_partial', message_id: 'a2', body_delta: 'two', ts: 2 });
    s = foldStreamFrame(s, { type: 'agent_message', message_id: 'a1', body: 'one done', ts: 3 });
    expect(s.typing).toBe(true);
    expect(s.buffers['a2']?.body).toBe('two');
  });

  it('returns the same reference for irrelevant frames', () => {
    const s = emptyStreamState();
    expect(foldStreamFrame(s, { type: 'session_ready' })).toBe(s);
    expect(foldStreamFrame(s, { type: 'user_message', message_id: 'u1' })).toBe(s);
    expect(foldStreamFrame(s, null)).toBe(s);
  });
});

describe('buildRenderRows', () => {
  it('appends live streaming bubbles after the durable transcript', () => {
    const messages = [userMsg({ client_msg_id: 'c1', body: 'q', status: 'acked' })];
    let s = emptyStreamState();
    s = foldStreamFrame(s, { type: 'agent_message_partial', message_id: 'a1', body_delta: 'typing…', ts: 1 });
    const rows = buildRenderRows(messages, s);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'streaming']);
    expect(rows[1]).toMatchObject({ kind: 'streaming', message_id: 'a1', body: 'typing…' });
  });

  it('drops a streaming bubble once its durable message has landed', () => {
    const messages = [agentMsg({ message_id: 'a1', body: 'final' })];
    let s = emptyStreamState();
    // Buffer still present (race: final persisted before fold cleared it).
    s = foldStreamFrame(s, { type: 'agent_message_partial', message_id: 'a1', body_delta: 'fin', ts: 1 });
    const rows = buildRenderRows(messages, s);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ kind: 'message' });
  });

  it('produces stable, unique keys', () => {
    const messages = [
      userMsg({ client_msg_id: 'c1' }),
      agentMsg({ message_id: 'a1' }),
    ];
    const rows = buildRenderRows(messages, emptyStreamState());
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['c:c1', 'm:a1']);
  });
});

describe('frameMatchesProject', () => {
  const partial = (project_id?: string) => ({
    v: 1,
    type: 'agent_message_partial',
    message_id: 'a1',
    body_delta: 'hi',
    ts: 1,
    ...(project_id !== undefined ? { project_id } : {}),
  });

  it('a project view keeps only its own tagged stream', () => {
    expect(frameMatchesProject(partial('proj-1'), 'proj-1')).toBe(true);
    // Regression (Codex P2): a sibling project's stream must be dropped so it
    // never renders in this project's chat.
    expect(frameMatchesProject(partial('proj-2'), 'proj-1')).toBe(false);
    // An untagged stream is the global transcript's, not this project's.
    expect(frameMatchesProject(partial(undefined), 'proj-1')).toBe(false);
  });

  it('the global (empty projectId) view keeps only untagged streams', () => {
    expect(frameMatchesProject(partial(undefined), '')).toBe(true);
    expect(frameMatchesProject(partial(''), '')).toBe(true);
    expect(frameMatchesProject(partial('proj-1'), '')).toBe(false);
  });

  it('passes through non-object frames (fold ignores them anyway)', () => {
    expect(frameMatchesProject(null, 'proj-1')).toBe(true);
    expect(frameMatchesProject('nope', 'proj-1')).toBe(true);
  });
});

describe('deliveryState', () => {
  it('maps user send status to the checkmark ladder', () => {
    expect(deliveryState(userMsg({ client_msg_id: 'c', status: 'queued' }))).toBe('pending');
    expect(deliveryState(userMsg({ client_msg_id: 'c', status: 'sent' }))).toBe('sent');
    expect(deliveryState(userMsg({ client_msg_id: 'c', status: 'acked' }))).toBe('delivered');
  });

  it('returns null for agent messages (no outbound ticks)', () => {
    expect(deliveryState(agentMsg({ message_id: 'a1' }))).toBeNull();
  });

  it('promotes acked → read when read by another device/agent (Track B Phase 4)', () => {
    expect(
      deliveryState(userMsg({ client_msg_id: 'c', status: 'acked', read_by: ['agent'] })),
    ).toBe('read');
    expect(
      deliveryState(userMsg({ client_msg_id: 'c', status: 'acked', read_by: ['devB'] }), 'devA'),
    ).toBe('read');
  });

  it('excludes the sender’s own device from the read set', () => {
    // read_by only contains self → still just delivered, not read.
    expect(
      deliveryState(userMsg({ client_msg_id: 'c', status: 'acked', read_by: ['devA'] }), 'devA'),
    ).toBe('delivered');
  });

  it('a queued/sent message ignores receipts', () => {
    expect(
      deliveryState(userMsg({ client_msg_id: 'c', status: 'sent', read_by: ['agent'] })),
    ).toBe('sent');
  });

  it('glyphs escalate pending → sent → delivered → read (read shares ✓✓)', () => {
    expect(deliveryGlyph('pending')).toBe('🕓');
    expect(deliveryGlyph('sent')).toBe('✓');
    expect(deliveryGlyph('delivered')).toBe('✓✓');
    expect(deliveryGlyph('read')).toBe('✓✓');
  });
});

describe('groupReactions (Track B Phase 4)', () => {
  it('groups a message’s reactions into per-emoji chips with a self flag', () => {
    const chips = groupReactions(
      agentMsg({
        message_id: 'a1',
        reactions: [
          { emoji: '👍', device_id: 'devA' },
          { emoji: '👍', device_id: 'self' },
          { emoji: '❤️', device_id: 'devB' },
        ],
      }),
      'self',
    );
    expect(chips).toEqual([
      { emoji: '👍', count: 2, reactedBySelf: true },
      { emoji: '❤️', count: 1, reactedBySelf: false },
    ]);
  });

  it('returns [] for a message with no reactions', () => {
    expect(groupReactions(agentMsg({ message_id: 'a1' }))).toEqual([]);
  });
});
