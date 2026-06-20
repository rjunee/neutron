/**
 * @neutronai/app — `shouldGateUpload` (Argus r2 BLOCKING #1).
 *
 * The chat surface used to gate the drop path with `if
 * (uploadAffordance === null) return;` but the picker / paste paths
 * bypassed that check. A user picking or pasting a .zip outside the
 * import_upload_pending phase landed at POST /api/upload/<source>, the
 * engine returned noop_no_state / noop_wrong_phase, but the modal still
 * walked uploading → analyzing → auto-dismiss. Same silent-success
 * shape as r1 BLOCKING #2. The shared predicate below is what every
 * file-entry path now consults so the rule lives in one place.
 */

import { describe, expect, it } from 'bun:test';

import { selectDropFiles, shouldGateUpload } from '../lib/upload-gate';

describe('shouldGateUpload', () => {
  it('gates history-import ZIPs when no upload affordance is live', () => {
    expect(shouldGateUpload('history-import-zip', null)).toBe(true);
  });

  it('lets history-import ZIPs through when an upload affordance is live', () => {
    expect(shouldGateUpload('history-import-zip', { source: 'chatgpt' })).toBe(false);
    expect(shouldGateUpload('history-import-zip', { source: 'claude' })).toBe(false);
    expect(shouldGateUpload('history-import-zip', {})).toBe(false);
  });

  it('never gates images — P5.1 attachments[] are always allowed', () => {
    expect(shouldGateUpload('image', null)).toBe(false);
    expect(shouldGateUpload('image', { source: 'chatgpt' })).toBe(false);
  });
});

describe('selectDropFiles — ISSUES #15 multi-file drop guard', () => {
  it('returns an empty selection + no hint on a 0-file drop', () => {
    const out = selectDropFiles([]);
    expect(out.files.length).toBe(0);
    expect(out.hint).toBeNull();
  });

  it('passes a single dropped file through unchanged with no hint', () => {
    const out = selectDropFiles([
      { name: 'chatgpt.zip', mime_type: 'application/zip', size_bytes: 1024 },
    ]);
    expect(out.files.length).toBe(1);
    expect(out.files[0]!.name).toBe('chatgpt.zip');
    expect(out.hint).toBeNull();
  });

  it('multi-file drop — selects ONLY the first + surfaces a hint citing the dropped count', () => {
    // Pre-fix this routed all 3 files through `useUploadState.start()`
    // which aborts each in-flight upload → 2 silent aborts + 1 success.
    // Post-fix the drop path mirrors the web picker's
    // `<input multiple={false}>` behavior: accept the first, surface a
    // visible hint so the abandoned siblings don't disappear silently.
    const out = selectDropFiles([
      { name: 'a.zip', mime_type: 'application/zip' },
      { name: 'b.zip', mime_type: 'application/zip' },
      { name: 'c.zip', mime_type: 'application/zip' },
    ]);
    expect(out.files.length).toBe(1);
    expect(out.files[0]!.name).toBe('a.zip');
    expect(out.hint).not.toBeNull();
    expect(out.hint!).toContain('3 files');
    expect(out.hint!).toContain('one file at a time');
  });
});
