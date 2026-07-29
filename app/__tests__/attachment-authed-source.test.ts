/**
 * @neutronai/app — `resolveAttachmentSource` / `isAuthedAttachmentUrl`
 * (M1 E2E round 5 — native attachment render parity).
 *
 * BUG (pre-fix): the gateway echoes a sent image back as a RELATIVE,
 * bearer-authed URL (`/api/app/upload/<user>/<hash>.<ext>`,
 * `gateway/http/app-upload-surface.ts:283`). `reconcileEcho`
 * (`chat-streaming.ts:237`) swaps the optimistic local `file://` uri for
 * that URL, and `MessageItem` rendered `<Image source={{ uri }}>` with no
 * host and no `Authorization` header — so the GET 401s (the upload surface
 * honors only `Authorization: Bearer`) and the user's OWN image shows as a
 * broken thumbnail. The web client already handled this
 * (`landing/chat-react/ChatApp.tsx`); native had no equivalent.
 *
 * FIX: `resolveAttachmentSource` resolves our authed attachment URLs
 * against the gateway `base_url` and attaches the bearer header; everything
 * else passes through untouched.
 */

import { describe, expect, it } from 'bun:test';

import {
  attachmentBasename,
  isAuthedAttachmentUrl,
  isImageAttachmentUrl,
  resolveAttachmentSource,
} from '../lib/attachment-url';

const CTX = { base_url: 'http://127.0.0.1:8080', token: 'tok-abc' };

describe('isAuthedAttachmentUrl', () => {
  it('treats a relative /api/app/upload/... path as ours (always authed)', () => {
    expect(isAuthedAttachmentUrl('/api/app/upload/sam/abc.png')).toBe(true);
  });

  it('treats a same-origin absolute upload URL as authed', () => {
    expect(
      isAuthedAttachmentUrl('http://127.0.0.1:8080/api/app/upload/sam/abc.png', 'http://127.0.0.1:8080'),
    ).toBe(true);
  });

  it('REFUSES a cross-origin absolute upload URL (bearer must not leak)', () => {
    expect(
      isAuthedAttachmentUrl('https://evil.example/api/app/upload/x.png', 'http://127.0.0.1:8080'),
    ).toBe(false);
  });

  it('refuses an absolute upload URL when the origin is unknown (fail closed)', () => {
    expect(isAuthedAttachmentUrl('http://127.0.0.1:8080/api/app/upload/sam/abc.png')).toBe(false);
  });

  it('does not treat data:/external/unrelated URLs as authed', () => {
    expect(isAuthedAttachmentUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isAuthedAttachmentUrl('https://cdn.example/pic.png', 'http://127.0.0.1:8080')).toBe(false);
    expect(isAuthedAttachmentUrl('/api/app/chat/send')).toBe(false);
  });
});

describe('resolveAttachmentSource', () => {
  it('THE FIX: a relative authed URL gets an absolute URI + bearer header', () => {
    const src = resolveAttachmentSource('/api/app/upload/sam/abc.png', CTX);
    expect(src.uri).toBe('http://127.0.0.1:8080/api/app/upload/sam/abc.png');
    expect(src.headers).toEqual({ Authorization: 'Bearer tok-abc' });
  });

  it('CONTROL: the raw relative URL (what the pre-fix renderer used) has no host and no auth — it would 401', () => {
    // What MessageItem rendered before the fix: source = { uri: <relative> }.
    const prefix = '/api/app/upload/sam/abc.png';
    expect(prefix.startsWith('http')).toBe(false); // host-less → RN <Image> cannot resolve
    // The resolver repairs exactly this case:
    const fixed = resolveAttachmentSource(prefix, CTX);
    expect(fixed.uri.startsWith('http://127.0.0.1:8080/')).toBe(true);
    expect(fixed.headers?.Authorization).toBe('Bearer tok-abc');
  });

  it('tolerates a base_url with a trailing slash (no double slash)', () => {
    const src = resolveAttachmentSource('/api/app/upload/sam/abc.png', {
      base_url: 'http://127.0.0.1:8080/',
      token: 'tok-abc',
    });
    expect(src.uri).toBe('http://127.0.0.1:8080/api/app/upload/sam/abc.png');
  });

  it('attaches the bearer to a same-origin absolute upload URL without rewriting it', () => {
    const abs = 'http://127.0.0.1:8080/api/app/upload/sam/abc.png';
    const src = resolveAttachmentSource(abs, CTX);
    expect(src.uri).toBe(abs);
    expect(src.headers).toEqual({ Authorization: 'Bearer tok-abc' });
  });

  it('passes data:/blob:/external URLs through with NO header', () => {
    expect(resolveAttachmentSource('data:image/png;base64,iVBORw0KGgo=', CTX)).toEqual({
      uri: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(resolveAttachmentSource('https://cdn.example/pic.png', CTX)).toEqual({
      uri: 'https://cdn.example/pic.png',
    });
  });

  it('does NOT send the bearer to a cross-origin upload URL', () => {
    const src = resolveAttachmentSource('https://evil.example/api/app/upload/x.png', CTX);
    expect(src.headers).toBeUndefined();
  });

  it('passes through unchanged when there is no session (null ctx)', () => {
    expect(resolveAttachmentSource('/api/app/upload/sam/abc.png', null)).toEqual({
      uri: '/api/app/upload/sam/abc.png',
    });
  });
});

// Argus r2 BLOCKER #1 — the mobile bubble must branch image-vs-document so a
// PDF renders as a file chip, not a broken <Image>. These predicates drive that
// branch (`app/components/AuthedAttachmentImage.tsx`).
describe('isImageAttachmentUrl', () => {
  it('is true for image extensions (authed upload URLs)', () => {
    for (const u of [
      '/api/app/upload/sam/abc.png',
      '/api/app/upload/sam/abc.jpg',
      '/api/app/upload/sam/abc.jpeg',
      '/api/app/upload/sam/abc.gif',
      '/api/app/upload/sam/abc.webp',
      'http://127.0.0.1:8080/api/app/upload/sam/abc.png?v=1',
    ]) {
      expect(isImageAttachmentUrl(u)).toBe(true);
    }
  });

  it('is true for a data:image/ URL', () => {
    expect(isImageAttachmentUrl('data:image/png;base64,AAAA')).toBe(true);
  });

  it('is FALSE for a PDF (routes to the file chip, not <Image>)', () => {
    expect(isImageAttachmentUrl('/api/app/upload/sam/abc.pdf')).toBe(false);
    expect(isImageAttachmentUrl('http://127.0.0.1:8080/api/app/upload/sam/abc.pdf')).toBe(false);
  });

  it('is FALSE for a non-image data URL', () => {
    expect(isImageAttachmentUrl('data:application/pdf;base64,AAAA')).toBe(false);
  });
});

describe('attachmentBasename', () => {
  it('strips the path and any query/hash', () => {
    expect(attachmentBasename('/api/app/upload/sam/deadbeef.pdf')).toBe('deadbeef.pdf');
    expect(attachmentBasename('http://127.0.0.1:8080/api/app/upload/sam/x.pdf?v=2#p')).toBe('x.pdf');
  });

  it('decodes percent-escapes but never throws on a malformed one', () => {
    expect(attachmentBasename('/x/report%20final.pdf')).toBe('report final.pdf');
    // Malformed escape → decodeURIComponent throws; we fall back to the raw
    // segment rather than crashing the chat view.
    expect(attachmentBasename('/x/report%ZZ.pdf')).toBe('report%ZZ.pdf');
  });

  it('falls back to "attachment" for an empty basename', () => {
    expect(attachmentBasename('/api/app/upload/sam/')).toBe('attachment');
  });
});
