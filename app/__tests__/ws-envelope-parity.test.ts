/**
 * @neutronai/app — app-ws envelope CONTRACT test (G3, post-L6).
 *
 * Before L6 this was a DRIFT GUARD between `app/lib/ws-envelope.ts` (a
 * hand-written Expo mirror, now DELETED) and the server envelope in
 * `channels/adapters/app-ws/envelope.ts`. L6 collapsed both onto ONE source:
 * the node-free `@neutronai/wire-types` leaf owns the envelope TYPES, the
 * server module re-exports them + keeps the decode/sanitize VALUE helpers, and
 * the Expo app imports the types directly from the leaf. There is no longer a
 * mirror to drift — so this is now a plain import-and-use CONTRACT test: the
 * wire types construct as expected AND the surface decoders behave.
 */

import { describe, expect, it } from 'bun:test';

// The runtime decode/sanitize value helpers still live channel-side (they
// encode wire validation, not the shape) — import them from there.
import {
  decodeAppWsInbound,
  MAX_ATTACHMENT_URL_LEN,
  MAX_ATTACHMENTS_PER_MESSAGE,
  sanitizeAttachments,
} from '@neutronai/channels/adapters/app-ws/envelope';

// The ONE source of the wire types (L6). The app + the server both import
// these from here now.
import type {
  AppWsOutbound,
  AppWsOutboundAgentMessage,
  AppWsOutboundAgentMessagePartial,
  AppWsOutboundUserMessageEcho,
  AppWsInboundUserMessage,
} from '@neutronai/wire-types';

describe('agent_message envelope (wire-types canonical)', () => {
  it('constructs with the canonical option shape', () => {
    const msg: AppWsOutboundAgentMessage = {
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
    expect(msg.body).toBe('hello');
    expect(msg.options?.[0]?.value).toBe('a');
  });

  it('carries a top-level deep_link (ISSUE #18)', () => {
    const msg: AppWsOutboundAgentMessage = {
      v: 1,
      type: 'agent_message',
      body: 'Opening task...',
      message_id: 'm-deep',
      ts: 1,
      deep_link: '/projects/p1/tasks/t1',
    };
    expect(msg.deep_link).toBe('/projects/p1/tasks/t1');
  });
});

describe('agent_message_partial envelope', () => {
  it('is a member of the AppWsOutbound union', () => {
    const msg: AppWsOutbound = {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'mid',
      body_delta: 'x',
      ts: 1,
    };
    expect(msg.type).toBe('agent_message_partial');
    const partial: AppWsOutboundAgentMessagePartial = {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'mid',
      body_delta: 'chunk',
      ts: 1,
      project_id: 'p',
    };
    expect(partial.body_delta).toBe('chunk');
  });
});

describe('user_message echo + inbound', () => {
  it('carries attachments', () => {
    const echo: AppWsOutboundUserMessageEcho = {
      v: 1,
      type: 'user_message',
      user_id: 'u',
      body: 'hi',
      message_id: 'm',
      ts: 1,
      attachments: ['https://cdn/a.png'],
    };
    expect(echo.attachments?.[0]).toBe('https://cdn/a.png');

    const inbound: AppWsInboundUserMessage = {
      v: 1,
      type: 'user_message',
      body: 'q',
      attachments: ['/api/app/upload/foo'],
    };
    expect(inbound.attachments?.[0]).toBe('/api/app/upload/foo');
  });
});

describe('decodeAppWsInbound — attachments handling (channel-side helper)', () => {
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
