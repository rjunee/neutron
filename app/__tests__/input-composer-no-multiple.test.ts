/**
 * @neutronai/app — InputComposer hidden web file input must not be
 * `multiple` (Argus r2 BLOCKING #2).
 *
 * Pre-r2, the composer's hidden `<input type="file">` had `multiple:
 * true`. The chat surface routes every picked file through
 * `useUploadState.start()`, which calls `abortRef.current?.abort()`
 * before launching the next upload. Picking N files therefore produced
 * N-1 silent aborts + 1 successful upload — a regression against the
 * P5.1 multi-image attachments[] flow. Native already does
 * `DocumentPicker.getDocumentAsync({multiple:false})`; this test pins
 * the web side to the same contract.
 *
 * The composer renders the file input via `React.createElement('input',
 * {...})` so there's no JSX attribute to grep. We assert against the
 * source file directly: the `multiple` prop in the file-input element
 * MUST be literally `false` (and MUST NOT be `true`).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(import.meta.dir, '..', 'components', 'InputComposer.tsx'),
  'utf8',
);

describe('InputComposer hidden web file input', () => {
  it('does not declare `multiple: true` anywhere', () => {
    expect(SRC).not.toMatch(/multiple:\s*true/);
  });

  it('explicitly sets `multiple: false` on the file input', () => {
    expect(SRC).toMatch(/multiple:\s*false/);
  });
});
