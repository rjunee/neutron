/**
 * @neutronai/app — chat-streaming reducer unit tests (P5.1).
 *
 * Pure-function coverage of the message-list lifecycle:
 *   - streaming partials assemble into a single message with cursor
 *   - canonical agent_message finalizes the buffer + attaches metadata
 *   - optimistic user-send + echo reconcile correctly
 *   - failed send + retry flip the bubble state
 *   - cross-message partials do not pollinate each other
 */

import { describe, expect, it } from 'bun:test';

import {
  addOptimisticUserMessage,
  appendPartial,
  chatReducer,
  EMPTY_CHAT_STATE,
  finalizeMessage,
  markSendFailed,
  markSendRetrying,
  reconcileEcho,
  recordChoice,
  type ChatState,
} from '../lib/chat-streaming';
import type {
  AppWsOutboundAgentMessage,
  AppWsOutboundAgentMessagePartial,
  AppWsOutboundUserMessageEcho,
} from '../lib/ws-envelope';

function makePartial(message_id: string, body_delta: string): AppWsOutboundAgentMessagePartial {
  return { v: 1, type: 'agent_message_partial', message_id, body_delta, ts: 1 };
}

function makeAgent(message_id: string, body: string, opts: Partial<AppWsOutboundAgentMessage> = {}): AppWsOutboundAgentMessage {
  return { v: 1, type: 'agent_message', message_id, body, ts: 1, ...opts };
}

function makeEcho(message_id: string, body: string, client_msg_id?: string): AppWsOutboundUserMessageEcho {
  return {
    v: 1,
    type: 'user_message',
    user_id: 'user-1',
    body,
    message_id,
    ts: 1,
    ...(client_msg_id !== undefined ? { client_msg_id } : {}),
  };
}

describe('appendPartial', () => {
  it('creates a new streaming message on the first partial', () => {
    const next = appendPartial(EMPTY_CHAT_STATE, makePartial('m1', 'Hel'));
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.body).toBe('Hel');
    expect(next.messages[0]!.kind).toBe('agent');
    expect(next.messages[0]!.streaming).toBe(true);
  });

  it('concatenates successive partials with the same message_id', () => {
    let state: ChatState = EMPTY_CHAT_STATE;
    state = appendPartial(state, makePartial('m1', 'Hel'));
    state = appendPartial(state, makePartial('m1', 'lo, '));
    state = appendPartial(state, makePartial('m1', 'world.'));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.body).toBe('Hello, world.');
    expect(state.messages[0]!.streaming).toBe(true);
  });

  it('does not cross-pollinate partials with different message_ids', () => {
    let state: ChatState = EMPTY_CHAT_STATE;
    state = appendPartial(state, makePartial('m1', 'foo'));
    state = appendPartial(state, makePartial('m2', 'bar'));
    state = appendPartial(state, makePartial('m1', 'baz'));
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]!.body).toBe('foobaz');
    expect(state.messages[1]!.body).toBe('bar');
  });
});

describe('finalizeMessage', () => {
  it('replaces an in-progress buffer with the canonical body and clears streaming', () => {
    let state: ChatState = EMPTY_CHAT_STATE;
    state = appendPartial(state, makePartial('m1', 'partial'));
    state = finalizeMessage(state, makeAgent('m1', 'Final body', {
      options: [{ label: 'Yes', body: 'Yes', value: 'yes' }],
      prompt_id: 'p1',
    }));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.body).toBe('Final body');
    expect(state.messages[0]!.streaming).toBe(false);
    expect(state.messages[0]!.options).toHaveLength(1);
    expect(state.messages[0]!.prompt_id).toBe('p1');
  });

  it('renders an atomic agent_message when no prior partials arrived', () => {
    const state = finalizeMessage(EMPTY_CHAT_STATE, makeAgent('m9', 'atomic body'));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.body).toBe('atomic body');
    expect(state.messages[0]!.streaming).toBe(false);
  });

  it('preserves agent metadata fields (citations / image_urls / doc_refs / kind)', () => {
    const agent = makeAgent('m2', 'with meta', {
      citations: [{ title: 'arxiv', url: 'https://arxiv.org/abs/1' }],
      image_urls: ['https://cdn/img.png'],
      doc_refs: [{ label: 'l', url: 'neutron://docs/foo', project_id: 'p', path: 'foo' }],
      kind: 'image-gallery',
      allow_freeform: true,
    });
    const state = finalizeMessage(EMPTY_CHAT_STATE, agent);
    const m = state.messages[0]!;
    expect(m.citations).toHaveLength(1);
    expect(m.image_urls).toHaveLength(1);
    expect(m.doc_refs).toHaveLength(1);
    expect(m.prompt_kind).toBe('image-gallery');
    expect(m.allow_freeform).toBe(true);
  });
});

describe('addOptimisticUserMessage + reconcileEcho', () => {
  it('stages a pending bubble and reconciles on echo with matching client_msg_id', () => {
    let state: ChatState = EMPTY_CHAT_STATE;
    state = addOptimisticUserMessage(state, { id: 'cmid-1', body: 'hello', ts: 1 });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.pending).toBe(true);
    expect(state.messages[0]!.kind).toBe('user');

    state = reconcileEcho(state, makeEcho('canonical-id', 'hello', 'cmid-1'));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.id).toBe('canonical-id');
    expect(state.messages[0]!.pending).toBe(false);
  });

  it('back-fills an echo with no matching pending bubble', () => {
    const state = reconcileEcho(EMPTY_CHAT_STATE, makeEcho('m1', 'other-tab body'));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.kind).toBe('user');
    expect(state.messages[0]!.id).toBe('m1');
    expect(state.messages[0]!.pending).toBe(false);
  });

  it('deduplicates double-echoes from a stale socket', () => {
    let state = reconcileEcho(EMPTY_CHAT_STATE, makeEcho('m1', 'body'));
    state = reconcileEcho(state, makeEcho('m1', 'body'));
    expect(state.messages).toHaveLength(1);
  });
});

describe('markSendFailed / markSendRetrying', () => {
  it('marks a pending bubble as failed', () => {
    let state = addOptimisticUserMessage(EMPTY_CHAT_STATE, { id: 'cmid-2', body: 'q', ts: 1 });
    state = markSendFailed(state, 'cmid-2');
    expect(state.messages[0]!.failed).toBe(true);
    expect(state.messages[0]!.pending).toBe(false);
  });

  it('flips a failed bubble back to retrying', () => {
    let state = addOptimisticUserMessage(EMPTY_CHAT_STATE, { id: 'cmid-3', body: 'q', ts: 1 });
    state = markSendFailed(state, 'cmid-3');
    state = markSendRetrying(state, 'cmid-3');
    expect(state.messages[0]!.failed).toBe(false);
    expect(state.messages[0]!.pending).toBe(true);
  });
});

describe('apply_agent_message — deep_link preservation (ISSUE #18)', () => {
  it('preserves top-level deep_link onto the ChatMessage', () => {
    const state = chatReducer(EMPTY_CHAT_STATE, {
      type: 'apply_agent_message',
      agent: makeAgent('m-deep-1', 'Opening task...', {
        deep_link: '/projects/p1/tasks/t1',
      }),
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.deep_link).toBe('/projects/p1/tasks/t1');
    expect(state.messages[0]!.kind).toBe('agent');
  });

  it('leaves deep_link undefined when envelope omits the field', () => {
    const state = chatReducer(EMPTY_CHAT_STATE, {
      type: 'apply_agent_message',
      agent: makeAgent('m-no-deep', 'no link'),
    });
    expect(state.messages[0]!.deep_link).toBeUndefined();
  });

  it('preserves deep_link when finalising a previously-streamed buffer', () => {
    let state: ChatState = EMPTY_CHAT_STATE;
    state = chatReducer(state, { type: 'apply_partial', partial: makePartial('m-deep-2', 'Open') });
    state = chatReducer(state, {
      type: 'apply_agent_message',
      agent: makeAgent('m-deep-2', 'Opening task...', { deep_link: '/projects/p2/tasks/t2' }),
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.deep_link).toBe('/projects/p2/tasks/t2');
    expect(state.messages[0]!.streaming).toBe(false);
  });
});

describe('recordChoice', () => {
  it('stamps the chosen value onto an agent message', () => {
    let state = finalizeMessage(EMPTY_CHAT_STATE, makeAgent('m1', 'pick one', {
      options: [
        { label: 'Yes', body: 'Yes', value: 'yes' },
        { label: 'No', body: 'No', value: 'no' },
      ],
    }));
    state = recordChoice(state, 'm1', 'yes');
    expect(state.messages[0]!.chosen_value).toBe('yes');
  });
});

describe('chatReducer', () => {
  it('routes every action through the correct helper', () => {
    let state: ChatState = EMPTY_CHAT_STATE;
    state = chatReducer(state, { type: 'append_system', body: 'connected', ts: 1 });
    state = chatReducer(state, { type: 'add_optimistic_user', id: 'c1', body: 'hi', ts: 2 });
    state = chatReducer(state, { type: 'apply_partial', partial: makePartial('m1', 'a') });
    state = chatReducer(state, { type: 'apply_partial', partial: makePartial('m1', 'b') });
    state = chatReducer(state, { type: 'apply_agent_message', agent: makeAgent('m1', 'final', { options: [{ label: 'L', body: 'L', value: 'v' }] }) });
    state = chatReducer(state, { type: 'apply_user_echo', echo: makeEcho('canon', 'hi', 'c1') });
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0]!.kind).toBe('system');
    // Optimistic user-send sits at index 1; reconcileEcho rewrites its id.
    expect(state.messages[1]!.id).toBe('canon');
    expect(state.messages[1]!.kind).toBe('user');
    // The streaming agent message lands at index 2 and finalizes there.
    expect(state.messages[2]!.body).toBe('final');
    expect(state.messages[2]!.streaming).toBe(false);
  });

  it('resets the buffer on `reset`', () => {
    let state: ChatState = EMPTY_CHAT_STATE;
    state = chatReducer(state, { type: 'append_system', body: 'a', ts: 1 });
    state = chatReducer(state, { type: 'reset' });
    expect(state.messages).toHaveLength(0);
  });
});
