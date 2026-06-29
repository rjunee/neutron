/**
 * @neutronai/app — retry-with-attachments re-upload regression
 * (M1 round-6 E2E find-AND-fix).
 *
 * BUG (pre-fix): `chat-state.tsx:retry()` re-sent the optimistic bubble's
 * stored `attachments` verbatim. Those are the raw *local* device URIs
 * (`file://`/`content://`/`ph://`) — only a SUCCESSFUL echo swaps them for
 * the gateway `/api/app/upload/...` URL via `reconcileEcho`, and a failed
 * send never echoed. retry() never re-uploaded (only `send()` called
 * `performUpload`), so it shipped local URIs to the gateway, whose
 * `sanitizeAttachments` rejects the WHOLE array unless every entry is
 * `https?://`- or `/`-prefixed → image-only retry 400s (`missing_body`)
 * and a text+image retry silently drops the image.
 *
 * FIX: `retry()` routes `target.attachments` through
 * `resolveSendableAttachments(..., performUpload)` (the same upload step
 * `send()` uses, which no-ops already-uploaded URLs) so the gateway only
 * ever sees URLs it accepts.
 *
 * Convention note (matching `comments-side-pane.test.tsx`): the app
 * bun:test suite does NOT mount React Native, so we cover the load-bearing
 * pure logic — `resolveSendableAttachments` — and assert the contract
 * against the REAL gateway sanitizer (`sanitizeAttachments`) as the oracle,
 * with a CONTROL that reproduces the pre-fix rejection. The JSX/touch
 * wiring (tap "Retry") is covered by the agent-browser smoke pass.
 */

import { describe, expect, it } from 'bun:test';

// Oracle: the actual gateway-side sanitizer the surface runs every
// inbound `attachments` array through.
import { sanitizeAttachments } from '../../channels/adapters/app-ws/envelope';
import {
  isAlreadyUploadedAttachmentUrl,
  resolveSendableAttachments,
} from '../lib/attachment-url';

/**
 * Stand-in for `chat-state.tsx:performUpload`: returns the input URL
 * unchanged when it is already an uploaded server URL (mirrors the
 * `isAlreadyUploadedAttachmentUrl` short-circuit), otherwise "uploads" it
 * and hands back a relative `/api/app/upload/...` URL.
 */
async function fakeUpload(atts: ReadonlyArray<{ uri: string }>): Promise<string[]> {
  return atts.map((a, i) =>
    isAlreadyUploadedAttachmentUrl(a.uri)
      ? a.uri
      : `/api/app/upload/test-user/hash${i}.png`,
  );
}

const LOCAL_URIS = [
  'file:///var/mobile/Containers/Data/Application/X/tmp/img.png',
  'content://media/external/images/media/42',
  'ph://CC95F08C-88C3-4012-9D6D-64A413D254B3/L0/001',
] as const;

describe('CONTROL — pre-fix retry shipped local URIs the gateway rejects', () => {
  it('every local device URI is rejected wholesale by sanitizeAttachments', () => {
    for (const uri of LOCAL_URIS) {
      // The pre-fix retry passed `[uri]` straight through → gateway drops
      // the entire array → image-only send becomes an empty body.
      expect(sanitizeAttachments([uri])).toBeNull();
    }
  });

  it('one bad (local) entry drops a mixed array entirely (text+image → image lost)', () => {
    const mixed = ['/api/app/upload/test-user/already.png', LOCAL_URIS[0]];
    expect(sanitizeAttachments(mixed)).toBeNull();
  });
});

describe('resolveSendableAttachments — fix routes stored URIs through upload', () => {
  it('returns [] for an empty attachment list (no upload attempted)', async () => {
    let called = false;
    const out = await resolveSendableAttachments([], async (a) => {
      called = true;
      return a.map((x) => x.uri);
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('uploads a single local URI → gateway-acceptable server URL', async () => {
    const out = await resolveSendableAttachments([LOCAL_URIS[0]], fakeUpload);
    expect(out).toEqual(['/api/app/upload/test-user/hash0.png']);
    // Oracle: the resolved URL now SURVIVES the gateway sanitizer.
    expect(sanitizeAttachments(out)).not.toBeNull();
    expect(sanitizeAttachments(out)).toEqual(out);
  });

  it('recovers all three local URI schemes (file/content/ph)', async () => {
    const out = await resolveSendableAttachments(LOCAL_URIS, fakeUpload);
    expect(out).toHaveLength(3);
    for (const url of out) expect(isAlreadyUploadedAttachmentUrl(url)).toBe(true);
    expect(sanitizeAttachments(out)).not.toBeNull();
  });

  it('is idempotent for already-uploaded URLs (no double-upload)', async () => {
    const already = [
      '/api/app/upload/test-user/keep.png',
      'https://demo.neutron.example/api/app/upload/u/keep2.png',
    ];
    const out = await resolveSendableAttachments(already, fakeUpload);
    // Already-uploaded entries pass through unchanged …
    expect(out).toEqual(already);
    // … and remain gateway-acceptable.
    expect(sanitizeAttachments(out)).not.toBeNull();
  });

  it('mixes a stale local URI with an already-uploaded one — both end sendable', async () => {
    const mixed = ['/api/app/upload/test-user/already.png', LOCAL_URIS[1]];
    const out = await resolveSendableAttachments(mixed, fakeUpload);
    expect(out[0]).toBe('/api/app/upload/test-user/already.png'); // untouched
    expect(out[1]).toBe('/api/app/upload/test-user/hash1.png'); // re-uploaded
    expect(sanitizeAttachments(out)).not.toBeNull(); // whole array now accepted
  });

  it('propagates an upload failure so retry() can mark the send failed', async () => {
    const boom = async (): Promise<string[]> => {
      throw new Error('upload failed');
    };
    await expect(resolveSendableAttachments([LOCAL_URIS[0]], boom)).rejects.toThrow(
      'upload failed',
    );
  });
});
