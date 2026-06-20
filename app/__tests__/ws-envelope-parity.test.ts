/**
 * @neutronai/app — ws-envelope parity tests (P5.1).
 *
 * Guards against drift between `app/lib/ws-envelope.ts` (Expo-side
 * mirror) and `channels/adapters/app-ws/envelope.ts` (server). The
 * Expo workspace is a separate bun workspace + the channels package
 * depends on `node:sqlite`, so we cannot import the server module
 * here — instead, we hand-test that each known envelope kind round-
 * trips through both representations identically.
 *
 * Bidirectional structural-equivalence trick: build a value typed as
 * the Expo type, assign it to the channels type, and back. TS
 * surfaces drift at compile time (caught by `bunx tsc --noEmit` in
 * the verify gate); these runtime assertions cover the JSON shape
 * the WS adapter actually sends + the surface decoder ingests.
 */

import { describe, expect, it } from 'bun:test';

import {
  decodeAppWsInbound,
  MAX_ATTACHMENT_URL_LEN,
  MAX_ATTACHMENTS_PER_MESSAGE,
  sanitizeAttachments,
} from '../../channels/adapters/app-ws/envelope';
import type {
  AppWsOutbound as ServerOutbound,
  AppWsOutboundAgentMessage as ServerAgentMessage,
  AppWsOutboundAgentMessagePartial as ServerAgentMessagePartial,
  AppWsOutboundUserMessageEcho as ServerUserEcho,
  AppWsInboundUserMessage as ServerInbound,
} from '../../channels/adapters/app-ws/envelope';

import type {
  AppWsOutbound,
  AppWsOutboundAgentMessage,
  AppWsOutboundAgentMessagePartial,
  AppWsOutboundUserMessageEcho,
  AppWsInboundUserMessage,
} from '../lib/ws-envelope';

describe('agent_message envelope', () => {
  it('round-trips between Expo + server types', () => {
    const expo: AppWsOutboundAgentMessage = {
      v: 1,
      type: 'agent_message',
      body: 'hello',
      message_id: 'mid',
      ts: 1,
      options: [{ label: 'A', body: 'A', value: 'a' }],
      allow_freeform: false,
      kind: 'buttons',
      citations: [{ title: 't', url: 'https://x' }],
      image_urls: ['https://cdn/i.png'],
      doc_refs: [{ label: 'l', url: 'neutron://docs/x', project_id: 'p', path: 'x' }],
      project_id: 'p',
    };
    const server: ServerAgentMessage = expo;
    const back: AppWsOutboundAgentMessage = server;
    expect(back.body).toBe('hello');
    expect(back.options?.[0]?.value).toBe('a');
  });

  it('declares deep_link?: string on BOTH sides (ISSUE #18)', () => {
    // Build a value typed as the Expo envelope WITH deep_link populated;
    // assign across the type boundary in both directions. If either side
    // drops `deep_link` from `AppWsOutboundAgentMessage`, this round-trip
    // fails at compile time (caught by `bunx tsc --noEmit` in CI) AND
    // the runtime equality assertion below fails.
    const expo: AppWsOutboundAgentMessage = {
      v: 1,
      type: 'agent_message',
      body: 'Opening task...',
      message_id: 'm-deep',
      ts: 1,
      deep_link: '/projects/p1/tasks/t1',
    };
    const server: ServerAgentMessage = expo;
    const back: AppWsOutboundAgentMessage = server;
    expect(back.deep_link).toBe('/projects/p1/tasks/t1');
    expect(server.deep_link).toBe('/projects/p1/tasks/t1');
  });
});

describe('agent_message_partial envelope', () => {
  it('mirrors on both sides (P5.1 new wire shape)', () => {
    const expo: AppWsOutboundAgentMessagePartial = {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'mid',
      body_delta: 'chunk',
      ts: 1,
      project_id: 'p',
    };
    const server: ServerAgentMessagePartial = expo;
    const back: AppWsOutboundAgentMessagePartial = server;
    expect(back.body_delta).toBe('chunk');
  });

  it('is a member of the AppWsOutbound union on both sides', () => {
    const expo: AppWsOutbound = {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'mid',
      body_delta: 'x',
      ts: 1,
    };
    const server: ServerOutbound = expo;
    expect(server.type).toBe('agent_message_partial');
  });
});

describe('user_message echo + inbound', () => {
  it('carries attachments on both sides', () => {
    const echo_expo: AppWsOutboundUserMessageEcho = {
      v: 1,
      type: 'user_message',
      user_id: 'u',
      body: 'hi',
      message_id: 'm',
      ts: 1,
      attachments: ['https://cdn/a.png'],
    };
    const echo_server: ServerUserEcho = echo_expo;
    const echo_back: AppWsOutboundUserMessageEcho = echo_server;
    expect(echo_back.attachments?.[0]).toBe('https://cdn/a.png');

    const inbound_expo: AppWsInboundUserMessage = {
      v: 1,
      type: 'user_message',
      body: 'q',
      attachments: ['/api/app/upload/foo'],
    };
    const inbound_server: ServerInbound = inbound_expo;
    expect(inbound_server.attachments?.[0]).toBe('/api/app/upload/foo');
  });
});

describe('decodeAppWsInbound — attachments handling', () => {
  it('accepts a well-formed attachments array', () => {
    const inbound = decodeAppWsInbound({
      v: 1,
      type: 'user_message',
      body: 'hi',
      attachments: ['https://cdn/a.png', '/api/app/upload/b'],
    });
    expect(inbound).not.toBeNull();
    expect(inbound?.attachments).toEqual(['https://cdn/a.png', '/api/app/upload/b']);
  });

  it('silently drops attachments that exceed the per-message cap', () => {
    const big = new Array(MAX_ATTACHMENTS_PER_MESSAGE + 1).fill('https://x/y.png');
    const inbound = decodeAppWsInbound({
      v: 1,
      type: 'user_message',
      body: 'hi',
      attachments: big,
    });
    expect(inbound).not.toBeNull();
    expect(inbound?.attachments).toBeUndefined();
  });

  it('silently drops attachments with URLs over the per-entry cap', () => {
    const huge = 'https://x/' + 'a'.repeat(MAX_ATTACHMENT_URL_LEN + 1);
    const inbound = decodeAppWsInbound({
      v: 1,
      type: 'user_message',
      body: 'hi',
      attachments: [huge],
    });
    expect(inbound).not.toBeNull();
    expect(inbound?.attachments).toBeUndefined();
  });

  it('rejects unsafe URL schemes (javascript: / mailto:)', () => {
    expect(sanitizeAttachments(['javascript:alert(1)'])).toBeNull();
    expect(sanitizeAttachments(['mailto:foo@bar'])).toBeNull();
  });
});
