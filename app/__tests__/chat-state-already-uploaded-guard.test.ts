/**
 * @neutronai/app — `isAlreadyUploadedAttachmentUrl` guard (Argus r1
 * BLOCKING #1).
 *
 * Pinpoint test for the predicate `performUpload` uses to short-circuit
 * re-uploads of attachment URIs that the chat surface's upload-modal
 * flow already pushed to the server. Pre-r1 the chat surface would
 * send `{ uri: '/api/app/upload/<user>/<hash>.<ext>' }` back through
 * `send()`, and chat-state would pipe it into `uploadAttachment` again
 * — `buildMultipartBody` only fetches `blob:`/`data:`/`http(s):` URIs,
 * so the relative URL fell into the native-FormData branch and shipped
 * a bogus multipart. The guard below is what makes the second-pass
 * upload a no-op.
 */

import { describe, expect, it } from 'bun:test';

import { isAlreadyUploadedAttachmentUrl } from '../lib/attachment-url';

describe('isAlreadyUploadedAttachmentUrl', () => {
  it('detects relative /api/app/upload/... server URLs', () => {
    expect(isAlreadyUploadedAttachmentUrl('/api/app/upload/sam/abc123.png')).toBe(true);
    expect(isAlreadyUploadedAttachmentUrl('/api/app/upload/test-user/x.jpg')).toBe(true);
  });

  it('detects absolute http/https /api/app/upload/... server URLs', () => {
    expect(
      isAlreadyUploadedAttachmentUrl('https://demo.neutron.example/api/app/upload/u/h.png'),
    ).toBe(true);
    expect(isAlreadyUploadedAttachmentUrl('http://127.0.0.1:7777/api/app/upload/u/h.png')).toBe(
      true,
    );
  });

  it('does NOT trigger on blob: / data: / file: URIs (those still need uploading)', () => {
    expect(isAlreadyUploadedAttachmentUrl('blob:http://localhost:3000/abc')).toBe(false);
    expect(isAlreadyUploadedAttachmentUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isAlreadyUploadedAttachmentUrl('file:///tmp/foo.png')).toBe(false);
  });

  it('does NOT trigger on unrelated /api/... paths', () => {
    // Adjacent endpoints (chat send, project docs) must NOT short-circuit.
    expect(isAlreadyUploadedAttachmentUrl('/api/app/chat/send')).toBe(false);
    expect(isAlreadyUploadedAttachmentUrl('/api/upload/chatgpt')).toBe(false);
    expect(isAlreadyUploadedAttachmentUrl('https://demo.neutron.example/api/app/chat/send')).toBe(
      false,
    );
  });
});
