/**
 * Voice-note send orchestration — capture stopped ⇒ attachment URL.
 *
 * Stubs the uploader, so this asserts the DECISIONS (what gets rejected before
 * a byte leaves the phone, what the multipart part is named and typed) rather
 * than re-testing `upload-client`, which has its own suite.
 */

import { describe, expect, it } from 'bun:test';

import { MIN_RECORDING_MS } from '../lib/voice-recording';
import { sendVoiceNote } from '../lib/voice-send';
import type { UploadAttachmentInput, UploadResult } from '../lib/upload-client';

type Uploader = (input: UploadAttachmentInput) => Promise<UploadResult | null>;

function recordingUploader(
  result: UploadResult | null,
): { impl: Uploader; calls: UploadAttachmentInput[] } {
  const calls: UploadAttachmentInput[] = [];
  const impl: Uploader = async (input) => {
    calls.push(input);
    return result;
  };
  return { impl, calls };
}

const OK: UploadResult = { url: '/api/app/upload/u1/' + 'a'.repeat(64) + '.m4a', kind: 'image' };

describe('sendVoiceNote', () => {
  it('uploads the clip and reports the attachment URL', async () => {
    const { impl, calls } = recordingUploader(OK);
    const outcome = await sendVoiceNote({
      uri: 'file:///tmp/rec.m4a',
      duration_ms: 4_200,
      base_url: 'http://gateway.example.com',
      token: 'tok',
      upload_impl: impl as unknown as typeof import('../lib/upload-client').uploadAttachment,
    });

    expect(outcome).toEqual({
      ok: true,
      url: OK.url,
      mime_type: 'audio/mp4',
      duration_ms: 4_200,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.base_url).toBe('http://gateway.example.com');
    expect(calls[0]?.token).toBe('tok');
    // The part must be typed + named so the gateway sniff agrees and the ASR
    // endpoint (which routes on the filename extension) can read it.
    expect(calls[0]?.mime_type).toBe('audio/mp4');
    expect(calls[0]?.name).toBe('voice-note.m4a');
  });

  it('discards a press too short to be speech, without uploading', async () => {
    const { impl, calls } = recordingUploader(OK);
    const outcome = await sendVoiceNote({
      uri: 'file:///tmp/rec.m4a',
      duration_ms: MIN_RECORDING_MS - 1,
      base_url: 'http://gateway.example.com',
      token: 'tok',
      upload_impl: impl as unknown as typeof import('../lib/upload-client').uploadAttachment,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('too_short');
    expect(calls).toHaveLength(0);
  });

  it('refuses a container the gateway would 415, before spending the upload', async () => {
    const { impl, calls } = recordingUploader(OK);
    const outcome = await sendVoiceNote({
      uri: 'file:///tmp/rec.webm',
      duration_ms: 5_000,
      base_url: 'http://gateway.example.com',
      token: 'tok',
      upload_impl: impl as unknown as typeof import('../lib/upload-client').uploadAttachment,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unsupported_format');
    expect(calls).toHaveLength(0);
  });

  it('stops when there is no bearer, rather than posting an anonymous blob', async () => {
    const { impl, calls } = recordingUploader(OK);
    for (const token of [null, '']) {
      const outcome = await sendVoiceNote({
        uri: 'file:///tmp/rec.m4a',
        duration_ms: 5_000,
        base_url: 'http://gateway.example.com',
        token,
        upload_impl: impl as unknown as typeof import('../lib/upload-client').uploadAttachment,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('not_signed_in');
    }
    expect(calls).toHaveLength(0);
  });

  it('reports an upload failure as a typed outcome, never a throw', async () => {
    const { impl } = recordingUploader(null);
    const outcome = await sendVoiceNote({
      uri: 'file:///tmp/rec.m4a',
      duration_ms: 5_000,
      base_url: 'http://gateway.example.com',
      token: 'tok',
      upload_impl: impl as unknown as typeof import('../lib/upload-client').uploadAttachment,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('upload_failed');
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it('passes progress + abort through to the uploader', async () => {
    const { impl, calls } = recordingUploader(OK);
    const controller = new AbortController();
    const seen: string[] = [];
    await sendVoiceNote({
      uri: 'file:///tmp/rec.m4a',
      duration_ms: 5_000,
      base_url: 'http://gateway.example.com',
      token: 'tok',
      onProgress: (p) => seen.push(p.phase),
      abort_signal: controller.signal,
      upload_impl: impl as unknown as typeof import('../lib/upload-client').uploadAttachment,
    });

    expect(calls[0]?.onProgress).toBeDefined();
    expect(calls[0]?.abort_signal).toBe(controller.signal);
  });
});
